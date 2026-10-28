import { render } from "../../src/server/render";
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { templates } from "../fixtures/examples";
import type { Content } from "../../src/shared/schema";

async function create(request: any, title: string, content: Content) {
  const response = await request.post("/api/artifacts", {
    data: { title, author: "Test agent", content },
  });
  expect(response.status()).toBe(201);
  return response.json();
}

test("agent-created artifacts fill the page; review and exports preserve interaction state", async ({
  page,
  request,
}) => {
  const a = await create(
    request,
    "A standalone dashboard",
    templates[0].content,
  );
  await page.goto("/a/" + a.id);
  const frame = page.frameLocator("iframe");
  await expect(
    frame.getByRole("heading", { name: "A little perspective." }),
  ).toBeVisible();
  await expect(page.locator("iframe")).toHaveCSS("width", "1440px");
  await expect(page.locator("iframe")).toHaveCSS("height", "956px");
  expect(await page.locator("iframe").boundingBox()).toEqual({
    x: 0,
    y: 44,
    width: 1440,
    height: 956,
  });
  await expect(
    page.getByRole("banner", { name: "Artifact toolbar" }),
  ).toBeVisible();
  await expect(page.locator(".review-panel")).toHaveCount(0);
  await expect(page.locator(".review-menu")).toHaveCount(0);
  await expect(page.locator(".sidebar")).toHaveCount(0);
  await frame.getByLabel("Period").selectOption("3 months");
  await page.getByRole("button", { name: "Comment on an element" }).click();
  await expect(page.locator(".review-panel")).toHaveCount(0);
  await expect(frame.locator("html")).toHaveCSS("cursor", "crosshair");
  await frame.getByRole("heading", { name: "A little perspective." }).click();
  await expect(page.locator(".selected-quote")).toContainText(
    "A little perspective.",
  );
  await page
    .getByLabel("Comment", { exact: true })
    .fill("Change the heading to A clearer picture.");
  await page.getByRole("button", { name: "Send comment", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Comments", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".comment")).toContainText("Not yet acknowledged");
  const comments = await (
    await request.get(`/api/artifacts/${a.id}/comments`)
  ).json();
  const r = await (
    await request.get(`/api/artifacts/${a.id}/revisions/1`)
  ).json();
  r.content.files["App.tsx"] = r.content.files["App.tsx"].replace(
    "A little perspective.",
    "A clearer picture.",
  );
  const updated = await request.post(`/api/artifacts/${a.id}/revisions`, {
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
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.getByRole("button", { name: /Revision 1 Initial/ }).click();
  await expect(
    frame.getByRole("heading", { name: "A little perspective." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Return to latest" }).click();
  await expect(
    frame.getByRole("heading", { name: "A clearer picture." }),
  ).toBeVisible();
  await frame.getByLabel("Period").selectOption("3 months");
  if (
    !(await page
      .getByRole("button", { name: "Source", exact: true })
      .isVisible())
  )
    await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await expect(page.getByLabel("Read-only source")).toContainText(
    "A clearer picture.",
  );
  await expect(page.getByRole("button", { name: "Save revision" })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save as HTML" }).click();
  const html = await readFile((await (await dl).path())!, "utf8");
  const standalone = await page.context().newPage();
  await standalone.route("**/*", (route) => route.abort());
  await standalone.setContent(html);
  await expect(
    standalone.frameLocator("iframe").getByLabel("Period"),
  ).toHaveValue("3 months");
  await standalone
    .frameLocator("iframe")
    .getByLabel("Period")
    .selectOption("6 months");
  const workspaceControls =
    ".review-controls, .review-menu, .review-panel, .revision-banner, .selection-banner";
  await expect(standalone.locator(workspaceControls)).toHaveCount(0);
  await expect(
    standalone.frameLocator("iframe").locator(workspaceControls),
  ).toHaveCount(0);
  await expect(
    standalone.getByRole("banner", { name: "Artifact toolbar" }),
  ).toHaveCount(0);
  expect(await standalone.locator("iframe").boundingBox()).toEqual({
    x: 0,
    y: 0,
    width: 1440,
    height: 1000,
  });
  await standalone.close();
  const pdfDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save as PDF" }).click();
  const pdf = await readFile((await (await pdfDownload).path())!);
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  await page.getByRole("button", { name: "Close panel" }).click();
  await expect(page.locator(".review-panel")).toHaveCount(0);
  await expect(frame.getByLabel("Period")).toHaveValue("3 months");
  expect(await page.locator("iframe").boundingBox()).toEqual({
    x: 0,
    y: 44,
    width: 1440,
    height: 956,
  });
  await expect(page.getByRole("status")).toHaveCount(0);
  await page.screenshot({
    path: "test-results/standalone-artifact.png",
    fullPage: true,
  });
});

test("rich visual examples render without runtime errors", async ({
  page,
  request,
}) => {
  for (const example of templates.slice(1)) {
    const a = await create(request, example.name, example.content);
    await page.goto("/a/" + a.id);
    const frame = page.frameLocator("iframe");
    await expect(frame.locator("body")).not.toBeEmpty();
    if (example.name === "Flow diagram")
      await expect(frame.locator("svg")).toBeVisible();
    if (example.name === "Written document")
      await expect(frame.locator(".katex")).toBeVisible();
    if (example.name === "Interactive canvas")
      await expect(frame.locator("canvas")).toBeVisible();
    if (example.name === "Presentation") {
      await expect(
        frame.getByRole("heading", { name: "Make room for ideas." }),
      ).toBeVisible();
      await frame.getByRole("button", { name: "Next" }).click();
      await expect(
        frame.getByRole("heading", { name: "Create. Review. Refine." }),
      ).toBeVisible();
    }
    await page.getByRole("button", { name: "More actions" }).click();
    await expect(page.locator(".runtime-errors")).toHaveCount(0);
  }
});

test("HTML assets, persistent data, and highlighted comments work inside isolation", async ({
  page,
  request,
}) => {
  const content: Content = {
    kind: "html",
    entry: "index.html",
    files: {
      "index.html":
        '<h1 id="heading">A local image</h1><img src="image.svg" width="40"><button id="count">0</button><script>const b=document.getElementById("count");window.atelier.getData().then(d=>b.textContent=d?.count||0);b.onclick=async()=>{b.textContent=Number(b.textContent)+1;await window.atelier.setData({count:Number(b.textContent)})}</script>',
      "image.svg":
        '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="18" fill="green"/></svg>',
    },
  };
  const a = await create(request, "Local assets", content);
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
  await frame.locator("h1").evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  });
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.locator(".selected-quote")).toContainText("A local image");
  expect(
    await frame.locator("body").evaluate(() => {
      try {
        return parent.document.body.innerHTML;
      } catch {
        return "isolated";
      }
    }),
  ).toBe("isolated");
});

test("the library receives agent creations and has no authoring controls", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("button", {
      name: /^(new artifact|create artifact|create an artifact|import|template)$/i,
    }),
  ).toHaveCount(0);
  await expect(page.locator("input[type=file]")).toHaveCount(0);
  const title = "Agent report " + Date.now();
  const a = await create(request, title, {
    kind: "markdown",
    entry: "report.md",
    files: {
      "report.md": "# An agent-made report\n\nCreated through the API.",
    },
  });
  await page.getByLabel("Search artifacts").fill(title);
  await page
    .getByRole("button", { name: `Open ${title}`, exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/a/${a.id}$`));
  await expect(
    page
      .frameLocator("iframe")
      .getByRole("heading", { name: "An agent-made report" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "More actions" }).click();
  if (
    !(await page
      .getByRole("button", { name: "Source", exact: true })
      .isVisible())
  )
    await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await expect(page.getByLabel("Read-only source")).toContainText(
    "Created through the API.",
  );
  await expect(page.locator("textarea")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /save revision|restore|duplicate/i }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator(".review-panel")).toHaveCount(0);
  await expect(page.locator(".review-menu")).toHaveCount(0);
});

test("text, charts, diagrams, and animation coexist in one artifact", async ({
  page,
  request,
}) => {
  const a = await create(request, "A living field guide", {
    kind: "react",
    entry: "App.tsx",
    files: {
      "App.tsx": `import React,{useEffect,useRef} from 'react';import {LineChart,Line,XAxis} from 'recharts';import mermaid from 'mermaid';export default function App(){const diagram=useRef(null),canvas=useRef(null);useEffect(()=>{mermaid.initialize({startOnLoad:false,theme:'neutral'});mermaid.render('mixed-diagram','graph LR; A[Observe] --> B[Explore]; B --> C[Understand];').then(({svg})=>diagram.current.innerHTML=svg);const ctx=canvas.current.getContext('2d');let id;function draw(t){ctx.fillStyle='#243e3a';ctx.fillRect(0,0,500,120);ctx.fillStyle='#b4c89e';for(let i=0;i<35;i++){ctx.beginPath();ctx.arc(i*15,60+Math.sin(i*.3+t*.001)*25,3,0,7);ctx.fill()}canvas.current.dataset.frame=String(t);id=requestAnimationFrame(draw)}id=requestAnimationFrame(draw);return()=>cancelAnimationFrame(id)},[]);return <main style={{maxWidth:1000,margin:'auto',padding:60,fontFamily:'system-ui',color:'#344b40'}}><small>FIELD NOTES / 001</small><h1 style={{font:'48px Georgia'}}>A living field guide.</h1><p>One page can tell a story through words, data, diagrams, and motion.</p><section style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:40,marginTop:50}}><div><h2>See a pattern</h2><LineChart width={380} height={180} data={[{x:'May',y:12},{x:'Jun',y:35},{x:'Jul',y:22},{x:'Aug',y:51}]}><XAxis dataKey="x"/><Line dataKey="y" stroke="#6c8c57" isAnimationActive={false}/></LineChart></div><div><h2>Follow an idea</h2><div ref={diagram}/></div></section><h2>Watch it move</h2><canvas ref={canvas} width={500} height={120} style={{width:'100%',borderRadius:10}}/><p style={{fontSize:12,color:'#98a687'}}>Created by an agent. Reviewed in atelier.</p></main>}`,
    },
  });
  await page.goto("/a/" + a.id);
  const frame = page.frameLocator("iframe");
  await expect(
    frame.getByRole("heading", { name: "A living field guide." }),
  ).toBeVisible();
  await expect(frame.locator(".recharts-surface")).toBeVisible();
  await expect(frame.locator("#mixed-diagram")).toBeVisible();
  await expect(frame.locator("canvas")).toBeVisible();
  const first = await frame.locator("canvas").getAttribute("data-frame");
  await expect
    .poll(() => frame.locator("canvas").getAttribute("data-frame"))
    .not.toBe(first);
  await page.screenshot({
    path: "test-results/mixed-artifact.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: /^Comments/ }).click();
  await page.screenshot({
    path: "test-results/mixed-artifact-review.png",
    fullPage: true,
  });
});

test("Pele diagrams work in React, Markdown, and offline HTML exports", async ({
  page,
  request,
}) => {
  const content: Content = {
    kind: "react",
    entry: "App.tsx",
    files: {
      "App.tsx": `import React,{useEffect,useRef} from 'react';import {mount} from 'pele';export default function App(){const ref=useRef(null);useEffect(()=>{const diagram=mount(ref.current,'flowchart LR; A[Input] --> B[Output]');return()=>diagram.destroy()},[]);return <main style={{padding:24}}><h1>Pele diagram</h1><div ref={ref} style={{'--pele-surface':'#e3eed6'}}/></main>}`,
    },
  };
  const a = await create(request, "Pele integration", content);
  await page.goto("/a/" + a.id);
  const frame = page.frameLocator("iframe");
  await expect(frame.locator("svg.pele")).toBeVisible();
  await expect(frame.locator("svg.pele")).toContainText("Input");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(frame.locator("svg.pele")).toBeVisible();
  expect(
    await frame.locator("body").evaluate((el) => el.scrollWidth > innerWidth),
  ).toBe(false);
  const htmlResponse = await request.post(`/api/artifacts/${a.id}/export`, {
    data: { revision: 1, format: "html" },
  });
  expect(htmlResponse.ok()).toBe(true);
  const standalone = await page.context().newPage();
  await standalone.route("**/*", (route) => route.abort());
  await standalone.setContent(await htmlResponse.text());
  await expect(
    standalone.frameLocator("iframe").locator("svg.pele"),
  ).toBeVisible();
  await standalone.close();
  const md = await create(request, "Markdown with diagrams", {
    kind: "markdown",
    entry: "report.md",
    files: {
      "report.md":
        "# Two diagrams\n\n```mermaid\nflowchart LR\n A[First] --> B[Second]\n```\n\n```mermaid\nsequenceDiagram\n Alice->>Bob: Hello\n```",
    },
  });
  await page.goto("/a/" + md.id);
  await expect(frame.locator("svg.pele")).toHaveCount(2);
  await expect(frame.locator("svg.pele").first()).toBeVisible();
  const pdf = await request.post(`/api/artifacts/${md.id}/export`, {
    data: { revision: 1, format: "pdf" },
  });
  expect(pdf.ok()).toBe(true);
  expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");
});

test("Google Fonts load in previews and HTML exports while other requests stay blocked", async ({
  page,
  request,
}) => {
  const font = await readFile(
    "node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2",
  );
  let fontRequests = 0;
  const unexpected: string[] = [];
  await page.route("https://**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "https://fonts.googleapis.com") {
      return route.fulfill({
        contentType: "text/css",
        body: "@font-face{font-family:TestFont;src:url(https://fonts.gstatic.com/test.woff2)} h1{font-family:TestFont}",
      });
    }
    if (url.origin === "https://fonts.gstatic.com") {
      fontRequests++;
      return route.fulfill({
        contentType: "font/woff2",
        headers: { "access-control-allow-origin": "*" },
        body: font,
      });
    }
    unexpected.push(url.href);
    await route.abort();
  });
  const a = await create(request, "Google Fonts", {
    kind: "html",
    entry: "index.html",
    files: {
      "index.html": `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=TestFont"><link rel="stylesheet" href="https://blocked.example/style.css"><h1>Font test</h1><script>fetch('https://fonts.googleapis.com/blocked-fetch').catch(()=>{});fetch('https://blocked.example/data').catch(()=>{});</script>`,
    },
  });
  await page.goto("/a/" + a.id);
  await expect(
    page.frameLocator("iframe").getByRole("heading", { name: "Font test" }),
  ).toBeVisible();
  const frame = page.frames().find((frame) => frame.url() === "about:srcdoc")!;
  await frame.evaluate(() => document.fonts.ready);
  expect(
    await frame.evaluate(() =>
      [...document.fonts].some(
        (font) => font.family === "TestFont" && font.status === "loaded",
      ),
    ),
  ).toBe(true);
  const exported = await request.post(`/api/artifacts/${a.id}/export`, {
    data: { format: "html", revision: 1 },
  });
  expect(exported.ok()).toBe(true);
  await page.goto("about:blank");
  await page.setContent(await exported.text());
  await page.frameLocator("iframe").locator("h1").waitFor();
  const exportedFrame = page
    .frames()
    .find((frame) => frame.parentFrame() === page.mainFrame())!;
  await exportedFrame.evaluate(() => document.fonts.ready);
  expect(
    await exportedFrame.evaluate(() =>
      [...document.fonts].some(
        (font) => font.family === "TestFont" && font.status === "loaded",
      ),
    ),
  ).toBe(true);
  expect(fontRequests).toBe(2);
  expect(unexpected).toEqual([]);
});

for (const fullDocument of [false, true]) {
  test(`HTML ${fullDocument ? "documents" : "fragments"} preserve styles, runtime, and interactions`, async ({
    page,
    request,
  }) => {
    const head =
      "<title>HTML contract</title><style>.content{color:rgb(20, 60, 90)}</style><script>window.runtimeReady = !!window.atelier;</script>";
    const body =
      "<main class=\"content\"><h1>HTML contract</h1><button onclick=\"this.textContent = window.runtimeReady ? 'Ready' : 'Missing runtime'\">Check runtime</button></main>";
    const source = fullDocument
      ? `<!doctype html><html lang="fr"><head>${head}</head><body class="authored">${body}</body></html>`
      : head + body;
    const artifact = await create(request, "HTML contract", {
      kind: "html",
      entry: "index.html",
      files: { "index.html": source },
    });
    await page.goto("/a/" + artifact.id);
    const frame = page.frameLocator("iframe");
    await expect(frame.locator("h1")).toHaveCSS("color", "rgb(20, 60, 90)");
    await frame.getByRole("button", { name: "Check runtime" }).click();
    await expect(
      frame.getByRole("button", { name: "Ready", exact: true }),
    ).toBeVisible();
    if (fullDocument) {
      await expect(frame.locator("html")).toHaveAttribute("lang", "fr");
      await expect(frame.locator("body")).toHaveClass("authored");
    }
    const exported = await request.post(
      `/api/artifacts/${artifact.id}/export`,
      { data: { format: "html", revision: 1 } },
    );
    expect(exported.ok()).toBe(true);
    await page.goto("about:blank");
    await page.setContent(await exported.text());
    await expect(page).toHaveTitle("HTML contract");
    await page
      .frameLocator("iframe")
      .getByRole("button", { name: "Check runtime" })
      .click();
    await expect(
      page
        .frameLocator("iframe")
        .getByRole("button", { name: "Ready", exact: true }),
    ).toBeVisible();
    await expect(page.frameLocator("iframe").locator("h1")).toHaveCSS(
      "color",
      "rgb(20, 60, 90)",
    );
  });
}

test("verified CDN scripts execute offline but cannot load runtime dependencies", async ({
  page,
}) => {
  const originalFetch = globalThis.fetch;
  const declared =
    "https://cdn.jsdelivr.net/npm/atelier-cdn-test@1.2.3/dist/index.js";
  const source = `window.cdnLoaded = true;
    const script = document.createElement('script'); script.src = 'https://cdn.jsdelivr.net/npm/extra@1.2.3/index.js'; document.head.append(script);
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'https://cdnjs.cloudflare.com/ajax/libs/extra/1.2.3/style.css'; document.head.append(css);
    const image = new Image(); image.src = 'https://cdn.jsdelivr.net/npm/extra@1.2.3/map.png';
    new FontFace('Extra', 'url(https://unpkg.com/extra@1.2.3/font.woff2)').load().catch(()=>{});
    fetch('https://unpkg.com/extra@1.2.3/data.json').catch(()=>{});
    try { new Worker('https://cdn.jsdelivr.net/npm/extra@1.2.3/worker.js'); } catch {}
    try { new Worker(URL.createObjectURL(new Blob(['postMessage("worker")']))); } catch {}
    `;
  let html: string;
  try {
    globalThis.fetch = (async (input) => {
      if (String(input).startsWith("https://registry.npmjs.org/"))
        return Response.json({
          versions: { "1.2.3": {} },
          time: { "1.2.3": "2020-01-01" },
        });
      expect(String(input)).toBe(declared);
      return new Response(source, {
        headers: { "content-type": "application/javascript" },
      });
    }) as typeof fetch;
    html = await render(
      {
        kind: "html",
        entry: "index.html",
        files: {
          "index.html": `<script src="${declared}"></script><button onclick="this.textContent=window.cdnLoaded?'Loaded':'Missing'">Check CDN</button>`,
        },
      },
      { id: "cdn-test", revision: 1, standalone: true },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  const network: string[] = [];
  await page.route("https://**/*", async (route) => {
    network.push(route.request().url());
    await route.abort();
  });
  await page.setContent(html);
  await page
    .frameLocator("iframe")
    .getByRole("button", { name: "Check CDN" })
    .click();
  await expect(
    page
      .frameLocator("iframe")
      .getByRole("button", { name: "Loaded", exact: true }),
  ).toBeVisible();
  expect(network).toEqual([]);
  expect(page.workers()).toHaveLength(0);
});

for (const prefix of ["", "<style>h1{color:teal}</style>"]) {
  test(`leading fragment scripts can access the body${prefix ? " after styles" : ""}`, async ({
    page,
    request,
  }) => {
    const artifact = await create(request, "Body context", {
      kind: "html",
      entry: "index.html",
      files: {
        "index.html": `${prefix}<script>document.body.dataset.initialized='yes';window.literal='<html><head><body>';</script><h1>Body context</h1>`,
      },
    });
    await page.goto("/a/" + artifact.id);
    await expect(page.frameLocator("iframe").locator("body")).toHaveAttribute(
      "data-initialized",
      "yes",
    );
    const exported = await request.post(
      `/api/artifacts/${artifact.id}/export`,
      { data: { format: "html", revision: 1 } },
    );
    expect(exported.ok()).toBe(true);
    await page.goto("about:blank");
    await page.setContent(await exported.text());
    await expect(page.frameLocator("iframe").locator("body")).toHaveAttribute(
      "data-initialized",
      "yes",
    );
  });
}

test("explicit full-document head scripts keep their authored execution order", async ({
  page,
  request,
}) => {
  const artifact = await create(request, "Head context", {
    kind: "html",
    entry: "index.html",
    files: {
      "index.html":
        "<!doctype html><html><head><script>window.bodyWasAbsent=document.body===null;</script></head><body><script>document.body.dataset.headOrder=String(window.bodyWasAbsent);</script><h1>Head context</h1></body></html>",
    },
  });
  await page.goto("/a/" + artifact.id);
  await expect(page.frameLocator("iframe").locator("body")).toHaveAttribute(
    "data-head-order",
    "true",
  );
});

test("comment events reuse immutable source and unrelated events do not reload the viewer", async ({
  page,
  request,
}) => {
  const content: Content = {
    kind: "html",
    entry: "index.html",
    files: { "index.html": "<h1>Efficient viewer</h1>" },
  };
  const a = await create(request, "Target", content);
  const b = await create(request, "Other", content);
  await page.goto(`/a/${a.id}`);
  await expect(page.frameLocator("iframe").getByRole("heading")).toHaveText(
    "Efficient viewer",
  );
  const reads: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "GET" && r.url().includes("/api/artifacts"))
      reads.push(new URL(r.url()).pathname);
  });
  await request.patch(`/api/artifacts/${b.id}`, {
    data: { title: "Unrelated rename" },
  });
  await page.waitForTimeout(200);
  expect(reads.filter((url) => !url.endsWith("/feedback"))).toEqual([]);
  await request.post(`/api/artifacts/${a.id}/comments`, {
    data: { revision: 1, body: "New comment" },
  });
  await expect(
    page.getByRole("button", { name: "Comments (1)", exact: true }),
  ).toBeVisible();
  expect(reads.some((url) => url.includes("/revisions"))).toBe(false);
  expect(reads.includes("/api/artifacts")).toBe(false);
});

test("local HTML scripts preserve execution order and CSS resolves nested assets", async ({
  page,
}) => {
  const html = await render(
    {
      kind: "html",
      entry: "index.html",
      files: {
        "index.html": `<script src="./dep.js"></script><script>window.observed=window.dep;window.literal='src="image.svg"';</script><link rel="stylesheet" href="styles/main.css"><div id="image">Asset</div>`,
        "dep.js": "window.dep=42;",
        "styles/main.css": '#image{background-image:url("../image.svg")}',
        "image.svg":
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>',
      },
    },
    { id: "order", revision: 1, standalone: true, freeze: true },
  );
  await page.setContent(html);
  expect(await page.evaluate(() => (window as any).observed)).toBe(42);
  expect(await page.evaluate(() => (window as any).literal)).toBe(
    'src="image.svg"',
  );
  await expect(page.locator("#image")).toHaveCSS(
    "background-image",
    /data:image\/svg\+xml;base64/,
  );
});
