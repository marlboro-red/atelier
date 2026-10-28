import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store.js";
import { Feedback } from "../src/server/feedback.js";
import { createApp } from "../src/server/app.js";
import { feedbackRequest, watchFeedback } from "../src/agents/watch.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "atelier-feedback-"));
  const store = new Store(dir);
  const artifact = store.create({
    title: "Feedback",
    description: "",
    author: "Test",
    summary: "Initial",
    content: {
      kind: "html",
      entry: "index.html",
      files: { "index.html": "<h1>Original</h1>" },
    },
  });
  const comment = store.addComment(artifact.id, {
    revision: 1,
    body: "Change the heading",
    author: "You",
    anchor: null,
  });
  let now = 100_000;
  const queue = new Feedback(store, () => now);
  return {
    store,
    artifact,
    comment,
    queue,
    advance: () => {
      now += 31_000;
    },
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("feedback survives reconnects, has one owner, and never replays an ambiguous dispatch automatically", () => {
  const f = fixture();
  try {
    const { queue, artifact: a, comment: c } = f;
    queue.enqueue(a.id, c.id, "comment");
    const first = queue.connect(a.id, "codex", "one");
    assert.throws(
      () => queue.connect(a.id, "copilot", "two"),
      /already connected/,
    );
    assert.throws(() => queue.claim(a.id, "wrong"), /expired/);
    const events = queue.claim(a.id, first.token);
    assert.equal(events.length, 1);
    assert.equal(queue.claim(a.id, first.token).length, 0);
    f.advance();
    assert.equal(queue.status(a.id).uncertain, 1);
    const second = queue.connect(a.id, "copilot", "two");
    assert.equal(queue.claim(a.id, second.token).length, 0);
    assert.throws(
      () =>
        queue.finish(
          a.id,
          first.token,
          events.map((e) => e.id),
        ),
      /expired/,
    );
    queue.retry(a.id);
    const retry = queue.claim(a.id, second.token);
    assert.equal(retry[0].id, events[0].id);
    queue.enqueue(a.id, c.id, "reply"); // A later reply must not be consumed by this acknowledgement.
    queue.finish(
      a.id,
      second.token,
      retry.map((e) => e.id),
    );
    assert.equal(queue.status(a.id).queued, 1);
    assert.equal(queue.status(a.id).delivered, 1);
    queue.disconnect(a.id);
    assert.throws(() => queue.claim(a.id, second.token), /disconnected/);
    const third = queue.connect(a.id, "claude", "three");
    c.status = "resolved";
    f.store.saveComment(c);
    assert.equal(queue.claim(a.id, third.token).length, 0);
    f.store.remove(a.id, 1);
    assert.equal(
      f.store.db.prepare("SELECT COUNT(*) AS n FROM feedback_events").get()!.n,
      0,
    );
  } finally {
    f.close();
  }
});

test("only explicit user feedback queues work, and the watcher consumes it without reply loops", async () => {
  const f = fixture();
  const app = createApp(f.store);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const request = feedbackRequest(address);
  const root = `/artifacts/${f.artifact.id}`;
  const control = new AbortController();
  let deliveries = 0;
  try {
    const ordinary = await request(root + "/comments", "POST", {
      revision: 1,
      body: "Agent note",
      author: "Agent",
    });
    assert.equal((await request(root + "/feedback")).queued, 0);
    await request(root + "/comments/" + ordinary.id, "PATCH", {
      reply: "User follow-up",
      author: "You",
      notifyAgent: true,
    });
    assert.equal((await request(root + "/feedback")).queued, 1);
    await watchFeedback({
      id: f.artifact.id,
      provider: "codex",
      request,
      signal: control.signal,
      state: () => "connected",
      interval: 10,
      log: (message) => {
        if (message.startsWith("Feedback delivered")) control.abort();
      },
      adapter: {
        sessionId: "test-session",
        close: () => {},
        send: async (prompt) => {
          deliveries++;
          assert.ok(prompt.includes(ordinary.id));
          await request(root + "/comments/" + ordinary.id, "PATCH", {
            reply: "Done",
            author: "Codex",
            status: "addressed",
          });
        },
      },
    });
    assert.equal(deliveries, 1);
    const status = await request(root + "/feedback");
    assert.equal(status.queued, 0);
    assert.equal(status.delivered, 1);
    assert.equal(status.connected, false);
    await request(root + "/comments/" + ordinary.id, "PATCH", {
      status: "open",
      notifyAgent: true,
    });
    assert.equal((await request(root + "/feedback")).queued, 1);
    await request(root + "/comments/" + ordinary.id, "PATCH", {
      status: "open",
      notifyAgent: true,
    });
    assert.equal((await request(root + "/feedback")).queued, 1);
  } finally {
    control.abort();
    await app.close();
    f.close();
  }
});

test("Claude channel sends IDs over MCP, scopes tools, and does not queue its own replies", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } =
    await import("@modelcontextprotocol/sdk/client/stdio.js");
  const { z } = await import("zod");
  const { resolve } = await import("node:path");
  const f = fixture();
  const app = createApp(f.store);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      resolve("bin/atelier.mjs"),
      "mcp",
      "--artifact",
      f.artifact.id,
      "--claude-channel",
    ],
    env: { ...process.env, ATELIER_URL: address } as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "channel-test", version: "1" });
  let resolveNotification: (value: any) => void = () => {};
  const notification = new Promise<any>((resolve) => {
    resolveNotification = resolve;
  });
  client.setNotificationHandler(
    z.object({
      method: z.literal("notifications/claude/channel"),
      params: z.object({
        content: z.string(),
        meta: z.record(z.string(), z.string()),
      }),
    }),
    (message) => {
      resolveNotification(message.params);
    },
  );
  try {
    await client.connect(transport);
    assert.ok(client.getServerCapabilities()?.experimental?.["claude/channel"]);
    const api = feedbackRequest(address);
    const comment = await api(`/artifacts/${f.artifact.id}/comments`, "POST", {
      revision: 1,
      body: "From viewer",
      author: "You",
      notifyAgent: true,
    });
    const incoming = await Promise.race([
      notification,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("No channel notification")),
          5000,
        ).unref(),
      ),
    ]);
    assert.ok(incoming.content.includes(comment.id));
    await client.callTool({
      name: "list_comments",
      arguments: { id: f.artifact.id },
    });
    assert.equal(incoming.meta.artifact_id, f.artifact.id);
    assert.equal(
      (
        await client.callTool({
          name: "get_artifact",
          arguments: { id: "another-artifact" },
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await client.callTool({
          name: "create_artifact",
          arguments: {
            title: "Disallowed",
            content: {
              kind: "html",
              entry: "index.html",
              files: { "index.html": "test" },
            },
          },
        })
      ).isError,
      true,
    );
    const reply = await client.callTool({
      name: "reply_to_comment",
      arguments: {
        id: f.artifact.id,
        commentId: comment.id,
        author: "Claude",
        reply: "Received",
      },
    });
    assert.ok(!reply.isError);
    assert.equal((await api(`/artifacts/${f.artifact.id}/feedback`)).queued, 0);
  } finally {
    await client.close();
    await app.close();
    f.close();
  }
});

test("queued events survive reopening the database and a dead idle adapter disconnects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-feedback-reopen-"));
  let store = new Store(dir);
  const a = store.create({
    title: "Durable",
    description: "",
    author: "Test",
    summary: "Initial",
    content: {
      kind: "html",
      entry: "index.html",
      files: { "index.html": "<p>Test</p>" },
    },
  });
  const c = store.addComment(a.id, {
    revision: 1,
    body: "Update",
    author: "You",
    anchor: null,
  });
  new Feedback(store).enqueue(a.id, c.id, "comment");
  store.close();
  store = new Store(dir);
  const queue = new Feedback(store);
  assert.equal(queue.status(a.id).queued, 1);
  const app = createApp(store);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const control = new AbortController();
  let die: (error: Error) => void = () => {};
  const closed = new Promise<Error>((resolve) => {
    die = resolve;
  });
  try {
    await assert.rejects(
      watchFeedback({
        id: a.id,
        provider: "codex",
        adapter: {
          sessionId: "dead",
          closed,
          send: async () => {},
          close: () => {},
        },
        request: feedbackRequest(address),
        signal: control.signal,
        state: () => "connected",
        log: (text) => {
          if (text.startsWith("Connected")) die(new Error("Agent died"));
        },
      }),
      /Agent died/,
    );
    assert.equal(queue.status(a.id).connected, false);
    assert.equal(queue.status(a.id).queued + queue.status(a.id).uncertain, 1);
  } finally {
    control.abort();
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("feedback counts remain exact after terminal-event retention", () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-feedback-counts-"));
  const store = new Store(dir);
  try {
    const feedback = new Feedback(store);
    const a = store.create({
      title: "Counts",
      description: "",
      author: "Test",
      summary: "Initial",
      content: {
        kind: "html",
        entry: "index.html",
        files: { "index.html": "" },
      },
    });
    const { token } = feedback.connect(a.id, "claude", "test");
    store.transaction(() => {
      const insert = store.prepare(
        "INSERT INTO feedback_events(artifact_id,comment_id,kind,status,created_at) VALUES (?,?,'comment','delivered',0)",
      );
      for (let i = 0; i < 600; i++) insert.run(a.id, "test");
    });
    feedback.finish(a.id, token, []);
    assert.equal(feedback.status(a.id).delivered, 600);
    assert.equal(
      store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM feedback_events WHERE artifact_id=?",
        )
        .get(a.id)!.n,
      500,
    );
    store.remove(a.id, 1);
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS n FROM feedback_counts").get()!.n,
      0,
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
