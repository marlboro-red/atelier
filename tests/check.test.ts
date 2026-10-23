import { createServer } from "node:http";
import { checkPreview } from "../src/server/check.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("missing Chromium returns an actionable unavailable report rather than failing publication", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atelier-missing-browser-"));
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        "import {checkPreview} from './src/server/check.ts'; console.log(JSON.stringify(await checkPreview('http://127.0.0.1:1/a/test',1)))",
      ],
      { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: dir } },
    );
    const result = JSON.parse(stdout);
    assert.equal(result.status, "unavailable");
    assert.deepEqual(result.errors, []);
    assert.match(result.warnings.join(" "), /atelier install-browser/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a hung artifact cannot hold a browser check indefinitely", async () => {
  const server = createServer((_req, reply) => {
    reply.setHeader("content-type", "text/html");
    reply.end("<script>while(true){}</script>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const result = await checkPreview(
      `http://127.0.0.1:${address.port}`,
      1,
      { width: 640, height: 480 },
      false,
      1500,
    );
    assert.equal(result.status, "failed");
    assert.match(result.errors.join(" "), /time limit/);
    assert.ok(result.durationMs < 5000);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
