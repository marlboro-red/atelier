import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Adapter } from "./adapters.js";
import { SocketRpc } from "./socket-rpc.js";

export function codexSocket() {
  return join(
    process.env.CODEX_HOME ?? join(homedir(), ".codex"),
    "app-server-control",
    "app-server-control.sock",
  );
}
export async function listCodexSessions(path = codexSocket()) {
  const rpc = new SocketRpc(path);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    rpc.close();
  }, 8000);
  try {
    await rpc.request("initialize", {
      clientInfo: { name: "atelier", version: "0.1.0" },
    });
    rpc.notify("initialized");
    const loaded = await rpc.request("thread/loaded/list", {});
    const sessions: {
      id: string;
      title: string;
      project: string;
      state: string;
    }[] = [];
    const ids = Array.isArray(loaded.data) ? loaded.data.slice(0, 100) : [];
    for (let i = 0; i < ids.length; i += 5) {
      const results = await Promise.allSettled(
        ids
          .slice(i, i + 5)
          .map((threadId: string) =>
            rpc.request("thread/read", { threadId, includeTurns: false }),
          ),
      );
      for (const result of results) {
        if (result.status !== "fulfilled") continue;
        const thread = result.value.thread;
        if (!thread || !["idle", "active"].includes(thread.status?.type))
          continue;
        sessions.push({
          id: thread.id,
          title: String(
            thread.name || thread.preview || "Untitled conversation",
          ).slice(0, 140),
          project: String(thread.cwd ?? ""),
          state: thread.status.type,
        });
      }
    }
    if (timedOut && !sessions.length)
      throw new Error("Codex conversation discovery timed out");
    return sessions;
  } finally {
    clearTimeout(timeout);
    rpc.close();
  }
}

const execute = promisify(execFile);
export async function connectCodexSession(
  options: { session: string; cwd: string; socket?: string },
  dependencies = {
    rpc: (path: string) => new SocketRpc(path),
    queue: async (args: string[], cwd: string, signal: AbortSignal) => {
      await execute("codex", args, {
        cwd,
        signal,
        timeout: 30_000,
        maxBuffer: 64 * 1024,
        shell: false,
      });
    },
  },
): Promise<Adapter> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      options.session,
    )
  )
    throw new Error(
      "Use the existing Codex session UUID with --session, not a session name.",
    );
  if (options.socket && !isAbsolute(options.socket))
    throw new Error("--codex-socket must be an absolute local socket path");
  const path = options.socket ?? codexSocket();
  const rpc = dependencies.rpc(path);
  const controller = new AbortController();
  const check = async () => {
    const result = await rpc.request(
      "thread/read",
      { threadId: options.session, includeTurns: false },
      5000,
    );
    if (
      result.thread?.id !== options.session ||
      !["idle", "active"].includes(result.thread?.status?.type)
    )
      throw new Error(
        "This Codex session is not open on the connected server. Open it in Codex first; atelier will not resume it in another process.",
      );
  };
  try {
    await rpc.request(
      "initialize",
      {
        clientInfo: {
          name: "atelier",
          title: "atelier comments",
          version: "0.1.0",
        },
      },
      5000,
    );
    rpc.notify("initialized");
    await check();
  } catch (error) {
    rpc.close();
    throw new Error(
      `Cannot connect to the existing Codex session: ${String(error)}. Keep Codex open on its shared local server. For a custom server, pass --codex-socket PATH. Update Codex if queue is unavailable.`,
    );
  }
  return {
    sessionId: options.session,
    closed: rpc.closed,
    close: () => {
      controller.abort();
      rpc.close();
    },
    send: async (prompt) => {
      controller.signal.throwIfAborted();
      await check();
      await dependencies.queue(
        [
          "queue",
          "--remote",
          `unix://${path}`,
          "--thread",
          options.session,
          "--message",
          prompt,
        ],
        options.cwd,
        controller.signal,
      );
    },
  };
}
