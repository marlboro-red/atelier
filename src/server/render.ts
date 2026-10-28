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
import { assemble } from "./render-document.js";
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
let mathCss: string | undefined;
function katexCss() {
  return (mathCss ??= readFileSync(
    require.resolve("katex/dist/katex.min.css"),
    "utf8",
  )
    // Modern preview browsers support WOFF2; do not embed duplicate WOFF/TTF fallbacks.
    .replace(/src:([^;}]+)/g, (declaration, sources: string) => {
      const woff2 = sources
        .split(",")
        .find((source) => source.includes(".woff2"));
      return woff2 ? "src:" + woff2 : declaration;
    })
    .replace(/url\(([^)]+)\)/g, (_, url: string) => {
      const path = url.replace(/["']/g, "");
      const bytes = readFileSync(require.resolve("katex/dist/" + path));
      return `url(data:font/woff2;base64,${bytes.toString("base64")})`;
    }));
}
async function htmlDocument(source: string, content: Content) {
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
  const localPath = (url: string, base = content.entry) => {
    if (/^(?:[a-z]+:|\/|#)/i.test(url)) return undefined;
    const path = posix.normalize(posix.join(posix.dirname(base), url));
    return Object.hasOwn(content.files, path) ? path : undefined;
  };
  const asset = (
    url: string,
    base = content.entry,
    seen = new Set<string>(),
  ): string => {
    const file = localPath(url, base);
    if (!file) return url;
    if (seen.has(file)) throw new Error(`Circular CSS asset: ${file}`);
    const value = content.files[file];
    if (value.startsWith("data:")) return value;
    const css = file.endsWith(".css");
    const next = new Set([...seen, file]);
    const source = css ? rewriteCss(value, file, next) : value;
    return `data:${css ? "text/css" : file.endsWith(".svg") ? "image/svg+xml" : "text/plain"};base64,${Buffer.from(source).toString("base64")}`;
  };
  const rewriteCss = (
    css: string,
    base: string,
    seen = new Set<string>(),
  ): string =>
    css
      .replace(
        /url\(\s*(["']?)([^)'"\s]+)\1\s*\)/g,
        (_, _quote, url) => `url("${asset(url, base, seen)}")`,
      )
      .replace(
        /(@import\s+)(["'])([^"']+)\2/g,
        (_, prefix, _quote, url) => `${prefix}"${asset(url, base, seen)}"`,
      );
  let scriptCount = 0;
  async function embedAssets(
    node: DefaultTreeAdapterMap["node"],
  ): Promise<void> {
    if ("tagName" in node) {
      if (node.tagName === "script") {
        const src = node.attrs.find((attr) => attr.name === "src");
        if (src && !src.value.startsWith("data:")) {
          const file = localPath(src.value);
          if (file) {
            const out = await bundle(content, file);
            src.value = `data:text/javascript;base64,${Buffer.from(out.js).toString("base64")}`;
            if (out.css) {
              const style = parseFragment(
                `<style>${out.css.replace(/<\/style/gi, "<\\/style")}</style>`,
              ).childNodes[0];
              if ("parentNode" in style) style.parentNode = head;
              head.childNodes.push(style);
            }
          } else {
            if (++scriptCount > 16)
              throw new Error("An artifact may declare at most 16 CDN scripts");
            src.value = await loadCdnScript(
              src.value,
              node.attrs.find((attr) => attr.name === "integrity")?.value,
            );
          }
          node.attrs = node.attrs.filter((attr) => attr.name !== "integrity");
        }
      } else {
        for (const attr of node.attrs) {
          if (["src", "href"].includes(attr.name))
            attr.value = asset(attr.value);
          if (attr.name === "style")
            attr.value = rewriteCss(attr.value, content.entry);
        }
        if (node.tagName === "style")
          for (const child of node.childNodes) {
            if (child.nodeName === "#text")
              (child as DefaultTreeAdapterMap["textNode"]).value = rewriteCss(
                (child as DefaultTreeAdapterMap["textNode"]).value,
                content.entry,
              );
          }
      }
    }
    if ("childNodes" in node)
      for (const child of [...node.childNodes]) await embedAssets(child);
  }
  await embedAssets(html);
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
export async function compile(content: Content) {
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
      (math.length ? katexCss() : "") +
      ".mermaid-diagram{margin:24px 0;overflow:auto}.mermaid-diagram .pele{display:block;max-width:100%;height:auto;margin:auto;--pele-font:system-ui,sans-serif}";
  } else if (content.kind === "svg") {
    body = source;
  } else {
    body = source;
  }
  const document =
    content.kind === "html"
      ? await htmlDocument(body, content)
      : {
          htmlOpen: "<html>",
          headOpen: "<head>",
          bodyOpen: "<body>",
          head: "",
          body,
        };
  return { document, script, styles };
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
  return assemble(await compile(content), options);
}
