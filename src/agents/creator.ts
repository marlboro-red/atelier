import { createServer, createConnection, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Adapter } from "./adapters.js";
import { watchFeedback, type Request } from "./watch.js";
import type { Provider } from "../server/feedback.js";

// Private IPC between a managed session and its MCP subprocesses. No browser
// endpoint, global config changes, process discovery, or second agent session.
export async function creatorBridge(onCreate: (id: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "at-"));
  const path =
    process.platform === "win32"
      ? `\\\\.\\pipe\\atelier-${randomUUID()}`
      : join(directory, "bridge.sock");
  const token = randomUUID();
  const ids = new Set<string>();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.setTimeout(10_000, () => socket.destroy());
    let input = "";
    let handled = false;
    socket.on("data", async (chunk) => {
      if (handled) return;
      input += chunk.toString();
      if (input.length > 8192) return socket.destroy();
      if (!input.includes("\n")) return;
      handled = true;
      try {
        const message = JSON.parse(input.split("\n")[0]);
        if (message.token !== token)
          throw new Error("Invalid creator connection");
        if (message.method === "created") {
          if (!/^[0-9a-f-]{36}$/.test(message.id))
            throw new Error("Invalid artifact ID");
          if (!ids.has(message.id)) {
            ids.add(message.id);
            if (message.watch !== false) await onCreate(message.id);
          }
        } else if (message.method !== "list")
          throw new Error("Unknown creator request");
        socket.end(JSON.stringify({ ids: [...ids] }) + "\n");
      } catch (error) {
        socket.end(JSON.stringify({ error: String(error) }) + "\n");
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    config: JSON.stringify({ path, token }),
    ids,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export async function creatorRequest(
  config: string,
  id?: string,
  watch = true,
): Promise<string[]> {
  const { path, token } = JSON.parse(config);
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let input = "";
    socket.setTimeout(8000, () =>
      socket.destroy(new Error("Creator connection timed out")),
    );
    socket.on("error", reject);
    socket.on("close", () => reject(new Error("Creator connection closed")));
    socket.on("connect", () =>
      socket.write(
        JSON.stringify({ token, method: id ? "created" : "list", id, watch }) +
          "\n",
      ),
    );
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (input.length > 1024 * 1024)
        socket.destroy(new Error("Creator response too large"));
    });
    socket.on("end", () => {
      try {
        const result = JSON.parse(input);
        if (result.error) throw new Error(result.error);
        resolve(result.ids);
      } catch (error) {
        reject(error);
      }
    });
  });
}

/** Serializes creation and feedback in one native session, across artifacts. */
export class CreatorFeedback {
  private queue: Promise<void> = Promise.resolve();
  private watchers = new Map<
    string,
    { control: AbortController; done: Promise<void> }
  >();
  constructor(
    private options: {
      adapter: Adapter;
      provider: Provider;
      request: Request;
      state: () => string;
      log: (text: string) => void;
    },
  ) {}
  send(prompt: string, signal?: AbortSignal, beforeSend?: () => Promise<void>) {
    const run = this.queue.then(async () => {
      signal?.throwIfAborted();
      await beforeSend?.();
      signal?.throwIfAborted();
      await this.options.adapter.send(prompt, signal);
    });
    this.queue = run.catch(() => {});
    return run;
  }
  async add(id: string) {
    if (this.watchers.has(id)) return;
    const control = new AbortController();
    let connected!: () => void;
    let failed!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      connected = resolve;
      failed = reject;
    });
    const done = watchFeedback({
      ...this.options,
      id,
      signal: control.signal,
      onConnected: connected,
      dispatch: (prompt, beforeSend) =>
        this.send(prompt, control.signal, beforeSend),
      adapter: {
        sessionId: this.options.adapter.sessionId,
        closed: this.options.adapter.closed,
        // Disconnecting one artifact does not close the shared native session.
        close: () => control.abort(),
        send: (prompt) => this.send(prompt, control.signal),
      },
    }).catch((error) => {
      failed(error);
      this.options.log(`Feedback for ${id} stopped: ${String(error)}\n`);
    });
    this.watchers.set(id, { control, done });
    await ready;
  }
  async close() {
    for (const { control } of this.watchers.values()) control.abort();
    this.options.adapter.close();
    await Promise.all([...this.watchers.values()].map(({ done }) => done));
  }
}
