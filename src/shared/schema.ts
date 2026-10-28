import { z } from "zod";
export const kinds = ["react", "html", "markdown", "svg"] as const;
const pathSchema = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      p.split("/").every((s) => s !== ".." && s !== "." && s !== ""),
    "Use relative file paths without traversal",
  );
export const contentSchema = z
  .object({
    kind: z.enum(kinds),
    entry: pathSchema,
    files: z
      .record(pathSchema, z.string())
      .refine(
        (f) => Object.keys(f).length > 0 && Object.keys(f).length <= 100,
        "Provide 1–100 files",
      ),
  })
  .refine((v) => Object.hasOwn(v.files, v.entry), "Entry must exist in files");
export const createSchema = z.object({
  waitForCheck: z.boolean().default(true),
  title: z.string().trim().min(1).max(160),
  description: z.string().max(2000).default(""),
  author: z.string().max(100).default("Agent"),
  summary: z.string().max(1000).default("Initial version"),
  content: contentSchema,
});
export const revisionSchema = z.object({
  waitForCheck: z.boolean().default(true),
  baseRevision: z.number().int().positive(),
  author: z.string().max(100).default("Agent"),
  summary: z.string().trim().min(1).max(1000),
  content: contentSchema,
  commentIds: z.array(z.string()).default([]),
});
export const anchorSchema = z.object({
  kind: z.enum(["text", "element", "section"]).optional(),
  label: z.string().max(200).optional(),
  quote: z.string().max(5000),
  prefix: z.string().max(200).default(""),
  suffix: z.string().max(200).default(""),
  selector: z.string().max(1000).default(""),
  tag: z.string().max(50).default(""),
});
export const commentSchema = z.object({
  revision: z.number().int().positive(),
  body: z.string().trim().min(1).max(10000),
  author: z.string().max(100).default("You"),
  anchor: anchorSchema.nullable().default(null),
});
export type Content = z.infer<typeof contentSchema>;
export type Anchor = z.infer<typeof anchorSchema>;
export interface Artifact {
  id: string;
  title: string;
  description: string;
  kind: Content["kind"];
  head: number;
  createdAt: string;
  updatedAt: string;
  thumbnailVersion?: string;
}
export interface Revision {
  artifactId: string;
  number: number;
  author: string;
  summary: string;
  createdAt: string;
  content: Content;
  commentIds: string[];
}
export interface Comment {
  id: string;
  artifactId: string;
  revision: number;
  body: string;
  author: string;
  anchor: Anchor | null;
  status: "open" | "in_progress" | "addressed" | "resolved";
  createdAt: string;
  acknowledgedAt?: string;
  replies: { body: string; author: string; createdAt: string }[];
}

export type RevisionMetadata = Omit<Revision, "content"> & {
  kind: Content["kind"];
};

export interface FeedbackStatus {
  provider: string | null;
  connected: boolean;
  state: string;
  queued: number;
  uncertain: number;
}
