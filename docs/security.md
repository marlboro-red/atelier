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
