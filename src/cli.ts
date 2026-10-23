import { Command } from "commander";
import { writeFile } from "node:fs/promises";
import { resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { anchorSchema } from "./shared/schema.js";
import { contentInput, readContentInput, cliContentInput } from "./inputs.js";
const base =
  process.env.ATELIER_URL ??
  `http://127.0.0.1:${process.env.ATELIER_PORT ?? 4310}`;
// Keep API requests on loopback; browser links use the workspace hostname.
const browserAddress = new URL(base);
if (["127.0.0.1", "localhost"].includes(browserAddress.hostname)) {
  browserAddress.hostname = "atelier.localhost";
}
const browserBase = browserAddress.toString().replace(/\/$/, "");
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
  .command("install-browser")
  .description("Install Chromium for PDF export")
  .action(async () => {
    const require = createRequire(import.meta.url);
    const cli = resolve(
      dirname(require.resolve("playwright/package.json")),
      "cli.js",
    );
    const child = spawn(process.execPath, [cli, "install", "chromium"], {
      stdio: "inherit",
    });
    child.on("error", (error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
    child.on("exit", (code) => {
      process.exitCode = code ?? 1;
    });
  });
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
function publishResult(result: any, id = result.id ?? result.artifactId) {
  const { content: _content, ...metadata } = result;
  return { ...metadata, url: `${browserBase}/a/${segment(id)}` };
}
async function mcpContent(args: any) {
  const paths = args.filePaths
    ? Object.values(args.filePaths)
    : args.filePath
      ? [args.filePath]
      : [];
  if (paths.some((path) => typeof path !== "string" || !isAbsolute(path)))
    throw new Error(
      "MCP file paths must be absolute paths accessible to the MCP process",
    );
  return readContentInput(args);
}
const appendFile = (value: string, previous: string[]) => [...previous, value];
program
  .command("create <file>")
  .requiredOption("-t, --title <title>")
  .option("-k, --kind <kind>")
  .option("--entry <name>", "Artifact-relative entry name")
  .option(
    "--file <path-or-mapping>",
    "Include a file; optionally artifact/name=local/path. Repeat for more files.",
    appendFile,
    [],
  )
  .option("--author <author>", "Agent attribution", "Agent")
  .description("Create from a source file or content JSON manifest")
  .action(async (file, options) =>
    print(
      publishResult(
        await request("/artifacts", "POST", {
          title: options.title,
          author: options.author,
          content: await readContentInput(cliContentInput(file, options)),
        }),
      ),
    ),
  );
program
  .command("revise <id> <file>")
  .requiredOption("--base <number>")
  .requiredOption("-m, --message <summary>")
  .option("-k, --kind <kind>")
  .option("--entry <name>", "Artifact-relative entry name")
  .option(
    "--file <path-or-mapping>",
    "Include a file; optionally artifact/name=local/path. Repeat for more files.",
    appendFile,
    [],
  )
  .option("--author <author>", "Agent attribution", "Agent")
  .option("--comments <ids>", "Comma-separated comment IDs addressed")
  .action(async (id, file, options) =>
    print(
      publishResult(
        await request(`/artifacts/${segment(id)}/revisions`, "POST", {
          baseRevision: Number(options.base),
          summary: options.message,
          author: options.author,
          content: await readContentInput(cliContentInput(file, options)),
          commentIds: options.comments?.split(",") ?? [],
        }),
        id,
      ),
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
          'Atelier is an agent-authored artifact service. Humans review, comment, and share; agents create and revise all content. Artifacts are standalone pages filling the space below Atelier\'s thin review header. Do not add workspace headers or sidebars to artifact content. Prefer React or HTML for freely combining text, diagrams, charts, images, controls, and animations in one artifact. There are no mandatory templates or content categories. Return the artifact URL to the user. For large artifacts use filePath or filePaths to read existing local files without repeating their contents in a tool call. Paths are absolute and read on the MCP host. Publish results omit source; use get_artifact to read it. Update existing artifacts using their stable ID and current baseRevision. Read comments before editing. Attribute revisions to your agent and include addressed commentIds. Prefer Pele for Mermaid diagrams: import { mount } from "pele" in React effects and call the returned handle.destroy() on cleanup; theme with --pele-* CSS variables. Markdown mermaid code fences render with Pele automatically. Existing mermaid imports remain supported for compatibility. React imports use curated browser dependencies. HTML may declare script tags from cdnjs.cloudflare.com, cdn.jsdelivr.net/npm/, unpkg.com, cdn.tailwindcss.com, or code.jquery.com. Each CDN script must use an exact version published at least 14 days ago and an explicit JavaScript file (Tailwind uses /VERSION). Atelier verifies the npm publication date and embeds only that script. Unverifiable dates, unversioned URLs, redirects, and runtime network dependencies are rejected or blocked. External stylesheets are limited to Google Fonts; inline and artifact-local CSS work. The React entry must default-export a component. Write HTML as a page fragment with optional style and script tags; Atelier supplies the doctype, html, head, body, security policy, and runtime. Full HTML documents are accepted for compatibility and normalized into that shell. Do not include video. Code runs in an isolated browser, not on the host. window.atelier offers getData/setData for persistent JSON data and getState/setState for export state.',
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
          url: `${browserBase}/a/${id}${revision ? `/revisions/${revision}` : ""}`,
          revision: await request(
            `/artifacts/${segment(id)}/revisions/${revision ?? artifact.head}`,
          ),
        };
      },
    );
    tool(
      "create_artifact",
      "Create a standalone page; freely mix text, diagrams, charts, images, and animation using React or HTML. No templates required. For HTML, supply a page fragment with optional style and script tags; Atelier supplies the document shell. Full documents are also accepted. Available packages: react, react-dom, recharts, d3, lucide-react, pele (preferred for Mermaid syntax), mermaid (legacy compatibility), katex.",
      {
        title: z.string(),
        description: z.string().optional(),
        author: z.string(),
        ...contentInput,
      },
      async (args) => {
        const artifact = await request("/artifacts", "POST", {
          title: args.title,
          description: args.description,
          author: args.author,
          content: await mcpContent(args),
        });
        return publishResult(artifact);
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
        ...contentInput,
        commentIds: z.array(z.string()).optional(),
      },
      async ({ id, ...args }) =>
        publishResult(
          await request(`/artifacts/${segment(id)}/revisions`, "POST", {
            baseRevision: args.baseRevision,
            summary: args.summary,
            author: args.author,
            commentIds: args.commentIds,
            content: await mcpContent(args),
          }),
          id,
        ),
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
      async ({ id, ...args }) =>
        publishResult(
          await request(`/artifacts/${segment(id)}/restore`, "POST", args),
          id,
        ),
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
        return publishResult(artifact);
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
