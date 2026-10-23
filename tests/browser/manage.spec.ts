import { test, expect } from "@playwright/test";

test("viewer renames without revising content and confirms deletion", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/artifacts", {
    data: {
      title: "Manage this artifact",
      content: {
        kind: "html",
        entry: "index.html",
        files: { "index.html": "<h1>Keep this content</h1>" },
      },
    },
  });
  const artifact = await response.json();
  await page.goto("/a/" + artifact.id);
  await page.getByRole("button", { name: "Open review tools" }).click();
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Artifact name").fill("Renamed document");
  await dialog.getByRole("button", { name: "Save name" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".artifact-header-title")).toHaveText(
    "Renamed document",
  );
  await expect(
    page
      .frameLocator("iframe")
      .getByRole("heading", { name: "Keep this content" }),
  ).toBeVisible();
  expect(
    (await (await request.get(`/api/artifacts/${artifact.id}`)).json()).head,
  ).toBe(1);
  expect(
    (
      await (
        await request.get(`/api/artifacts/${artifact.id}/revisions`)
      ).json()
    ).length,
  ).toBe(1);
  await page
    .getByRole("button", { name: "Delete artifact", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect((await request.get(`/api/artifacts/${artifact.id}`)).status()).toBe(
    200,
  );
  await page
    .getByRole("button", { name: "Delete artifact", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Delete artifact", exact: true })
    .click();
  await expect(page).toHaveURL(/\/$/);
  await expect(dialog).toHaveCount(0);
  expect((await request.get(`/api/artifacts/${artifact.id}`)).status()).toBe(
    404,
  );
});

test("home cards show real previews and offer rename and delete on narrow screens", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/artifacts", {
    data: {
      title: "Card preview example",
      content: {
        kind: "html",
        entry: "index.html",
        files: {
          "index.html":
            '<main style="padding:40px;background:#d7ece1"><h1>Visual preview</h1><svg width="300" height="120"><rect x="10" y="30" width="80" height="90" fill="#226454"/><rect x="110" y="10" width="80" height="110" fill="#c88145"/></svg></main>',
        },
      },
    },
  });
  const artifact = await response.json();
  const preview = await request.get(`/api/artifacts/${artifact.id}/thumbnail`);
  expect(preview.status()).toBe(200);
  expect(preview.headers()["content-type"]).toContain("image/jpeg");
  expect((await preview.body()).subarray(0, 2)).toEqual(
    Buffer.from([255, 216]),
  );
  await page.goto("/");
  await page.getByLabel("Search artifacts").fill("Card preview example");
  const card = page.locator(`[data-artifact-id="${artifact.id}"]`);
  await expect(
    card.getByRole("img", { name: "Preview of Card preview example" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      card
        .locator("img")
        .evaluate((img) => (img as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  await expect(page.locator(".artifact-list")).toHaveCSS("display", "grid");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await card
    .getByRole("button", { name: "Rename Card preview example", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Artifact name")
    .fill("Card preview renamed");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save name" })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByLabel("Search artifacts").fill("Card preview renamed");
  const renamed = page.locator(`[data-artifact-id="${artifact.id}"]`);
  await expect(
    renamed.getByRole("button", {
      name: "Open Card preview renamed",
      exact: true,
    }),
  ).toBeVisible();
  await renamed
    .getByRole("button", { name: "Delete Card preview renamed", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete artifact", exact: true })
    .click();
  await expect(renamed).toHaveCount(0);
  expect(
    (await request.get(`/api/artifacts/${artifact.id}/thumbnail`)).status(),
  ).toBe(404);
});
