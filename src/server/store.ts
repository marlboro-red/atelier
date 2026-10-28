import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Artifact,
  Revision,
  RevisionMetadata,
  Comment,
  Content,
  Anchor,
} from "../shared/schema.js";
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export class Store {
  db: DatabaseSync;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(join(dir, "atelier.sqlite"));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS revisions (artifact_id TEXT NOT NULL REFERENCES artifacts(id), number INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(artifact_id,number));
 CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL REFERENCES artifacts(id), data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS thumbnails (artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id), revision INTEGER NOT NULL, version TEXT NOT NULL, image BLOB NOT NULL);
 CREATE TABLE IF NOT EXISTS app_data (artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id), data TEXT NOT NULL);`);
    // Migrate once, rather than parsing source blobs during every history read.
    if (
      !this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='revision_metadata'",
        )
        .get()
    ) {
      this.transaction(() => {
        this.db.exec(`CREATE TABLE revision_metadata (
          artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
          number INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(artifact_id,number));
          INSERT INTO revision_metadata SELECT artifact_id,number,
            json_set(json_remove(data,'$.content'),'$.kind',json_extract(data,'$.content.kind')) FROM revisions;`);
      });
    }
  }
  list(): Artifact[] {
    return this.db
      .prepare(
        "SELECT artifacts.data, thumbnails.revision AS thumbnail_revision, thumbnails.version AS thumbnail_version FROM artifacts LEFT JOIN thumbnails ON thumbnails.artifact_id=artifacts.id",
      )
      .all()
      .map((r) => {
        const artifact = JSON.parse(r.data as string);
        if (r.thumbnail_revision === artifact.head)
          artifact.thumbnailVersion = r.thumbnail_version;
        return artifact;
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  get(id: string): Artifact {
    const r = this.db.prepare("SELECT data FROM artifacts WHERE id=?").get(id);
    if (!r) throw new HttpError(404, "Artifact not found");
    return JSON.parse(r.data as string);
  }
  revisions(
    id: string,
    before = Number.MAX_SAFE_INTEGER,
    limit = 200,
  ): RevisionMetadata[] {
    this.get(id);
    return this.db
      .prepare(
        "SELECT data FROM revision_metadata WHERE artifact_id=? AND number<? ORDER BY number DESC LIMIT ?",
      )
      .all(id, before, limit)
      .map((r) => JSON.parse(r.data as string));
  }
  revision(id: string, n?: number): Revision {
    const a = this.get(id);
    const r = this.db
      .prepare("SELECT data FROM revisions WHERE artifact_id=? AND number=?")
      .get(id, n ?? a.head);
    if (!r) throw new HttpError(404, "Revision not found");
    return JSON.parse(r.data as string);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  create(input: {
    title: string;
    description: string;
    author: string;
    summary: string;
    content: Content;
  }): Artifact {
    return this.transaction(() => {
      const now = new Date().toISOString();
      const a: Artifact = {
        id: randomUUID(),
        title: input.title,
        description: input.description,
        kind: input.content.kind,
        head: 1,
        createdAt: now,
        updatedAt: now,
      };
      this.db
        .prepare("INSERT INTO artifacts VALUES (?,?)")
        .run(a.id, JSON.stringify(a));
      this.insertRevision({
        artifactId: a.id,
        number: 1,
        author: input.author,
        summary: input.summary,
        content: input.content,
        createdAt: now,
        commentIds: [],
      });
      return a;
    });
  }
  rename(id: string, title: string): Artifact {
    const name = title.trim();
    if (!name || name.length > 160)
      throw new HttpError(400, "Use a name between 1 and 160 characters");
    const artifact = this.get(id);
    artifact.title = name;
    artifact.updatedAt = new Date().toISOString();
    this.db
      .prepare("UPDATE artifacts SET data=? WHERE id=?")
      .run(JSON.stringify(artifact), id);
    return artifact;
  }
  remove(id: string, baseRevision: number) {
    this.transaction(() => {
      const artifact = this.get(id);
      if (artifact.head !== baseRevision)
        throw new HttpError(
          409,
          "The artifact has a newer revision. Reopen Delete to review the current artifact.",
        );
      this.db.prepare("DELETE FROM comments WHERE artifact_id=?").run(id);
      this.db.prepare("DELETE FROM app_data WHERE artifact_id=?").run(id);
      this.db.prepare("DELETE FROM thumbnails WHERE artifact_id=?").run(id);
      this.db.prepare("DELETE FROM revisions WHERE artifact_id=?").run(id);
      this.db.prepare("DELETE FROM artifacts WHERE id=?").run(id);
    });
  }
  private insertRevision(r: Revision) {
    const { content, ...metadata } = r;
    this.db
      .prepare("INSERT INTO revision_metadata VALUES (?,?,?)")
      .run(
        r.artifactId,
        r.number,
        JSON.stringify({ ...metadata, kind: content.kind }),
      );
    this.db
      .prepare("INSERT INTO revisions VALUES (?,?,?)")
      .run(r.artifactId, r.number, JSON.stringify(r));
  }
  update(
    id: string,
    input: {
      baseRevision: number;
      author: string;
      summary: string;
      content: Content;
      commentIds: string[];
    },
  ): Revision {
    return this.transaction(() => {
      const a = this.get(id);
      if (a.head !== input.baseRevision)
        throw new HttpError(
          409,
          `Revision conflict: latest is ${a.head}; you started from ${input.baseRevision}`,
        );
      for (const cid of input.commentIds) {
        const c = this.comment(id, cid);
        if (c.status !== "resolved") {
          c.status = "addressed";
          this.saveComment(c);
        }
      }
      const now = new Date().toISOString();
      const r: Revision = {
        artifactId: id,
        number: a.head + 1,
        createdAt: now,
        author: input.author,
        summary: input.summary,
        content: input.content,
        commentIds: input.commentIds,
      };
      this.insertRevision(r);
      a.head = r.number;
      a.kind = r.content.kind;
      a.updatedAt = now;
      this.db
        .prepare("UPDATE artifacts SET data=? WHERE id=?")
        .run(JSON.stringify(a), id);
      return r;
    });
  }
  comments(id: string): Comment[] {
    this.get(id);
    return this.db
      .prepare("SELECT data FROM comments WHERE artifact_id=?")
      .all(id)
      .map((r) => JSON.parse(r.data as string));
  }
  comment(id: string, cid: string): Comment {
    const c = this.comments(id).find((c) => c.id === cid);
    if (!c) throw new HttpError(404, "Comment not found");
    return c;
  }
  addComment(
    id: string,
    input: {
      revision: number;
      body: string;
      author: string;
      anchor: Anchor | null;
    },
  ): Comment {
    this.revision(id, input.revision);
    const c: Comment = {
      ...input,
      id: randomUUID(),
      artifactId: id,
      status: "open",
      createdAt: new Date().toISOString(),
      replies: [],
    };
    this.saveComment(c);
    return c;
  }
  saveComment(c: Comment) {
    this.db
      .prepare(
        "INSERT INTO comments VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(c.id, c.artifactId, JSON.stringify(c));
  }
  data(id: string): unknown {
    this.get(id);
    const row = this.db
      .prepare("SELECT data FROM app_data WHERE artifact_id=?")
      .get(id);
    return row ? JSON.parse(row.data as string) : null;
  }
  setData(id: string, data: unknown) {
    this.get(id);
    this.db
      .prepare(
        "INSERT INTO app_data VALUES (?,?) ON CONFLICT(artifact_id) DO UPDATE SET data=excluded.data",
      )
      .run(id, JSON.stringify(data));
  }
  saveThumbnail(id: string, revision: number, image: Uint8Array): boolean {
    const row = this.db
      .prepare("SELECT data FROM artifacts WHERE id=?")
      .get(id);
    // A slower check must not replace a newer revision's preview, or recreate
    // a preview for an artifact deleted while the browser was running.
    if (!row || JSON.parse(row.data as string).head !== revision) return false;
    this.db
      .prepare(
        "INSERT INTO thumbnails VALUES (?,?,?,?) ON CONFLICT(artifact_id) DO UPDATE SET revision=excluded.revision, version=excluded.version, image=excluded.image",
      )
      .run(id, revision, `${revision}-${randomUUID()}`, image);
    return true;
  }
  thumbnail(id: string): Uint8Array {
    const artifact = this.get(id);
    const row = this.db
      .prepare("SELECT revision,image FROM thumbnails WHERE artifact_id=?")
      .get(id);
    if (!row || row.revision !== artifact.head)
      throw new HttpError(404, "No preview for the current revision");
    return row.image as Uint8Array;
  }
  close() {
    this.db.close();
  }
}
