import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "../src/server/render.js";
import { templates } from "./fixtures/examples.js";
test("compiles the dashboard and embeds an isolated runtime", async () => {
  const html = await render(templates[0].content, { id: "test", revision: 1 });
  assert.match(html, /artifact-root/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /snapshot/);
  assert.match(html, /const __name=/);
});
test("sanitizes markdown and renders mathematics", async () => {
  const html = await render(
    {
      kind: "markdown",
      entry: "a.md",
      files: { "a.md": '# Title\n<script>alert("bad")</script>\n\n$$x^2$$' },
    },
    { id: "test", revision: 1 },
  );
  assert.match(html, /katex/);
  assert.doesNotMatch(html, /alert\("bad"\)/);
});
test("rejects dependency and filesystem escapes", async () => {
  for (const dependency of [
    "node:fs",
    "../../package.json",
    "https://evil.example/a.js",
  ])
    await assert.rejects(
      () =>
        render(
          {
            kind: "react",
            entry: "App.tsx",
            files: {
              "App.tsx": `import x from '${dependency}';export default function App(){return x}`,
            },
          },
          { id: "test", revision: 1 },
        ),
      /Unsupported dependency|Missing artifact/,
    );
});

test("renders Mermaid fences with Pele while preserving ordinary code and math", async () => {
  const html = await render(
    {
      kind: "markdown",
      entry: "report.md",
      files: {
        "report.md":
          '# Report\n\n```mermaid\nflowchart LR\n A["Cost $5"] --> B[Output]\n```\n\n```js\nconst price = "$5";\n```\n\n$$x^2$$\n\n```mermaid\nsequenceDiagram\n Alice->>Bob: Hello\n```',
      },
    },
    { id: "test", revision: 1 },
  );
  assert.match(html, /class="pele pele-flowchart/);
  assert.match(html, /pele-sequence/);
  assert.match(html, /Cost \$5/);
  assert.match(html, /<pre><code>/);
  assert.match(html, /const price = "\$5"/);
  assert.match(html, /katex/);
  assert.equal(
    (html.match(/<figure class="mermaid-diagram">/g) ?? []).length,
    2,
  );
  assert.doesNotMatch(html, /ATELIER(?:CODE|DIAGRAM)[a-f0-9]+TOKEN/);
});

test("Pele diagram text cannot inject HTML scripts", async () => {
  const html = await render(
    {
      kind: "markdown",
      entry: "report.md",
      files: {
        "report.md":
          '```mermaid\nflowchart LR\n A["<script>alert(1)</script>"] --> B[Safe]\n```',
      },
    },
    { id: "test", revision: 1 },
  );
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /pele-flowchart/);
});
