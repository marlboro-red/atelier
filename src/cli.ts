import { serveMcp } from "./mcp.js";
import { Command } from "commander";
import { creatorBridge, CreatorFeedback } from "./agents/creator.js";
import { nativeAgentEnvironment } from "./agents/rpc.js";
import { connectCodexSession } from "./agents/codex-queue.js";
import { createAdapter, type Adapter } from "./agents/adapters.js";
import {
  feedbackRequest,
  terminalApproval,
  watchFeedback,
} from "./agents/watch.js";
import { doctor, mcpConfig } from "./setup.js";
import { writeFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { z } from "zod";
import { readContentInput, cliContentInput } from "./inputs.js";
const configuredBase =
  process.env.ATELIER_URL ??
  `http://127.0.0.1:${process.env.ATELIER_PORT ?? 4310}`;
const apiAddress = new URL(configuredBase);
if (
  apiAddress.protocol !== "http:" ||
  !["localhost", "127.0.0.1", "atelier.localhost"].includes(
    apiAddress.hostname,
  ) ||
  apiAddress.username ||
  apiAddress.password ||
  apiAddress.pathname !== "/" ||
  apiAddress.search ||
  apiAddress.hash
)
  throw new Error(
    "ATELIER_URL must be an HTTP loopback origin, such as http://127.0.0.1:4310",
  );
const base = apiAddress.origin;
// Keep API requests on loopback; browser links use the workspace hostname.
const browserAddress = new URL(base);
if (["127.0.0.1", "localhost"].includes(browserAddress.hostname)) {
  browserAddress.hostname = "atelier.localhost";
}
const browserBase = browserAddress.toString().replace(/\/$/, "");
async function request(path: string, method = "GET", body?: unknown) {
  let response: Response;
  try {
    response = await fetch(base + "/api" + path, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(75000),
      headers: { "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError")
      throw new Error(
        "The service timed out. Read the artifact list or current revision before retrying a publish; it may already be saved.",
      );
    throw new Error(
      `Cannot reach atelier at ${base}. Run atelier start, keep it running, then use atelier doctor to check the connection.`,
    );
  }
  let result: any;
  try {
    result = await response.json();
  } catch {
    throw new Error(
      `Expected JSON from ${base}, received HTTP ${response.status}. Check ATELIER_URL and run atelier doctor.`,
    );
  }
  if (!response.ok)
    throw new Error(result.error ?? `atelier returned HTTP ${response.status}`);
  return result;
}
const segment = (value: string) => encodeURIComponent(value);
const print = (data: unknown) => console.log(JSON.stringify(data, null, 2));
const program = new Command()
  .name("atelier")
  .description("A local workspace for artifacts, made with any agent")
  .version("0.1.0");
program
  .command("doctor")
  .description(
    "Check Node, the workspace build, the running service, and Chromium",
  )
  .option("--json", "Print machine-readable checks")
  .action(async (options) => {
    const report = await doctor(base);
    if (options.json) print(report);
    else
      for (const check of report.checks)
        console.log(
          `${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.message}`,
        );
    if (!report.ok) process.exitCode = 1;
  });
program
  .command("mcp-config <client>")
  .description(
    "Print configuration for codex, claude-desktop, or vscode using absolute paths",
  )
  .action((client) => console.log(mcpConfig(client, base)));
program
  .command("install-browser")
  .description("Install Chromium for preview checks and PDF export")
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
    const port = process.env.ATELIER_PORT ?? "4310";
    const url = `http://atelier.localhost:${port}`;
    const open = () =>
      spawn(
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "explorer"
            : "xdg-open",
        [url],
        { stdio: "ignore" },
      )
        .on("error", () => console.error(`Open ${url} in your browser.`))
        .unref();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(2000),
        redirect: "error",
      });
      if (response.ok && (await response.json()).service === "atelier") {
        console.log(`atelier is already running at ${url}`);
        if (options.open) open();
        return;
      }
    } catch {}
    if (!existsSync(resolve(root, "dist/web/index.html")))
      throw new Error(
        "The browser app is not built. Run npm install from the atelier directory.",
      );
    const child = spawn(
      process.execPath,
      ["--import", "tsx", resolve(root, "src/server/index.ts")],
      { stdio: "inherit", env: process.env, cwd: root },
    );
    child.on("error", (error) => {
      console.error(`Could not start atelier: ${error.message}`);
      process.exitCode = 1;
    });
    child.on("exit", (code) => process.exit(code ?? 0));
    if (options.open) {
      for (let i = 0; i < 30; i++) {
        try {
          await request("/health");
          open();
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    }
  });
program
  .command("list")
  .description("List artifacts (up to 200 per page)")
  .option("--search <text>")
  .option(
    "--cursor <cursor>",
    "Continue after UPDATED_AT|ID from the last result",
  )
  .action(async (options) =>
    print(
      await request(
        "/artifacts?" +
          new URLSearchParams(
            Object.entries(options).filter(
              ([, value]) => typeof value === "string",
            ) as [string, string][],
          ),
      ),
    ),
  );
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
  .option(
    "--no-watch",
    "Do not connect feedback to the creating Codex conversation",
  )
  .action(async (file, options) => {
    const artifact = await request("/artifacts", "POST", {
      title: options.title,
      author: options.author,
      content: await readContentInput(cliContentInput(file, options)),
    });
    const result: any = publishResult(artifact);
    const session = z.string().uuid().safeParse(process.env.CODEX_THREAD_ID);
    if (options.watch && session.success) {
      try {
        await request(
          `/artifacts/${segment(artifact.id)}/feedback/codex`,
          "POST",
          { session: session.data },
        );
        result.feedback = { connected: true, target: "creating_session" };
      } catch (error) {
        result.feedback = { connected: false, reason: String(error) };
      }
    }
    print(result);
  });
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
  .command("check <id>")
  .description(
    "Load the workspace preview in Chromium and report runtime errors",
  )
  .option("-r, --revision <number>")
  .option("--width <pixels>", "Viewport width", "1280")
  .option("--height <pixels>", "Viewport height", "900")
  .option("--screenshot <file>", "Save a PNG of the checked workspace")
  .action(async (id, options) => {
    const report = await request(`/artifacts/${segment(id)}/check`, "POST", {
      revision: options.revision ? Number(options.revision) : undefined,
      width: Number(options.width),
      height: Number(options.height),
      screenshot: !!options.screenshot,
    });
    if (report.screenshot) {
      await writeFile(
        options.screenshot,
        Buffer.from(report.screenshot.data, "base64"),
      );
      report.screenshot = resolve(options.screenshot);
    }
    print(report);
  });
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
  .command("agent [prompt]")
  .description(
    "Create artifacts with an agent and automatically send feedback to the same session",
  )
  .requiredOption("--agent <provider>", "claude, codex, or copilot")
  .requiredOption("--cwd <directory>", "Working directory for the agent")
  .action(async (prompt, options) => {
    const provider = z
      .enum(["claude", "codex", "copilot"])
      .parse(options.agent);
    const cwd = await realpath(resolve(options.cwd));
    const entry = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../bin/atelier.mjs",
    );
    await request("/health");
    if (provider === "claude") {
      const child = spawn(
        "claude",
        [
          "--mcp-config",
          JSON.stringify({
            mcpServers: {
              atelier: {
                command: process.execPath,
                args: [entry, "mcp", "--claude-channel"],
                env: { ATELIER_URL: base },
              },
            },
          }),
          "--dangerously-load-development-channels",
          "server:atelier",
          ...(prompt ? [prompt] : []),
        ],
        { cwd, env: nativeAgentEnvironment(), stdio: "inherit", shell: false },
      );
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => {
          process.exitCode = code ?? 1;
          resolve();
        });
      });
      return;
    }
    if (!prompt?.trim())
      throw new Error(
        "Provide a creation request: atelier agent 'Make a tide chart' --agent " +
          provider +
          " --cwd .",
      );
    const control = new AbortController();
    const stop = () => control.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    let state = "connected";
    const log = (text: string) =>
      process.stderr.write(text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""));
    let feedback: CreatorFeedback | undefined;
    let adapter: Adapter | undefined;
    const bridge = await creatorBridge(async (id) => {
      if (!feedback) throw new Error("Creator session is not ready");
      await feedback.add(id);
    });
    try {
      adapter = await createAdapter({
        provider,
        cwd,
        base,
        creator: { config: bridge.config },
        approve: terminalApproval((value) => {
          state = value;
        }, control.signal),
        log,
      });
      control.signal.addEventListener("abort", () => adapter?.close(), {
        once: true,
      });
      if (control.signal.aborted) return;
      feedback = new CreatorFeedback({
        adapter,
        provider,
        request: feedbackRequest(base),
        state: () => state,
        log,
      });
      log(
        `Creating with ${provider} session ${adapter.sessionId}. Keep this terminal open for comments.\n`,
      );
      await feedback.send(prompt);
      log("\nReady for feedback in atelier. Ctrl+C ends this session.\n");
      await Promise.race([
        new Promise<void>((resolve) => {
          if (control.signal.aborted) resolve();
          else
            control.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
        }),
        adapter.closed?.then((error) => {
          throw error;
        }) ?? new Promise(() => {}),
      ]);
    } catch (error) {
      if (!control.signal.aborted) throw error;
    } finally {
      control.abort();
      await feedback?.close();
      adapter?.close();
      await bridge.close();
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  });
program
  .command("connect <id>")
  .description(
    "Connect feedback to the Codex conversation running this command",
  )
  .action(async (id) => {
    const session = z.string().uuid().safeParse(process.env.CODEX_THREAD_ID);
    if (!session.success)
      throw new Error(
        "Run this command from your Codex agent, or choose a conversation under Comments → Connect an agent in atelier.",
      );
    print(
      await request(`/artifacts/${segment(id)}/feedback/codex`, "POST", {
        session: session.data,
      }),
    );
  });
program
  .command("watch <id>")
  .description(
    "Connect an artifact to Claude Code, Codex, or Copilot until interrupted",
  )
  .requiredOption("--agent <provider>", "claude, codex, or copilot")
  .requiredOption("--cwd <directory>", "Working directory for the agent")
  .option(
    "--session <id>",
    "Existing session UUID; Codex stays open, other providers resume it",
  )
  .option(
    "--new-session",
    "Explicitly start a new Codex session instead of connecting",
  )
  .option("--codex-socket <path>", "Custom local Codex app-server socket")
  .action(async (id, options) => {
    const provider = z
      .enum(["claude", "codex", "copilot"])
      .parse(options.agent);
    if (options.newSession && options.session)
      throw new Error("Choose --session or --new-session, not both");
    if (provider !== "codex" && (options.newSession || options.codexSocket))
      throw new Error("--new-session and --codex-socket apply to Codex only");
    if (provider === "codex" && !options.session && !options.newSession)
      throw new Error(
        "Codex watch requires --session SESSION_ID to connect to your open conversation. To intentionally start a separate conversation, pass --new-session.",
      );
    if (options.newSession && options.codexSocket)
      throw new Error(
        "--codex-socket connects to an existing session; it cannot be used with --new-session",
      );
    const api = feedbackRequest(base);
    await api(`/artifacts/${segment(id)}`);
    if (provider === "claude") {
      const entry = resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../bin/atelier.mjs",
      );
      const config = {
        mcpServers: {
          atelier: {
            command: process.execPath,
            args: [entry, "mcp", "--artifact", id, "--claude-channel"],
            env: { ATELIER_URL: base },
          },
        },
      };
      const child = spawn(
        "claude",
        [
          "--mcp-config",
          JSON.stringify(config),
          "--dangerously-load-development-channels",
          "server:atelier",
          ...(options.session ? ["--resume", options.session] : []),
        ],
        {
          cwd: resolve(options.cwd),
          env: nativeAgentEnvironment(),
          stdio: "inherit",
          shell: false,
        },
      );
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => {
          process.exitCode = code ?? 1;
          resolve();
        });
      });
      return;
    }
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    let state = "connected";
    const log = (text: string) =>
      process.stderr.write(text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""));
    let adapter: Adapter | undefined;
    try {
      adapter =
        provider === "codex" && options.session
          ? await connectCodexSession({
              session: options.session,
              cwd: resolve(options.cwd),
              socket: options.codexSocket,
            })
          : await createAdapter({
              provider,
              artifact: id,
              cwd: resolve(options.cwd),
              base,
              session: options.session,
              approve: terminalApproval((value) => {
                state = value;
              }, controller.signal),
              log,
            });
      const close = adapter.close;
      adapter.close = () => {
        controller.abort();
        close();
      };
      await watchFeedback({
        id,
        provider,
        adapter,
        request: api,
        signal: controller.signal,
        state: () => state,
        log,
      });
    } finally {
      adapter?.close();
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  });
program
  .command("mcp")
  .option("--artifact <id>", "Restrict tools to one artifact")
  .option(
    "--claude-channel",
    "Deliver comments through an opted-in Claude Code channel",
  )
  .option(
    "--creator-bridge <config>",
    "Private connection to an atelier agent session",
  )
  .option("--no-watch", "Do not automatically connect newly created artifacts")
  .description(
    "Serve agent tools over stdio; connect to the running local service",
  )
  .action((options) =>
    serveMcp(options, {
      base,
      browserBase,
      request,
      publishResult,
      mcpContent,
    }),
  );
program.parseAsync().catch((e) => {
  console.error(`atelier: ${e.message}`);
  process.exitCode = 1;
});
