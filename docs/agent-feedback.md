# Automatic comment delivery

atelier saves comments and updates open viewers through `/api/events`. Agents currently read comments with `list_comments`. No background process starts an agent or injects a message into its session.

Automatic delivery needs two parts: a durable record that feedback arrived, and an agent client that accepts a new turn. MCP alone does not supply both.

## Available mechanisms

| Mechanism | What it provides | Limit for atelier |
| --- | --- | --- |
| MCP resource subscriptions | Tells a subscribed client that a resource changed | The host decides whether to read the resource or run the agent. A notification is not an instruction to start a turn. |
| Claude Code Channels | Pushes an event into an open Claude Code session | Requires session opt-in. Custom channels remain a research-preview integration. This does not establish support in Claude Desktop. |
| Codex app server | Starts a turn in a specified thread through `turn/start` | Requires an adapter that owns or connects to the app-server session. Ordinary MCP configuration does not establish that connection. |
| Agent polling or a waiting tool call | Lets a running agent check for comments | Does not wake an idle or closed session. Repeated checks also consume agent time. |

MCP sampling requests a model response from a supporting client. It does not guarantee access to the user's existing conversation, tools, or an autonomous editing turn. It is not a portable substitute for comment delivery.

These findings come from the [MCP resource specification](https://modelcontextprotocol.io/specification/2025-11-25/server/resources), [MCP sampling specification](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling), [Claude Code Channels reference](https://code.claude.com/docs/en/channels-reference), and [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server), checked on 24 October 2026. Actual client behavior still needs integration testing.

## Proposed implementation

Keep the comment queue independent of the agent. Add adapters for clients that can accept events or new turns. The user chooses one agent session for an artifact and enables automatic handling explicitly.

A new comment, user reply, or reopened thread should create a durable event with a unique ID. The current `/api/events` stream contains artifact IDs and has no replay history, so it cannot be the only delivery record. An adapter should resume from its last acknowledged event after reconnecting.

Send the artifact ID, comment ID, and event ID to the adapter. The agent then reads the thread through MCP. Agent replies and published revisions must not trigger another agent turn. Delivery acknowledgement and completed work need separate states: writing a notification does not prove that an agent read or addressed it.

Only one adapter should claim an event. Group comments that arrive while the agent is working, and deliver them after its current turn. Keep `baseRevision` conflict checks when publishing. Show whether automatic handling is connected, disconnected, or waiting for permission; never describe an undelivered comment as being processed.

The adapter must retain the client's permission and sandbox settings. Comment text is task data, not permission to execute unrelated commands. Choosing an agent must not enable arbitrary shell commands or silently resume another conversation.

Start with a Codex app-server adapter for an explicitly selected session. A Claude Code channel can share the same durable event queue later. Both should remain optional; ordinary MCP clients must continue to work through `list_comments`.

This is a design proposal. No automatic delivery adapter is enabled or shipped yet.
