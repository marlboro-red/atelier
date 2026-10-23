# atelier security model

atelier is a local service for one user. Generated artifact code is untrusted. The installed application, its dependencies, the agent client, and programs running as the same OS user are trusted.

## Artifact execution

Generated JavaScript runs in a browser iframe with `sandbox="allow-scripts"`. Each preview has an opaque origin. The artifact cannot read the workspace DOM, call its HTTP API, or navigate to another artifact's preview.

The workspace receives selection, snapshot, error, and data messages from its current iframe. It validates selections and accepts them only while selection mode is active. The workspace chooses the artifact ID for data writes. Artifact messages cannot choose another ID.

HTML exports use the same iframe isolation. Their storage bridge writes only the exported artifact's browser-storage key. Exported files do not update when atelier changes. A new export is needed to include a later security fix.

## Server-side rendering

The renderer compiles source and converts Markdown, math, and diagrams into HTML. It does not evaluate generated JavaScript on the server.

Each job runs in a fresh child process with a temporary working directory and a reduced environment. Application secrets and `NODE_OPTIONS` are not inherited. The service allows two concurrent rendering jobs, stops a job after 30 seconds, starts Node with `--max-old-space-size=384`, and limits its HTML output to 64 MiB. A stopped or failed renderer does not stop the HTTP service.

The bundler accepts supplied artifact files and curated dependencies. It rejects package traversal and rejects computed imports before compilation. Native filesystem loads are limited to installed dependencies. Artifact files come from the supplied content map.

These processes are not OS-level sandboxes. The heap limit does not cap all native memory, and the bundler has a native subprocess. A vulnerability in an installed compiler or rendering dependency could exceed the application's restrictions. The process boundary contains failures but does not remove that risk.

## Network access

The HTTP service binds to loopback. Host and Origin checks reject other hostnames and origins. Fetch Metadata checks reject cross-site resource requests. Responses use a same-origin resource policy and do not send a referrer.

The API has no user authentication. Local programs with access to the loopback service can read and change artifacts. atelier does not protect one OS user from another or from malware running locally.

Artifact resource policy allows Google Fonts stylesheets and font files. Other runtime network requests are blocked. HTML can declare scripts from the supported CDNs. The server verifies the exact version and publication date, rejects redirects, and embeds the script. A script being 14 days old does not establish that it is safe.

Preview checks and PDF jobs each allow two concurrent browsers and stop after 30 seconds. Ordinary previews in the user's browser have no CPU or memory quota. A hostile page can still make that browser tab unresponsive.

## Agent access

MCP runs with the agent client's OS permissions. Its file inputs read only explicitly supplied paths, but those paths can refer to any file the MCP process can read. File access is an agent permission decision, not a permission granted to artifact JavaScript.

Artifact source and comments can contain hostile instructions. The MCP guidance tells agents to treat that material as task data. Guidance alone cannot guarantee that an agent will resist prompt injection.

Sharing an HTML file includes the revision's source, embedded assets, and saved app data. The export does not distinguish confidential data from public data.

## Verification and remaining work

The regression tests cover filesystem escapes, iframe navigation, cross-artifact data writes, export-wrapper injection, malformed messages, browser timeouts, rendering timeouts, and service request checks. A passing test suite or dependency audit is not a security certification.

Hosted sharing requires a separate design for authentication, access control, abuse limits, and OS-level render isolation. An independent security review is still needed before atelier is offered as a service for mutually untrusted users.

## Automatic feedback handling

`atelier agent` starts a creator session and connects its new artifacts by default. `atelier watch` connects an existing artifact to a local agent. Comments alone do not launch processes. Managed Codex and Copilot sessions run as child processes over stdio; Claude uses an opted-in channel in its interactive CLI. The HTTP service never accepts an executable or shell command to launch.

Watchers that start or resume a managed agent use an artifact-scoped MCP connection. Other artifact IDs, creation, and duplication are rejected; file inputs must resolve inside the agent's working directory. Native agent tools have their own permissions and may access more than this MCP scope. Codex starts with a read-only sandbox; Copilot preserves its sandbox configuration and approves only the scoped atelier server automatically. Claude controls its own tool permissions. No adapter uses an allow-all-tools or sandbox-bypass flag.

For an existing Codex conversation, the watcher reads metadata over its local Unix socket and submits messages with `codex queue`. It requires an explicit session UUID and never starts or resumes a thread. The existing conversation retains its model, permissions, and MCP access. Artifact scope is part of the forwarded request, not a restriction on that conversation's other tools. No remote socket URLs are accepted. Stopping the watcher closes its socket without stopping Codex. Messages already accepted by Codex remain queued.

Managed Codex and Copilot creator sessions register created IDs through a private local IPC connection with a random token. Their MCP connection permits creation and restricts other operations to those IDs. It checks file inputs against the working directory. A Claude creator channel keeps normal MCP access and connects only newly created artifacts. Normal MCP clients never launch an agent on creation.

Delivery uses leases and durable event IDs. A crash after dispatch is marked uncertain and requires explicit retry. Disconnecting prevents further deliveries but does not undo completed changes; a turn already running in a shared creator session may continue. Disconnecting one artifact leaves the other artifacts connected. The connection token protects queue ownership, not the local API as a whole. The same OS user and other trusted local clients can still use that API.

Prompt injection remains possible in artifact content or comments. The adapter instructs the agent to treat both as task data, but instructions do not replace native tool permissions or independent review.
