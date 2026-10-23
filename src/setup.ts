import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function mcpConfig(client: string, base: string) {
  const entry = {
    command: process.execPath,
    args: [resolve(root, "bin/atelier.mjs"), "mcp"],
    env: { ATELIER_URL: base },
  };
  if (client === "codex")
    return `[mcp_servers.atelier]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\n\n[mcp_servers.atelier.env]\nATELIER_URL = ${JSON.stringify(base)}\n`;
  if (client === "claude-desktop")
    return JSON.stringify({ mcpServers: { atelier: entry } }, null, 2);
  if (client === "vscode")
    return JSON.stringify(
      { servers: { atelier: { type: "stdio", ...entry } } },
      null,
      2,
    );
  throw new Error("Choose codex, claude-desktop, or vscode");
}
export async function doctor(base: string) {
  const checks: { name: string; ok: boolean; message: string }[] = [];
  const [major, minor] = process.versions.node.split(".").map(Number);
  checks.push({
    name: "node",
    ok: major > 22 || (major === 22 && minor >= 13),
    message: `Node ${process.versions.node}; requires 22.13 or later`,
  });
  const built = existsSync(resolve(root, "dist/web/index.html"));
  checks.push({
    name: "workspace",
    ok: built,
    message: built
      ? "Browser app is built"
      : "Run npm install from the atelier directory",
  });
  try {
    const response = await fetch(`${base}/api/health`, {
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
    const health = await response.json();
    const ok =
      response.ok && health.ok === true && health.service === "atelier";
    checks.push({
      name: "service",
      ok,
      message: ok
        ? `atelier ${health.version} is running at ${base}`
        : `Unexpected service response at ${base}. Restart atelier and check ATELIER_URL.`,
    });
  } catch {
    checks.push({
      name: "service",
      ok: false,
      message: `Cannot reach ${base}. Run atelier start in another terminal and keep it open.`,
    });
  }
  try {
    const browser = await chromium.launch({ headless: true, timeout: 5000 });
    await browser.close();
    checks.push({ name: "browser", ok: true, message: "Chromium can start" });
  } catch {
    checks.push({
      name: "browser",
      ok: false,
      message:
        "Chromium cannot start. Run atelier install-browser. On Linux, check Playwright's system dependency requirements.",
    });
  }
  return { ok: checks.every((c) => c.ok), checks };
}
