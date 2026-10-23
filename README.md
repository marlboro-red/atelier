# atelier

atelier is a local service that lets AI agents create interactive pages. A page can combine text, charts, diagrams, images, forms, and animations.

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

`npm install` builds the browser app automatically. `npm link` makes the `atelier` command available globally and points it to this directory. `atelier install-browser` supplies Chromium for automatic preview checks and PDF export. Without it, artifacts still save, but checks report `unavailable`.

atelier is not published to the npm registry, so `npm install --global atelier` is not supported.

### Open atelier

The service opens [atelier](http://atelier.localhost:4310) in your browser. If that hostname does not resolve, open [127.0.0.1:4310](http://127.0.0.1:4310).

Keep this terminal open. `atelier start` runs in the foreground. If atelier is already running, the command opens that service instead of starting a second copy.

In a second terminal, check the installation:

```sh
atelier doctor
```

Expect `OK` for Node, the workspace, the service, and Chromium. A failed check prints the command or setting to fix.

If `npm link` fails, use `node bin/atelier.mjs` in place of `atelier` from the repository directory. For example, run `node bin/atelier.mjs start`. The MCP configuration command below prints absolute paths and does not require a global link.

## Connect your agent

atelier provides an MCP server over stdio. It connects to the running local service and needs no model API key. Use an agent client on the same computer as atelier.

### Codex

```sh
codex mcp add atelier -- atelier mcp
```

See [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

### Claude Code

```sh
claude mcp add --transport stdio --scope user atelier -- atelier mcp
```

This adds atelier for all your projects. Run `/mcp` in Claude Code to check the connection. See [Claude Code's MCP setup](https://code.claude.com/docs/en/mcp).

### Claude Desktop

Print the configuration for your installation:

```sh
atelier mcp-config claude-desktop
```

Open **Settings → Developer → Edit Config** in Claude Desktop. If the file is empty, paste the output. Otherwise, copy the `atelier` entry into the existing `mcpServers` object.

Fully quit and reopen Claude Desktop. The generated configuration uses absolute paths, so the desktop app does not need your terminal's PATH. See the [local MCP setup guide](https://modelcontextprotocol.io/docs/develop/connect-local-servers).

### GitHub Copilot in VS Code

Print the configuration:

```sh
atelier mcp-config vscode
```

Create `.vscode/mcp.json` in the project where you use Copilot and paste the output. If that file exists, copy the `atelier` entry into its `servers` object.

Run **MCP: List Servers** from the Command Palette. Start **atelier** and accept the trust prompt. Use Copilot in Agent mode with the atelier tools enabled. See [VS Code's MCP configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

### GitHub Copilot CLI

```sh
copilot mcp add atelier -- atelier mcp
```

### If the client cannot find atelier

Use the generated configuration instead of a bare `atelier` command. The command prints your Node executable and the path to `bin/atelier.mjs`:

```sh
node bin/atelier.mjs mcp-config codex
```

Run this command from the repository directory. Merge the output into Codex's `config.toml`. Use `claude-desktop` or `vscode` for JSON configuration. The command prints configuration and does not edit client files.

If you move the repository or replace Node, generate the configuration again. For service connection errors, run `atelier doctor` and check that `atelier start` is still running.

### Add authoring guidance (optional)

atelier includes the [atelier-artifacts skill](skills/atelier-artifacts/SKILL.md) for choosing formats, designing pages, preserving export state, and applying comments to existing artifacts. Follow the [skill installation guide](docs/skills.md) for Codex, Claude Code, or GitHub Copilot. MCP works without it.

### Create your first artifact

Start a new agent session to load the connection. Ask the agent to create an artifact:

> Create a report in atelier with text, an interactive chart, and a diagram. Give me the artifact URL.

The agent returns a URL such as `http://atelier.localhost:4310/a/<id>`. Open that URL to view the page. The artifact also appears in the library at the root URL.

## Request a change

1. Highlight text in an artifact and click **Comment** beside the selection.
2. Enter the change you want in the popup and send the comment.
3. If an agent is connected, it picks up the comment automatically. Otherwise, ask your agent to read the comments.

For a chart, diagram, or other visual element, click **Comment on an element** in the header, then click the element. Choose **Section** to target a whole section. A blue outline shows the target before you click. The header's **Comments** button shows the number of unresolved threads. Click highlighted text or a numbered marker to open its thread.

For new Codex artifacts, the agent connects feedback to its own conversation as part of creation. Keep Codex and atelier open. You do not need a separate watcher terminal.

For an existing artifact, open **Comments → Connect an agent**. Choose your Codex conversation by its name and project, then click **Connect**. Comments arrive in that conversation. If the list is empty, open the conversation in Codex and click **Refresh conversations**.

See [automatic comment delivery](docs/agent-feedback.md) for Claude Code, Copilot, and advanced terminal setup.

The agent saves a new revision under the same artifact ID. The thread links to the revision that addressed it. Click **History** in the header to inspect earlier revisions or compare source. Resolve the comment after you check the change.

## Manage artifacts

The home view shows artifacts as cards with visual previews. Use the Rename and Delete actions on a card, or open **More actions → Rename** to change an artifact's name without changing its ID or revision history. **Delete artifact** asks for confirmation, then permanently removes the artifact, its revisions, comments, and saved data.

## Export a revision

Open the revision you want to share. Click **Share** in the header.

- **Save as HTML** downloads a standalone file with supported interactions and embedded assets.
- **Save as PDF** downloads a static rendering of the current state.
- **Download source** downloads the artifact's files as a JSON manifest.

Exports exclude atelier's review controls. Custom controls need the [export state API](docs/reference.md#artifact-state) to retain their state. PDF pagination can change the layout.

atelier runs on your computer. Public hosting, team collaboration, and video are not supported.

See the [security model and limits](docs/security.md) before using untrusted content.

See the [reference](docs/reference.md) for artifact formats, supported libraries, configuration, agent tools, and development commands.
