# Atelier authoring patterns

These are small examples to adapt. They do not prescribe a page layout or require every artifact to include charts, diagrams, or controls.

## Content payload

Pass this shape as `content` to `create_artifact` or `revise_artifact`. Creation also needs a title and agent attribution; revision also needs the existing ID, current base revision, attribution, and a change summary. A revision must include the whole file map, including unchanged files.

```json
{
	"kind": "html",
	"entry": "index.html",
	"files": {
		"index.html": "<main><h1>Project notes</h1><p>Decisions and next steps.</p></main>"
	}
}
```

Paths must be relative, without `..` or empty path segments. Include 1–100 files. Raster image files contain data URLs; SVG files can contain SVG text. A browser-relative path does not grant access to a file on the user's disk.

## Publish existing files without repeating their contents

For MCP, send an absolute `filePath` for one page, or a map for a multi-file artifact:

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

For the CLI:

```sh
atelier create report/index.html --title "Report" --file report/styles.css --file assets/chart.png=images/chart.png
```

Use your actual agent attribution and file locations. `filePath`, `filePaths`, and inline `content` are mutually exclusive. Neither input form collects undeclared imports automatically. Publish results include the browser URL and omit the source; read it explicitly when needed.

## HTML fragment: a labeled interaction

Use as `index.html`. The control appears before the script that reads it. Ordinary form state is captured during browser export; the input event recalculates the displayed result when that state is restored.

```html
<style>
	main { max-width: 42rem; margin: auto; padding: clamp(1rem, 4vw, 3rem); }
	label { display: block; margin-block: 1rem; }
	input { max-width: 100%; }
	output { font-weight: 600; }
	@media print { .controls { display: none; } }
</style>
<main>
	<h1>Time estimate</h1>
	<p>An illustrative model: each item takes 15 minutes.</p>
	<div class="controls">
		<label for="items">Number of items</label>
		<input id="items" type="range" min="1" max="20" value="4">
	</div>
	<p>Estimated time: <output id="estimate" for="items" aria-live="polite"></output>.</p>
</main>
<script>
	const items = document.getElementById('items');
	const estimate = document.getElementById('estimate');
	function update() { estimate.textContent = `${Number(items.value) * 15} minutes`; }
	items.addEventListener('input', update);
	update();
</script>
```

## React: export state and persistent data

Use as `App.jsx`, with `kind: "react"`. The selected view uses export state; the saved note uses app data. UI state belongs in the artifact, not in the host page.

```jsx
import { useEffect, useState } from 'react';

export default function App() {
	const [view, setView] = useState(() => window.atelier.getState()?.view ?? 'summary');
	const [note, setNote] = useState('');
	const [status, setStatus] = useState('Loading saved note…');
	const [loaded, setLoaded] = useState(false);
	useEffect(() => {
		window.atelier.setState({ view });
	}, [view]);
	useEffect(() => {
		let active = true;
		window.atelier.getData().then(data => {
			if (active) { setNote(data?.note ?? ''); setLoaded(true); setStatus(''); }
		}).catch(() => { if (active) setStatus('Could not load the saved note.'); });
		return () => { active = false; };
	}, []);
	async function save() {
		setStatus('Saving…');
		try { await window.atelier.setData({ note }); setStatus('Saved'); }
		catch { setStatus('Could not save. Your note is still here.'); }
	}
	return <main style={{ maxWidth: 720, margin: 'auto', padding: 24 }}>
		<h1>Project notes</h1>
		<label>View <select value={view} onChange={event => setView(event.target.value)}>
			<option value="summary">Summary</option><option value="details">Details</option>
		</select></label>
		<p>{view === 'summary' ? 'Decisions at a glance.' : 'Describe the evidence and tradeoffs here.'}</p>
		<label>Note <textarea disabled={!loaded} value={note} onChange={event => setNote(event.target.value)} /></label>
		<button disabled={!loaded} onClick={save}>Save note</button>
		<p role="status">{status}</p>
	</main>;
}
```

For multiple custom controls, register one coherent state object instead of letting each control overwrite the other's state. App data is shared across an artifact's revisions; source rollback does not roll back its data. If you add fields to existing app data, preserve unrelated fields.

## React: Pele diagram lifecycle

Add this component to a React artifact. It can sit next to text and charts; it does not need a separate artifact.

```jsx
import { useEffect, useRef } from 'react';
import { mount } from 'pele';

export function Diagram({ source }) {
	const container = useRef(null);
	useEffect(() => {
		const diagram = mount(container.current, source);
		return () => diagram.destroy();
	}, [source]);
	return <figure>
		<div ref={container} style={{ overflowX: 'auto', '--pele-surface': '#f1f5ef' }} />
		<figcaption>Steps and their dependencies.</figcaption>
	</figure>;
}
```

For Markdown, use a `mermaid` code fence. For React charts, give responsive chart containers an explicit height; a percentage-height chart in a zero-height parent will be invisible.

## Check the published page

Every publication returns its browser URL and a `preview` report. Do not repeat creation when a check fails: the artifact and revision already exist. Read the errors, fix the source, and revise the same ID.

For MCP, use `check_artifact` with `id`, `width: 390`, `height: 844`, and `screenshot: true` to receive a narrow-viewport image. For the CLI:

```sh
atelier check ARTIFACT_ID --width 390 --height 844 --screenshot preview.png
```

The screenshot is a view of the workspace. Shared HTML and PDF still omit its header. The check does not exercise controls; test important interactions separately when browser tools are available.

## Sharing

HTML exports embed declared CDN scripts and local assets, but Google Fonts remain remote. Prefer an included font or a system stack when the recipient must work offline. The exported file is sandboxed, fills the viewport, and contains no review header. Use the Atelier data API rather than trying to access its parent or browser storage directly.

For PDF, keep labels and the selected chart view visible without hovering. Use print styles to remove control-only UI, expand clipped content, and avoid splitting small figures. Large documents still need pagination; do not promise pixel-identical PDF layout.

## Common failure cases

| Symptom | Check |
| --- | --- |
| An edit loses unrelated content | `revise_artifact` replaces the entire content object; retain the other files |
| A diagram duplicates after an update | Return the Pele handle's `destroy()` from the effect cleanup |
| A script cannot find a control | Place it after the markup or wait for DOM readiness; an explicit full-document head runs before the body |
| A library tries to download a worker or map tiles | Use an alternative that works from embedded data; runtime downloads are blocked |
| A CDN script is rejected | Check its exact version, verifiable publication date, explicit file path, redirects, and any integrity hash |
| A filter looks different in the export | Initialize it with `getState()` and register changes with `setState()` |
| The artifact looks blank at `/preview/…` | Open the workspace URL returned by the tool; direct preview navigation is blocked |
