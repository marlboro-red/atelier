import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    assert.equal(tools.tools.length, 10);
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
    const browserBase = address.replace("127.0.0.1", "atelier.localhost");
    assert.equal(a.url, `${browserBase}/a/${a.id}`);
    assert.equal(latest.url, `${browserBase}/a/${a.id}`);
    const historical = await call("get_artifact", { id: a.id, revision: 1 });
    assert.equal(historical.url, `${browserBase}/a/${a.id}/revisions/1`);
    const restored = await call("restore_artifact", {
      id: a.id,
      revision: 1,
      baseRevision: 2,
      author: "Test agent",
    });
    assert.equal(restored.number, 3);
    assert.equal(restored.author, "Test agent");
    assert.equal(restored.content, undefined);
    assert.equal(
      (await call("get_artifact", { id: a.id })).revision.content.files[
        "index.md"
      ],
      "# Original",
    );
    const copy = await call("duplicate_artifact", {
      id: a.id,
      revision: 2,
      author: "Test agent",
    });
    assert.notEqual(copy.id, a.id);
    assert.equal(copy.head, 1);
    assert.equal(copy.url, `${browserBase}/a/${copy.id}`);
    const pagePath = join(dir, "page.html");
    writeFileSync(
      pagePath,
      '<link rel="stylesheet" href="styles.css"><h1>File-backed page</h1><!--' +
        "x".repeat(137 * 1024) +
        "-->",
    );
    writeFileSync(join(dir, "styles.css"), "h1{color:teal}");
    const fromPath = await call("create_artifact", {
      title: "Local source",
      author: "Test",
      filePath: pagePath,
    });
    assert.equal(fromPath.content, undefined);
    const fromMap = await call("revise_artifact", {
      id: fromPath.id,
      baseRevision: 1,
      summary: "Include styling",
      author: "Test",
      entry: "page.html",
      filePaths: {
        "page.html": pagePath,
        "styles.css": join(dir, "styles.css"),
      },
    });
    assert.equal(fromMap.content, undefined);
    assert.equal(fromMap.url, `${browserBase}/a/${fromPath.id}`);
    assert.equal(
      (await call("get_artifact", { id: fromPath.id })).revision.content.files[
        "styles.css"
      ],
      "h1{color:teal}",
    );
    const cli = await promisify(execFile)(
      process.execPath,
      [
        resolve("bin/atelier.mjs"),
        "create",
        pagePath,
        "--title",
        "CLI files",
        "--file",
        join(dir, "styles.css"),
      ],
      { env: { ...process.env, ATELIER_URL: address } },
    );
    const cliArtifact = JSON.parse(cli.stdout);
    assert.equal(cliArtifact.url, `${browserBase}/a/${cliArtifact.id}`);
    const cliRevision = await promisify(execFile)(
      process.execPath,
      [
        resolve("bin/atelier.mjs"),
        "revise",
        cliArtifact.id,
        pagePath,
        "--base",
        "1",
        "-m",
        "Keep both files",
        "--file",
        `styles.css=${join(dir, "styles.css")}`,
      ],
      { env: { ...process.env, ATELIER_URL: address } },
    );
    const revised = JSON.parse(cliRevision.stdout);
    assert.equal(revised.url, cliArtifact.url);
    assert.equal(revised.content, undefined);
    assert.equal(
      store.revision(cliArtifact.id).content.files["styles.css"],
      "h1{color:teal}",
    );
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
