# Atelier

Atelier is a local service that lets AI agents create interactive pages. A page can combine text, charts, diagrams, images, forms, and animations.

Agents create and revise the content through MCP, the CLI, or the HTTP API. You open the page in your browser, leave comments, and export a revision as HTML or PDF. Each artifact keeps the same URL and its revision history.

## Install and start

Requires Git, Node.js 22.13 or later, and npm.

```sh
git clone https://github.com/marlboro-red/atelier.git
cd atelier
npm install
npm link
atelier install-browser
atelier start
```

`npm install` builds the browser app automatically. `npm link` makes the `atelier` command available globally and points it to this directory. Skip `atelier install-browser` if you do not need PDF exports.

Atelier is not published to the npm registry, so `npm install --global atelier` is not supported.

### Open Atelier

The service opens [Atelier](http://atelier.localhost:4310) in your browser. If that hostname does not resolve, open [127.0.0.1:4310](http://127.0.0.1:4310).

Keep the terminal process running while you use Atelier. `atelier start` runs in the foreground; it does not install a background service.

## Connect your agent

Atelier provides an MCP server over stdio. It connects to the running local service and needs no model API key. Use an agent client on the same computer as Atelier.

### Codex

```sh
codex mcp add atelier -- atelier mcp
```

### Claude Code

```sh
claude mcp add --transport stdio --scope user atelier -- atelier mcp
```

This adds Atelier for all your projects. Run `/mcp` in Claude Code to check the connection. See [Claude Code's MCP setup](https://code.claude.com/docs/en/mcp).

### Claude Desktop

Open **Settings → Developer → Edit Config**. Add `atelier` to the existing `mcpServers` object, or use this configuration if the file is empty:

```json
{
	"mcpServers": {
		"atelier": {
			"command": "atelier",
			"args": ["mcp"]
		}
	}
}
```

Save the file and fully quit and reopen Claude Desktop. See the [local MCP setup guide](https://modelcontextprotocol.io/docs/develop/connect-local-servers).

### GitHub Copilot in VS Code

Create `.vscode/mcp.json` in your project, or add `atelier` to its existing `servers` object:

```json
{
	"servers": {
		"atelier": {
			"type": "stdio",
			"command": "atelier",
			"args": ["mcp"]
		}
	}
}
```

Run **MCP: List Servers** from the Command Palette, select **atelier**, and start it. Accept the trust prompt, then use Copilot in Agent mode with the Atelier tools enabled. See [VS Code's MCP configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

### GitHub Copilot CLI

```sh
copilot mcp add atelier -- atelier mcp
```

### If the client cannot find Atelier

Desktop apps may not inherit your terminal's PATH. On Windows, using Node directly also avoids relying on an npm command shim.

Run `node -p "process.execPath"` to find Node, and `npm root --global` to find your global packages directory. In the client configuration, replace `command` with the absolute Node path and use:

```json
"args": ["/absolute/global/packages/atelier/bin/atelier.mjs", "mcp"]
```

You can also point directly to `bin/atelier.mjs` in your cloned repository. Escape Windows backslashes as `\\` in JSON, or use forward slashes.

### Create your first artifact

Start a new agent session to load the connection. Ask the agent to create an artifact:

> Create a report in Atelier with text, an interactive chart, and a diagram. Give me the artifact URL.

The agent returns a URL such as `http://atelier.localhost:4310/a/<id>`. Open that URL to view the page. The artifact also appears in the library at the root URL.

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
