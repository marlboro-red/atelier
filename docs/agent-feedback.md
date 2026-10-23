# Handle comments automatically

Connect one artifact to an agent to have new comments picked up automatically. The connection runs locally and uses the agent's existing login. Keep atelier and the agent terminal open.

## Start a connection

Install and sign in to the CLI you want to use. Then run one of these commands from the directory the agent should work in:

```sh
atelier watch ARTIFACT_ID --agent codex --cwd .
atelier watch ARTIFACT_ID --agent copilot --cwd .
atelier watch ARTIFACT_ID --agent claude --cwd .
```

Replace `ARTIFACT_ID` with the ID at the end of the artifact's URL. In the viewer, **Comments → Connect an agent** can copy the command with the ID filled in.

Codex and Copilot start a managed session and print its ID. Claude opens its interactive CLI with atelier configured as a channel. None of these commands changes your global MCP configuration.

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

Highlight text and click **Comment**, or use **Comment on an element** in the header. Write your request in the small popup and send it. The document stays at full width.

New viewer comments, replies, and reopened threads enter the durable queue. Feedback saved while disconnected waits for the next connection. Agent replies and revisions do not trigger another turn. Comments created through MCP do not enqueue work; API callers must explicitly set `notifyAgent: true` when submitting user feedback.

The agent reads the source and thread, replies, and publishes revisions under the same artifact ID. Check the result and resolve the thread yourself. A completed delivery means the agent received the work, not that the requested change succeeded.

## Check or stop delivery

Open **Comments** to see the connection, queued feedback, and permission requests. For Codex and Copilot, approve unrelated tool actions in the terminal when prompted. Without an interactive terminal, those requests are denied.

Press **Ctrl+C** to stop a managed watcher, or click **Disconnect** to stop further delivery. Watchers check the connection every five seconds. A Claude turn already running may continue after delivery is disconnected; stop that turn in Claude if needed.

If delivery is interrupted, check the comment and latest revision before using **Retry uncertain deliveries**. The agent may have already applied the change. atelier does not automatically replay an ambiguous attempt. Queued feedback that has not been dispatched is preserved across restarts.

## Permission boundaries

Starting a watcher authorizes the scoped atelier tools for that artifact. The MCP connection rejects other artifact IDs, creation, and duplication. File inputs must resolve inside the chosen working directory, including through symlinks. This scope does not restrict every tool offered by the agent itself.

Managed Codex sessions use a read-only filesystem sandbox and request approval for untrusted commands. Copilot retains its CLI sandbox settings and receives approval for the scoped atelier MCP server only. Other permission requests are handled individually. atelier never passes an allow-all-tools or sandbox-bypass flag.

Claude retains its own terminal permissions. The channel does not relay approvals through artifact comments. Comment text remains task data, not permission to run unrelated commands or access unrelated files.

Only one active delivery connection can own an artifact's queue. Events are recorded before dispatch, grouped in batches of up to 50, and acknowledged by event ID. New feedback arriving during a managed turn waits for the next turn. Revision conflict checks still apply.
