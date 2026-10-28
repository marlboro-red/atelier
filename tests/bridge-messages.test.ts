import { test } from "node:test";
import assert from "node:assert/strict";
import {
  artifactMessageSchema,
  workspaceChangeSchema,
} from "../src/shared/bridge-messages.js";

test("bridge messages validate envelopes and bound displayed errors", () => {
  assert.equal(
    artifactMessageSchema.safeParse({
      type: "save-data",
      requestId: {},
      data: {},
    }).success,
    false,
  );
  assert.equal(
    artifactMessageSchema.safeParse({
      type: "open-comment",
      id: "x",
      x: Infinity,
    }).success,
    false,
  );
  assert.equal(
    artifactMessageSchema.safeParse({
      type: "snapshot",
      requestId: "1",
      snapshot: {},
    }).success,
    true,
  );
  const parsed = artifactMessageSchema.parse({
    type: "runtime-error",
    message: "x".repeat(2000),
  });
  assert.equal(parsed.type === "runtime-error" && parsed.message.length, 1500);
  assert.equal(workspaceChangeSchema.parse({ id: "legacy" }).type, "artifact");
  assert.equal(
    workspaceChangeSchema.safeParse({ id: "x", type: "unknown" }).success,
    false,
  );
});
