import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const content = (source: string) => ({
  kind: "html",
  entry: "index.html",
  files: { "index.html": source },
});
test("publishes include runtime checks without changing app data or rolling back failed revisions", async ({
  request,
}) => {
  const response = await request.post("/api/artifacts", {
    data: {
      title: "Checked publish",
      content: content(
        "<h1>Checked</h1><script>atelier.setData({writes:1}).catch(console.error)</script>",
      ),
    },
  });
  expect(response.status()).toBe(201);
  const artifact = await response.json();
  expect(artifact.preview.status).toBe("passed");
  expect(artifact.preview.warnings.join(" ")).toContain(
    "writes were simulated",
  );
  expect(
    (await (await request.get(`/api/artifacts/${artifact.id}/data`)).json())
      .data,
  ).toBeNull();
  const revision = await request.post(
    `/api/artifacts/${artifact.id}/revisions`,
    {
      data: {
        baseRevision: 1,
        summary: "Exercise failure",
        content: content(
          '<h1>Broken</h1><script>throw new Error("publish-check-sentinel")</script>',
        ),
      },
    },
  );
  expect(revision.status()).toBe(201);
  const revised = await revision.json();
  expect(revised.number).toBe(2);
  expect(revised.preview.status).toBe("failed");
  expect(revised.preview.errors.join(" ")).toContain("publish-check-sentinel");
  expect(
    (await (await request.get(`/api/artifacts/${artifact.id}`)).json()).head,
  ).toBe(2);
  const restored = await request.post(`/api/artifacts/${artifact.id}/restore`, {
    data: { revision: 1, baseRevision: 2 },
  });
  expect((await restored.json()).preview.status).toBe("passed");
  const copied = await request.post(`/api/artifacts/${artifact.id}/duplicate`, {
    data: { revision: 1 },
  });
  expect((await copied.json()).preview.status).toBe("passed");
});

test("checks report narrow-layout overflow and return screenshots through MCP and CLI", async ({
  request,
}, testInfo) => {
  const response = await request.post("/api/artifacts", {
    data: {
      title: "Viewport check",
      content: content(
        '<h1>Viewport check</h1><div style="width:600px">Wide content</div>',
      ),
    },
  });
  const artifact = await response.json();
  expect(artifact.preview.status).toBe("passed");
  const client = new Client({ name: "preview-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("bin/atelier.mjs"), "mcp"],
    env: { ...process.env, ATELIER_URL: "http://127.0.0.1:14310" } as Record<
      string,
      string
    >,
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "check_artifact",
      arguments: { id: artifact.id, width: 390, height: 844, screenshot: true },
    });
    expect(result.isError).not.toBe(true);
    const blocks = result.content as any[];
    const report = JSON.parse(
      blocks.find((block) => block.type === "text").text,
    );
    expect(report.status).toBe("passed");
    expect(report.viewport).toEqual({ width: 390, height: 844 });
    expect(report.warnings.join(" ")).toContain("overflows");
    const image = blocks.find((block) => block.type === "image");
    expect(image.mimeType).toBe("image/png");
    expect(Buffer.from(image.data, "base64").subarray(1, 4).toString()).toBe(
      "PNG",
    );
    expect(report.screenshot).toBeUndefined();
  } finally {
    await client.close();
  }
  const path = testInfo.outputPath("check.png");
  const cli = await promisify(execFile)(
    process.execPath,
    [
      resolve("bin/atelier.mjs"),
      "check",
      artifact.id,
      "--width",
      "390",
      "--screenshot",
      path,
    ],
    { env: { ...process.env, ATELIER_URL: "http://127.0.0.1:14310" } },
  );
  const report = JSON.parse(cli.stdout);
  expect(report.status).toBe("passed");
  expect(report.screenshot).toBe(path);
  expect((await readFile(path)).subarray(1, 4).toString()).toBe("PNG");
});
