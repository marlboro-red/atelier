import { test } from "node:test";
import assert from "node:assert/strict";
import { validateImports } from "../src/server/imports.js";
test("computed imports are rejected by syntax, including comments, templates, and parenthesized require", () => {
  for (const source of [
    "import /* comment */ ('./' + name + '.json')",
    "import(`./${name}.json`)",
    "(require)('./' + name)",
    "require?.('./' + name)",
    "import(name)",
  ])
    assert.throws(() => validateImports(source, "App.js"), /Computed imports/);
  for (const source of [
    "import('./data.json')",
    "import(`./data.json`)",
    "const text = \"import('./' + name)\"; // require(name)",
    "export default function App(){return <h1>hello</h1>}",
  ])
    assert.doesNotThrow(() => validateImports(source, "App.jsx"));
});
