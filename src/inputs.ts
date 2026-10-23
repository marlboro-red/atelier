import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { z } from "zod";
import { contentSchema, kinds, type Content } from "./shared/schema.js";

export const contentInput = {
  content: contentSchema
    .optional()
    .describe(
      "Inline content. Use exactly one of content, filePath, or filePaths.",
    ),
  filePath: z
    .string()
    .optional()
    .describe(
      "Absolute local path to one source file or an existing content JSON manifest. Read by the MCP process, not the HTTP service.",
    ),
  filePaths: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'Map of artifact-relative names to absolute local file paths, e.g. {"App.jsx":"/work/App.jsx","styles.css":"/work/styles.css"}. Include entry.',
    ),
  entry: z
    .string()
    .optional()
    .describe(
      "Artifact-relative entry name; required with filePaths. Defaults to the file's basename with filePath.",
    ),
  kind: z
    .enum(kinds)
    .optional()
    .describe("Format; inferred from the entry extension when omitted."),
};
type Input = {
  content?: Content;
  filePath?: string;
  filePaths?: Record<string, string>;
  entry?: string;
  kind?: Content["kind"];
};
const limit = 30 * 1024 * 1024;
const binaryTypes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};
function infer(entry: string): Content["kind"] {
  const ext = extname(entry).toLowerCase();
  return ext === ".md"
    ? "markdown"
    : ext === ".svg"
      ? "svg"
      : [".html", ".htm"].includes(ext)
        ? "html"
        : "react";
}
async function bytes(path: string) {
  const info = await stat(path);
  if (!info.isFile() || info.size > limit)
    throw new Error(
      `Input must be a regular file no larger than 30 MiB: ${path}`,
    );
  const data = await readFile(path);
  if (data.length > limit) throw new Error(`Input exceeds 30 MiB: ${path}`);
  return data;
}
export async function readContentInput(input: Input): Promise<Content> {
  if (
    [input.content, input.filePath, input.filePaths].filter(
      (value) => value !== undefined,
    ).length !== 1
  )
    throw new Error("Provide exactly one of content, filePath, or filePaths");
  if (input.content) {
    if (input.entry || input.kind)
      throw new Error(
        "Put entry and kind inside content when using inline content",
      );
    return contentSchema.parse(input.content);
  }
  if (
    input.filePath?.toLowerCase().endsWith(".json") &&
    !input.entry &&
    !input.kind
  )
    return contentSchema.parse(
      JSON.parse((await bytes(input.filePath)).toString("utf8")),
    );
  const entry =
    input.entry ?? (input.filePath ? basename(input.filePath) : undefined);
  if (!entry) throw new Error("entry is required with filePaths");
  const paths = input.filePaths ?? { [entry]: input.filePath! };
  // Validate names, count, and entry before reading any files.
  const content = contentSchema.parse({
    kind: input.kind ?? infer(entry),
    entry,
    files: Object.fromEntries(Object.keys(paths).map((name) => [name, ""])),
  });
  let size = 0;
  for (const [name, path] of Object.entries(paths)) {
    const data = await bytes(path);
    const mime = binaryTypes[extname(path).toLowerCase()];
    const value = mime
      ? `data:${mime};base64,${data.toString("base64")}`
      : data.toString("utf8");
    size +=
      Buffer.byteLength(JSON.stringify(name)) +
      Buffer.byteLength(JSON.stringify(value));
    if (size > limit) throw new Error("Combined artifact input exceeds 30 MiB");
    content.files[name] = value;
  }
  return content;
}
export function cliContentInput(
  file: string,
  options: { kind?: Content["kind"]; entry?: string; file?: string[] },
): Input {
  if (!options.file?.length)
    return {
      filePath: resolve(file),
      entry: options.entry,
      kind: options.kind,
    };
  const entry = options.entry ?? basename(file);
  const paths: Record<string, string> = { [entry]: resolve(file) };
  for (const extra of options.file) {
    const equals = extra.indexOf("=");
    const path = resolve(equals < 0 ? extra : extra.slice(equals + 1));
    const name =
      equals < 0
        ? relative(dirname(resolve(file)), path)
            .split("\\")
            .join("/")
        : extra.slice(0, equals);
    if (Object.hasOwn(paths, name))
      throw new Error(`Duplicate artifact file: ${name}`);
    paths[name] = path;
  }
  return { filePaths: paths, entry, kind: options.kind };
}
