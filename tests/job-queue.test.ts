import { test } from "node:test";
import assert from "node:assert/strict";
import { JobQueue } from "../src/server/job-queue.js";

test("jobs share in-flight work, prioritize exports, and reject excess queue entries", async () => {
  const queue = new JobQueue(1, 2);
  let release!: () => void;
  const order: string[] = [];
  const first = queue.run(
    "first",
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  assert.equal(
    queue.run("first", async () => {
      throw new Error("duplicate");
    }),
    first,
  );
  const low = queue.run("low", async () => {
    order.push("low");
  });
  const high = queue.run(
    "high",
    async () => {
      order.push("high");
    },
    1,
  );
  await assert.rejects(
    queue.run("overflow", async () => {}),
    { statusCode: 503 },
  );
  release();
  await Promise.all([first, low, high]);
  assert.deepEqual(order, ["high", "low"]);
});
