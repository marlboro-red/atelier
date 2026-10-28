import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
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
      pool.run(content, { id: "test", revision: 1 }),
      pool.run(content, { id: "test", revision: 2 }),
    ]);
    await assert.rejects(pool.run(content, { id: "test", revision: 3 }), {
      statusCode: 503,
    });
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
test("identical renders share one job and later views reuse the result", async () => {
  const pool = new RenderPool(
    new URL("./fixtures/render-env.mjs", import.meta.url),
  );
  try {
    const [first, second] = await Promise.all([
      pool.run(content, options),
      pool.run(content, options),
    ]);
    assert.equal(first, second);
    assert.equal(await pool.run(content, options), first);
    assert.notEqual(
      await pool.run(content, { ...options, data: { changed: true } }),
      first,
    );
  } finally {
    pool.close();
  }
});

test("compilation survives state changes, export variants, and pool restarts", async () => {
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "atelier-compilation-"));
  let pool = new RenderPool(undefined, undefined, undefined, directory);
  try {
    await pool.run(content, options);
    // An unavailable compiler must not prevent assembly of already compiled content.
    (pool as any).spawn = () => {
      throw new Error("Unexpected compilation");
    };
    const changed = await pool.run(content, { ...options, data: { count: 7 } });
    assert.match(changed, /"count":7/);
    assert.match(
      await pool.run(content, { ...options, standalone: true }),
      /srcdoc=/,
    );
    pool.close();
    pool = new RenderPool(undefined, undefined, undefined, directory);
    (pool as any).spawn = () => {
      throw new Error("Unexpected compilation after restart");
    };
    assert.match(
      await pool.run(content, { id: "copy", revision: 2 }),
      /"id":"copy"/,
    );
  } finally {
    pool.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
