import { build } from "esbuild";
import {
  parse,
  parseFragment,
  serialize,
  serializeOuter,
  type DefaultTreeAdapterMap,
} from "parse5";
import { posix, resolve, relative, isAbsolute, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateImports } from "./imports.js";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { Marked } from "marked";
import { render as renderDiagram } from "pele";
import { randomUUID } from "node:crypto";
import sanitize from "sanitize-html";
import katex from "katex";
import type { Content } from "../shared/schema.js";
import { loadCdnScript } from "./cdn.js";
import { artifactPolicy } from "../shared/security.js";
const require = createRequire(import.meta.url);
const dependencies = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../node_modules",
);
const allowed = new Set([
  "react",
  "react-dom",
  "recharts",
  "d3",
  "lucide-react",
  "mermaid",
  "pele",
  "katex",
]);
const escape = (s: string) => s.replace(/</g, "\\u003c");
const css = readFileSync(
  require.resolve("katex/dist/katex.min.css"),
  "utf8",
).replace(/url\(([^)]+)\)/g, (_, url: string) => {
  const path = url.replace(/["']/g, "");
  const bytes = readFileSync(require.resolve("katex/dist/" + path));
  return `url(data:font/woff2;base64,${bytes.toString("base64")})`;
});
async function htmlDocument(source: string) {
  type Element = DefaultTreeAdapterMap["element"];
  const document = parse(source, { sourceCodeLocationInfo: true });
  const html = document.childNodes.find(
    (node): node is Element => node.nodeName === "html",
  )!;
  const head = html.childNodes.find(
    (node): node is Element => node.nodeName === "head",
  )!;
  const body = html.childNodes.find(
    (node): node is Element => node.nodeName === "body",
  )!;
  const isDocument =
    document.childNodes.some((node) => node.nodeName === "#documentType") ||
    [html, head, body].some((node) => node.sourceCodeLocation?.startTag);
  if (!isDocument) {
    // A fragment already has a body supplied by atelier. Do not let the full
    // document parser promote its leading styles and scripts into the head.
    head.childNodes = [];
    body.childNodes = parseFragment(body, source, {}).childNodes;
    for (const child of body.childNodes) child.parentNode = body;
  }
  let scriptCount = 0;
  async function embedScripts(
    node: DefaultTreeAdapterMap["node"],
  ): Promise<void> {
    if ("tagName" in node && node.tagName === "script") {
      const src = node.attrs.find((attr) => attr.name === "src");
      if (src && !src.value.startsWith("data:")) {
        if (++scriptCount > 16)
          throw new Error("An artifact may declare at most 16 CDN scripts");
        src.value = await loadCdnScript(
          src.value,
          node.attrs.find((attr) => attr.name === "integrity")?.value,
        );
        node.attrs = node.attrs.filter((attr) => attr.name !== "integrity");
      }
    }
    if ("childNodes" in node)
      for (const child of node.childNodes) await embedScripts(child);
  }
  await embedScripts(html);
  // atelier owns encoding, viewport, and security policy. Keep authored styles,
  // scripts, metadata, and attributes on the single document shell.
  head.childNodes = head.childNodes.filter((node) => {
    if (!("tagName" in node) || node.tagName !== "meta") return true;
    return !node.attrs.some(
      ({ name, value }) =>
        name === "charset" ||
        (name === "name" && value.toLowerCase() === "viewport") ||
        (name === "http-equiv" &&
          ["content-security-policy", "content-type"].includes(
            value.toLowerCase(),
          )),
    );
  });
  const opening = (node: Element) =>
    serializeOuter({ ...node, childNodes: [] }).replace(
      new RegExp(`</${node.tagName}>$`),
      "",
    );
  return {
    htmlOpen: opening(html),
    headOpen: opening(head),
    bodyOpen: opening(body),
    head: serialize(head),
    body: serialize(body),
  };
}
async function bundle(content: Content, entry: string, react = false) {
  const result = await build({
    bundle: true,
    minify: true,
    logLevel: "silent",
    write: false,
    outfile: "artifact.js",
    format: "iife",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    stdin: {
      contents: react
        ? `import React from 'react';import {createRoot} from 'react-dom/client';import App from ${JSON.stringify("./" + entry)};createRoot(document.getElementById('artifact-root')).render(React.createElement(App));`
        : `import ${JSON.stringify("./" + entry)};`,
      sourcefile: "__bootstrap.tsx",
    },
    plugins: [
      {
        name: "artifact-files",
        setup(b) {
          b.onResolve({ filter: /.*/ }, (args) => {
            if (
              args.namespace === "artifact" ||
              args.importer.endsWith("__bootstrap.tsx")
            ) {
              if (args.path.startsWith(".")) {
                const base =
                  args.namespace === "artifact"
                    ? posix.dirname(args.importer)
                    : ".";
                const path = posix.normalize(posix.join(base, args.path));
                const found = [
                  path,
                  path + ".tsx",
                  path + ".ts",
                  path + ".jsx",
                  path + ".js",
                  path + ".css",
                  path + "/index.tsx",
                  path + "/index.ts",
                ].find((p) => Object.hasOwn(content.files, p));
                if (!found)
                  return {
                    errors: [{ text: `Missing artifact file: ${path}` }],
                  };
                return { path: found, namespace: "artifact" };
              }
              const pkg = args.path.startsWith("@")
                ? args.path.split("/").slice(0, 2).join("/")
                : args.path.split("/")[0];
              if (
                !allowed.has(pkg) ||
                args.path.includes("\\") ||
                args.path
                  .split("/")
                  .some((part) => !part || part === "." || part === "..")
              )
                return {
                  errors: [
                    {
                      text: `Unsupported dependency: ${args.path}. Available: ${[...allowed].join(", ")}`,
                    },
                  ],
                };
              return { path: require.resolve(args.path) };
            }
            return undefined;
          });
          // Native bundling can only read installed dependencies. Artifact files
          // are served from memory and checked before compilation.
          b.onLoad({ filter: /.*/, namespace: "file" }, (args) => {
            const path = relative(dependencies, args.path);
            if (
              isAbsolute(path) ||
              path === ".." ||
              path.startsWith("../") ||
              path.startsWith("..\\")
            )
              return {
                errors: [
                  {
                    text: "Filesystem imports outside installed dependencies are blocked",
                  },
                ],
              };
          });
          b.onLoad({ filter: /.*/, namespace: "artifact" }, (args) => {
            const ext = posix.extname(args.path).slice(1);
            if (["js", "jsx", "ts", "tsx"].includes(ext))
              validateImports(content.files[args.path], args.path);
            const loader =
              (
                {
                  tsx: "tsx",
                  ts: "ts",
                  jsx: "jsx",
                  js: "js",
                  json: "json",
                  css: "css",
                  svg: "dataurl",
                } as const
              )[ext as "tsx"] ?? "text";
            return {
              contents: content.files[args.path],
              loader,
            };
          });
        },
      },
    ],
  });
  return {
    js: result.outputFiles.find((f) => f.path.endsWith(".js"))?.text ?? "",
    css: result.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "",
  };
}
// This bridge runs only inside the sandboxed preview, never in the service process.
function bridge(config: {
  id: string;
  revision: number;
  data: unknown;
  snapshot: any;
  standalone: boolean;
  freeze: boolean;
}) {
  const w = window as any;
  let selecting = false;
  let state = config.snapshot?.state ?? null;
  let data = config.data;
  const pending = new Map();
  let seq = 0;
  const emit = (type: string, payload: any = {}) =>
    parent.postMessage({ atelier: true, type, ...payload }, "*");
  const exportRequest = (type: string, value?: unknown) => {
    const requestId = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      emit(type, { requestId, data: value });
    });
  };
  w.atelier = {
    getData: async () =>
      config.standalone && parent !== window
        ? exportRequest("export-get-data")
        : data,
    setData: async (value: any) => {
      data = value;
      if (config.standalone) {
        if (parent !== window) return exportRequest("export-set-data", value);
        try {
          localStorage.setItem("atelier:" + config.id, JSON.stringify(value));
        } catch {}
        return;
      }
      const requestId = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        emit("save-data", { requestId, data: value });
      });
    },
    getState: () => state,
    setState: (value: any) => {
      state = value;
    },
  };
  if (config.standalone) {
    try {
      const saved = localStorage.getItem("atelier:" + config.id);
      if (saved) data = JSON.parse(saved);
    } catch {}
  }
  const path = (el: Element): string => {
    if (el.id) return "#" + CSS.escape(el.id);
    if (el.hasAttribute("data-atelier-id"))
      return (
        '[data-atelier-id="' +
        CSS.escape(el.getAttribute("data-atelier-id")!) +
        '"]'
      );
    const parts = [];
    while (el && el !== document.body) {
      const p: Element | null = el.parentElement;
      if (!p) break;
      parts.unshift(
        el.tagName.toLowerCase() +
          ":nth-child(" +
          (Array.from(p.children).indexOf(el) + 1) +
          ")",
      );
      el = p;
    }
    return "body > " + parts.join(" > ");
  };
  const snapshot = () => ({
    state,
    inputs: Array.from(document.querySelectorAll("input,textarea,select")).map(
      (el: any) => ({
        selector: path(el),
        value: el.value,
        checked: el.checked,
      }),
    ),
    canvases: Array.from(document.querySelectorAll("canvas"))
      .map((el) => {
        try {
          return { selector: path(el), image: el.toDataURL() };
        } catch {
          return null;
        }
      })
      .filter(Boolean),
    scroll: { x: scrollX, y: scrollY },
  });
  addEventListener("message", (event) => {
    if (event.source !== parent || !event.data?.atelier) return;
    const msg = event.data;
    if (msg.type === "selection-mode") {
      selecting = msg.enabled;
      document.documentElement.style.cursor = selecting ? "crosshair" : "";
    }
    if (msg.type === "snapshot")
      emit("snapshot", { requestId: msg.requestId, snapshot: snapshot() });
    if (msg.type === "data-result") {
      const p = pending.get(msg.requestId);
      if (p) {
        msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.data);
        pending.delete(msg.requestId);
      }
    }
    if (msg.type === "locate") {
      let el: Element | null = null;
      try {
        el = document.querySelector(msg.anchor.selector);
      } catch {}
      if (
        (!el || !el.textContent?.includes(msg.anchor.quote)) &&
        msg.anchor.quote
      ) {
        const matches = Array.from(document.querySelectorAll("body *")).filter(
          (node) =>
            !["SCRIPT", "STYLE"].includes(node.tagName) &&
            node.textContent?.includes(msg.anchor.quote) &&
            !Array.from(node.children).some((child) =>
              child.textContent?.includes(msg.anchor.quote),
            ),
        );
        if (matches.length === 1) el = matches[0];
        else el = null;
      }
      if (
        el &&
        (!msg.anchor.quote || el.textContent?.includes(msg.anchor.quote))
      ) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        (el as HTMLElement).style.outline = "2px solid #a36f47";
        setTimeout(() => {
          (el as HTMLElement).style.outline = "";
        }, 2200);
      } else emit("anchor-missing");
    }
  });
  addEventListener("pointerup", (event) => {
    if (!selecting) return;
    const selection = getSelection();
    const quote = selection?.toString().trim() ?? "";
    const common = selection?.rangeCount
      ? selection.getRangeAt(0).commonAncestorContainer
      : null;
    const target = quote
      ? common?.nodeType === 1
        ? (common as Element)
        : common?.parentElement
      : (event.target as Element);
    if (!target || target === document.body) return;
    const text = target.textContent ?? "";
    const offset = quote ? text.indexOf(quote) : 0;
    emit("selection", {
      anchor: {
        quote: (quote || text).slice(0, 5000),
        prefix: text.slice(Math.max(0, offset - 100), offset),
        suffix: text.slice(offset + quote.length, offset + quote.length + 100),
        selector: path(target),
        tag: target.tagName.toLowerCase(),
      },
    });
  });
  // srcdoc inherits the viewer's base URL. Handle local anchors in the
  // artifact itself instead of navigating the frame to the viewer file.
  if (parent !== window)
    addEventListener("click", (event) => {
      if (event.defaultPrevented || !(event.target instanceof Element)) return;
      const link = event.target.closest("a[href]");
      const href = link?.getAttribute("href");
      if (!href?.startsWith("#")) return;
      event.preventDefault();
      try {
        const target = document.getElementById(
          decodeURIComponent(href.slice(1)),
        );
        if (target) target.scrollIntoView();
        else if (href === "#") scrollTo(0, 0);
      } catch {}
    });
  addEventListener("keydown", (e) => {
    if (e.key === "Escape") emit("escape");
  });
  addEventListener("error", (e) =>
    emit("runtime-error", { message: e.message }),
  );
  addEventListener("unhandledrejection", (e) =>
    emit("runtime-error", { message: String(e.reason) }),
  );
  const restore = () => {
    for (const item of config.snapshot?.inputs ?? []) {
      const el: any = document.querySelector(item.selector);
      if (el) {
        const setter = Object.getOwnPropertyDescriptor(
          el.tagName === "TEXTAREA"
            ? HTMLTextAreaElement.prototype
            : el.tagName === "SELECT"
              ? HTMLSelectElement.prototype
              : HTMLInputElement.prototype,
          "value",
        )?.set;
        setter?.call(el, item.value);
        if ("checked" in el) el.checked = item.checked;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    if (config.freeze) {
      for (const item of config.snapshot?.canvases ?? []) {
        const el = document.querySelector(item.selector);
        if (el) {
          const image = new Image();
          image.src = item.image;
          image.style.cssText = (el as HTMLElement).style.cssText;
          image.width = (el as HTMLCanvasElement).width;
          image.height = (el as HTMLCanvasElement).height;
          el.replaceWith(image);
        }
      }
    }
    emit("ready");
  };
  addEventListener("load", () => setTimeout(restore, 150));
}
// Trusted export viewer: keep storage outside the opaque-origin artifact.
function exportDataBridge(config: { id: string; data: unknown }) {
  let data = config.data;
  const key = "atelier:" + config.id;
  try {
    const saved = localStorage.getItem(key);
    if (saved !== null) data = JSON.parse(saved);
  } catch {}
  addEventListener("message", (event) => {
    const frame = document.querySelector("iframe");
    const msg = event.data;
    if (
      !frame ||
      event.source !== frame.contentWindow ||
      !msg?.atelier ||
      !["export-get-data", "export-set-data"].includes(msg.type)
    )
      return;
    let error: string | undefined;
    if (msg.type === "export-set-data") {
      try {
        const json = JSON.stringify(msg.data);
        if (json === undefined || json.length > 2 * 1024 * 1024)
          throw new Error("App data must be JSON within the 2 MiB limit");
        data = JSON.parse(json);
        try {
          localStorage.setItem(key, json);
        } catch {}
      } catch (e) {
        error = e instanceof Error ? e.message : "Could not save app data";
      }
    }
    frame.contentWindow!.postMessage(
      {
        atelier: true,
        type: "data-result",
        requestId: msg.requestId,
        data,
        error,
      },
      "*",
    );
  });
}
export async function render(
  content: Content,
  options: {
    id: string;
    revision: number;
    data?: unknown;
    snapshot?: unknown;
    standalone?: boolean;
    freeze?: boolean;
  },
): Promise<string> {
  let body = "",
    script = "",
    styles = "";
  const source = content.files[content.entry];
  if (content.kind === "react") {
    const out = await bundle(content, content.entry, true);
    body = '<div id="artifact-root"></div>';
    script = out.js;
    styles = out.css;
  } else if (content.kind === "markdown") {
    const math: string[] = [];
    const diagrams: string[] = [];
    const marker = `ATELIERDIAGRAM${randomUUID().replaceAll("-", "")}TOKEN`;
    const markdownParser = new Marked({
      renderer: {
        code(token) {
          if (token.lang?.trim().split(/\s+/)[0] !== "mermaid") return false;
          const index = diagrams.length;
          const { svg } = renderDiagram(token.text, {
            idPrefix: `diagram-${index}`,
            linkSchemes: [],
          });
          diagrams.push(`<figure class="mermaid-diagram">${svg}</figure>`);
          return `${marker}${index}END`;
        },
      },
    });
    // Keep math processing out of fenced/indented code, including Mermaid source.
    const codeBlocks: string[] = [];
    const codeMarker = `ATELIERCODE${randomUUID().replaceAll("-", "")}TOKEN`;
    let prose = source;
    markdownParser.walkTokens(markdownParser.lexer(source), (token) => {
      if (token.type === "code" && prose.includes(token.raw)) {
        const index = codeBlocks.push(token.raw) - 1;
        prose = prose.replace(token.raw, `${codeMarker}${index}END\n`);
      }
    });
    const prepared = prose.replace(
      /\$\$([\s\S]+?)\$\$|\$([^\n$]+?)\$/g,
      (_, block, inline) => {
        const token = `ATELIERMATHTOKEN${math.length}END`;
        math.push(
          katex.renderToString(block ?? inline, {
            displayMode: !!block,
            throwOnError: false,
          }),
        );
        return token;
      },
    );
    const markdown = prepared.replace(
      /!\[([^\]]*)\]\(([^)]+)\)/g,
      (all, alt, path) => {
        const file = content.files[path.replace(/^\.\//, "")];
        if (file === undefined) return all;
        return `![${alt}](${file.startsWith("data:") ? file : "data:image/svg+xml;base64," + Buffer.from(file).toString("base64")})`;
      },
    );
    const restored = markdown.replace(
      new RegExp(`${codeMarker}(\\d+)END\n`, "g"),
      (_, index) => codeBlocks[Number(index)],
    );
    body = sanitize(await markdownParser.parse(restored), {
      allowedTags: sanitize.defaults.allowedTags.concat(["img"]),
      allowedAttributes: {
        ...sanitize.defaults.allowedAttributes,
        img: ["src", "alt", "width", "height"],
      },
      allowedSchemes: ["data"],
    });
    body = body.replace(/ATELIERMATHTOKEN(\d+)END/g, (_, n) => math[Number(n)]);
    body = body.replace(
      new RegExp(`${marker}(\\d+)END`, "g"),
      (_, index) => diagrams[Number(index)],
    );
    body = '<article class="document">' + body + "</article>";
    styles =
      css +
      ".mermaid-diagram{margin:24px 0;overflow:auto}.mermaid-diagram .pele{display:block;max-width:100%;height:auto;margin:auto;--pele-font:system-ui,sans-serif}";
  } else if (content.kind === "svg") {
    body = source;
  } else {
    body = source;
    for (const match of [
      ...body.matchAll(
        /<script\b[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/gi,
      ),
    ]) {
      const file = match[1].replace(/^\.\//, "");
      if (Object.hasOwn(content.files, file)) {
        const out = await bundle(content, file);
        body = body.replace(match[0], "");
        script += "\n" + out.js;
        styles += out.css;
      }
    }
    body = body.replace(/(src|href)=["']([^"']+)["']/g, (all, attr, path) => {
      const file = content.files[path.replace(/^\.\//, "")];
      if (file === undefined) return all;
      const mime = path.endsWith(".css")
        ? "text/css"
        : path.endsWith(".svg")
          ? "image/svg+xml"
          : "text/plain";
      const url = file.startsWith("data:")
        ? file
        : `data:${mime};base64,${Buffer.from(file).toString("base64")}`;
      return `${attr}="${url}"`;
    });
  }
  const document =
    content.kind === "html"
      ? await htmlDocument(body)
      : {
          htmlOpen: "<html>",
          headOpen: "<head>",
          bodyOpen: "<body>",
          head: "",
          body,
        };
  const config = {
    id: options.id,
    revision: options.revision,
    data: options.data ?? null,
    snapshot: options.snapshot ?? null,
    standalone: options.standalone ?? false,
    freeze: options.freeze ?? false,
  };
  const bootstrap = `const __name=(fn)=>fn;(${bridge.toString()})(${escape(JSON.stringify(config))});`;
  const rendered = `<!doctype html>${document.htmlOpen}${document.headOpen}<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${artifactPolicy}"><style>html{color-scheme:light}body{margin:0;color:#292722;font-family:system-ui,sans-serif}*{box-sizing:border-box}.document{max-width:860px;margin:auto;padding:48px;line-height:1.75}.document h1,.document h2,.document h3{line-height:1.2}.document img,svg{max-width:100%}.document pre{padding:20px;background:#f4f3ef;overflow:auto}.document table{border-collapse:collapse;width:100%}.document td,.document th{padding:10px;border:1px solid #ddd;text-align:left}.document blockquote{border-left:3px solid #c8a780;margin:24px 0;padding-left:20px;color:#666}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}.document{padding:0}pre,figure,tr{break-inside:avoid}}${styles.replace(/<\/style/gi, "<\\/style")}</style><script>${bootstrap.replace(/<\/script/gi, "<\\/script")}</script>${document.head}</head>${document.bodyOpen}${document.body}<script>${script.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
  if (!options.standalone || options.freeze) return rendered;
  // A downloaded document needs its own trusted parent. srcdoc permits the
  // initial inline page, while the parent's frame-src blocks later navigation.
  const attribute = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  function findTitle(
    node: DefaultTreeAdapterMap["node"],
  ): DefaultTreeAdapterMap["element"] | undefined {
    if ("tagName" in node && node.tagName === "title") return node;
    if ("childNodes" in node)
      for (const child of node.childNodes) {
        const title = findTitle(child);
        if (title) return title;
      }
  }
  const title = findTitle(parse(rendered));
  function textContent(node: DefaultTreeAdapterMap["node"]): string {
    if ("value" in node) return node.value;
    return "childNodes" in node
      ? node.childNodes.map(textContent).join("")
      : "";
  }
  // SVG titles can contain elements. Never promote serialized artifact markup
  // into the trusted viewer's HTML title (an HTML RCDATA context).
  const titleText = attribute(title ? textContent(title) : "atelier artifact");
  const storage = `const __name=(fn)=>fn;(${exportDataBridge.toString()})(${escape(JSON.stringify({ id: options.id, data: options.data ?? null }))});`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${artifactPolicy}"><title>${titleText}</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style><script>${storage.replace(/<\/script/gi, "<\\/script")}</script></head><body><iframe title="Artifact" sandbox="allow-scripts" srcdoc="${attribute(rendered)}"></iframe></body></html>`;
}
