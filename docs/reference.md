# atelier reference

This document describes atelier's runtime, artifact format, and agent interfaces. The [README](../README.md) covers setup and review.

## Runtime and storage

The service binds to `127.0.0.1`. MCP responses use `atelier.localhost` for browser links when the service address is `127.0.0.1` or `localhost`, preserving the configured port. The browser app and API use port `4310`. Artifact previews load as sandboxed inline documents with opaque origins. The legacy preview port (`4311`) rejects direct preview URLs.

The default database is `~/.atelier/atelier.sqlite`. SQLite stores artifact metadata, complete source revisions, comments, and app data. Revision content and metadata commit in one transaction. A file-copy backup requires the service to be stopped and the complete data directory to be copied.

The `start` command runs in the foreground and opens the browser. `start --no-open` and `npm start` run without opening the browser. `npm link` makes the `atelier` command available globally. `atelier install-browser` installs Chromium for preview checks and PDF export. See the [installation guide](../README.md#install-and-start) for setup instructions.

Environment variables control the service and its clients:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ATELIER_PORT` | `4310` | Browser app and API port |
| `ATELIER_PREVIEW_PORT` | `ATELIER_PORT + 1` | Legacy port that rejects executable preview URLs |
| `ATELIER_DATA_DIR` | `~/.atelier` | Database directory |
| `ATELIER_URL` | `http://127.0.0.1:4310` | HTTP loopback origin for CLI and MCP clients; follows `ATELIER_PORT` when set |

## Artifacts and revisions

An artifact has a stable `id`. Its `head` identifies the latest revision.

| URL | Content |
| --- | --- |
| `/` | Library of agent-created artifacts |
| `/a/<id>` | Latest revision |
| `/a/<id>/revisions/<number>` | Specified revision |

Each artifact fills the space below a thin, pinned header. The header shows the artifact title, revision, and a link back to the library. Comments, element selection, history, and sharing are available directly in the header. Source, Rename, and Delete are under More actions. Review panels sit beside the artifact on desktop and overlay it on narrow screens. Closing a panel preserves the artifact's live state.

Agents own all authoring. The browser provides no creation form, template picker, source editor, restore action, or duplicate action.

A revision contains the full source, an author, a timestamp, a summary, and any addressed comment IDs. Revisions are immutable. An update requires `baseRevision`; a stale value returns HTTP `409`. Restoring an earlier revision creates a new revision. Duplicating an artifact creates a separate ID.

### Content object

The `content` object identifies the format, entry file, and source files:

```json
{
	"kind": "react",
	"entry": "App.tsx",
	"files": {
		"App.tsx": "export default function App() { return <h1>Report</h1> }"
	}
}
```

The schema is defined in [src/shared/schema.ts](../src/shared/schema.ts).

| Field | Constraint |
| --- | --- |
| `kind` | `react`, `html`, `markdown`, or `svg` |
| `entry` | A path present in `files` |
| `files` | Between 1 and 100 files, with string contents |
| File path | Relative, at most 240 characters; no backslashes, empty segments, `.` segments, or `..` segments |

React entries default-export a component. Relative imports can reference other files in the artifact, including CSS. Use literal paths, including with `import()`: computed imports cannot load files from the service filesystem. Write HTML as a page fragment, with optional `<style>` and `<script>` tags. atelier supplies `<!doctype html>`, `<html>`, `<head>`, `<body>`, the security policy, and the runtime. HTML supports inline scripts and references to local script and style files.

Full HTML documents are also accepted. atelier merges their head content and document attributes into one shell, preserving titles, styles, scripts, and body content. atelier controls charset, viewport, and security policy metadata.

```html
<style>h1 { color: coral; }</style>
<h1>Report</h1>
<p>Content goes here.</p>
```

Images can be data URLs or files in the content object. SVG files contain SVG text. Other image files contain data URLs. React can import these files as strings; HTML can reference them by relative path.

React and HTML support mixed content in a single artifact. Markdown supports tables, code blocks, KaTeX math, and Mermaid code fences. SVG artifacts render the supplied SVG source.

### CDN scripts

HTML artifacts can declare scripts from these HTTPS sources:

| Source | URL form |
| --- | --- |
| cdnjs | `https://cdnjs.cloudflare.com/ajax/libs/LIBRARY/VERSION/FILE.js` |
| jsDelivr npm | `https://cdn.jsdelivr.net/npm/PACKAGE@VERSION/FILE.js` |
| UNPKG | `https://unpkg.com/PACKAGE@VERSION/FILE.js` |
| Tailwind | `https://cdn.tailwindcss.com/VERSION` |
| jQuery | `https://code.jquery.com/jquery-VERSION.min.js` |
| jQuery UI | `https://code.jquery.com/ui/VERSION/jquery-ui.min.js` |

Use an exact version published at least 14 days ago. Tags, version ranges, unversioned URLs, query parameters, and redirects are rejected. npm publication metadata supplies the release date. For cdnjs, the library must have a verifiable npm source; use an npm CDN URL if it does not.

```html
<script src="https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js"></script>
<button id="example">Click me</button>
<script>$('#example').on('click', function () { $(this).text('Clicked'); });</script>
```

atelier downloads and embeds only the declared JavaScript file. Libraries cannot fetch extra scripts, workers, fonts, map tiles, or data at runtime. Use a self-contained browser build; module files with external imports will not work. External stylesheets are limited to Google Fonts, with font files from `fonts.gstatic.com`. Inline CSS and local CSS files remain supported.

The loader checks supplied `integrity` hashes, limits each script to 5 MiB, and accepts at most 16 CDN scripts per artifact. Verification failures appear as preview errors. Exported HTML embeds the scripts, so those scripts do not need a network connection after export. Google Fonts still require internet access.

### Supported libraries

The artifact bundler accepts these packages:

| Package | Use |
| --- | --- |
| `react`, `react-dom` | Components and interactive controls |
| `recharts`, `d3` | Charts and data visualization |
| `lucide-react` | Icons |
| `pele` | Preferred renderer for Mermaid syntax |
| `mermaid` | Compatibility with existing artifacts |
| `katex` | Mathematical notation |

The package allowlist is in [src/server/render.ts](../src/server/render.ts). Installed versions are pinned by `package-lock.json`. Dependency upgrades can change the rendering of existing revisions.

### Mermaid diagrams

[Pele](https://github.com/obsidianmd/pele) renders Mermaid syntax as SVG. Markdown `mermaid` code fences use Pele automatically, including in exports. Invalid syntax produces a preview error.

React artifacts can use Pele's `mount()` function. The returned handle provides `destroy()` for effect cleanup:

```jsx
import { useEffect, useRef } from "react";
import { mount } from "pele";

function Diagram({ source }) {
	const container = useRef(null);
	useEffect(() => {
		const diagram = mount(container.current, source);
		return () => diagram.destroy();
	}, [source]);
	return <div ref={container} />;
}
```

Pele reads CSS variables such as `--pele-fg`, `--pele-bg`, `--pele-surface`, `--pele-border`, and `--pele-line` from the container. Its `pele/core` and `pele/diagrams/<type>` imports support bundles with selected diagram types.

Pele has its own layout and visual style. Existing `mermaid` imports still use Mermaid.js.

## Comments

Highlighting text offers a nearby Comment button that opens a compact composer without opening the sidebar or resizing the artifact. The header provides element and section selection, with a blue outline before selection, and a Comments button with an unresolved count. Unresolved comments appear as highlights and numbered markers; clicking either opens the thread. Annotations do not appear in HTML or PDF exports.

A comment belongs to an artifact and a revision. Its optional anchor contains the selected quote, surrounding text, DOM selector, and element tag. New anchors also include `kind` (`text`, `element`, or `section`). Element and section anchors have an empty quote and a descriptive `label`; their annotations cover the whole element. Older anchors remain valid.

The browser locates a selection by its selector and quote. If the selector no longer matches, a unique quote can identify the element. Removed or ambiguous selections remain accessible through the original revision. Stable element IDs and `data-atelier-id` attributes improve matching.

Comment status has four values:

| Status | Browser label | Meaning |
| --- | --- | --- |
| `open` | Queued for agent | Feedback awaits an agent |
| `in_progress` | Being addressed | An agent has marked the thread as active |
| `addressed` | Ready for review | An agent has submitted a revision linked to the comment, or set this status |
| `resolved` | Resolved | The thread is closed |

Agents read comments through MCP, the CLI, or the API. `atelier agent` automatically connects artifacts created through its MCP connection to the creating session. `atelier watch` connects an existing artifact. Delivery uses Claude Code Channels, Codex queue for existing conversations, the Codex app server for managed sessions, or Copilot CLI ACP. See [automatic comment delivery](agent-feedback.md). A revision's `commentIds` marks linked, unresolved comments as `addressed`.

## Artifact state

The preview exposes `window.atelier`:

| Method | Behavior |
| --- | --- |
| `getData()` | Returns a promise for saved JSON data, or `null` |
| `setData(value)` | Saves JSON data for the artifact and returns a promise |
| `getState()` | Returns the UI state supplied by an export snapshot, or the latest value registered with `setState()` |
| `setState(value)` | Registers JSON UI state for export; does not save to the database |

Saved app data belongs to the artifact, separately from source revisions. Restoring source does not restore earlier app data. The service rejects app data when its serialized JSON exceeds `2 * 1024 * 1024` characters.

A saved counter uses the data methods:

```js
const data = await window.atelier.getData();
await window.atelier.setData({ count: (data?.count ?? 0) + 1 });
```

A React control can restore and register export state:

```jsx
const [period, setPeriod] = useState(
	window.atelier.getState()?.period ?? "6 months"
);
window.atelier.setState({ period });
```

## Exports

Both export formats use a specified source revision and the artifact's saved app data. Browser exports also capture ordinary form values and registered UI state. CLI exports use default UI state.

| Format | Behavior |
| --- | --- |
| HTML | Bundles supported dependencies and local assets into one interactive file |
| PDF | Uses Chromium, print CSS, and A4 pagination to render a static document |
| Source JSON | Contains the artifact's `content` object |

HTML exports include a copy of app data and render inside a sandboxed, full-page viewer without review controls. The viewer handles local browser storage where available; the artifact cannot access the parent page or write back to atelier. In-page links still work, while navigation to other pages is blocked.

atelier cannot infer arbitrary component state. Custom filters and slide selection require the export state methods. A presentation PDF captures the current slide. PDF captures canvas frames; HTML retains animation. WebGL capture depends on a readable drawing buffer.

Text remains selectable in PDF where the renderer supports it. Recipient viewport sizes and PDF pagination can change the layout. Exports omit atelier's review controls.

## Agent interfaces

MCP and the CLI call the same HTTP API. Their implementations are in [src/cli.ts](../src/cli.ts).

### MCP tools

The stdio server exposes these tools:

| Tool | Operation |
| --- | --- |
| `list_artifacts` | Lists artifacts and their current revisions |
| `get_artifact` | Reads metadata and complete revision content |
| `create_artifact` | Creates an artifact |
| `revise_artifact` | Saves a revision under the same ID |
| `restore_artifact` | Copies an earlier revision into a new revision |
| `duplicate_artifact` | Copies a revision into a separate artifact |
| `check_artifact` | Loads a revision in Chromium; optionally returns a screenshot |
| `list_revisions` | Reads revision history |
| `list_comments` | Reads feedback and replies |
| `add_comment` | Adds a comment to a specified revision |
| `reply_to_comment` | Adds a reply or changes comment status |

Create, get, revise, restore, and duplicate results include a browser URL. MCP write tools require an `author` for attribution. Tool annotations distinguish reads from writes. Failed tool calls return `isError` and an explanation. CLI and MCP requests reject redirects and non-loopback service addresses. A request timeout tells the agent to read the saved state before retrying a publication.

Creation and duplication results also include `feedback.connected`. A connected result has `target: "creating_session"`; a disconnected result includes `reason`. MCP `create_artifact` defaults `watch` to `true`. MCP creation accepts `feedbackSession`, the calling Codex agent's own thread UUID. With that field, the service connects the artifact to the existing conversation. Without an identity or a managed creator connection, the result reports disconnected and points to the viewer picker. A failed feedback connection does not undo the publication.

### Library previews

The home view displays cards with cached screenshots of the artifact content, without the workspace header. Default-viewport publish checks capture a preview for the current revision. Missing previews for older artifacts are generated as their cards become visible. Chromium must be installed; otherwise the cards show a placeholder.

Screenshots are stored locally with the artifact. A check for an older revision cannot overwrite the current preview. Rename preserves it; deletion removes it along with revisions, comments, and app data. Card actions and More actions both support Rename and Delete.

### Preview checks

Create, revise, restore, and duplicate responses include a `preview` result. atelier opens the saved revision in the real workspace using Chromium, waits for readiness, and reports runtime errors, console errors, failed requests, and horizontal overflow. It simulates app-data writes so the check cannot change saved data.

`preview.status` is `passed`, `failed`, or `unavailable`. Missing Chromium or a busy checker produces `unavailable`; install the browser with `atelier install-browser` or retry. The revision is already saved regardless of check status. Fix errors by revising the same artifact, not by repeating its creation.

The default viewport is 1280 × 900. Use `check_artifact` with `id`, optional `revision`, `width`, `height`, and `screenshot: true` to inspect another viewport. MCP returns the screenshot as an image alongside the report. The CLI can save it directly:

```sh
atelier check ARTIFACT_ID --width 390 --height 844 --screenshot preview.png
```

Checks run briefly after initial load. A pass is not a visual review or an interaction test; use the screenshot to inspect the layout and browser tools for deeper interaction testing. Two checks may run concurrently; additional calls report that the checker is busy.

### File inputs for MCP

`create_artifact` and `revise_artifact` accept exactly one source form:

- `content`: the existing inline content object.
- `filePath`: an absolute path to a source file or an existing JSON content manifest.
- `filePaths`: a map of artifact-relative names to absolute local paths, with an `entry` name and optional `kind`.

```json
{
	"title": "Report",
	"author": "My agent",
	"entry": "index.html",
	"filePaths": {
		"index.html": "/work/report/index.html",
		"styles.css": "/work/report/styles.css",
		"assets/chart.png": "/work/report/chart.png"
	}
}
```

Paths refer to the machine running the MCP process. Only explicitly named files are read; imports and directories are not collected automatically. Images and font binaries become data URLs. File inputs have a combined 30 MiB JSON budget and the same 100-file limit as inline content. The HTTP service still accepts content, not disk paths.

MCP and CLI publish results include the browser `url` and compact metadata without echoing the source. Use `get_artifact` or `atelier get` when you need the full source.

### CLI commands

`atelier doctor` checks the Node version, built workspace, service identity, and whether Chromium can start. A failed check exits with code 1. `--json` returns the checks as JSON. The command does not install software or start the service.

`atelier mcp-config codex`, `atelier mcp-config claude-desktop`, and `atelier mcp-config vscode` print client configuration with absolute paths and the current `ATELIER_URL`. They do not write client configuration files.


The command prefix is `node bin/atelier.mjs`, or `atelier` after `npm link`. The following examples use `atelier`:

```sh
atelier list
atelier create report.md --title "Research notes" --author "My agent"
atelier get ARTIFACT_ID
atelier comments ARTIFACT_ID
atelier revise ARTIFACT_ID report.md --base 1 --message "Clarify the introduction" --comments COMMENT_ID
atelier reply ARTIFACT_ID COMMENT_ID "Updated the introduction."
atelier history ARTIFACT_ID
atelier check ARTIFACT_ID
atelier export ARTIFACT_ID --format html --output report.html
```

The `create` and `revise` commands accept a source file or an existing JSON content manifest. Add files directly with repeated `--file` flags; no manifest is required:

```sh
atelier create report/index.html --title "Report" --file report/styles.css --file assets/chart.png=images/chart.png
atelier revise ARTIFACT_ID report/index.html --base 1 --message "Update chart" --file report/styles.css --file assets/chart.png=images/chart.png
```

Without a mapping, each additional file keeps its path relative to the entry file's directory. With `artifact/name=local/path`, the left side names it inside the artifact. Use `--entry` to override the entry name and `--kind` to override format inference. Include all files again when revising; the file set is replaced as a whole.

### HTTP API

Paths are relative to `/api`. Request and response bodies use JSON, except exports and the event stream. The implementation is in [src/server/app.ts](../src/server/app.ts).

| Method | Path | Operation |
| --- | --- | --- |
| GET | `/health` | Service status and preview port |
| GET | `/artifacts` | List artifacts |
| POST | `/artifacts` | Create an artifact |
| GET | `/artifacts/:id` | Read metadata and `head` |
| GET | `/artifacts/:id/thumbnail` | Read the current revision’s cached JPEG preview |
| PATCH | `/artifacts/:id` | Rename an artifact |
| DELETE | `/artifacts/:id` | Delete the artifact and its owned data |
| GET | `/artifacts/:id/revisions` | List revision metadata |
| POST | `/artifacts/:id/revisions` | Create a revision |
| GET | `/artifacts/:id/revisions/:n` | Read complete revision content |
| GET | `/artifacts/:id/revisions/:n/preview` | Read `{html}` for the workspace sandbox |
| POST | `/artifacts/:id/restore` | Restore a revision |
| POST | `/artifacts/:id/duplicate` | Duplicate a revision |
| GET | `/artifacts/:id/comments` | List comments |
| POST | `/artifacts/:id/comments` | Add a comment |
| PATCH | `/artifacts/:id/comments/:cid` | Add a reply or change status |
| GET | `/artifacts/:id/data` | Read `{data}` |
| PUT | `/artifacts/:id/data` | Write `{data}` |
| POST | `/artifacts/:id/export` | Export HTML or PDF |
| POST | `/artifacts/:id/check` | Check a revision in the workspace browser |
| GET | `/events` | Server-sent change events |

Write requests accept these fields:

| Operation | Required fields | Optional fields |
| --- | --- | --- |
| Create artifact | `title`, `content` | `description`, `author`, `summary` |
| Create revision | `baseRevision`, `summary`, `content` | `author`, `commentIds` |
| Rename artifact | `title` | None |
| Delete artifact | `baseRevision` | None |
| Restore revision | `revision`, `baseRevision` | `author` |
| Duplicate revision | `revision` | `author` |
| Add comment | `revision`, `body` | `author`, `anchor`, `notifyAgent` |
| Update comment | None | `reply`, `author`, `status`, `notifyAgent` |
| Write app data | `data` | None |
| Export | `revision`, `format` | `snapshot` |
| Preview check | None | `revision`, `width`, `height`, `screenshot` |

The export `format` is `html` or `pdf`. Validation errors return `400`, unknown artifacts or revisions return `404`, and revision conflicts return `409`. A missing Chromium installation returns `503` for PDF export. Server-side document rendering runs in separate processes, with at most two jobs, a 30-second deadline, Node's `--max-old-space-size=384` limit per process, and a 64 MiB output limit. An overloaded renderer returns `503`. A render timeout returns `504` on export, or a preview error in the workspace. Preview checks and PDF exports share at most two concurrent browser jobs. Up to 32 additional jobs wait in a bounded queue, with PDF exports taking priority; excess work or a queue wait over 30 seconds returns `503`. Identical in-flight jobs are shared. A job that exceeds 30 seconds is stopped and returns `504`. The API body limit is 32 MiB.

## Development commands

The package scripts are defined in [package.json](../package.json).

| Command | Result |
| --- | --- |
| `npm run build` | Type-checks the code and builds the browser app |
| `npm run dev` | Watches and restarts the service; serves the built browser app |
| `npx vite` | Runs the frontend development server at `http://127.0.0.1:5173` |
| `npm test` | Runs storage, renderer, API, and MCP integration tests |
| `npm run test:browser` | Runs browser tests for review, mixed content, isolation, and exports |
| `npm run format:check` | Checks source formatting |

Browser tests use separate ports and `.atelier/test` data. Screenshots and failure traces are written to `test-results/`.

## Execution limits

atelier is a local, single-user service. It has no public hosting, team accounts, agent execution engine, in-artifact model calls, external app connections, or video support.

Generated code runs in a sandboxed inline iframe without same-origin privileges. The workspace blocks all frame navigation, including navigation to other artifacts. Preview policy allows Google Fonts stylesheets from `https://fonts.googleapis.com` and font files from `https://fonts.gstatic.com`. Other network requests and embedded frames are blocked. The workspace and exported HTML viewer also restrict frame navigation, so artifacts cannot bypass the resource policy by replacing themselves with an external page. Rendered previews are delivered as JSON through the API and placed into the sandbox by the workspace; raw preview URLs cannot execute. PDF export allows the same font sources. HTML exports keep these remote font references and need internet access to load them; use embedded fonts when offline fidelity is required. Artifacts cannot install arbitrary packages or execute server code. Package imports reject traversal segments, computed imports are rejected before compilation and filesystem loads are limited to installed dependencies, and artifact titles are copied into HTML export wrappers as escaped text. Selection messages are validated. Element selections require selection mode; natural text selections offer a Comment button and require a user click before opening the composer. Annotation messages can open only existing comment IDs for the current artifact.

The API rejects unrecognized hostnames and disallowed origins. Local processes running as the same OS user are trusted. atelier is not a security boundary between users of the computer.

The [security model](security.md) describes the trusted components, resource limits, and remaining risks.

### Feedback delivery endpoints

`GET /api/agents/codex/sessions` lists up to 100 loaded Codex conversations with their ID, title, project directory, and state. It returns metadata, not transcripts. The viewer lists names and projects, without exposing a session-ID input.

`POST /api/artifacts/:id/feedback/codex` accepts `{ "session": "UUID" }` and starts forwarding in the atelier service. The selected conversation must already be loaded. The request accepts no command, environment, working directory, or socket path. The service allows up to 32 concurrent connections, stops them on shutdown, and does not restore them automatically after restart. Duplicate connects to the same conversation reuse the connection.

`atelier connect ID` reads `CODEX_THREAD_ID` from its caller's environment and requests that service-owned connection. CLI `create` does the same when the variable is present, unless `--no-watch` is passed.

All paths below are relative to `/api/artifacts/:id/feedback`. `notifyAgent` defaults to `false` on comment creation and update. The viewer sets it to `true` for user feedback. Feedback events and connection metadata persist in SQLite and are deleted with their artifact.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | Connection state and queued, delivered, and uncertain counts |
| POST | `/connect` | Claim the artifact with `provider` and `session`; returns a connection token |
| POST | `/heartbeat` | Renew the 30-second lease with `token` and `state` |
| POST | `/claim` | Claim up to 50 pending events with `token` |
| POST | `/finish` | Record delivery for `ids` with `token`; optional `error` makes them uncertain |
| POST | `/disconnect` | Disable delivery; a watcher supplies its token |
| POST | `/retry` | Explicitly requeue uncertain events |

A connection token fences queue operations, not every native agent tool. A disconnected or expired token cannot acknowledge a later connection's events. Delivery acknowledgements do not mark comments resolved. For an existing Codex conversation, delivered means accepted by its native queue, not a completed agent turn. Disconnecting cannot retract a message already queued there.

`atelier agent "REQUEST" --agent claude|codex|copilot --cwd PATH` creates through one foreground session and automatically connects its new artifacts. Codex and Copilot require the request; Claude can open an interactive session without one. `atelier watch ID --agent codex --cwd PATH --session UUID` connects to a loaded session on Codex's existing local server. It checks thread metadata through the local socket and submits feedback with `codex queue`. `--codex-socket PATH` selects a custom absolute local socket path. `--new-session` explicitly starts a separate managed Codex session and cannot be combined with `--session`. Claude and Copilot watchers retain their optional `--session ID` resume behavior. `atelier mcp --artifact ID` scopes the MCP tools to one artifact and file inputs to its working directory. `atelier mcp --claude-channel` advertises Claude's channel capability and waits for comment reads as delivery receipts. With no artifact scope, it automatically watches new artifacts created through that connection. `--no-watch` disables automatic connection on creation. Claude still requires its native development-channel opt-in. Managed Codex and Copilot sessions use a private authenticated IPC connection to register their created artifact IDs.

### Comment acknowledgement

`GET /api/artifacts/:id/comments` reads threads without changing their state. `POST /api/artifacts/:id/comments/read` with `{}` returns the current threads and records `acknowledgedAt` for unresolved comments. The MCP `list_comments` tool uses this endpoint. Viewer reads do not acknowledge feedback; user replies and reopened threads clear the previous acknowledgement.

Creation and revision requests accept `waitForCheck: false` (HTTP or MCP) to return the saved revision immediately with `preview.status: "pending"`. Checks continue in the background and update thumbnails. The default remains `true`. Use `check_artifact` to obtain a report. Checks use a minimal trusted sandbox viewer; the browser integration suite separately exercises the full workspace. Revision history accepts `before` (exclusive revision number) and `limit` (1–200, default 200).
