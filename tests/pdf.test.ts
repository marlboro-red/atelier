import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPdf } from "../src/server/pdf.js";

test("PDF exports bound concurrency and stop hung scripts, releasing their slots", async () => {
  const start = Date.now();
  const hung = "<script>while(true){}</script>";
  const first = renderPdf(hung, 2000);
  const second = renderPdf(hung + "<!-- second -->", 2000);
  const completed = Promise.allSettled([first, second]);
  const queued = renderPdf("<h1>Third export</h1>");
  for (const result of await completed) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected")
      assert.equal(result.reason.statusCode, 504);
  }
  assert.equal((await queued).subarray(0, 4).toString(), "%PDF");
  assert.ok(Date.now() - start < 6000);
  const pdf = await renderPdf("<h1>Export after timeout</h1>");
  assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
});
