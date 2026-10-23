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
  await expect(page.getByRole("dialog", { name: "New comment" })).toBeVisible();
  await expect(page.locator(".review-panel")).toHaveCount(0);
  await expect(page.locator("iframe")).toHaveCSS("width", "1440px");
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
  await expect(page.getByRole("dialog", { name: "New comment" })).toHaveCount(
    0,
  );
  await frame
    .locator("#detail")
    .evaluate(() => getSelection()?.removeAllRanges());
  await frame.locator("#detail").click({ position: { x: 30, y: 8 } });
  await expect(page.locator('.comment[data-active="true"]')).toContainText(
    "Explain the timing.",
  );
  const thread = page.getByRole("dialog", { name: "Comments", exact: true });
  await expect(thread).toBeVisible();
  await expect(page.locator(".review-panel")).toHaveCount(0);
  await expect(page.locator("iframe")).toHaveCSS("width", "1440px");
  await expect(
    thread.getByText("Not yet acknowledged", { exact: true }),
  ).toBeVisible();
  await request.get(`/api/artifacts/${artifact.id}/comments`);
  await expect(
    thread.getByText("Not yet acknowledged", { exact: true }),
  ).toBeVisible();
  await request.post(`/api/artifacts/${artifact.id}/comments/read`, {
    data: {},
  });
  await expect(thread.getByText("Acknowledged", { exact: true })).toBeVisible();
  await page.getByLabel("Reply to comment").fill("Keep it brief.");
  await page.getByRole("button", { name: "Send reply" }).click();
  await expect(page.locator(".reply")).toContainText("Keep it brief.");
  await expect(
    thread.getByText("Not yet acknowledged", { exact: true }),
  ).toBeVisible();
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
  await expect(page.locator(".review-panel")).toHaveCount(0);
  await page.getByRole("button", { name: "Close comment" }).click();
  await frame.getByRole("button", { name: "Try control" }).click();
  await expect(frame.getByRole("button", { name: "Changed" })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Comments (1)", exact: true }).click();
  const panel = await page
    .getByRole("dialog", { name: "Comments", exact: true })
    .boundingBox();
  expect(panel!.x).toBeGreaterThanOrEqual(0);
  expect(panel!.y).toBe(52);
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
  await expect(page.getByRole("dialog", { name: "New comment" })).toHaveCount(
    0,
  );
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

test("mobile comments use a compact popup and show connection state in the thread list", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/artifacts", {
    data: {
      title: "Mobile feedback",
      content: {
        kind: "html",
        entry: "index.html",
        files: {
          "index.html": '<h1 style="margin:80px 24px">A small page</h1>',
        },
      },
    },
  });
  const a = await response.json();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/a/" + a.id);
  await page.getByRole("button", { name: "Comment on an element" }).click();
  await expect(page.frameLocator("iframe").locator("html")).toHaveCSS(
    "cursor",
    "crosshair",
  );
  await page.frameLocator("iframe").locator("h1").click();
  const popup = page.getByRole("dialog", { name: "New comment" });
  await expect(popup).toBeVisible();
  await expect(page.locator(".review-panel")).toHaveCount(0);
  const box = await popup.boundingBox();
  expect(box!.width).toBeLessThan(390);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  await page.getByLabel("Comment", { exact: true }).fill("Make this clearer.");
  await page.getByRole("button", { name: "Send comment" }).click();
  await expect(popup).toHaveCount(0);
  expect(
    (await (await request.get(`/api/artifacts/${a.id}/feedback`)).json())
      .queued,
  ).toBe(1);
  if (
    !(await page
      .getByRole("dialog", { name: "Comments", exact: true })
      .isVisible())
  )
    await page.getByRole("button", { name: "Comments (1)" }).click();
  await page.route("**/api/agents/codex/sessions", (route) =>
    route.fulfill({
      json: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          title: "Tide chart discussion",
          project: "/work/tides",
          state: "idle",
        },
        {
          id: "00000000-0000-4000-8000-000000000002",
          title: "Another project",
          project: "/work/other",
          state: "active",
        },
      ],
    }),
  );
  let selected: string | undefined;
  await page.route("**/api/artifacts/*/feedback/codex", async (route) => {
    selected = route.request().postDataJSON().session;
    // Exercise the existing queue status UI without starting a real agent.
    await request.post(`/api/artifacts/${a.id}/feedback/connect`, {
      data: { provider: "codex", session: selected },
    });
    const status = await (
      await request.get(`/api/artifacts/${a.id}/feedback`)
    ).json();
    await route.fulfill({ json: status });
  });
  await page.getByText("Connect an agent", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Connect to Tide chart discussion" }),
  ).toBeVisible();
  await expect(page.getByLabel("Codex session UUID")).toHaveCount(0);
  await expect(page.locator(".agent-connect code")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Connect to Tide chart discussion" })
    .click();
  expect(selected).toBe("00000000-0000-4000-8000-000000000001");
  await expect(page.locator(".feedback-status")).toContainText(
    "codex connected",
  );
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  const connected = await (
    await request.post(`/api/artifacts/${a.id}/feedback/connect`, {
      data: { provider: "copilot", session: "test" },
    })
  ).json();
  await request.post(`/api/artifacts/${a.id}/feedback/heartbeat`, {
    data: { token: connected.token, state: "needs_permission" },
  });
  await expect(page.locator(".feedback-status")).toContainText(
    "copilot needs permission in the terminal",
  );
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.locator(".feedback-status")).toContainText(
    "No agent connected",
  );
});

test("non-text elements and whole sections have visible targets and persistent comment anchors", async ({
  page,
  request,
}) => {
  const result = await request.post("/api/artifacts", {
    data: {
      title: "Visual targets",
      content: {
        kind: "html",
        entry: "index.html",
        files: {
          "index.html": `
      <main style="padding:70px 30px"><section id="forecast" style="padding:30px;border:1px solid #ccc;max-width:600px">
      <h2>Weekly forecast</h2><p>A chart and a control.</p>
      <svg id="chart" aria-label="Tide chart" width="240" height="100"><rect id="bar" x="10" y="10" width="80" height="80" fill="blue"/></svg>
      <canvas id="canvas" aria-label="Wave simulation" width="120" height="100" style="background:#ded"></canvas>
      <button onclick="this.textContent='Activated'">Run simulation</button></section></main>`,
        },
      },
    },
  });
  const a = await result.json();
  await page.goto("/a/" + a.id);
  const frame = page.frameLocator("iframe");
  const select = page.getByRole("button", { name: "Comment on an element" });
  await select.click();
  await expect(frame.locator("html")).toHaveCSS("cursor", "crosshair");
  await frame.locator("#bar").hover();
  await expect(frame.locator("atelier-selection-highlight")).toContainText(
    "Tide chart",
  );
  await frame.locator("#bar").click();
  await expect(page.locator(".selected-quote")).toContainText(
    "Element: Tide chart",
  );
  await page
    .getByLabel("Comment", { exact: true })
    .fill("Change the chart colors");
  await page.getByRole("button", { name: "Send comment" }).click();
  await expect(page.getByRole("dialog", { name: "New comment" })).toHaveCount(
    0,
  );
  await select.click();
  await page.getByRole("button", { name: "Section", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Section", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await frame.locator("#bar").hover();
  await expect(frame.locator("atelier-selection-highlight")).toContainText(
    "Section: Weekly forecast",
  );
  await frame.getByRole("button", { name: "Run simulation" }).click();
  await expect(
    frame.getByRole("button", { name: "Run simulation" }),
  ).toBeVisible();
  await expect(page.locator(".selected-quote")).toContainText(
    "Section: Weekly forecast",
  );
  await page
    .getByLabel("Comment", { exact: true })
    .fill("Rearrange this section");
  await page.getByRole("button", { name: "Send comment" }).click();
  await expect(page.getByRole("dialog", { name: "New comment" })).toHaveCount(
    0,
  );
  const comments = await (
    await request.get(`/api/artifacts/${a.id}/comments`)
  ).json();
  expect(comments[0].anchor).toMatchObject({
    kind: "element",
    quote: "",
    selector: "#chart",
    label: "Element: Tide chart",
  });
  expect(comments[1].anchor).toMatchObject({
    kind: "section",
    quote: "",
    selector: "#forecast",
  });
  await page.reload();
  await expect(
    frame.getByRole("button", { name: "Open comment 2" }),
  ).toBeVisible();
  const mark = await frame
    .locator("atelier-annotations .mark")
    .last()
    .boundingBox();
  const section = await frame.locator("#forecast").boundingBox();
  expect(mark!.width).toBeCloseTo(section!.width, 0);
  expect(mark!.height).toBeCloseTo(section!.height, 0);
  await select.click();
  await page.getByRole("button", { name: "Element", exact: true }).click();
  await frame.locator("#canvas").hover();
  await expect(frame.locator("atelier-selection-highlight")).toContainText(
    "Wave simulation",
  );
  await frame.locator("#canvas").click();
  await expect(page.locator(".selected-quote")).toContainText(
    "Element: Wave simulation",
  );
  await page.getByRole("button", { name: "Close comment" }).click();
  await expect(frame.locator("atelier-selection-highlight")).toHaveCount(0);
});

test("conversation picker handles unavailable, empty, and closed sessions without asking for IDs", async ({
  page,
  request,
}) => {
  const a = await (
    await request.post("/api/artifacts", {
      data: {
        title: "Picker states",
        content: {
          kind: "html",
          entry: "index.html",
          files: { "index.html": "<h1>Picker</h1>" },
        },
      },
    })
  ).json();
  let state = "offline";
  await page.route("**/api/agents/codex/sessions", (route) =>
    route.fulfill(
      state === "offline"
        ? {
            status: 503,
            json: {
              error:
                "Open Codex to connect a conversation, then refresh this list.",
            },
          }
        : {
            json:
              state === "empty"
                ? []
                : [
                    {
                      id: "00000000-0000-4000-8000-000000000001",
                      title: "My conversation",
                      project: "/work/report",
                      state: "idle",
                    },
                  ],
          },
    ),
  );
  await page.route("**/api/artifacts/*/feedback/codex", (route) =>
    route.fulfill({
      status: 409,
      json: { error: "Conversation closed. Refresh and connect again." },
    }),
  );
  await page.goto("/a/" + a.id);
  await page.getByRole("button", { name: "Comments (0)" }).click();
  await page.getByText("Connect an agent", { exact: true }).click();
  await expect(page.locator(".agent-connect")).toContainText(
    "Open Codex to connect",
  );
  state = "empty";
  await page.getByRole("button", { name: "Refresh conversations" }).click();
  await expect(page.locator(".agent-connect")).toContainText(
    "No open conversations",
  );
  state = "available";
  await page.getByRole("button", { name: "Refresh conversations" }).click();
  await page
    .getByRole("button", { name: "Connect to My conversation" })
    .click();
  await expect(page.locator(".agent-connect")).toContainText(
    "Conversation closed",
  );
  await expect(page.locator(".feedback-status")).toContainText(
    "No agent connected",
  );
  await expect(page.getByLabel("Codex session UUID")).toHaveCount(0);
  await expect(page.locator(".agent-connect code")).toHaveCount(0);
});

test("acknowledgements and replies update with the event stream unavailable, preserving the draft and page", async ({
  page,
  request,
}) => {
  // Model an unavailable SSE connection, not a page reload.
  await page.addInitScript(() => {
    window.EventSource = class {
      onmessage = null;
      onopen = null;
      close() {}
    } as unknown as typeof EventSource;
  });
  const a = await (
    await request.post("/api/artifacts", {
      data: {
        title: "Offline event stream",
        content: {
          kind: "html",
          entry: "index.html",
          files: {
            "index.html":
              '<h1>Keep this page open</h1><input aria-label="Artifact input">',
          },
        },
      },
    })
  ).json();
  const c = await (
    await request.post(`/api/artifacts/${a.id}/comments`, {
      data: { revision: 1, body: "Check acknowledgement", author: "You" },
    })
  ).json();
  await page.goto("/a/" + a.id);
  await page
    .frameLocator("iframe")
    .getByLabel("Artifact input")
    .fill("Keep my state");
  await page.getByRole("button", { name: "Comments (1)", exact: true }).click();
  const popup = page.getByRole("dialog", { name: "Comments", exact: true });
  await popup.getByLabel("Reply to comment").fill("Unsent reply");
  await expect(
    popup.getByText("Not yet acknowledged", { exact: true }),
  ).toBeVisible();
  await request.post(`/api/artifacts/${a.id}/comments/read`, { data: {} });
  await expect(popup.getByText("Acknowledged", { exact: true })).toBeVisible({
    timeout: 10000,
  });
  await request.patch(`/api/artifacts/${a.id}/comments/${c.id}`, {
    data: { reply: "Read your message", author: "Agent" },
  });
  await expect(popup.locator(".reply")).toContainText("Read your message", {
    timeout: 10000,
  });
  await expect(popup.getByLabel("Reply to comment")).toHaveValue(
    "Unsent reply",
  );
  await expect(
    page.frameLocator("iframe").getByLabel("Artifact input"),
  ).toHaveValue("Keep my state");
});
