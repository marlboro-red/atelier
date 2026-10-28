import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Store } from "../src/server/store.js";
import { createApp } from "../src/server/app.js";

test("previews compress, revalidate without a body, and invalidate on data changes and restarts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "atelier-preview-response-"));
  const store = new Store(directory);
  let app = createApp(store);
  const artifact = store.create({
    title: "Cache test",
    description: "",
    author: "test",
    summary: "",
    content: {
      kind: "html",
      entry: "index.html",
      files: {
        "index.html": `<h1>Preview</h1><p>${"example ".repeat(5000)}</p>`,
      },
    },
  });
  const url = `/api/artifacts/${artifact.id}/revisions/1/preview`;
  const headers = { host: "localhost", "accept-encoding": "gzip" };
  try {
    const first = await app.inject({ url, headers });
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers["content-encoding"], "gzip");
    const decoded = gunzipSync(first.rawPayload);
    assert.match(JSON.parse(decoded.toString()).html, /<h1>Preview<\/h1>/);
    assert.ok(first.rawPayload.length < decoded.length / 2);
    const etag = String(first.headers.etag);
    const unchanged = await app.inject({
      url,
      headers: { ...headers, "if-none-match": etag },
    });
    assert.equal(unchanged.statusCode, 304);
    assert.equal(unchanged.rawPayload.length, 0);
    store.setData(artifact.id, { note: "latest saved data" });
    const changed = await app.inject({
      url,
      headers: { host: "localhost", "if-none-match": etag },
    });
    assert.equal(changed.statusCode, 200);
    assert.notEqual(changed.headers.etag, etag);
    assert.match(changed.json().html, /latest saved data/);
    await app.close();
    app = createApp(store);
    const restarted = await app.inject({
      url,
      headers: {
        host: "localhost",
        "if-none-match": String(changed.headers.etag),
      },
    });
    assert.equal(restarted.statusCode, 200);
    assert.notEqual(restarted.headers.etag, changed.headers.etag);
    store.remove(artifact.id, 1);
    assert.equal(
      (
        await app.inject({
          url,
          headers: {
            host: "localhost",
            "if-none-match": String(restarted.headers.etag),
          },
        })
      ).statusCode,
      404,
    );
  } finally {
    await app.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
