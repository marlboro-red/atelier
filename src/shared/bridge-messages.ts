import { z } from "zod";
import { anchorSchema } from "./schema.js";
const coordinates = {
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
};
const requestId = z.union([
  z.string().max(100),
  z.number().int().nonnegative(),
]);
export const artifactMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("escape") }),
  z.object({ type: z.literal("selection-cancel") }),
  z.object({ type: z.literal("anchor-missing") }),
  z.object({
    type: z.literal("selection"),
    anchor: anchorSchema,
    ...coordinates,
  }),
  z.object({
    type: z.literal("selection-candidate"),
    anchor: anchorSchema.optional(),
    ...coordinates,
  }),
  z.object({
    type: z.literal("open-comment"),
    id: z.string().max(100),
    ...coordinates,
  }),
  z.object({
    type: z.literal("runtime-error"),
    message: z.string().transform((value) => value.slice(0, 1500)),
  }),
  z.object({
    type: z.literal("snapshot"),
    requestId: z.string().max(100),
    snapshot: z.unknown().optional(),
    error: z.string().max(2000).optional(),
  }),
  z.object({
    type: z.literal("save-data"),
    requestId,
    data: z.unknown(),
    baseVersion: z.number().int().nonnegative().optional(),
  }),
]);
export const workspaceChangeSchema = z.object({
  id: z.string(),
  type: z
    .enum(["artifact", "comments", "feedback", "thumbnail"])
    .default("artifact"),
});
export type WorkspaceChange = z.infer<typeof workspaceChangeSchema>;
