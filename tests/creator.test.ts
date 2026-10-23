import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Store } from "../src/server/store.js";
import { createApp } from "../src/server/app.js";
import {
  creatorBridge,
  creatorRequest,
  CreatorFeedback,
} from "../src/agents/creator.js";
import { feedbackRequest } from "../src/agents/watch.js";
import { z } from "zod";

const content = {
  kind: "html",
  entry: "index.html",
  files: { "index.html": "<h1>Creator</h1>" },
};
const unpack = (result: any) => {
  assert.ok(!result.isError, JSON.stringify(result));
  return JSON.parse(result.content[0].text);
};
async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 8000;
  while (!(await check())) {
    if (Date.now() > end)
      throw new Error("Timed out waiting for creator feedback");
    await new Promise((r) => setTimeout(r, 30));
  }
}
async function fixture(args: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "atelier-creator-test-"));
  const store = new Store(dir);
  const app = createApp(store);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const client = new Client({ name: "creator-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("bin/atelier.mjs"), "mcp", ...args],
    env: { ...process.env, ATELIER_URL: address } as Record<string, string>,
    stderr: "pipe",
  });
  return {
    client,
    dir,
    store,
    request: feedbackRequest(address),
    connect: () => client.connect(transport),
    close: async () => {
      await client.close();
      await app.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("creator MCP automatically connects multiple artifacts to the same session, serializes work, and enforces ownership", async () => {
  let feedback!: CreatorFeedback;
  const bridge = await creatorBridge((id) => feedback.add(id));
  const f = await fixture(["--creator-bridge", bridge.config]);
  const delivered: string[] = [];
  let release!: () => void;
  const initial = new Promise<void>((resolve) => {
    release = resolve;
  });
  feedback = new CreatorFeedback({
    provider: "codex",
    request: f.request,
    state: () => "connected",
    log: () => {},
    adapter: {
      sessionId: "the-creating-session",
      close: () => {},
      send: async (prompt) => {
        if (prompt === "Create") await initial;
        else delivered.push(prompt);
      },
    },
  });
  const creating = feedback.send("Create");
  try {
    await f.connect();
    const create = async (title: string, watch = true) =>
      unpack(
        await f.client.callTool({
          name: "create_artifact",
          arguments: { title, author: "Test", content, watch },
        }),
      );
    const first = await create("First");
    const second = await create("Second");
    const manual = await create("Manual", false);
    const cancelled = await create("Disconnect before dispatch");
    assert.equal(first.feedback.connected, true);
    assert.equal(second.feedback.target, "creating_session");
    assert.equal(manual.feedback.connected, false);
    assert.equal(
      (await f.request(`/artifacts/${first.id}/feedback`)).session,
      "the-creating-session",
    );
    assert.equal(
      (await f.request(`/artifacts/${manual.id}/feedback`)).connected,
      false,
    );
    assert.ok(
      unpack(
        await f.client.callTool({
          name: "get_artifact",
          arguments: { id: manual.id },
        }),
      ).artifact,
    );
    const outside = join(f.dir, "outside.html");
    await writeFile(outside, "<h1>Outside the agent working directory</h1>");
    const outsideResult: any = await f.client.callTool({
      name: "create_artifact",
      arguments: { title: "Outside", author: "Test", filePath: outside },
    });
    assert.equal(outsideResult.isError, true);
    assert.match(outsideResult.content[0].text, /inside its working directory/);
    const foreign = await f.request("/artifacts", "POST", {
      title: "Other session",
      content,
    });
    assert.equal(
      (
        await f.client.callTool({
          name: "get_artifact",
          arguments: { id: foreign.id },
        })
      ).isError,
      true,
    );
    assert.equal(
      unpack(await f.client.callTool({ name: "list_artifacts", arguments: {} }))
        .length,
      4,
    );
    await assert.rejects(
      creatorRequest(
        JSON.stringify({ ...JSON.parse(bridge.config), token: "wrong" }),
      ),
      /Invalid creator/,
    );
    for (const id of [first.id, second.id, cancelled.id])
      await f.request(`/artifacts/${id}/comments`, "POST", {
        revision: 1,
        body: "Change this",
        notifyAgent: true,
      });
    await until(
      async () =>
        (await f.request(`/artifacts/${first.id}/feedback`)).state ===
        "working",
    );
    assert.equal(delivered.length, 0, "Feedback cannot race the creation turn");
    await until(
      async () =>
        (await f.request(`/artifacts/${cancelled.id}/feedback`)).state ===
        "working",
    );
    await f.request(
      `/artifacts/${cancelled.id}/feedback/disconnect`,
      "POST",
      {},
    );
    release();
    await creating;
    await until(async () => delivered.length === 2);
    assert.ok(delivered.some((p) => p.includes(first.id)));
    assert.ok(delivered.some((p) => p.includes(second.id)));
    await until(
      async () =>
        (await f.request(`/artifacts/${second.id}/feedback`)).delivered === 1,
    );
    assert.ok(!delivered.some((p) => p.includes(cancelled.id)));
    await f.request(`/artifacts/${first.id}/feedback/disconnect`, "POST", {});
    assert.equal(
      (await f.request(`/artifacts/${second.id}/feedback`)).connected,
      true,
    );
  } finally {
    release();
    await feedback.close();
    await bridge.close();
    await f.close();
  }
});

test("Claude channel creation connects by default and receipt for one artifact cannot acknowledge another", async () => {
  const f = await fixture(["--claude-channel"]);
  const notifications: any[] = [];
  f.client.setNotificationHandler(
    z.object({
      method: z.literal("notifications/claude/channel"),
      params: z.any(),
    }),
    (message) => {
      notifications.push(message.params);
    },
  );
  try {
    await f.connect();
    const make = async () =>
      unpack(
        await f.client.callTool({
          name: "create_artifact",
          arguments: { title: "Channel creation", author: "Claude", content },
        }),
      );
    const a = await make();
    const b = await make();
    assert.equal(a.feedback.connected, true);
    assert.equal(b.feedback.connected, true);
    await f.request(`/artifacts/${a.id}/comments`, "POST", {
      revision: 1,
      body: "A comment",
      notifyAgent: true,
    });
    await until(async () => notifications.length > 0);
    assert.equal(notifications[0].meta.artifact_id, a.id);
    await f.client.callTool({ name: "list_comments", arguments: { id: b.id } });
    assert.equal((await f.request(`/artifacts/${a.id}/feedback`)).delivered, 0);
    await f.client.callTool({ name: "list_comments", arguments: { id: a.id } });
    await until(
      async () =>
        (await f.request(`/artifacts/${a.id}/feedback`)).delivered === 1,
    );
    await f.request(`/artifacts/${a.id}/comments`, "POST", {
      revision: 1,
      body: "Another request",
      notifyAgent: true,
    });
    await until(async () => notifications.length === 2);
    await f.request(`/artifacts/${a.id}/feedback/disconnect`, "POST", {});
    await f.request(`/artifacts/${b.id}/comments`, "POST", {
      revision: 1,
      body: "Request for B",
      notifyAgent: true,
    });
    await until(async () => notifications.length === 3);
    assert.equal(notifications[2].meta.artifact_id, b.id);
    await f.client.callTool({ name: "list_comments", arguments: { id: b.id } });
    await until(
      async () =>
        (await f.request(`/artifacts/${b.id}/feedback`)).delivered === 1,
    );
  } finally {
    await f.close();
  }
});

test("plain MCP creation reports that it cannot wake the client rather than launching an agent", async () => {
  const f = await fixture([]);
  try {
    await f.connect();
    const a = unpack(
      await f.client.callTool({
        name: "create_artifact",
        arguments: { title: "Plain MCP", author: "Test", content },
      }),
    );
    assert.equal(a.feedback.connected, false);
    assert.match(a.feedback.reason, /cannot wake/);
    assert.equal(
      (await f.request(`/artifacts/${a.id}/feedback`)).connected,
      false,
    );
  } finally {
    await f.close();
  }
});
