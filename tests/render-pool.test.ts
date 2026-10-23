import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { RenderPool } from "../src/server/render-pool.js";
const content = {
  kind: "html" as const,
  entry: "index.html",
  files: { "index.html": "<h1>Rendered</h1>" },
};
const options = { id: "test", revision: 1 };
test("render jobs time out without blocking the service event loop and reject overload", async () => {
  const pool = new RenderPool(
    new URL("./fixtures/render-hang.mjs", import.meta.url),
    500,
  );
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  try {
    const jobs = Promise.allSettled([
      pool.run(content, options),
      pool.run(content, options),
    ]);
    await assert.rejects(pool.run(content, options), { statusCode: 503 });
    for (const result of await jobs) {
      assert.equal(result.status, "rejected");
      if (result.status === "rejected")
        assert.equal(result.reason.statusCode, 504);
    }
    assert.ok(ticks > 10);
  } finally {
    clearInterval(timer);
    pool.close();
  }
});
test("render processes do not inherit application secrets and clean up temporary directories", async () => {
  const pool = new RenderPool(
    new URL("./fixtures/render-env.mjs", import.meta.url),
  );
  process.env.ATELIER_TEST_SECRET = "fake-secret-for-test";
  try {
    const result = JSON.parse(await pool.run(content, options));
    assert.equal(result.secret, undefined);
    assert.equal(result.options, undefined);
    assert.notEqual(result.cwd, process.cwd());
    assert.equal(result.cwd, result.home);
    assert.equal(existsSync(result.cwd), false);
  } finally {
    delete process.env.ATELIER_TEST_SECRET;
    pool.close();
  }
});
test("the isolated renderer compiles supplied content and rejects work after shutdown", async () => {
  const pool = new RenderPool();
  assert.match(await pool.run(content, options), /<h1>Rendered<\/h1>/);
  pool.close();
  await assert.rejects(pool.run(content, options), { statusCode: 503 });
});
