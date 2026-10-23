import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { templates } from "../../src/web/templates";
test("create, annotate, revise, preserve history, export HTML and PDF", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New artifact" }).click();
  await page
    .getByPlaceholder("Interactive dashboard")
    .fill("Browser test dashboard");
  await page
    .getByRole("button", { name: "Create artifact", exact: true })
    .click();
  await expect(page).toHaveURL(/\/a\//);
  const id = page.url().split("/a/")[1];
  const frame = page.frameLocator("iframe");
  await expect(
    frame.getByRole("heading", { name: "A little perspective." }),
  ).toBeVisible();
  await frame.getByLabel("Period").selectOption("3 months");
  await page.getByTitle("Select text or an element to comment").click();
  await frame.getByRole("heading", { name: "A little perspective." }).click();
  await expect(page.locator(".selected-quote")).toContainText(
    "A little perspective.",
  );
  await page
    .getByLabel("Comment", { exact: true })
    .fill("Change the heading to A clearer picture.");
  await page.getByRole("button", { name: "Send comment", exact: true }).click();
  await expect(page.locator(".comment")).toContainText("Queued for agent");
  const comments = await (
    await request.get(`/api/artifacts/${id}/comments`)
  ).json();
  const r = await (
    await request.get(`/api/artifacts/${id}/revisions/1`)
  ).json();
  r.content.files["App.tsx"] = r.content.files["App.tsx"].replace(
    "A little perspective.",
    "A clearer picture.",
  );
  const updated = await request.post(`/api/artifacts/${id}/revisions`, {
    data: {
      baseRevision: 1,
      author: "Test agent",
      summary: "Clarify heading",
      content: r.content,
      commentIds: [comments[0].id],
    },
  });
  expect(updated.status()).toBe(201);
  await expect(
    frame.getByRole("heading", { name: "A clearer picture." }),
  ).toBeVisible();
  await expect(page.locator(".comment")).toContainText("Ready for review");
  await page.getByTitle("Revision history").click();
  await page.getByRole("button", { name: /Revision 1 Initial/ }).click();
  await expect(
    frame.getByRole("heading", { name: "A little perspective." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Return to latest" }).click();
  await expect(
    frame.getByRole("heading", { name: "A clearer picture." }),
  ).toBeVisible();
  await frame.getByLabel("Period").selectOption("3 months");
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save as HTML" }).click();
  const downloaded = await dl;
  const html = await readFile((await downloaded.path())!, "utf8");
  expect(html).toContain("A clearer picture.");
  const standalone = await page.context().newPage();
  await standalone.route("**/*", (route) => route.abort());
  await standalone.setContent(html);
  await expect(standalone.getByLabel("Period")).toHaveValue("3 months");
  await standalone.getByLabel("Period").selectOption("6 months");
  await standalone.close();
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const pdfDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save as PDF" }).click();
  const pdf = await readFile((await (await pdfDownload).path())!);
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  await page.screenshot({ path: "test-results/workspace.png", fullPage: true });
});
test("all visual templates render without runtime errors", async ({
  page,
  request,
}) => {
  for (const t of templates.slice(1)) {
    const a = await (
      await request.post("/api/artifacts", {
        data: { title: t.name, content: t.content },
      })
    ).json();
    await page.goto("/a/" + a.id);
    const frame = page.frameLocator("iframe");
    await expect(frame.locator("body")).not.toBeEmpty();
    if (t.name === "Flow diagram")
      await expect(frame.locator("svg")).toBeVisible();
    if (t.name === "Written document")
      await expect(frame.locator(".katex")).toBeVisible();
    if (t.name === "Interactive canvas")
      await expect(frame.locator("canvas")).toBeVisible();
    if (t.name === "Presentation") {
      await expect(
        frame.getByRole("heading", { name: "Make room for ideas." }),
      ).toBeVisible();
      await frame.getByRole("button", { name: "Next" }).click();
      await expect(
        frame.getByRole("heading", { name: "Create. Review. Refine." }),
      ).toBeVisible();
    }
    await expect(page.locator(".runtime-errors")).toHaveCount(0);
  }
});
test("HTML assets, persistent data, and text selection work inside isolation", async ({
  page,
  request,
}) => {
  const content = {
    kind: "html",
    entry: "index.html",
    files: {
      "index.html":
        '<h1 id="heading">A local image</h1><img src="image.svg" width="40"><button id="count">0</button><script>const b=document.getElementById("count");window.atelier.getData().then(d=>b.textContent=d?.count||0);b.onclick=async()=>{b.textContent=Number(b.textContent)+1;await window.atelier.setData({count:Number(b.textContent)})}</script>',
      "image.svg":
        '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="18" fill="green"/></svg>',
    },
  };
  const a = await (
    await request.post("/api/artifacts", {
      data: { title: "Local assets", content },
    })
  ).json();
  await page.goto("/a/" + a.id);
  const frame = page.frameLocator("iframe");
  await expect(frame.locator("img")).toBeVisible();
  await frame.getByRole("button", { name: "0", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/artifacts/${a.id}/data`)).json()).data,
    )
    .toEqual({ count: 1 });
  await page.reload();
  await expect(
    frame.getByRole("button", { name: "1", exact: true }),
  ).toBeVisible();
  await page.getByTitle("Select text or an element to comment").click();
  await expect(frame.locator("html")).toHaveCSS("cursor", "crosshair");
  await frame.locator("h1").evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  });
  await expect(page.locator(".selected-quote")).toContainText("A local image");
  const isolated = await frame.locator("body").evaluate(() => {
    try {
      return parent.document.body.innerHTML;
    } catch {
      return "isolated";
    }
  });
  expect(isolated).toBe("isolated");
});
test("source edits survive agent updates and stale saves are rejected", async ({
  page,
  request,
}) => {
  const content = {
    kind: "markdown",
    entry: "index.md",
    files: { "index.md": "# Start" },
  };
  const a = await (
    await request.post("/api/artifacts", {
      data: { title: "Concurrent editing", content },
    })
  ).json();
  await page.goto("/a/" + a.id);
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await page.getByLabel("Artifact source").fill("# My unsaved work");
  await request.post(`/api/artifacts/${a.id}/revisions`, {
    data: {
      baseRevision: 1,
      author: "Agent",
      summary: "Agent update",
      content: { ...content, files: { "index.md": "# Agent change" } },
    },
  });
  await expect(page.getByLabel("Artifact source")).toHaveValue(
    "# My unsaved work",
  );
  await page.getByLabel("Change summary").fill("My change");
  await page
    .getByRole("button", { name: "Save revision", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Revision conflict");
});

test("imports existing source, saves edits, restores without erasing history, and duplicates", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New artifact" }).click();
  await page.locator("input[type=file]").setInputFiles({
    name: "notes.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Imported notes\n\nA first draft."),
  });
  await expect(
    page.getByRole("button", { name: "Imported 1 files" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Create artifact", exact: true })
    .click();
  await expect(page).toHaveURL(/\/a\//);
  const id = page.url().split("/a/")[1];
  await expect(
    page
      .frameLocator("iframe")
      .getByRole("heading", { name: "Imported notes" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await page
    .getByLabel("Artifact source")
    .fill("# Revised notes\n\nA better draft.");
  await page.getByLabel("Change summary").fill("Refine imported document");
  await page
    .getByRole("button", { name: "Save revision", exact: true })
    .click();
  await expect(page.locator(".version-tag")).toContainText("v2");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(
    page.frameLocator("iframe").getByRole("heading", { name: "Revised notes" }),
  ).toBeVisible();
  await page.getByTitle("Revision history").click();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.locator(".version-tag")).toContainText("v3");
  await expect(
    page
      .frameLocator("iframe")
      .getByRole("heading", { name: "Imported notes" }),
  ).toBeVisible();
  const revisions = await (
    await request.get(`/api/artifacts/${id}/revisions`)
  ).json();
  expect(revisions).toHaveLength(3);
  await page.getByTitle("Duplicate this revision").click();
  await expect(page).not.toHaveURL(new RegExp(`/a/${id}$`));
  await expect(page.locator(".version-tag")).toContainText("v1");
  await expect(
    page
      .frameLocator("iframe")
      .getByRole("heading", { name: "Imported notes" }),
  ).toBeVisible();
});
