import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createAdapter } from "../src/agents/adapters.js";
import type { AgentRpc } from "../src/agents/rpc.js";
class FakeRpc extends EventEmitter {
  calls: { method: string; params: any }[] = [];
  onRequest: (method: string, params: any) => Promise<any> = async () => ({});
  closed = false;
  notify(method: string, params: any) {
    this.calls.push({ method, params });
  }
  async request(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === "initialize")
      return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
    if (method === "thread/start" || method === "thread/resume")
      return { thread: { id: "thread" } };
    if (method === "session/new" || method === "session/load")
      return { sessionId: "session" };
    if (method === "turn/start") {
      queueMicrotask(() =>
        this.emit("notification", "turn/completed", {
          threadId: "thread",
          turn: { status: "completed" },
        }),
      );
      return { turn: { id: "turn" } };
    }
    if (method === "session/prompt") return { stopReason: "end_turn" };
  }
  close() {
    this.closed = true;
  }
}
for (const provider of ["codex", "copilot"] as const)
  test(`${provider} adapter configures a scoped MCP and handles permissions without blanket approval`, async () => {
    const rpc = new FakeRpc();
    let approvals = 0;
    let spawnArgs: string[] = [];
    const adapter = await createAdapter(
      {
        provider,
        artifact: "artifact-1",
        base: "http://127.0.0.1:4310",
        cwd: "/tmp",
        approve: async () => {
          approvals++;
          return false;
        },
        log: () => {},
      },
      (_command, args) => {
        spawnArgs = args;
        return rpc as unknown as AgentRpc;
      },
    );
    try {
      await adapter.send("Handle the comment");
      if (provider === "codex") {
        const config = rpc.calls.find(
          (c) => c.method === "thread/start",
        )!.params;
        assert.equal(config.approvalPolicy, "untrusted");
        assert.equal(config.sandbox, "read-only");
        assert.ok(
          config.config["mcp_servers.atelier"].args.includes("artifact-1"),
        );
        assert.deepEqual(
          await rpc.onRequest("mcpServer/elicitation/request", {
            serverName: "atelier",
            mode: "form",
            requestedSchema: { properties: {} },
            _meta: {
              codex_approval_kind: "mcp_tool_call",
              tool_params: { id: "artifact-1" },
            },
          }),
          { action: "accept", content: {} },
        );
        assert.equal(approvals, 0);
        assert.deepEqual(
          await rpc.onRequest("item/commandExecution/requestApproval", {
            command: "rm file",
          }),
          { decision: "decline" },
        );
        assert.equal(
          (
            await rpc.onRequest("mcpServer/elicitation/request", {
              serverName: "other",
              mode: "form",
              requestedSchema: { properties: {} },
              _meta: {
                codex_approval_kind: "mcp_tool_call",
                tool_params: { id: "artifact-1" },
              },
            })
          ).action,
          "decline",
        );
      } else {
        assert.ok(spawnArgs.includes("--additional-mcp-config"));
        assert.ok(spawnArgs.includes("--allow-tool=atelier"));
        assert.ok(!spawnArgs.includes("--allow-all-tools"));
        assert.deepEqual(
          await rpc.onRequest("session/request_permission", {
            toolCall: { title: "Shell" },
            options: [
              { kind: "allow_once", optionId: "once" },
              { kind: "allow_always", optionId: "always" },
            ],
          }),
          { outcome: { outcome: "cancelled" } },
        );
      }
    } finally {
      adapter.close();
      assert.ok(rpc.closed);
    }
  });

test("managed agent subprocesses cannot inherit the launching Codex conversation identity", async () => {
  const { AgentRpc } = await import("../src/agents/rpc.js");
  const prior = process.env.CODEX_THREAD_ID;
  process.env.CODEX_THREAD_ID = "launching-thread";
  const rpc = new AgentRpc(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    process.stdin.once('data', raw => { const m = JSON.parse(raw); process.stdout.write(JSON.stringify({ id: m.id, result: { inherited: Boolean(process.env.CODEX_THREAD_ID) } }) + '\\n'); });
  `,
    ],
    process.cwd(),
  );
  if (prior === undefined) delete process.env.CODEX_THREAD_ID;
  else process.env.CODEX_THREAD_ID = prior;
  try {
    assert.equal((await rpc.request("check", {})).inherited, false);
  } finally {
    rpc.close();
  }
});
