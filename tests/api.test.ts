import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../src/server/store.js";
import { createApp } from "../src/server/app.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
test("MCP clients create, annotate, and revise the same artifact through the local API", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-mcp-"));
  const store = new Store(dir);
  const app = createApp(store);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("bin/atelier.mjs"), "mcp"],
    env: { ...process.env, ATELIER_URL: address } as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "integration-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 8);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, JSON.stringify(result));
      return JSON.parse((result.content as any)[0].text);
    };
    const content = {
      kind: "markdown",
      entry: "index.md",
      files: { "index.md": "# Original" },
    };
    const a = await call("create_artifact", {
      title: "MCP artifact",
      author: "Test agent",
      content,
    });
    const c = await call("add_comment", {
      id: a.id,
      revision: 1,
      author: "User",
      body: "Update the title",
    });
    await call("reply_to_comment", {
      id: a.id,
      commentId: c.id,
      author: "Test agent",
      status: "in_progress",
      reply: "Working on it",
    });
    await call("revise_artifact", {
      id: a.id,
      baseRevision: 1,
      summary: "Updated title",
      author: "Test agent",
      content: { ...content, files: { "index.md": "# Updated" } },
      commentIds: [c.id],
    });
    const latest = await call("get_artifact", { id: a.id });
    assert.equal(latest.artifact.id, a.id);
    assert.equal(latest.revision.number, 2);
    const comments = await call("list_comments", { id: a.id });
    assert.equal(comments[0].status, "addressed");
    assert.equal(comments[0].replies.length, 1);
    const crossOrigin = await app.inject({
      method: "POST",
      url: "/api/artifacts",
      headers: { host: "127.0.0.1", origin: "https://other.example" },
      payload: { title: "No", content },
    });
    assert.equal(crossOrigin.statusCode, 403);
    const badHost = await app.inject({
      method: "GET",
      url: "/api/artifacts",
      headers: { host: "evil.example" },
    });
    assert.equal(badHost.statusCode, 403);
  } finally {
    await client.close();
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
