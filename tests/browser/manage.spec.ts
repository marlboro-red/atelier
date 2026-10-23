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
