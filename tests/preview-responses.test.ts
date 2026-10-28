import { test } from "node:test";
import assert from "node:assert/strict";
import { PreviewResponses } from "../src/server/preview-responses.js";

test("encoded previews share work and evict least-recently-used bytes", async () => {
  const cache = new PreviewResponses(12);
  let builds = 0;
  const build = async () => {
    builds++;
    return Buffer.from("123456");
  };
  const [a, b] = await Promise.all([
    cache.get("one", build),
    cache.get("one", build),
  ]);
  assert.equal(a, b);
  assert.equal(builds, 1);
  await cache.get("two", build);
  await cache.get("one", build);
  await cache.get("three", build);
  assert.equal(builds, 3);
  await cache.get("two", build);
  assert.equal(builds, 4);
  cache.close();
});
test("failed and oversized encodings are not cached", async () => {
  const cache = new PreviewResponses(10);
  await assert.rejects(
    cache.get("failure", async () => {
      throw Error("failed");
    }),
  );
  assert.equal(
    (await cache.get("failure", async () => Buffer.from("ok"))).toString(),
    "ok",
  );
  let builds = 0;
  const large = async () => {
    builds++;
    return Buffer.alloc(20);
  };
  await cache.get("large", large);
  await cache.get("large", large);
  assert.equal(builds, 2);
  cache.close();
});
