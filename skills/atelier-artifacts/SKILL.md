---
name: atelier-artifacts
description: Create and revise interactive pages in Atelier through its MCP tools, including changes requested in artifact comments. Use when the user wants an Atelier artifact, dashboard, report, diagram, or interactive explanation. Not for developing the Atelier service itself or building an unrelated website.
---

# Atelier artifacts

Make the document the user asked for. One artifact can mix prose, diagrams, charts, images, forms, and animation; there are no required templates or sections. The agent authors the artifact. The human views it, comments, and shares it.

## Choose the format

- Use React for linked charts, filters, reusable components, or substantial interactive state. The entry file must default-export a component.
- Use HTML for a document with custom styling and lighter interactions. Write a page fragment with optional style and script tags. Atelier supplies the document shell, runtime, and security policy. Full documents also work. Put code that accesses an element after its markup, or wait for the DOM.
- Use Markdown for prose, tables, math, and Mermaid fences when custom layout or controls are unnecessary.
- Use SVG for a self-contained vector illustration or diagram.

Respect an existing artifact's format unless the requested change needs another. Do not reproduce Atelier's header, review buttons, comment UI, or library inside the artifact. Design for the available viewport; exports have no workspace controls.

## Create or revise through the tools

Use the connected Atelier MCP tools. Tool names may have a client-specific server prefix; inspect their schemas rather than assuming argument shapes. The local Atelier service must be running. The skill does not install or connect it.

For new work, call `create_artifact` with a descriptive title, your agent name as `author`, and exactly one source form: inline `content` (`kind`, `entry`, `files`), an absolute `filePath`, or a `filePaths` map from artifact-relative names to absolute local paths with `entry` and optional `kind`. Prefer path inputs for files already on disk, especially large pages; do not repeat their contents in a tool call. Paths are relative to the artifact; `entry` must exist in `files`. Inline file contents are strings; the path loader encodes image and font binaries as data URLs. Paths are read on the MCP host. Include every required local asset.

For an amendment:

1. Use the ID from the user's URL or conversation. Use `list_artifacts` only if you need to locate it; do not guess between ambiguous matches.
2. Read `get_artifact` for the latest source and revision, then `list_comments`. Check a comment's revision and selected quote before applying it to the current content.
3. Preserve the stable ID, unrelated content, and useful element IDs or `data-atelier-id` anchors. Change the requested parts without replacing the design unnecessarily.
4. Call `revise_artifact` with the current `baseRevision`, a concise change summary, the complete updated content object, and the `commentIds` actually addressed. Files are replaced as a set, not patched or merged by the service.
5. If there is a revision conflict, read the latest source and reconcile it before retrying. Do not overwrite concurrent changes or create a new artifact to bypass the conflict.

Use `reply_to_comment` for a useful reply or `in_progress` status. Linking comments to a revision marks them ready for review; leave resolution to the user unless asked to resolve them. Comments do not wake an agent automatically. Use `duplicate_artifact` only when the user wants a separate copy, and `restore_artifact` for an intentional rollback.

## Work within the runtime

Code runs in an isolated browser, without host filesystem access or arbitrary package installation. Fetch data outside the artifact using authorized agent tools, then include the needed data in its files. Do not design an artifact around live external API calls.

React can import `react`, `react-dom`, `recharts`, `d3`, `lucide-react`, `pele`, `mermaid`, and `katex`, plus local files. Prefer Pele for Mermaid diagrams. Markdown Mermaid fences render automatically; in React, clean up Pele's `mount()` handle when the component unmounts.

HTML can declare scripts from `cdnjs.cloudflare.com`, `cdn.jsdelivr.net/npm/`, `unpkg.com`, `cdn.tailwindcss.com`, and `code.jquery.com`. Use an exact version published at least 14 days ago and an explicit JavaScript file; Tailwind uses `/VERSION`. Atelier verifies the date and embeds that file. Unknown dates, version ranges, unversioned URLs, query parameters, and redirects are rejected. Choose a self-contained browser build: additional scripts, workers, font files, map tiles, or API data fetched by a library are blocked.

External stylesheets are limited to Google Fonts (`fonts.googleapis.com`, with font files from `fonts.gstatic.com`). Inline and artifact-local CSS work. Google Fonts need internet access in shared HTML; use system fonts or embedded fonts for offline fidelity. Images must be embedded data URLs or included files, not remote URLs. Video and embedded external pages are out of scope. External navigation is blocked; use in-page links for document navigation.

## Design for reading and use

Let the content determine the layout. Use readable type, a clear hierarchy, responsive charts, and deliberate spacing. Avoid generic app navigation and decorative dashboards when the request is a document. Label inputs, keep keyboard focus visible, and communicate chart values with labels or a textual summary as well as color. Allow a narrow layout to stack without clipping. Respect reduced-motion preferences for animation.

Separate supplied facts from illustrative data. Do not invent measurements to fill a chart. Preserve the user's wording and visual direction when revising.

## Preserve state and sharing

Use `window.atelier.getData()` and `setData(value)` for persistent JSON app data. Both are asynchronous. Handle loading and save errors; direct `localStorage` access is unavailable inside the sandbox.

Use `getState()` to initialize UI state from an export snapshot and `setState(value)` to register the current serializable UI state. `setState` does not save to the database. Browser exports capture ordinary form values automatically; charts and custom controls should register the state needed to reproduce what the user sees.

HTML exports retain supported interactions. PDF exports are static, use print CSS and pagination, and cannot show a click-through sequence. When PDF matters, make important content visible in print, hide purely interactive controls, and avoid fixed-height containers that clip it. Neither export includes Atelier's review controls.

Read [examples.md](references/examples.md) when you need a content payload, HTML interaction, React state, diagram lifecycle, or print pattern. Adapt the patterns; they are not templates to impose on every artifact.

## Check and deliver

Inspect the `preview` result returned by each publication. The revision is saved even if the check fails or is unavailable. Fix reported errors under the same artifact ID. Use `check_artifact` to retry, check a narrow viewport, or request `screenshot: true` for a rendered image. A passing load check does not prove visual quality or interactions. If browser tools are available, open the returned workspace URL and exercise the important interaction. For sharing tasks, also open the exported HTML or inspect the PDF; preview success alone does not prove export fidelity. Do not open the internal `/preview/` endpoint as a top-level page.

Fix problems attributable to your change and revise the same artifact. If a tool or visual check is unavailable, state that limitation rather than claiming it passed. Return the actual artifact URL and a brief description of what changed. Do not present a localhost URL as a publicly hosted share link; recipients need the exported document.
