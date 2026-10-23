import { build } from "esbuild";
import { posix } from "node:path";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { Marked } from "marked";
import { render as renderDiagram } from "pele";
import { randomUUID } from "node:crypto";
import sanitize from "sanitize-html";
import katex from "katex";
import type { Content } from "../shared/schema.js";
const require = createRequire(import.meta.url);
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
        ? `import React from 'react';import {createRoot} from 'react-dom/client';import App from './${entry}';createRoot(document.getElementById('artifact-root')).render(React.createElement(App));`
        : `import './${entry}';`,
      resolveDir: process.cwd(),
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
              if (!allowed.has(pkg))
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
          b.onLoad({ filter: /.*/, namespace: "artifact" }, (args) => {
            const ext = posix.extname(args.path).slice(1);
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
              resolveDir: process.cwd(),
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
  w.atelier = {
    getData: async () => data,
    setData: async (value: any) => {
      data = value;
      if (config.standalone) {
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
        msg.error ? p.reject(new Error(msg.error)) : p.resolve();
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
  const config = {
    id: options.id,
    revision: options.revision,
    data: options.data ?? null,
    snapshot: options.snapshot ?? null,
    standalone: options.standalone ?? false,
    freeze: options.freeze ?? false,
  };
  const bootstrap = `const __name=(fn)=>fn;(${bridge.toString()})(${escape(JSON.stringify(config))});`;
  const policy =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' data: https://fonts.googleapis.com; img-src data: blob:; font-src data: https://fonts.gstatic.com; connect-src 'none'; media-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${policy}"><style>html{color-scheme:light}body{margin:0;color:#292722;font-family:system-ui,sans-serif}*{box-sizing:border-box}.document{max-width:860px;margin:auto;padding:48px;line-height:1.75}.document h1,.document h2,.document h3{line-height:1.2}.document img,svg{max-width:100%}.document pre{padding:20px;background:#f4f3ef;overflow:auto}.document table{border-collapse:collapse;width:100%}.document td,.document th{padding:10px;border:1px solid #ddd;text-align:left}.document blockquote{border-left:3px solid #c8a780;margin:24px 0;padding-left:20px;color:#666}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}.document{padding:0}pre,figure,tr{break-inside:avoid}}${styles.replace(/<\/style/gi, "<\\/style")}</style><script>${bootstrap.replace(/<\/script/gi, "<\\/script")}</script></head><body>${body}<script>${script.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
}
