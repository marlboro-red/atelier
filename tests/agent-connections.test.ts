import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Store } from "../src/server/store.js";
import { createApp } from "../src/server/app.js";
const session = "00000000-0000-4000-8000-000000000001";
const content = {
  kind: "html",
  entry: "index.html",
  files: { "index.html": "<h1>Connection test</h1>" },
} as const;
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "at-connect-"));
  const store = new Store(dir);
  const calls: string[] = [];
  const prompts: string[] = [];
  let closed = 0;
  const app = createApp(store, 4311, {
    list: async () => [
      {
        id: session,
        title: "Existing conversation",
        project: dir,
        state: "idle",
      },
    ],
    connect: async (id) => {
      calls.push(id);
      if (id !== session) throw new Error("Conversation closed");
      return {
        sessionId: id,
        send: async (prompt) => {
          prompts.push(prompt);
        },
        close: () => {
          closed++;
        },
      };
    },
  });
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  const create = () =>
    store.create({
      title: "Connections",
      description: "",
      author: "Test",
      summary: "Initial",
      content,
    });
  return {
    dir,
    store,
    app,
    base,
    calls,
    prompts,
    create,
    get closed() {
      return closed;
    },
    close: async () => {
      await app.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("the service owns a selected connection, rejects cross-origin requests, and stops forwarding on disconnect", async () => {
  const f = await fixture();
  const a = f.create();
  const path = `/api/artifacts/${a.id}/feedback`;
  try {
    assert.equal(
      (
        await f.app.inject({ method: "GET", url: "/api/agents/codex/sessions" })
      ).json()[0].title,
      "Existing conversation",
    );
    assert.equal(
      (
        await f.app.inject({
          method: "GET",
          url: "/api/agents/codex/sessions",
          headers: { origin: "https://evil.example" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: path + "/codex",
          payload: { session },
          headers: { origin: "null" },
        })
      ).statusCode,
      403,
    );
    assert.equal(f.calls.length, 0);
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: path + "/codex",
          payload: { session, socket: "/tmp/other" },
        })
      ).statusCode,
      400,
    );
    const [one, two] = await Promise.all(
      [1, 2].map(() =>
        f.app.inject({
          method: "POST",
          url: path + "/codex",
          payload: { session },
        }),
      ),
    );
    assert.equal(one.json().connected, true);
    assert.equal(two.json().connected, true);
    assert.deepEqual(f.calls, [session]);
    await f.app.inject({
      method: "POST",
      url: `/api/artifacts/${a.id}/comments`,
      payload: { revision: 1, body: "Change this", notifyAgent: true },
    });
    await until(() => f.prompts.length === 1);
    assert.match(f.prompts[0], new RegExp(a.id));
    const stop = await f.app.inject({
      method: "POST",
      url: path + "/disconnect",
      payload: {},
    });
    assert.equal(stop.statusCode, 200);
    assert.ok(f.closed > 0);
    await f.app.inject({
      method: "POST",
      url: `/api/artifacts/${a.id}/comments`,
      payload: { revision: 1, body: "Later", notifyAgent: true },
    });
    assert.equal(
      (await f.app.inject({ method: "GET", url: path })).json().queued,
      1,
    );
    const b = f.create();
    await f.app.inject({
      method: "POST",
      url: `/api/artifacts/${b.id}/feedback/codex`,
      payload: { session },
    });
    const count = f.closed;
    await f.app.close();
    assert.ok(f.closed > count);
  } finally {
    await f.close();
  }
});

test("MCP creation accepts the agent's own identity and connect reads it from the Codex tool environment", async () => {
  const f = await fixture();
  const client = new Client({ name: "test", version: "1" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve("bin/atelier.mjs"), "mcp"],
        env: { ...process.env, ATELIER_URL: f.base } as Record<string, string>,
        stderr: "pipe",
      }),
    );
    const result: any = await client.callTool({
      name: "create_artifact",
      arguments: {
        title: "Auto connected",
        author: "Codex",
        content,
        feedbackSession: session,
      },
    });
    assert.ok(!result.isError, JSON.stringify(result));
    const created = JSON.parse(result.content[0].text);
    assert.equal(created.feedback.connected, true);
    assert.deepEqual(f.calls, [session]);
    const comment = f.store.addComment(created.id, {
      revision: 1,
      body: "Please amend",
      author: "You",
      anchor: null,
    });
    const commentsPath = `/api/artifacts/${created.id}/comments`;
    const unread = await f.app.inject({ method: "GET", url: commentsPath });
    assert.equal(unread.json()[0].acknowledgedAt, undefined);
    const denied = await f.app.inject({
      method: "POST",
      url: commentsPath + "/read",
      payload: {},
      headers: { origin: "null" },
    });
    assert.equal(denied.statusCode, 403);
    const read: any = await client.callTool({
      name: "list_comments",
      arguments: { id: created.id },
    });
    assert.ok(!read.isError);
    const acknowledgedAt = JSON.parse(read.content[0].text)[0].acknowledgedAt;
    assert.ok(acknowledgedAt);
    await client.callTool({
      name: "list_comments",
      arguments: { id: created.id },
    });
    assert.equal(
      f.store.comment(created.id, comment.id).acknowledgedAt,
      acknowledgedAt,
    );
    await f.app.inject({
      method: "PATCH",
      url: commentsPath + "/" + comment.id,
      payload: { reply: "One more thing", notifyAgent: true },
    });
    assert.equal(
      f.store.comment(created.id, comment.id).acknowledgedAt,
      undefined,
    );
    await client.callTool({
      name: "list_comments",
      arguments: { id: created.id },
    });
    assert.ok(f.store.comment(created.id, comment.id).acknowledgedAt);
    const a = f.create();
    const resultCLI = await promisify(execFile)(
      process.execPath,
      [resolve("bin/atelier.mjs"), "connect", a.id],
      {
        env: { ...process.env, ATELIER_URL: f.base, CODEX_THREAD_ID: session },
      },
    );
    assert.equal(JSON.parse(resultCLI.stdout).connected, true);
    assert.deepEqual(f.calls, [session, session]);
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [resolve("bin/atelier.mjs"), "connect", a.id],
        { env: { ...process.env, ATELIER_URL: f.base, CODEX_THREAD_ID: "" } },
      ),
      (error: any) =>
        /Run this command from your Codex agent/.test(error.stderr),
    );
    const bad = await f.app.inject({
      method: "POST",
      url: `/api/artifacts/${f.create().id}/feedback/codex`,
      payload: { session: "00000000-0000-4000-8000-000000000002" },
    });
    assert.equal(bad.statusCode, 500);
  } finally {
    await client.close();
    await f.close();
  }
});
