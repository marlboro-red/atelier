import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readContentInput, cliContentInput } from "../src/inputs.js";
import { render } from "../src/server/render.js";

test("file maps preserve artifact names, encode images, and compile local imports", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atelier-input-"));
  try {
    await writeFile(
      join(dir, "App.jsx"),
      "import './styles.css';import image from './assets/image.png';export default function App(){return <img src={image} alt='Image'/>}",
    );
    await writeFile(join(dir, "styles.css"), "body{color:teal}");
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    await writeFile(join(dir, "image.png"), image);
    const content = await readContentInput(
      cliContentInput(join(dir, "App.jsx"), {
        file: [
          join(dir, "styles.css"),
          `assets/image.png=${join(dir, "image.png")}`,
        ],
      }),
    );
    assert.equal(content.kind, "react");
    assert.equal(
      content.files["assets/image.png"],
      "data:image/png;base64," + image.toString("base64"),
    );
    assert.match(
      await render(content, { id: "test", revision: 1 }),
      /data:image\/png;base64/,
    );
    await assert.rejects(
      readContentInput({
        filePaths: { "../escape": join(dir, "App.jsx") },
        entry: "../escape",
      }),
    );
    await assert.rejects(
      readContentInput({ filePaths: { "App.jsx": join(dir, "App.jsx") } }),
      /entry is required/,
    );
    await assert.rejects(
      readContentInput({ filePath: join(dir, "missing.html") }),
      /ENOENT/,
    );
    assert.throws(
      () =>
        cliContentInput(join(dir, "App.jsx"), { file: [join(dir, "App.jsx")] }),
      /Duplicate/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("single source files and existing manifests remain supported without inline content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atelier-input-"));
  try {
    const source = "<h1>Large page</h1><!--" + "x".repeat(137 * 1024) + "-->";
    await writeFile(join(dir, "page.html"), source);
    const content = await readContentInput({
      filePath: join(dir, "page.html"),
    });
    assert.equal(content.files["page.html"], source);
    await writeFile(join(dir, "manifest.json"), JSON.stringify(content));
    assert.deepEqual(
      await readContentInput({ filePath: join(dir, "manifest.json") }),
      content,
    );
    await assert.rejects(
      readContentInput({ content, filePath: join(dir, "page.html") }),
      /exactly one/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
