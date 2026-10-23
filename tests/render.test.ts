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
    "recharts/../../package.json",
    "lucide-react/../../package.json",
    "recharts/../react/package.json",
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

test("normalizes HTML documents without losing attributes, head content, or script text", async () => {
  const html = await render(
    {
      kind: "html",
      entry: "index.html",
      files: {
        "index.html": `<!doctype html><html lang="fr" class="dark"><head><title>Report</title><meta charset="iso-8859-1"><meta name="viewport" content="width=500"><style>body{color:red}</style><script>window.example = "<body>literal</body>";</script></head><body class="report" data-label='a"b'><h1>Hello</h1></body></html>`,
      },
    },
    { id: "test", revision: 1 },
  );
  assert.equal((html.match(/<!doctype/gi) ?? []).length, 1);
  assert.equal((html.match(/<html\b/g) ?? []).length, 1);
  assert.equal((html.match(/<head>/g) ?? []).length, 1);
  assert.match(html, /<html lang="fr" class="dark">/);
  assert.match(html, /<body class="report" data-label="a&quot;b">/);
  assert.match(html, /<title>Report<\/title>/);
  assert.match(html, /window.example = "<body>literal<\/body>"/);
  assert.doesNotMatch(html, /iso-8859-1|width=500/);
  assert.equal((html.match(/name="viewport"/g) ?? []).length, 1);
});
