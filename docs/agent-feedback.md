# Handle comments automatically

Start an agent through atelier to create artifacts and handle their comments in the same session. Keep atelier and the agent terminal open.

## Create with automatic feedback

Install and sign in to the CLI you want to use. From the directory the agent should work in, run one of these commands:

```sh
atelier agent "Create a report with a chart" --agent codex --cwd .
atelier agent "Create a report with a chart" --agent copilot --cwd .
atelier agent "Create a report with a chart" --agent claude --cwd .
```

Replace the quoted request with your task. Codex and Copilot print their session ID, create the artifact, and stay open for comments. Claude opens its interactive CLI. New artifacts and duplicates created through the session's MCP connection join that same session automatically. Multiple artifacts share one session, with feedback handled one turn at a time.

Open the returned artifact URL and leave a comment. **Comments** shows the connected agent. The creation tool also reports `feedback.connected`. If the connection fails, the artifact is still saved and the result explains the failure. Set `watch: false` in `create_artifact` to leave an artifact disconnected.

Ordinary MCP connections cannot wake arbitrary Codex or Copilot conversations. atelier does not discover live sessions, resume them behind your back, or start a second agent after creation. Use `atelier agent` when you want automatic feedback from the start. No command changes your global MCP configuration.

## Connect an existing artifact

```sh
atelier watch ARTIFACT_ID --agent codex --cwd .
atelier watch ARTIFACT_ID --agent copilot --cwd .
atelier watch ARTIFACT_ID --agent claude --cwd .
```

Replace `ARTIFACT_ID` with the ID at the end of the artifact's URL. In the viewer, **Comments → Connect an agent** copies the command with the ID filled in.

### Claude Code

Claude's custom channels require its development-channel opt-in. The command passes `--dangerously-load-development-channels server:atelier`; Claude displays its own confirmation. Accept only the local atelier channel you intended to start. Organization policy may block channels.

Use the interactive terminal. Claude ignores the development-channel flag in `-p` mode and through its Agent SDK. atelier waits for Claude to call `list_comments` before recording delivery, because writing a channel notification does not prove that Claude received it. A missing receipt times out after 15 minutes and needs review before retrying.

See the [Claude Code Channels reference](https://code.claude.com/docs/en/channels-reference).

### Codex and GitHub Copilot CLI

Codex uses its app-server protocol. Copilot uses ACP over stdio. These are managed sessions started by atelier, not attachments to an arbitrary open terminal conversation.

To resume an explicit saved session, add its ID:

```sh
atelier watch ARTIFACT_ID --agent codex --cwd . --session SESSION_ID
atelier watch ARTIFACT_ID --agent copilot --cwd . --session SESSION_ID
```

Stop any other client using that session before resuming it. Use the same working directory. Claude also accepts `--session`, which passes the ID to `claude --resume`.

See the [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server) and [Copilot CLI ACP reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server). ACP and custom Claude channels are preview interfaces and may change between CLI releases.

## Leave feedback

Highlight text and click **Comment**, or use **Comment on an element** in the header. Choose **Element** for a chart, image, or control. Choose **Section** for a whole section. The blue outline shows the target. Write your request in the small popup and send it. The document stays at full width.

New viewer comments, replies, and reopened threads enter the durable queue. Feedback saved while disconnected waits for the next connection. Agent replies and revisions do not trigger another turn. Comments created through MCP do not enqueue work; API callers must explicitly set `notifyAgent: true` when submitting user feedback.

The agent reads the source and thread, replies, and publishes revisions under the same artifact ID. Check the result and resolve the thread yourself. A completed delivery means the agent received the work, not that the requested change succeeded.

## Check or stop delivery

Open **Comments** to see the connection, queued feedback, and permission requests. For Codex and Copilot, approve unrelated tool actions in the terminal when prompted. Without an interactive terminal, those requests are denied.

Press **Ctrl+C** to stop a managed watcher, or click **Disconnect** to stop further delivery. Watchers check the connection every five seconds. A turn already running in a shared creator session may continue after that artifact is disconnected. Stop the agent terminal if you need to end the turn. Other artifacts in the session stay connected.

If delivery is interrupted, check the comment and latest revision before using **Retry uncertain deliveries**. The agent may have already applied the change. atelier does not automatically replay an ambiguous attempt. Queued feedback that has not been dispatched is preserved across restarts.

## Permission boundaries

Starting `atelier watch` authorizes the scoped atelier tools for that artifact. That MCP connection rejects other artifact IDs, creation, and duplication. Managed Codex and Copilot creator sessions allow creation, then restrict reads and revisions to artifacts created in that session. Claude creator channels retain the normal MCP tools and automatically connect only artifacts created through that connection. File inputs must resolve inside the chosen working directory, including through symlinks. This scope does not restrict every tool offered by the agent itself.

Managed Codex sessions use a read-only filesystem sandbox and request approval for untrusted commands. Copilot retains its CLI sandbox settings and receives approval for the scoped atelier MCP server only. Other permission requests are handled individually. atelier never passes an allow-all-tools or sandbox-bypass flag.

Claude retains its own terminal permissions. The channel does not relay approvals through artifact comments. Comment text remains task data, not permission to run unrelated commands or access unrelated files.

Only one active delivery connection can own an artifact's queue. Events are recorded before dispatch, grouped in batches of up to 50, and acknowledged by event ID. New feedback arriving during a managed turn waits for the next turn. Revision conflict checks still apply.
