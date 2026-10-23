# Atelier reference

This document describes Atelier's runtime, artifact format, and agent interfaces. The [README](../README.md) covers setup and review.

## Runtime and storage

The service binds to `127.0.0.1`. MCP responses use `atelier.localhost` for browser links when the service address is `127.0.0.1` or `localhost`, preserving the configured port. The browser app and API use port `4310`. Artifact previews use a separate origin on port `4311`.

The default database is `~/.atelier/atelier.sqlite`. SQLite stores artifact metadata, complete source revisions, comments, and app data. Revision content and metadata commit in one transaction. A file-copy backup requires the service to be stopped and the complete data directory to be copied.

The `start` command runs in the foreground and opens the browser. `start --no-open` and `npm start` run without opening the browser. `npm link` makes the `atelier` command available globally. `atelier install-browser` installs Chromium for PDF export. See the [installation guide](../README.md#install-and-start) for ZIP and terminal installs.

Environment variables control the service and its clients:

| Variable | Default | Purpose |
| --- | --- | --- |
| `ATELIER_PORT` | `4310` | Browser app and API port |
| `ATELIER_PREVIEW_PORT` | `ATELIER_PORT + 1` | Artifact preview port |
| `ATELIER_DATA_DIR` | `~/.atelier` | Database directory |
| `ATELIER_URL` | `http://127.0.0.1:4310` | Service address for CLI and MCP clients; follows `ATELIER_PORT` when set |

## Artifacts and revisions

An artifact has a stable `id`. Its `head` identifies the latest revision.

| URL | Content |
| --- | --- |
| `/` | Library of agent-created artifacts |
| `/a/<id>` | Latest revision |
| `/a/<id>/revisions/<number>` | Specified revision |

Each artifact fills the space below a thin, pinned header. The header shows the artifact title, revision, and a link back to the library. Its **Review** control opens comments, history, source, or export options without resizing the artifact. Closing those controls preserves the artifact's live state.

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

React entries default-export a component. Relative imports can reference other files in the artifact, including CSS. Write HTML as a page fragment, with optional `<style>` and `<script>` tags. Atelier supplies `<!doctype html>`, `<html>`, `<head>`, `<body>`, the security policy, and the runtime. HTML supports inline scripts and references to local script and style files.

Full HTML documents are also accepted. Atelier merges their head content and document attributes into one shell, preserving titles, styles, scripts, and body content. Atelier controls charset, viewport, and security policy metadata.

```html
<style>h1 { color: coral; }</style>
<h1>Report</h1>
<p>Content goes here.</p>
```

Images can be data URLs or files in the content object. SVG files contain SVG text. Other image files contain data URLs. React can import these files as strings; HTML can reference them by relative path.

React and HTML support mixed content in a single artifact. Markdown supports tables, code blocks, KaTeX math, and Mermaid code fences. SVG artifacts render the supplied SVG source.

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

A comment belongs to an artifact and a revision. Its optional anchor contains the selected quote, surrounding text, DOM selector, and element tag.

The browser locates a selection by its selector and quote. If the selector no longer matches, a unique quote can identify the element. Removed or ambiguous selections remain accessible through the original revision. Stable element IDs and `data-atelier-id` attributes improve matching.

Comment status has four values:

| Status | Browser label | Meaning |
| --- | --- | --- |
| `open` | Queued for agent | Feedback awaits an agent |
| `in_progress` | Being addressed | An agent has marked the thread as active |
| `addressed` | Ready for review | An agent has submitted a revision linked to the comment, or set this status |
| `resolved` | Resolved | The thread is closed |

Agents read comments through MCP, the CLI, or the API. Atelier does not launch agents. A revision's `commentIds` marks linked, unresolved comments as `addressed`.

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

HTML exports include a copy of app data. They use local browser storage where available and do not write back to Atelier.

Atelier cannot infer arbitrary component state. Custom filters and slide selection require the export state methods. A presentation PDF captures the current slide. PDF captures canvas frames; HTML retains animation. WebGL capture depends on a readable drawing buffer.

Text remains selectable in PDF where the renderer supports it. Recipient viewport sizes and PDF pagination can change the layout. Exports omit Atelier's review controls.

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
| `list_revisions` | Reads revision history |
| `list_comments` | Reads feedback and replies |
| `add_comment` | Adds a comment to a specified revision |
| `reply_to_comment` | Adds a reply or changes comment status |

Create, get, revise, restore, and duplicate results include a browser URL. MCP write tools require an `author` for attribution.

### CLI commands

The command prefix is `node bin/atelier.mjs`, or `atelier` after `npm link`. The following examples use `atelier`:

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

The `create` and `revise` commands accept a source file or a JSON content object. A source file becomes a single-file artifact. The CLI does not collect its relative imports; a JSON content object carries multiple files.

### HTTP API

Paths are relative to `/api`. Request and response bodies use JSON, except exports and the event stream. The implementation is in [src/server/app.ts](../src/server/app.ts).

| Method | Path | Operation |
| --- | --- | --- |
| GET | `/health` | Service status and preview port |
| GET | `/artifacts` | List artifacts |
| POST | `/artifacts` | Create an artifact |
| GET | `/artifacts/:id` | Read metadata and `head` |
| GET | `/artifacts/:id/revisions` | List revision metadata |
| POST | `/artifacts/:id/revisions` | Create a revision |
| GET | `/artifacts/:id/revisions/:n` | Read complete revision content |
| POST | `/artifacts/:id/restore` | Restore a revision |
| POST | `/artifacts/:id/duplicate` | Duplicate a revision |
| GET | `/artifacts/:id/comments` | List comments |
| POST | `/artifacts/:id/comments` | Add a comment |
| PATCH | `/artifacts/:id/comments/:cid` | Add a reply or change status |
| GET | `/artifacts/:id/data` | Read `{data}` |
| PUT | `/artifacts/:id/data` | Write `{data}` |
| POST | `/artifacts/:id/export` | Export HTML or PDF |
| GET | `/events` | Server-sent change events |

Write requests accept these fields:

| Operation | Required fields | Optional fields |
| --- | --- | --- |
| Create artifact | `title`, `content` | `description`, `author`, `summary` |
| Create revision | `baseRevision`, `summary`, `content` | `author`, `commentIds` |
| Restore revision | `revision`, `baseRevision` | `author` |
| Duplicate revision | `revision` | `author` |
| Add comment | `revision`, `body` | `author`, `anchor` |
| Update comment | None | `reply`, `author`, `status` |
| Write app data | `data` | None |
| Export | `revision`, `format` | `snapshot` |

The export `format` is `html` or `pdf`. Validation errors return `400`, unknown artifacts or revisions return `404`, and revision conflicts return `409`. A missing Chromium installation returns `503` for PDF export. The API body limit is 32 MiB.

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

Atelier is a local, single-user service. It has no public hosting, team accounts, agent execution engine, in-artifact model calls, external app connections, or video support.

Generated code runs in a separate-origin iframe without same-origin privileges. Preview policy allows Google Fonts stylesheets from `https://fonts.googleapis.com` and font files from `https://fonts.gstatic.com`. Other network requests and embedded frames are blocked. PDF export allows the same font sources. HTML exports keep these remote font references and need internet access to load them; use embedded fonts when offline fidelity is required. Artifacts cannot install arbitrary packages or execute server code.

The API rejects unrecognized hostnames and disallowed origins. Local processes running as the same OS user are trusted. Atelier is not a security boundary between users of the computer.
