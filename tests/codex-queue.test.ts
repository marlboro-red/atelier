import { test } from "node:test";
import assert from "node:assert/strict";
import { connectCodexSession } from "../src/agents/codex-queue.js";
import type { SocketRpc } from "../src/agents/socket-rpc.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
const id = "00000000-0000-4000-8000-000000000001";
function fake(status = "idle") {
  const calls: { method: string; params: any }[] = [];
  let closed = false;
  return {
    calls,
    get closed() {
      return closed;
    },
    rpc: {
      closed: new Promise<Error>(() => {}),
      request: async (method: string, params: any) => {
        calls.push({ method, params });
        return method === "thread/read"
          ? { thread: { id, status: { type: status } } }
          : {};
      },
      notify: (method: string, params: any) => {
        calls.push({ method, params });
      },
      close: () => {
        closed = true;
      },
    } as unknown as SocketRpc,
  };
}
test("Codex watch queues into the existing server without starting, resuming, or reconfiguring a thread", async () => {
  const f = fake();
  const queued: string[][] = [];
  let socket = "";
  const adapter = await connectCodexSession(
    { session: id, cwd: "/tmp", socket: "/tmp/codex-test.sock" },
    {
      rpc: (path) => {
        socket = path;
        return f.rpc;
      },
      queue: async (args) => {
        queued.push(args);
      },
    },
  );
  const prompt = 'Feedback with "quotes", $(), and\nnewlines';
  await adapter.send(prompt);
  assert.equal(adapter.sessionId, id);
  assert.equal(socket, "/tmp/codex-test.sock");
  assert.deepEqual(queued, [
    [
      "queue",
      "--remote",
      "unix:///tmp/codex-test.sock",
      "--thread",
      id,
      "--message",
      prompt,
    ],
  ]);
  assert.deepEqual(
    f.calls.map((c) => c.method),
    ["initialize", "initialized", "thread/read", "thread/read"],
  );
  adapter.close();
  assert.equal(f.closed, true);
  await assert.rejects(adapter.send("After close"));
  assert.equal(queued.length, 1);
});
test("a missing or unloaded Codex session never falls back to starting another session", async () => {
  const f = fake("notLoaded");
  let queued = false;
  await assert.rejects(
    connectCodexSession(
      { session: id, cwd: "/tmp" },
      {
        rpc: () => f.rpc,
        queue: async () => {
          queued = true;
        },
      },
    ),
    /not open/,
  );
  assert.equal(queued, false);
  assert.equal(f.closed, true);
  assert.ok(!f.calls.some((c) => /start|resume/.test(c.method)));
  await assert.rejects(
    connectCodexSession({ session: "a guessed name", cwd: "/tmp" }),
    /UUID/,
  );
});
test("Codex watch requires an explicit existing session before contacting any service", async () => {
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [
        resolve("bin/atelier.mjs"),
        "watch",
        "artifact",
        "--agent",
        "codex",
        "--cwd",
        ".",
      ],
      {
        env: { ...process.env, ATELIER_URL: "http://127.0.0.1:1" },
      },
    ),
    (error: any) =>
      /requires --session/.test(error.stderr) &&
      !/Cannot reach/.test(error.stderr),
  );
});

test("the local Codex connection uses WebSocket frames and leaves the server running when disconnected", async () => {
  const { createServer } = await import("node:http");
  const { WebSocketServer } = await import("ws");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { SocketRpc } = await import("../src/agents/socket-rpc.js");
  const directory = await mkdtemp(join(tmpdir(), "at-ws-"));
  const socket = join(directory, "server.sock");
  const http = createServer();
  const server = new WebSocketServer({ server: http });
  const received: any[] = [];
  server.on("connection", (ws) =>
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      received.push(message);
      if (message.id !== undefined)
        ws.send(
          JSON.stringify({
            id: message.id,
            result:
              message.method === "thread/read"
                ? { thread: { id, status: { type: "active" } } }
                : {},
          }),
        );
    }),
  );
  await new Promise<void>((resolve) => http.listen(socket, resolve));
  let adapter;
  let second;
  try {
    adapter = await connectCodexSession(
      { session: id, cwd: directory, socket },
      { rpc: (path) => new SocketRpc(path), queue: async () => {} },
    );
    await adapter.send("Feedback");
    adapter.close();
    second = new SocketRpc(socket);
    await second.request("initialize", {
      clientInfo: { name: "test", version: "1" },
    });
    assert.equal(http.listening, true);
    assert.ok(received.some((m) => m.method === "thread/read"));
    assert.ok(!received.some((m) => /start|resume|interrupt/.test(m.method)));
  } finally {
    adapter?.close();
    second?.close();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("service discovery finds a user installation with a restricted PATH and skips relative paths", async () => {
  const { codexExecutable } = await import("../src/agents/codex-queue.js");
  const { mkdtemp, mkdir, writeFile, chmod, rm } =
    await import("node:fs/promises");
  const { join, delimiter } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const home = await mkdtemp(join(tmpdir(), "atelier-cli-"));
  const name = process.platform === "win32" ? "codex.exe" : "codex";
  const install = join(home, ".local", "bin");
  const preferred = join(home, "custom-bin");
  try {
    await mkdir(install, { recursive: true });
    await mkdir(preferred);
    const executable = join(install, name);
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);
    assert.equal(await codexExecutable("/usr/bin:/bin", home), executable);
    assert.equal(
      await codexExecutable([".", "", "relative/bin"].join(delimiter), home),
      executable,
    );
    await writeFile(join(preferred, name), "#!/bin/sh\nexit 0\n");
    await chmod(join(preferred, name), 0o755);
    assert.equal(await codexExecutable(preferred, home), join(preferred, name));
    // A directory named codex must never count as an executable.
    await rm(join(preferred, name));
    await mkdir(join(preferred, name));
    assert.equal(await codexExecutable(preferred, home), executable);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("an unusable queue command fails before opening a Codex connection", async () => {
  if (process.platform === "win32") return;
  const { mkdtemp, writeFile, chmod, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const directory = await mkdtemp(join(tmpdir(), "atelier-old-cli-"));
  const previous = process.env.PATH;
  try {
    const executable = join(directory, "codex");
    await writeFile(executable, "#!/bin/sh\nexit 2\n");
    await chmod(executable, 0o755);
    process.env.PATH = directory;
    await assert.rejects(
      connectCodexSession({
        session: id,
        cwd: directory,
        socket: join(directory, "absent.sock"),
      }),
      /Codex queue is unavailable/,
    );
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
