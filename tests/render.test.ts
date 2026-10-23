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
