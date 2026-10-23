# Atelier

Atelier is a local service that lets AI agents create interactive pages. A page can combine text, charts, diagrams, images, forms, and animations.

Agents create and revise the content through MCP, the CLI, or the HTTP API. You open the page in your browser, leave comments, and export a revision as HTML or PDF. Each artifact keeps the same URL and its revision history.

## Start Atelier

Requires Node.js 22.13 or later and npm.

1. In the repository directory, install the dependencies and build the browser app.

   ```sh
   npm ci
   npm run build
   ```

2. Install Chromium for PDF export.

   ```sh
   npx playwright install chromium
   ```

3. Start the service.

   ```sh
   node bin/atelier.mjs start
   ```

   The command opens [Atelier](http://atelier.localhost:4310) in your browser. If that hostname does not resolve, open [127.0.0.1:4310](http://127.0.0.1:4310).

   Keep the process running while you use Atelier. The `start` command runs in the foreground. It does not install a background service.

## Connect your agent

Atelier provides an MCP server over stdio. The MCP server connects to the running local service and needs no model API key.

Add this entry to your agent's MCP configuration. Replace `/absolute/path/to/atelier` with the repository path.

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

For Codex, register the same server with the CLI instead:

```sh
codex mcp add atelier -- node /absolute/path/to/atelier/bin/atelier.mjs mcp
```

Start a new agent session to load the connection. Ask the agent to create an artifact:

> Create a report in Atelier with text, an interactive chart, and a diagram. Give me the artifact URL.

The agent returns a URL such as `http://127.0.0.1:4310/a/<id>`. Open that URL to view the page. The artifact also appears in the library at the root URL.

## Request a change

1. Open an artifact and click **Review**.
2. Click **Comment**, then **Select a detail**.
3. Highlight text or select an element.
4. Enter the change you want and send the comment.
5. Ask your agent to read the artifact's comments and apply the changes.

Comments wait until an agent reads them. Atelier does not start or wake an agent.

The agent saves a new revision under the same artifact ID. Click **Review**, then **History**, to inspect earlier revisions or compare source. Resolve the comment after you check the change.

## Export a revision

Open the revision you want to share. Click **Review**, then **Share**.

- **Save as HTML** downloads a standalone file with supported interactions and embedded assets.
- **Save as PDF** downloads a static rendering of the current state.
- **Download source** downloads the artifact's files as a JSON manifest.

Exports exclude Atelier's review controls. Custom controls need the [export state API](docs/reference.md#artifact-state) to retain their state. PDF pagination can change the layout.

Atelier runs on your computer. Public hosting, team collaboration, and video are not supported.

See the [reference](docs/reference.md) for artifact formats, supported libraries, configuration, agent tools, and development commands.
