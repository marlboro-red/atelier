import { Command } from "commander";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { contentSchema, anchorSchema } from "./shared/schema.js";
const base =
  process.env.ATELIER_URL ??
  `http://127.0.0.1:${process.env.ATELIER_PORT ?? 4310}`;
async function request(path: string, method = "GET", body?: unknown) {
  const response = await fetch(base + "/api" + path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error((await response.json()).error);
  return response.json();
}
const segment = (value: string) => encodeURIComponent(value);
const print = (data: unknown) => console.log(JSON.stringify(data, null, 2));
const program = new Command()
  .name("atelier")
  .description("A local workspace for artifacts, made with any agent")
  .version("0.1.0");
program
  .command("start")
  .description("Start the workspace and open your browser")
  .option("--no-open", "Do not open a browser")
  .action(async (options) => {
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const child = spawn(
      process.execPath,
      ["--import", "tsx", resolve(root, "src/server/index.ts")],
      { stdio: "inherit", env: process.env, cwd: root },
    );
    child.on("exit", (code) => process.exit(code ?? 0));
    if (options.open) {
      for (let i = 0; i < 30; i++) {
        try {
          await request("/health");
          spawn(
            process.platform === "darwin"
              ? "open"
              : process.platform === "win32"
                ? "explorer"
                : "xdg-open",
            [`http://atelier.localhost:${process.env.ATELIER_PORT ?? 4310}`],
            { stdio: "ignore" },
          ).unref();
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    }
  });
program
  .command("list")
  .description("List artifacts")
  .action(async () => print(await request("/artifacts")));
program
  .command("get <id>")
  .option("-r, --revision <number>")
  .action(async (id, options) => {
    const a = await request("/artifacts/" + segment(id));
    print(
      await request(
        `/artifacts/${segment(id)}/revisions/${options.revision ?? a.head}`,
      ),
    );
  });
async function readContent(file: string, kind?: string) {
  if (file.endsWith(".json"))
    return contentSchema.parse(JSON.parse(await readFile(file, "utf8")));
  const inferred =
    kind ??
    (file.endsWith(".md")
      ? "markdown"
      : file.endsWith(".svg")
        ? "svg"
        : file.endsWith(".html")
          ? "html"
          : "react");
  return contentSchema.parse({
    kind: inferred,
    entry: basename(file),
    files: { [basename(file)]: await readFile(file, "utf8") },
  });
}
program
  .command("create <file>")
  .requiredOption("-t, --title <title>")
  .option("-k, --kind <kind>")
  .option("--author <author>", "Agent attribution", "Agent")
  .description("Create from a source file or content JSON manifest")
  .action(async (file, options) =>
    print(
      await request("/artifacts", "POST", {
        title: options.title,
        author: options.author,
        content: await readContent(file, options.kind),
      }),
    ),
  );
program
  .command("revise <id> <file>")
  .requiredOption("--base <number>")
  .requiredOption("-m, --message <summary>")
  .option("-k, --kind <kind>")
  .option("--author <author>", "Agent attribution", "Agent")
  .option("--comments <ids>", "Comma-separated comment IDs addressed")
  .action(async (id, file, options) =>
    print(
      await request(`/artifacts/${segment(id)}/revisions`, "POST", {
        baseRevision: Number(options.base),
        summary: options.message,
        author: options.author,
        content: await readContent(file, options.kind),
        commentIds: options.comments?.split(",") ?? [],
      }),
    ),
  );
program
  .command("history <id>")
  .action(async (id) =>
    print(await request(`/artifacts/${segment(id)}/revisions`)),
  );
program
  .command("comments <id>")
  .action(async (id) =>
    print(await request(`/artifacts/${segment(id)}/comments`)),
  );
program
  .command("reply <id> <commentId> <message>")
  .option("--author <author>", "Agent attribution", "Agent")
  .option("--status <status>")
  .action(async (id, cid, message, options) =>
    print(
      await request(
        `/artifacts/${segment(id)}/comments/${segment(cid)}`,
        "PATCH",
        { reply: message, author: options.author, status: options.status },
      ),
    ),
  );
program
  .command("export <id>")
  .requiredOption("-f, --format <format>")
  .requiredOption("-o, --output <file>")
  .option("-r, --revision <number>")
  .action(async (id, options) => {
    const a = await request("/artifacts/" + segment(id));
    const response = await fetch(
      `${base}/api/artifacts/${segment(id)}/export`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revision: Number(options.revision ?? a.head),
          format: options.format,
        }),
      },
    );
    if (!response.ok) throw new Error((await response.json()).error);
    await writeFile(options.output, Buffer.from(await response.arrayBuffer()));
    console.log(options.output);
  });
program
  .command("mcp")
  .description(
    "Serve agent tools over stdio; connect to the running local service",
  )
  .action(async () => {
    const server = new McpServer(
      { name: "atelier", version: "0.1.0" },
      {
        instructions:
          "Atelier is an agent-authored artifact service. Humans review, comment, and share; agents create and revise all content. Artifacts are standalone pages filling the browser viewport, without required workspace headers or sidebars. Prefer React or HTML for freely combining text, diagrams, charts, images, controls, and animations in one artifact. There are no mandatory templates or content categories. Return the artifact URL to the user. Update existing artifacts using their stable ID and current baseRevision. Read comments before editing. Attribute revisions to your agent and include addressed commentIds. Use curated browser dependencies only. The React entry must default-export a component. Do not include video. Code runs in an isolated browser, not on the host. window.atelier offers getData/setData for persistent JSON data and getState/setState for export state.",
      },
    );
    const tool = (
      name: string,
      description: string,
      schema: any,
      fn: (args: any) => Promise<unknown>,
    ) =>
      server.registerTool(
        name,
        { description, inputSchema: schema },
        async (args: any) => {
          try {
            return {
              content: [
                { type: "text" as const, text: JSON.stringify(await fn(args)) },
              ],
            };
          } catch (e: any) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: e.message }],
            };
          }
        },
      );
    tool(
      "list_artifacts",
      "List all artifacts and their current revision.",
      {},
      () => request("/artifacts"),
    );
    tool(
      "get_artifact",
      "Read complete artifact files at a revision. Omit revision for latest.",
      { id: z.string(), revision: z.number().int().positive().optional() },
      async ({ id, revision }) => {
        const artifact = await request("/artifacts/" + segment(id));
        return {
          artifact,
          url: `${base}/a/${id}${revision ? `/revisions/${revision}` : ""}`,
          revision: await request(
            `/artifacts/${segment(id)}/revisions/${revision ?? artifact.head}`,
          ),
        };
      },
    );
    tool(
      "create_artifact",
      "Create a standalone page; freely mix text, diagrams, charts, images, and animation using React or HTML. No templates required. Available packages: react, react-dom, recharts, d3, lucide-react, mermaid, katex.",
      {
        title: z.string(),
        description: z.string().optional(),
        author: z.string(),
        content: contentSchema,
      },
      async (args) => {
        const artifact = await request("/artifacts", "POST", args);
        return { ...artifact, url: `${base}/a/${artifact.id}` };
      },
    );
    tool(
      "revise_artifact",
      "Create an immutable revision under the same artifact ID. Conflicts require re-reading and reconciling. Linked comments become ready for user review.",
      {
        id: z.string(),
        baseRevision: z.number().int().positive(),
        summary: z.string(),
        author: z.string(),
        content: contentSchema,
        commentIds: z.array(z.string()).optional(),
      },
      async ({ id, ...args }) => ({
        ...(await request(`/artifacts/${segment(id)}/revisions`, "POST", args)),
        url: `${base}/a/${id}`,
      }),
    );
    tool(
      "restore_artifact",
      "Restore an earlier revision as a new revision, preserving the artifact ID and full history.",
      {
        id: z.string(),
        revision: z.number().int().positive(),
        baseRevision: z.number().int().positive(),
        author: z.string(),
      },
      async ({ id, ...args }) => ({
        ...(await request(`/artifacts/${segment(id)}/restore`, "POST", args)),
        url: `${base}/a/${id}`,
      }),
    );
    tool(
      "duplicate_artifact",
      "Create a separate artifact from a specific revision. Use revise_artifact for amendments to the existing artifact.",
      {
        id: z.string(),
        revision: z.number().int().positive(),
        author: z.string(),
      },
      async ({ id, ...args }) => {
        const artifact = await request(
          `/artifacts/${segment(id)}/duplicate`,
          "POST",
          args,
        );
        return { ...artifact, url: `${base}/a/${artifact.id}` };
      },
    );
    tool(
      "list_revisions",
      "Read revision history and change summaries.",
      { id: z.string() },
      ({ id }) => request(`/artifacts/${segment(id)}/revisions`),
    );
    tool(
      "list_comments",
      "Read feedback, selections, revision references, replies, and statuses.",
      { id: z.string() },
      ({ id }) => request(`/artifacts/${segment(id)}/comments`),
    );
    tool(
      "add_comment",
      "Leave feedback on a specific revision.",
      {
        id: z.string(),
        revision: z.number().int().positive(),
        body: z.string(),
        author: z.string(),
        anchor: anchorSchema.nullable().optional(),
      },
      ({ id, ...args }) =>
        request(`/artifacts/${segment(id)}/comments`, "POST", args),
    );
    tool(
      "reply_to_comment",
      "Reply or mark feedback in progress. Prefer linking commentIds when submitting revisions; let the user resolve the thread.",
      {
        id: z.string(),
        commentId: z.string(),
        reply: z.string().optional(),
        author: z.string(),
        status: z
          .enum(["open", "in_progress", "addressed", "resolved"])
          .optional(),
      },
      ({ id, commentId, ...args }) =>
        request(
          `/artifacts/${segment(id)}/comments/${segment(commentId)}`,
          "PATCH",
          args,
        ),
    );
    await server.connect(new StdioServerTransport());
  });
program.parseAsync().catch((e) => {
  console.error(`Atelier: ${e.message}`);
  process.exitCode = 1;
});
