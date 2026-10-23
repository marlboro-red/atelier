# Atelier

A local browser workspace for artifacts made with any agent. Create interactive dashboards, documents, diagrams, illustrations, presentations, and browser animations. Highlight something, leave feedback, and let an agent revise the same artifact without losing its history.

## Run locally

Requires Node.js 22.13 or newer (a current LTS release is recommended).

```sh
npm install
npm run build
npx playwright install chromium
node bin/atelier.mjs start
```

Open **http://atelier.localhost:4310**. If your browser does not resolve that hostname, use **http://127.0.0.1:4310**. Both point to the same workspace. `start --no-open` starts without opening a browser. `npm start` also starts the service without opening a browser.

Optionally run `npm link` to make `atelier start` and the other CLI commands available globally. Port-free `atelier.localhost` is deferred; it requires a local proxy or access to port 80.

The service binds to IPv4 loopback only. The workspace runs on port 4310 and isolated previews run on 4311. Data is stored in `~/.atelier/atelier.sqlite`. The database contains metadata, complete source snapshots for every revision, comments, and app data. Keeping the complete revision in SQLite makes a revision and its metadata commit atomically. Stop Atelier before copying its data directory for a backup.

Environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ATELIER_PORT` | `4310` | Workspace/API port |
| `ATELIER_PREVIEW_PORT` | workspace port + 1 | Isolated preview port |
| `ATELIER_DATA_DIR` | `~/.atelier` | Database directory |
| `ATELIER_URL` | `http://127.0.0.1:4310` | Service address for CLI/MCP clients |

## Workspace

- Create from five working templates, or import source files, images, and JSON artifact manifests.
- Preview React, HTML, Markdown, or SVG. Markdown includes tables, code blocks, and KaTeX math.
- Build charts with Recharts or D3, diagrams with Mermaid, and interactive graphics with SVG, canvas, or browser WebGL APIs.
- View and edit source, with a change summary on every saved revision.
- Select text or elements to attach feedback; reply, resolve, and reopen threads.
- View revision history, compare source side by side, restore an earlier revision as a new one, or duplicate a revision into a new artifact.
- Export a specific revision as standalone HTML or PDF; download source as a JSON manifest.
- Send preview errors to the comment queue for an agent to repair.

An artifact keeps one stable ID: `/a/<id>`. Historical links use `/a/<id>/revisions/<number>`. Updates include `baseRevision`; stale updates return HTTP 409, and agents must reconcile them. Unsaved source edits survive incoming agent revisions.

Comments retain their original revision, selected quote, surrounding text, and DOM locator. A unique surviving quote can be located after the DOM moves. Ambiguous or removed selections stay attached to their original revision; Atelier does not guess. `data-atelier-id` attributes or stable element IDs improve anchoring.

## Connect an agent

Atelier owns no model credentials. Run the local service, then add its stdio MCP server to your agent's configuration:

```json
{
  "mcpServers": {
    "atelier": {
      "command": "node",
      "args": ["/absolute/path/to/atelier/bin/atelier.mjs", "mcp"]
    }
  }
}
```

Available tools: `list_artifacts`, `get_artifact`, `create_artifact`, `revise_artifact`, `list_revisions`, `list_comments`, `add_comment`, and `reply_to_comment`.

A typical agent cycle:

1. Read the artifact and its latest revision.
2. Read comments, including anchors and their original revisions.
3. Mark relevant comments `in_progress` and optionally reply.
4. Submit the full new content with the current `baseRevision`, author, change summary, and addressed `commentIds`.
5. Linked comments become `addressed` (ready for review); the user resolves them.

**Comments are queued feedback.** The MCP server exposes them to agents; it does not launch or wake an idle agent. Tell your agent to read Atelier comments, or have your agent's orchestration poll `list_comments`. There is no provider-specific agent runner in this version.

### CLI

```sh
atelier list
atelier create report.md --title "Research notes" --author "My agent"
atelier get ARTIFACT_ID
atelier comments ARTIFACT_ID
atelier revise ARTIFACT_ID report.md --base 1 --message "Clarify the introduction" --comments COMMENT_ID
atelier reply ARTIFACT_ID COMMENT_ID "Updated the introduction."
atelier history ARTIFACT_ID
atelier export ARTIFACT_ID --format html --output report.html
```

Use `node bin/atelier.mjs` in place of `atelier` if you have not run `npm link`.

### HTTP API

All paths below are relative to `/api`. CLI and MCP use this same API.

| Method | Path | Purpose |
| --- | --- | --- |
| GET / POST | `/artifacts` | List / create |
| GET | `/artifacts/:id` | Metadata and head revision |
| GET / POST | `/artifacts/:id/revisions` | History / create revision |
| GET | `/artifacts/:id/revisions/:n` | Complete immutable revision |
| POST | `/artifacts/:id/restore` | `{revision, baseRevision}` |
| POST | `/artifacts/:id/duplicate` | `{revision}` |
| GET / POST | `/artifacts/:id/comments` | List / add feedback |
| PATCH | `/artifacts/:id/comments/:cid` | `{status?, reply?, author?}` |
| GET / PUT | `/artifacts/:id/data` | Read / write `{data}` |
| POST | `/artifacts/:id/export` | `{revision, format: "html" or "pdf", snapshot?}` |
| GET | `/events` | Server-sent change notifications |

Create body: `{title, description?, author?, summary?, content}`. Revision body: `{baseRevision, author, summary, content, commentIds?}`. Comment body: `{revision, body, author?, anchor?}`.

## Artifact format

```json
{
  "kind": "react",
  "entry": "App.tsx",
  "files": {
    "App.tsx": "export default function App() { return <h1>Hello, Atelier.</h1> }"
  }
}
```

Kinds: `react`, `html`, `markdown`, `svg`. React entries default-export a component. Relative imports can reference other files in the manifest. Available packages: `react`, `react-dom`, `recharts`, `d3`, `lucide-react`, `mermaid`, and `katex`. CSS imports are supported. Dependency versions are pinned by this installation's lockfile; upgrades can change rendering and should be tested against existing artifacts.

HTML can include inline scripts and local script/style references from its `files`. Images should be data URLs, or included as SVG text / image data URLs in `files` and referenced by relative path. React can import those files as strings. External network assets, arbitrary npm installation, server-side execution, and video are outside this version's scope. Browser previews disallow network requests and embedded frames.

### Persistent data and export state

Inside an artifact, use:

```js
const data = await window.atelier.getData();
await window.atelier.setData({ count: (data?.count ?? 0) + 1 });
```

App data is separate from source revisions, scoped to the artifact, and limited to 2 MB of JSON. Restoring source does not roll back user data. HTML exports include a snapshot of that data and use local browser storage where available; they do not write back to Atelier.

For React state or custom controls that must survive export:

```jsx
const [period, setPeriod] = useState(
  window.atelier.getState()?.period ?? "6 months"
);
window.atelier.setState({ period });
```

At export, Atelier captures registered JSON state and ordinary form values. Arbitrary internal application state cannot be inferred; artifacts should use this contract for filters, selected slides, and other meaningful state. Canvas frames are captured for PDF; HTML retains live animation. WebGL canvas capture depends on the artifact making its drawing buffer readable.

HTML exports bundle the supported dependencies and local assets into one file. PDF uses Chromium and print CSS with selectable text where supported; it is static and paginated. A PDF of a presentation captures the current slide, not every slide. Exporting from the CLI renders default UI state plus saved app data; exporting from the browser additionally captures current UI state. There is no guarantee of pixel-identical layout across recipient browser sizes or PDF pagination.

## Development

```sh
npm run build          # Type-check and build the workspace UI
npm run dev            # Watch/restart the service (uses the built UI)
npx vite               # Optional frontend dev server on 127.0.0.1:5173
npm test               # Storage, renderer, API, and real MCP client integration
npm run test:browser   # Browser interaction, exports, isolation, concurrency
npm run format:check
```

Browser tests use separate ports and `.atelier/test` data. `test-results/` contains the workspace screenshot and failure traces.

## Scope

This is a local, single-user workspace. It has no public hosting, public links, team accounts, agent execution engine, in-artifact model calls, connected external apps, or video support. Generated browser code runs in a separate-origin iframe without same-origin privileges. The service rejects unrecognized hosts and cross-origin API requests. All applications running as your OS user should be treated as trusted; this is not a multi-user security boundary.
