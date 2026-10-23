import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/server/store.js";
import { contentSchema } from "../src/shared/schema.js";
const content = {
  kind: "markdown" as const,
  entry: "index.md",
  files: { "index.md": "# Hello" },
};
test("stable identity, immutable revisions, conflicts, comments, and persistence", () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-"));
  let s = new Store(dir);
  try {
    const a = s.create({
      title: "Hello",
      description: "",
      author: "Test",
      summary: "Create",
      content,
    });
    const c = s.addComment(a.id, {
      revision: 1,
      body: "Change heading",
      author: "You",
      anchor: null,
    });
    s.update(a.id, {
      baseRevision: 1,
      author: "Agent",
      summary: "Change",
      content: { ...content, files: { "index.md": "# Updated" } },
      commentIds: [c.id],
    });
    assert.equal(s.get(a.id).head, 2);
    assert.equal(s.revision(a.id, 1).content.files["index.md"], "# Hello");
    assert.equal(s.comment(a.id, c.id).status, "addressed");
    assert.throws(
      () =>
        s.update(a.id, {
          baseRevision: 1,
          author: "Agent",
          summary: "Stale",
          content,
          commentIds: [],
        }),
      /conflict/,
    );
    assert.equal(s.revisions(a.id).length, 2);
    assert.throws(
      () =>
        s.update(a.id, {
          baseRevision: 2,
          author: "Agent",
          summary: "Invalid link",
          content,
          commentIds: ["missing"],
        }),
      /not found/,
    );
    assert.equal(s.get(a.id).head, 2);
    s.setData(a.id, { count: 3 });
    s.close();
    s = new Store(dir);
    assert.deepEqual(s.data(a.id), { count: 3 });
    assert.equal(s.revisions(a.id).length, 2);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("rejects traversal and absent entries", () => {
  assert.equal(
    contentSchema.safeParse({ ...content, entry: "../secret" }).success,
    false,
  );
  assert.equal(
    contentSchema.safeParse({ ...content, entry: "absent.md" }).success,
    false,
  );
});
