import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createScriptLoader, scriptLocation } from "../src/server/cdn.js";

const now = Date.parse("2026-10-23T00:00:00Z");
const url = "https://cdn.jsdelivr.net/npm/example@1.2.3/dist/example.js";
const code = "window.example = true;";
function fixture(date: string | undefined = "2026-10-09T00:00:00Z") {
  const calls: string[] = [];
  const fetcher = (async (input, options) => {
    const address = String(input);
    calls.push(address);
    assert.equal(options?.redirect, "error");
    if (address.startsWith("https://api.cdnjs.com/"))
      return Response.json({
        autoupdate: { source: "npm", target: "example" },
      });
    if (address.startsWith("https://registry.npmjs.org/"))
      return Response.json({
        versions: { "1.2.3": {} },
        time: { "1.2.3": date },
      });
    return new Response(code, {
      headers: { "content-type": "application/javascript; charset=utf-8" },
    });
  }) as typeof fetch;
  return { calls, loader: createScriptLoader(fetcher, () => now) };
}

test("only exact versions and JavaScript files on the listed CDNs are accepted", () => {
  for (const address of [
    url,
    "https://unpkg.com/@scope/example@1.2.3/dist/index.js",
    "https://cdnjs.cloudflare.com/ajax/libs/example/1.2.3/index.min.js",
    "https://cdn.tailwindcss.com/1.2.3",
    "https://code.jquery.com/jquery-1.2.3.min.js",
    "https://code.jquery.com/ui/1.2.3/jquery-ui.min.js",
  ])
    assert.equal(scriptLocation(address).version, "1.2.3");
  for (const address of [
    "https://evil.example/example@1.2.3/file.js",
    "http://unpkg.com/example@1.2.3/file.js",
    "https://unpkg.com/example@latest/file.js",
    "https://unpkg.com/example@1/file.js",
    "https://unpkg.com/example@^1.2.3/file.js",
    "https://unpkg.com/example@1.2.3",
    "https://cdn.tailwindcss.com",
    "https://cdn.jsdelivr.net/gh/example@1.2.3/file.js",
    url + "?module",
    url + "#x",
    "https://unpkg.com/example@1.2.3/style.css",
    "https://user@unpkg.com/example@1.2.3/file.js",
    "https://unpkg.com:123/example@1.2.3/file.js",
  ])
    assert.throws(() => scriptLocation(address), Error, address);
});

test("scripts at least 14 days old are embedded, cached, and integrity checked", async () => {
  const { loader, calls } = fixture();
  const integrity =
    "sha384-" + createHash("sha384").update(code).digest("base64");
  assert.equal(
    await loader(url, integrity),
    "data:text/javascript;base64," + Buffer.from(code).toString("base64"),
  );
  await loader(url);
  assert.equal(calls.length, 2);
  await assert.rejects(loader(url, "sha384-invalid"), /integrity mismatch/);
});

test("recent, future, missing, and invalid publication dates fail closed before fetching script bytes", async () => {
  for (const date of [
    "2026-10-09T00:00:00.001Z",
    "2027-01-01",
    "invalid",
    "",
  ]) {
    const { loader, calls } = fixture(date);
    await assert.rejects(loader(url), /at least 14 days/);
    assert.equal(calls.length, 1);
  }
});

test("cdnjs publication dates use its declared npm package", async () => {
  const { loader, calls } = fixture();
  await loader(
    "https://cdnjs.cloudflare.com/ajax/libs/example/1.2.3/example.js",
  );
  assert.equal(calls[1], "https://registry.npmjs.org/example");
});

test("unknown cdnjs publication sources, redirects, and non-JavaScript responses fail closed", async () => {
  const unknown = createScriptLoader(
    (async () =>
      Response.json({ autoupdate: { source: "git" } })) as typeof fetch,
    () => now,
  );
  await assert.rejects(
    unknown("https://cdnjs.cloudflare.com/ajax/libs/example/1.2.3/example.js"),
    /Cannot verify/,
  );
  for (const response of [
    new Response(null, { status: 302 }),
    new Response("<html>not JS</html>", {
      headers: { "content-type": "text/html" },
    }),
  ]) {
    const loader = createScriptLoader(
      (async (input) =>
        String(input).includes("registry.npmjs.org")
          ? Response.json({
              versions: { "1.2.3": {} },
              time: { "1.2.3": "2020-01-01" },
            })
          : response) as typeof fetch,
      () => now,
    );
    await assert.rejects(loader(url));
  }
});

test("verified scripts persist across loaders and concurrent downloads are shared", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "atelier-cdn-"));
  let requests = 0;
  const fetcher: typeof fetch = async (input) => {
    requests++;
    return String(input).includes("registry.npmjs.org")
      ? Response.json({
          versions: { "1.2.3": {} },
          time: { "1.2.3": "2020-01-01" },
        })
      : new Response(code, { headers: { "content-type": "text/javascript" } });
  };
  try {
    const loader = createScriptLoader(fetcher, () => now, directory);
    const [a, b] = await Promise.all([loader(url), loader(url)]);
    assert.equal(a, b);
    assert.equal(requests, 2);
    const offline = createScriptLoader(
      async () => {
        throw new Error("offline");
      },
      () => now,
      directory,
    );
    assert.equal(await offline(url), a);
    await assert.rejects(offline(url, "sha384-invalid"), /integrity mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
