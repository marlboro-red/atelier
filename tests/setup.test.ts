import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { mcpConfig } from "../src/setup.js";
const exec = promisify(execFile);
test("MCP configuration uses absolute paths and preserves the service port", () => {
  for (const client of ["vscode", "claude-desktop"]) {
    const config = JSON.parse(mcpConfig(client, "http://127.0.0.1:9981"));
    const entry = (config.servers ?? config.mcpServers).atelier;
    assert.equal(entry.command, process.execPath);
    assert.ok(isAbsolute(entry.args[0]));
    assert.equal(entry.args[1], "mcp");
    assert.equal(entry.env.ATELIER_URL, "http://127.0.0.1:9981");
  }
  const toml = mcpConfig("codex", "http://127.0.0.1:9981");
  assert.match(toml, /\[mcp_servers.atelier\]/);
  assert.match(toml, /9981/);
  assert.throws(() => mcpConfig("unknown", "http://127.0.0.1:4310"));
});
test("doctor explains missing service and browser without installing or starting anything", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-doctor-"));
  try {
    await assert.rejects(
      exec(process.execPath, [resolve("bin/atelier.mjs"), "doctor", "--json"], {
        env: {
          ...process.env,
          ATELIER_URL: "http://127.0.0.1:1",
          PLAYWRIGHT_BROWSERS_PATH: dir,
        },
      }),
      (error: any) => {
        const result = JSON.parse(error.stdout);
        assert.equal(result.ok, false);
        assert.match(
          result.checks.find((c: any) => c.name === "service").message,
          /atelier start/,
        );
        assert.match(
          result.checks.find((c: any) => c.name === "browser").message,
          /atelier install-browser/,
        );
        return error.code === 1;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("CLI rejects remote service addresses before sending source", async () => {
  await assert.rejects(
    exec(process.execPath, [resolve("bin/atelier.mjs"), "list"], {
      env: { ...process.env, ATELIER_URL: "https://example.com" },
    }),
    (error: any) => /HTTP loopback origin/.test(error.stderr),
  );
});
