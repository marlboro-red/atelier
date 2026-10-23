import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("text selection, annotations, replies, resolution and exports form one review flow", async ({
  page,
  request,
}) => {
  const result = await request.post("/api/artifacts", {
    data: {
      title: "Inline feedback",
      content: {
        kind: "html",
        entry: "index.html",
        files: {
          "index.html": `<main style="padding:60px;max-width:600px"><h1>Field observations</h1><p id="detail">The tide rises twice each day.</p><button id="control" onclick="this.textContent='Changed'">Try control</button></main>`,
        },
      },
    },
  });
  const artifact = await result.json();
  await page.goto("/a/" + artifact.id);
  const frame = page.frameLocator("iframe");
  await expect(frame.locator("#detail")).toBeVisible();
  // Select rendered text without entering a review mode.
  await frame.locator("#detail").evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  });
  await expect(page.locator(".review-panel")).toHaveCount(0);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.getByLabel("Comment", { exact: true })).toBeFocused();
  await expect(page.locator(".selected-quote")).toHaveText(
    "The tide rises twice each day.",
  );
  await page.getByLabel("Comment", { exact: true }).fill("Explain the timing.");
  await page.getByRole("button", { name: "Send comment", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Comments (1)", exact: true }),
  ).toBeVisible();
  await expect(
    frame.getByRole("button", { name: "Open comment 1" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close panel" }).click();
  await frame
    .locator("#detail")
    .evaluate(() => getSelection()?.removeAllRanges());
  await frame.locator("#detail").click({ position: { x: 30, y: 8 } });
  await expect(page.locator('.comment[data-active="true"]')).toContainText(
    "Explain the timing.",
  );
  await page.getByLabel("Reply to comment").fill("Keep it brief.");
  await page.getByRole("button", { name: "Send reply" }).click();
  await expect(page.locator(".reply")).toContainText("Keep it brief.");
  await page.getByRole("button", { name: "Resolve comment" }).click();
  await expect(
    frame.getByRole("button", { name: "Open comment 1" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Reopen comment" }).click();
  await expect(
    frame.getByRole("button", { name: "Open comment 1" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close panel" }).click();
  await frame.getByRole("button", { name: "Open comment 1" }).click();
  await expect(page.locator(".comment")).toContainText("Keep it brief.");
  await page.getByRole("button", { name: "Comment on an element" }).click();
  await expect(frame.locator("html")).toHaveCSS("cursor", "crosshair");
  await frame.getByRole("button", { name: "Try control" }).click();
  await expect(
    frame.getByRole("button", { name: "Try control" }),
  ).toBeVisible();
  await expect(page.locator(".selected-quote")).toContainText("Try control");
  await page.getByRole("button", { name: "Close panel" }).click();
  await frame.getByRole("button", { name: "Try control" }).click();
  await expect(frame.getByRole("button", { name: "Changed" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Comments (1)", exact: true }).click();
  const panel = await page.locator(".review-panel").boundingBox();
  expect(panel!.x).toBeGreaterThanOrEqual(0);
  expect(panel!.y).toBe(44);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save as HTML" }).click();
  const html = await readFile((await (await download).path())!, "utf8");
  const exported = await page.context().newPage();
  await exported.setContent(html);
  const exportFrame = exported.frameLocator("iframe");
  await expect(exportFrame.locator("#detail")).toBeVisible();
  await expect(exportFrame.locator("atelier-annotations")).toHaveCount(0);
  await exportFrame.locator("#detail").evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  });
  await expect(
    exported.getByRole("button", { name: "Comment", exact: true }),
  ).toHaveCount(0);
});

test("repeated text anchors retain the selected occurrence after reload", async ({
  page,
  request,
}) => {
  const result = await request.post("/api/artifacts", {
    data: {
      title: "Repeated text",
      content: {
        kind: "html",
        entry: "index.html",
        files: {
          "index.html":
            '<p id="repeated" style="margin:80px">First tide, second tide.</p>',
        },
      },
    },
  });
  const artifact = await result.json();
  await page.goto("/a/" + artifact.id);
  const frame = page.frameLocator("iframe");
  await frame.locator("#repeated").evaluate((el) => {
    const range = document.createRange();
    const node = el.firstChild!;
    const start = node.textContent!.lastIndexOf("tide");
    range.setStart(node, start);
    range.setEnd(node, start + 4);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  });
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByLabel("Comment", { exact: true }).fill("The second tide.");
  await page.getByRole("button", { name: "Send comment", exact: true }).click();
  await expect(page.locator(".comment")).toContainText("The second tide.");
  const comments = await (
    await request.get(`/api/artifacts/${artifact.id}/comments`)
  ).json();
  expect(comments[0].anchor.prefix).toBe("First tide, second ");
  await page.reload();
  await expect(
    frame.getByRole("button", { name: "Open comment 1" }),
  ).toBeVisible();
  await frame.getByRole("button", { name: "Open comment 1" }).click();
  await expect(page.locator('.comment[data-active="true"]')).toContainText(
    "The second tide.",
  );
});
