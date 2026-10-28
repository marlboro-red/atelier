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

test("rename preserves identity and history; delete atomically removes owned data and rejects stale heads", () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-manage-"));
  const store = new Store(dir);
  try {
    const artifact = store.create({
      title: "Original",
      description: "",
      author: "Test",
      summary: "Create",
      content,
    });
    const other = store.create({
      title: "Keep",
      description: "",
      author: "Test",
      summary: "Create",
      content,
    });
    store.addComment(artifact.id, {
      revision: 1,
      body: "Feedback",
      author: "User",
      anchor: null,
    });
    store.setData(artifact.id, { saved: true });
    assert.equal(
      store.saveThumbnail(artifact.id, 1, Buffer.from("first")),
      true,
    );
    assert.ok(
      store.list().find((item) => item.id === artifact.id)?.thumbnailVersion,
    );
    const renamed = store.rename(artifact.id, " New name ");
    assert.equal(renamed.id, artifact.id);
    assert.equal(renamed.title, "New name");
    assert.equal(renamed.head, 1);
    assert.equal(store.revisions(artifact.id).length, 1);
    assert.equal(
      store.revision(artifact.id).content.files["index.md"],
      "# Hello",
    );
    store.update(artifact.id, {
      baseRevision: 1,
      author: "Test",
      summary: "Update",
      content,
      commentIds: [],
    });
    assert.throws(() => store.remove(artifact.id, 1), /newer revision/);
    assert.equal(
      store.saveThumbnail(artifact.id, 1, Buffer.from("stale")),
      false,
    );
    assert.throws(() => store.thumbnail(artifact.id), /current revision/);
    assert.equal(
      store.saveThumbnail(artifact.id, 2, Buffer.from("second")),
      true,
    );
    assert.equal(
      Buffer.from(store.thumbnail(artifact.id)).toString(),
      "second",
    );
    assert.equal(store.comments(artifact.id).length, 1);
    store.remove(artifact.id, 2);
    assert.throws(() => store.get(artifact.id), /not found/);
    for (const table of ["revisions", "comments", "app_data", "thumbnails"])
      assert.equal(
        store.db
          .prepare(`SELECT count(*) AS count FROM ${table} WHERE artifact_id=?`)
          .get(artifact.id)!.count,
        0,
      );
    assert.equal(
      store.saveThumbnail(artifact.id, 2, Buffer.from("deleted")),
      false,
    );
    assert.equal(store.get(other.id).title, "Keep");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legacy histories migrate once and metadata reads do not touch source blobs", () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-history-"));
  let store = new Store(dir);
  try {
    const a = store.create({
      title: "History",
      description: "",
      author: "Test",
      summary: "Initial",
      content,
    });
    store.update(a.id, {
      baseRevision: 1,
      author: "Test",
      summary: "Second",
      content,
      commentIds: [],
    });
    store.db.exec("DROP TABLE revision_metadata");
    store.close();
    store = new Store(dir);
    assert.deepEqual(
      store.revisions(a.id).map((r) => r.number),
      [2, 1],
    );
    assert.equal(store.revisions(a.id, 2, 1)[0].number, 1);
    assert.equal("content" in store.revisions(a.id)[0], false);
    store.db
      .prepare("UPDATE revisions SET data=? WHERE artifact_id=?")
      .run("unreadable source", a.id);
    assert.equal(store.revisions(a.id)[0].summary, "Second");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("single comment reads are scoped and do not parse unrelated comments", () => {
  const dir = mkdtempSync(join(tmpdir(), "atelier-comments-"));
  const store = new Store(dir);
  try {
    const make = () =>
      store.create({
        title: "Comments",
        description: "",
        author: "Test",
        summary: "Initial",
        content,
      });
    const a = make(),
      b = make();
    const c = store.addComment(a.id, {
      revision: 1,
      body: "Target",
      author: "You",
      anchor: null,
    });
    const other = store.addComment(a.id, {
      revision: 1,
      body: "Other",
      author: "You",
      anchor: null,
    });
    store.db
      .prepare("UPDATE comments SET data='invalid' WHERE id=?")
      .run(other.id);
    assert.equal(store.comment(a.id, c.id).body, "Target");
    assert.throws(() => store.comment(b.id, c.id), /not found/);
    const plan = store.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT data FROM comments WHERE artifact_id=?",
      )
      .all(a.id);
    assert.match(JSON.stringify(plan), /comments_artifact/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
