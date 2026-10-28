import { DiskCache } from "./disk-cache.js";
import { createHash } from "node:crypto";

const minimumAge = 14 * 24 * 60 * 60 * 1000;
const exactVersion =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;
const scriptFile = /^(?:[\w@.-]+\/)*[\w.-]+\.(?:js|mjs)$/;

type ScriptLocation = {
  url: string;
  version: string;
  package?: string;
  library?: string;
};
export function scriptLocation(source: string): ScriptLocation {
  const url = new URL(source);
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    source.includes("%")
  ) {
    throw new Error(
      "CDN scripts require an HTTPS URL without credentials, query parameters, or fragments",
    );
  }
  let name: string | undefined,
    library: string | undefined,
    version: string | undefined,
    file: string | undefined;
  if (url.hostname === "cdn.jsdelivr.net" || url.hostname === "unpkg.com") {
    const path =
      url.hostname === "cdn.jsdelivr.net"
        ? url.pathname.replace(/^\/npm\//, "")
        : url.pathname.slice(1);
    const match = path.match(/^((?:@[^/]+\/)?[^/@]+)@([^/]+)\/(.+)$/);
    if (match) [, name, version, file] = match;
  } else if (url.hostname === "cdnjs.cloudflare.com") {
    const match = url.pathname.match(
      /^\/ajax\/libs\/([\w.-]+)\/([^/]+)\/(.+)$/,
    );
    if (match) [, library, version, file] = match;
  } else if (url.hostname === "code.jquery.com") {
    const match = url.pathname.match(
      /^\/jquery-([\d.]+)(?:\.slim)?(?:\.min)?\.js$/,
    );
    if (match) {
      name = "jquery";
      version = match[1];
      file = "jquery.js";
    }
    const ui = url.pathname.match(/^\/ui\/([^/]+)\/jquery-ui(?:\.min)?\.js$/);
    if (ui) {
      name = "jquery-ui";
      version = ui[1];
      file = "jquery-ui.js";
    }
  } else if (url.hostname === "cdn.tailwindcss.com") {
    name = "tailwindcss";
    version = url.pathname.slice(1);
    file = "tailwind.js";
  }
  if (
    !version ||
    !exactVersion.test(version) ||
    !file ||
    !scriptFile.test(file) ||
    (name && !packageName.test(name))
  ) {
    throw new Error(
      `Unsupported CDN script URL: ${source}. Use an allowed CDN, an exact version, and an explicit JavaScript file (Tailwind: /VERSION).`,
    );
  }
  return { url: url.href, version, package: name, library };
}

export function createScriptLoader(
  fetcher: typeof fetch = (input, init) => fetch(input, init),
  now = Date.now,
  directory?: string,
) {
  const cache = new Map<string, Buffer>();
  const pending = new Map<string, Promise<Buffer>>();
  const metadata = new Map<string, Promise<any>>();
  const disk = directory
    ? new DiskCache(directory, 64 * 1024 * 1024)
    : undefined;
  const hash = (value: string | Buffer) =>
    createHash("sha256").update(value).digest("hex");
  function remember(url: string, bytes: Buffer) {
    cache.set(url, bytes);
    let total = [...cache.values()].reduce(
      (sum, value) => sum + value.length,
      0,
    );
    for (const [key, value] of cache) {
      if (total <= 16 * 1024 * 1024) break;
      cache.delete(key);
      total -= value.length;
    }
  }
  async function download(url: string, limit: number) {
    const response = await fetcher(url, {
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok || !response.body)
      throw new Error(
        `Could not verify or download CDN script: ${url} (${response.status})`,
      );
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit)
          throw new Error(`CDN response exceeds ${limit} bytes`);
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return {
      bytes: Buffer.concat(chunks),
      type: response.headers.get("content-type") ?? "",
    };
  }
  async function json(url: string) {
    let request = metadata.get(url);
    if (!request) {
      request = download(url, 32 * 1024 * 1024).then(({ bytes }) =>
        JSON.parse(bytes.toString()),
      );
      metadata.set(url, request);
      void request.finally(() => metadata.delete(url)).catch(() => {});
    }
    return request;
  }
  async function verified(
    location: ScriptLocation,
    source: string,
  ): Promise<Buffer> {
    const key = hash("verified-script-v1:" + location.url);
    const saved = await disk?.get(key);
    if (saved) {
      try {
        const entry = JSON.parse(saved);
        const bytes = Buffer.from(entry.bytes, "base64");
        if (
          entry.url === location.url &&
          Number.isFinite(entry.published) &&
          now() - entry.published >= minimumAge &&
          bytes.length <= 5 * 1024 * 1024 &&
          hash(bytes) === entry.hash
        )
          return bytes;
      } catch {
        /* Reverify damaged cache entries. */
      }
    }
    let name = location.package;
    if (location.library) {
      const metadata = await json(
        `https://api.cdnjs.com/libraries/${location.library}?fields=autoupdate`,
      );
      if (metadata.autoupdate?.source === "npm")
        name = metadata.autoupdate.target;
    }
    if (!name || !packageName.test(name))
      throw new Error(
        `Cannot verify the publication date for ${source}; use a versioned npm CDN URL instead`,
      );
    const metadata = await json(
      `https://registry.npmjs.org/${encodeURIComponent(name)}`,
    );
    const published = Date.parse(metadata.time?.[location.version]);
    if (
      !metadata.versions?.[location.version] ||
      !Number.isFinite(published) ||
      now() - published < minimumAge
    ) {
      throw new Error(
        `CDN script ${name}@${location.version} must have a verified publication date at least 14 days ago`,
      );
    }
    const downloaded = await download(location.url, 5 * 1024 * 1024);
    if (
      !/^(?:text|application)\/(?:javascript|ecmascript|x-javascript)(?:;|$)/i.test(
        downloaded.type,
      )
    )
      throw new Error(`CDN URL did not return JavaScript: ${source}`);
    const bytes = downloaded.bytes;
    await disk?.put(
      key,
      JSON.stringify({
        url: location.url,
        published,
        hash: hash(bytes),
        bytes: bytes.toString("base64"),
      }),
    );
    return bytes;
  }
  return async (source: string, integrity?: string) => {
    const location = scriptLocation(source);
    let bytes = cache.get(location.url);
    if (!bytes) {
      let job = pending.get(location.url);
      if (!job) {
        job = verified(location, source).finally(() =>
          pending.delete(location.url),
        );
        pending.set(location.url, job);
      }
      bytes = await job;
      remember(location.url, bytes);
    }
    if (integrity) {
      const tokens = integrity.trim().split(/\s+/);
      const algorithm = ["sha512", "sha384", "sha256"].find((a) =>
        tokens.some((token) => token.startsWith(a + "-")),
      );
      if (
        !algorithm ||
        !tokens.includes(
          `${algorithm}-${createHash(algorithm).update(bytes).digest("base64")}`,
        )
      )
        throw new Error(`CDN script integrity mismatch: ${source}`);
    }
    return `data:text/javascript;base64,${bytes.toString("base64")}`;
  };
}
export const loadCdnScript = createScriptLoader(
  undefined,
  undefined,
  process.env.ATELIER_SCRIPT_CACHE,
);
