import { test } from "node:test";
import assert from "node:assert/strict";
import { createPreviewLoader } from "../src/web/preview-cache.js";

test("preview reuse validates state and skips JSON parsing on unchanged responses", async () => {
  let version = 1,
    requests = 0,
    parses = 0;
  const load = createPreviewLoader(async (_url, init) => {
    requests++;
    const etag = `"${version}"`;
    assert.equal(init?.cache, "no-store");
    if (new Headers(init?.headers).get("if-none-match") === etag)
      return new Response(null, { status: 304 });
    const response = new Response(
      JSON.stringify({ html: `version ${version}` }),
      { headers: { etag } },
    );
    const json = response.json.bind(response);
    response.json = () => {
      parses++;
      return json();
    };
    return response;
  });
  const first = await load("/preview");
  assert.equal(await load("/preview"), first);
  assert.equal(requests, 2);
  assert.equal(parses, 1);
  version++;
  assert.equal((await load("/preview")).html, "version 2");
  assert.equal(parses, 2);
});
test("preview cache evicts by byte budget and never caches failed renders", async () => {
  const headers: (string | null)[] = [];
  const load = createPreviewLoader(async (url, init) => {
    headers.push(new Headers(init?.headers).get("if-none-match"));
    return new Response(JSON.stringify({ html: "0123456789" }), {
      headers: String(url).endsWith("failed") ? {} : { etag: '"v1"' },
    });
  }, 30);
  await load("/one");
  await load("/two");
  await load("/one");
  await load("/failed");
  await load("/failed");
  assert.deepEqual(headers, [null, null, null, null, null]);
});
