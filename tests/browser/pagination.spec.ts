import { test, expect } from "@playwright/test";

test("collection pages bound the DOM, fetch later pages, reset search, and observe new thumbnails", async ({
  page,
}) => {
  const artifacts = Array.from({ length: 425 }, (_, i) => ({
    id: `paged-${i}`,
    title: `Page item ${i}`,
    description: "",
    kind: "html",
    head: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    thumbnailVersion: i === 50 ? null : "test",
  }));
  let failNext = true;
  const checks: string[] = [];
  await page.route("**/api/artifacts?*", async (route) => {
    const url = new URL(route.request().url());
    const search = url.searchParams.get("search");
    const cursor = url.searchParams.get("cursor");
    if (cursor && failNext) {
      failNext = false;
      await route.fulfill({ status: 503, json: { error: "Retry pagination" } });
      return;
    }
    const start = cursor ? Number(cursor.split("paged-").at(-1)) + 1 : 0;
    await route.fulfill({
      json: artifacts
        .filter((a) => !search || a.title.includes(search))
        .slice(start, start + 200),
    });
  });
  await page.route("**/api/artifacts/paged-*/thumbnail?*", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>',
    }),
  );
  await page.route("**/api/artifacts/paged-*/check", (route) => {
    checks.push(route.request().url());
    return route.fulfill({ json: { thumbnailAvailable: true } });
  });
  await page.goto("/");
  const cards = page.locator(".artifact-card");
  const next = page.getByRole("button", { name: "Next", exact: true });
  await expect(cards).toHaveCount(50);
  await expect(
    page.getByRole("button", { name: "Previous", exact: true }),
  ).toBeDisabled();
  await next.click();
  await expect(cards.first()).toHaveAttribute("data-artifact-id", "paged-50");
  await expect(page.getByRole("heading", { name: /Artifacts/ })).toBeFocused();
  await expect
    .poll(() => checks.some((url) => url.includes("paged-50/check")))
    .toBeTruthy();
  for (const start of [100, 150]) {
    await next.click();
    await expect(cards.first()).toHaveAttribute(
      "data-artifact-id",
      `paged-${start}`,
    );
  }
  await next.click(); // A failed fetch must leave the current page intact.
  await expect(page.getByText("Retry pagination")).toBeVisible();
  await expect(cards.first()).toHaveAttribute("data-artifact-id", "paged-150");
  for (const start of [200, 250, 300, 350, 400]) {
    await next.click();
    await expect(cards.first()).toHaveAttribute(
      "data-artifact-id",
      `paged-${start}`,
    );
    await expect(cards).toHaveCount(start === 400 ? 25 : 50);
  }
  await expect(next).toBeDisabled();
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(cards.first()).toHaveAttribute("data-artifact-id", "paged-350");
  await page
    .getByRole("textbox", { name: "Search artifacts" })
    .fill("Page item 424");
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toHaveAttribute("data-artifact-id", "paged-424");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});
