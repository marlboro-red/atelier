import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Search,
  ArrowUpRight,
  Code2,
  MessageSquare,
  History,
  Download,
  Copy,
  Check,
  X,
  MousePointer2,
  ArrowRight,
  RotateCcw,
  ArrowLeft,
  Pencil,
  Trash2,
} from "lucide-react";
import type { Artifact, Revision, Comment, Anchor } from "../shared/schema";
import "./style.css";
async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch("/api" + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (!response.ok)
    throw new Error((await response.json()).error ?? response.statusText);
  return response.json();
}
const post = (body: unknown) => ({
  method: "POST",
  body: JSON.stringify(body),
});
const route = () => {
  const match = location.pathname.match(/^\/a\/([^/]+)(?:\/revisions\/(\d+))?/);
  return {
    id: match?.[1] ?? "",
    revision: match?.[2] ? Number(match[2]) : null,
  };
};
type Panel = "comments" | "history" | "source" | "share" | null;
function App() {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]),
    [locationState, setLocationState] = useState(route),
    [artifact, setArtifact] = useState<Artifact | null>(null),
    [revision, setRevision] = useState<Revision | null>(null),
    [history, setHistory] = useState<Revision[]>([]),
    [comments, setComments] = useState<Comment[]>([]);
  const [search, setSearch] = useState(""),
    [reviewOpen, setReviewOpen] = useState(false),
    [panel, setPanel] = useState<Panel>(null),
    [selecting, setSelecting] = useState(false),
    [anchor, setAnchor] = useState<Anchor | null>(null),
    [body, setBody] = useState(""),
    [error, setError] = useState(""),
    [runtimeErrors, setRuntimeErrors] = useState<string[]>([]),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [previewPort, setPreviewPort] = useState<number | null>(null),
    [sourceFile, setSourceFile] = useState(""),
    [compare, setCompare] = useState<Revision | null>(null);
  const [management, setManagement] = useState<{
    action: "rename" | "delete";
    artifact: Artifact;
  } | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [managementError, setManagementError] = useState("");
  const [managing, setManaging] = useState(false);
  const managementDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (management) managementDialog.current?.showModal();
  }, [management]);
  function manage(action: "rename" | "delete", target: Artifact) {
    setNameDraft(target.title);
    setManagementError("");
    setManagement({ action, artifact: target });
  }
  async function submitManagement() {
    if (!management) return;
    setManaging(true);
    setManagementError("");
    try {
      const id = management.artifact.id;
      if (management.action === "rename") {
        await api(`/artifacts/${id}`, {
          method: "PATCH",
          body: JSON.stringify({ title: nameDraft }),
        });
        notify("Artifact renamed");
      } else {
        await api(`/artifacts/${id}`, {
          method: "DELETE",
          body: JSON.stringify({ baseRevision: management.artifact.head }),
        });
        if (locationState.id === id) {
          closeReview();
          navigate("");
        }
        notify("Artifact deleted");
      }
      setManagement(null);
      await refresh();
    } catch (error: any) {
      setManagementError(error.message);
    } finally {
      setManaging(false);
    }
  }
  const iframe = useRef<HTMLIFrameElement>(null);
  const snapshotResolvers = useRef(new Map<string, (value: unknown) => void>());
  const requestCounter = useRef(0);
  const loading = useRef(0);
  const notify = (message: string) => {
    setNotice(message);
    setTimeout(() => setNotice(""), 3500);
  };
  const run = async (fn: () => Promise<void>) => {
    setError("");
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    }
  };
  const navigate = (id: string, n?: number) => {
    window.history.pushState(
      {},
      "",
      id ? `/a/${id}${n ? "/revisions/" + n : ""}` : "/",
    );
    setLocationState(route());
    setCompare(null);
    setAnchor(null);
    setSelecting(false);
  };
  function closeReview() {
    setReviewOpen(false);
    setPanel(null);
    setSelecting(false);
  }
  function openPanel(next: Panel) {
    setReviewOpen(true);
    setPanel(next);
    setSelecting(false);
    if (next !== "source") setCompare(null);
  }
  function startSelection() {
    setSelecting(true);
    setPanel(null);
    setReviewOpen(true);
  }
  async function refresh() {
    const token = ++loading.current;
    const list = await api<Artifact[]>("/artifacts");
    if (token !== loading.current) return;
    setArtifacts(list);
    if (!locationState.id) {
      setArtifact(null);
      setRevision(null);
      return;
    }
    if (!list.some((item) => item.id === locationState.id)) {
      closeReview();
      navigate("");
      return;
    }
    const a = await api<Artifact>(`/artifacts/${locationState.id}`);
    const [r, h, c] = await Promise.all([
      api<Revision>(
        `/artifacts/${a.id}/revisions/${locationState.revision ?? a.head}`,
      ),
      api<Revision[]>(`/artifacts/${a.id}/revisions`),
      api<Comment[]>(`/artifacts/${a.id}/comments`),
    ]);
    if (token !== loading.current) return;
    setArtifact(a);
    setRevision(r);
    setHistory(h);
    setComments(c);
  }
  useEffect(() => {
    run(refresh);
    const events = new EventSource("/api/events");
    events.onmessage = () => run(refresh);
    return () => {
      events.close();
      loading.current++;
    };
  }, [locationState.id, locationState.revision]);
  useEffect(() => {
    api("/health")
      .then((h) => setPreviewPort(h.previewPort))
      .catch((e) => setError(e.message));
    const pop = () => setLocationState(route());
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeReview();
    };
    addEventListener("popstate", pop);
    addEventListener("keydown", key);
    return () => {
      removeEventListener("popstate", pop);
      removeEventListener("keydown", key);
    };
  }, []);
  useEffect(() => {
    if (revision) {
      setSourceFile(revision.content.entry);
      setRuntimeErrors([]);
      setSelecting(false);
    }
  }, [revision?.artifactId, revision?.number]);
  useEffect(() => {
    document.title = artifact ? `${artifact.title} · Atelier` : "Atelier";
  }, [artifact?.title]);
  useEffect(() => {
    setReviewOpen(false);
    setPanel(null);
    setBody("");
    setAnchor(null);
  }, [locationState.id]);
  useEffect(() => {
    const listener = async (event: MessageEvent) => {
      if (
        event.source !== iframe.current?.contentWindow ||
        !event.data?.atelier
      )
        return;
      const msg = event.data;
      if (msg.type === "selection") {
        setAnchor(msg.anchor);
        setSelecting(false);
        setPanel("comments");
        setReviewOpen(true);
      }
      if (msg.type === "runtime-error")
        setRuntimeErrors((old) => [...new Set([...old, msg.message])]);
      if (msg.type === "snapshot") {
        snapshotResolvers.current.get(msg.requestId)?.(msg.snapshot);
        snapshotResolvers.current.delete(msg.requestId);
      }
      if (msg.type === "anchor-missing")
        notify(
          "This selection has changed. Open its original revision to locate it.",
        );
      if (msg.type === "escape") closeReview();
      if (msg.type === "ready")
        iframe.current?.contentWindow?.postMessage(
          { atelier: true, type: "selection-mode", enabled: selecting },
          "*",
        );
      if (msg.type === "save-data" && artifact) {
        try {
          await api(`/artifacts/${artifact.id}/data`, {
            method: "PUT",
            body: JSON.stringify({ data: msg.data }),
          });
          event.source?.postMessage(
            { atelier: true, type: "data-result", requestId: msg.requestId },
            { targetOrigin: "*" },
          );
        } catch (e: any) {
          event.source?.postMessage(
            {
              atelier: true,
              type: "data-result",
              requestId: msg.requestId,
              error: e.message,
            },
            { targetOrigin: "*" },
          );
        }
      }
    };
    addEventListener("message", listener);
    return () => removeEventListener("message", listener);
  }, [artifact?.id, selecting]);
  useEffect(() => {
    iframe.current?.contentWindow?.postMessage(
      { atelier: true, type: "selection-mode", enabled: selecting },
      "*",
    );
  }, [selecting]);
  async function addComment() {
    if (!artifact || !revision) return;
    await api(
      `/artifacts/${artifact.id}/comments`,
      post({ revision: revision.number, body, anchor, author: "You" }),
    );
    setBody("");
    setAnchor(null);
    await refresh();
    notify("Feedback queued for your agent");
  }
  async function exportArtifact(format: "html" | "pdf") {
    if (!artifact || !revision) return;
    setBusy(true);
    await run(async () => {
      const requestId = String(++requestCounter.current);
      const snapshot = await new Promise((resolve) => {
        snapshotResolvers.current.set(requestId, resolve);
        iframe.current?.contentWindow?.postMessage(
          { atelier: true, type: "snapshot", requestId },
          "*",
        );
        setTimeout(() => {
          snapshotResolvers.current.delete(requestId);
          resolve(null);
        }, 1200);
      });
      const response = await fetch(`/api/artifacts/${artifact.id}/export`, {
        ...post({ revision: revision.number, format, snapshot }),
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) throw new Error((await response.json()).error);
      download(
        await response.blob(),
        `${artifact.title}-v${revision.number}.${format}`,
      );
      notify(`${format.toUpperCase()} exported · revision ${revision.number}`);
    });
    setBusy(false);
  }
  const filtered = artifacts.filter((a) =>
    (a.title + " " + a.description)
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const showingArtifact = !!locationState.id;
  return (
    <div className={showingArtifact ? "artifact-page" : "library-page"}>
      {showingArtifact ? (
        <>
          {artifact && revision && previewPort ? (
            <iframe
              key={`${artifact.id}:${revision.number}`}
              ref={iframe}
              title="Artifact"
              sandbox="allow-scripts"
              src={`http://127.0.0.1:${previewPort}/preview/${artifact.id}/${revision.number}`}
              className="artifact-frame"
            />
          ) : (
            <div className="loading-page">
              {error
                ? "This artifact could not be opened."
                : "Opening artifact…"}
              {error && (
                <button onClick={() => navigate("")}>Back to artifacts</button>
              )}
            </div>
          )}
          {artifact && revision && (
            <>
              {locationState.revision && (
                <div className="revision-banner">
                  Revision {revision.number}
                  <button onClick={() => navigate(artifact.id)}>
                    Return to latest <ArrowRight size={13} />
                  </button>
                </div>
              )}
              {selecting && (
                <div className="selection-banner">
                  <MousePointer2 size={15} /> Highlight text or select an
                  element.
                  <button
                    aria-label="Cancel selection"
                    onClick={() => setSelecting(false)}
                  >
                    <X size={15} />
                  </button>
                </div>
              )}
              <header className="review-controls" aria-label="Artifact toolbar">
                <button
                  className="artifact-back"
                  aria-label="Back to artifacts"
                  onClick={() => navigate("")}
                >
                  <ArrowLeft size={15} />
                </button>
                <span className="artifact-header-title" title={artifact.title}>
                  {artifact.title}
                </span>
                <span className="version-tag">v{revision.number}</span>
                <button
                  className={"review-toggle " + (reviewOpen ? "active" : "")}
                  aria-label={
                    reviewOpen ? "Close review tools" : "Open review tools"
                  }
                  aria-expanded={reviewOpen}
                  onClick={() =>
                    reviewOpen ? closeReview() : setReviewOpen(true)
                  }
                >
                  {reviewOpen ? (
                    <X size={15} />
                  ) : (
                    <span className="atelier-symbol">a</span>
                  )}
                  {reviewOpen ? "Close" : "Review"}
                  {runtimeErrors.length > 0 && <span className="error-dot" />}
                </button>
                {reviewOpen && (
                  <div className="review-menu">
                    <header>
                      <button
                        className="library-link"
                        onClick={() => navigate("")}
                      >
                        <ArrowLeft size={13} /> All artifacts
                      </button>
                      <span className="version-tag">
                        v{revision.number}
                        {revision.number === artifact.head ? " · latest" : ""}
                      </span>
                    </header>
                    <h1>{artifact.title}</h1>
                    <div className="review-actions">
                      <button
                        className={panel === "comments" ? "selected" : ""}
                        onClick={() =>
                          openPanel(panel === "comments" ? null : "comments")
                        }
                      >
                        <MessageSquare size={17} />
                        Comment
                      </button>
                      <button
                        className={panel === "history" ? "selected" : ""}
                        onClick={() =>
                          openPanel(panel === "history" ? null : "history")
                        }
                      >
                        <History size={17} />
                        History
                      </button>
                      <button
                        className={panel === "source" ? "selected" : ""}
                        onClick={() =>
                          openPanel(panel === "source" ? null : "source")
                        }
                      >
                        <Code2 size={17} />
                        Source
                      </button>
                      <button
                        className={panel === "share" ? "selected" : ""}
                        onClick={() =>
                          openPanel(panel === "share" ? null : "share")
                        }
                      >
                        <Download size={17} />
                        Share
                      </button>
                    </div>
                    <div className="artifact-management">
                      <button onClick={() => manage("rename", artifact)}>
                        <Pencil size={14} /> Rename
                      </button>
                      <button
                        className="danger-action"
                        onClick={() => manage("delete", artifact)}
                      >
                        <Trash2 size={14} /> Delete artifact
                      </button>
                    </div>
                    {runtimeErrors.length > 0 && (
                      <div className="runtime-errors">
                        <strong>Preview needs attention</strong>
                        <pre>{runtimeErrors.join("\n")}</pre>
                        <button
                          onClick={() =>
                            run(async () => {
                              await api(
                                `/artifacts/${artifact.id}/comments`,
                                post({
                                  revision: revision.number,
                                  body:
                                    "Please fix these preview errors:\n" +
                                    runtimeErrors.join("\n"),
                                  author: "You",
                                }),
                              );
                              openPanel("comments");
                              await refresh();
                              notify("Error details queued for your agent");
                            })
                          }
                        >
                          Send errors to agent <ArrowUpRight size={13} />
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </header>
              {panel && reviewOpen && (
                <aside
                  className={
                    "review-panel " + (panel === "source" ? "source-panel" : "")
                  }
                  aria-label={
                    {
                      comments: "Comments",
                      history: "Revision history",
                      source: "Artifact source",
                      share: "Share artifact",
                    }[panel]
                  }
                >
                  <header>
                    <h2>
                      {
                        {
                          comments: "Comments",
                          history: "Version history",
                          source: "Source",
                          share: "Share this revision",
                        }[panel]
                      }
                    </h2>
                    <button
                      className="icon-button"
                      aria-label="Close panel"
                      onClick={() => {
                        setPanel(null);
                        setSelecting(false);
                      }}
                    >
                      <X size={16} />
                    </button>
                  </header>
                  {panel === "comments" ? (
                    <>
                      <div className="comment-intro">
                        <p>Tell your agent what to change.</p>
                        <button onClick={startSelection}>
                          <MousePointer2 size={14} /> Select a detail
                        </button>
                      </div>
                      <div className="comments-list">
                        {!comments.length && (
                          <div className="empty-comments">
                            <MessageSquare size={27} strokeWidth={1} />
                            <h3>No comments yet</h3>
                            <p>
                              Select text or an element, or add a comment below.
                            </p>
                            <button onClick={startSelection}>
                              <MousePointer2 size={14} /> Select an element
                            </button>
                          </div>
                        )}
                        {comments.map((c) => (
                          <div
                            className={
                              "comment " +
                              (c.status === "resolved" ? "resolved" : "")
                            }
                            key={c.id}
                          >
                            <div className="comment-meta">
                              <span className="avatar">
                                {c.author.charAt(0)}
                              </span>
                              <strong>{c.author}</strong>
                              <button
                                onClick={() =>
                                  navigate(artifact.id, c.revision)
                                }
                              >
                                v{c.revision}
                              </button>
                            </div>
                            {c.anchor && (
                              <button
                                className="quote"
                                onClick={() =>
                                  iframe.current?.contentWindow?.postMessage(
                                    {
                                      atelier: true,
                                      type: "locate",
                                      anchor: c.anchor,
                                    },
                                    "*",
                                  )
                                }
                              >
                                {c.anchor.quote || `<${c.anchor.tag}>`}
                              </button>
                            )}
                            <p>{c.body}</p>
                            {c.replies.map((r, i) => (
                              <div className="reply" key={i}>
                                <strong>{r.author}</strong>
                                <p>{r.body}</p>
                              </div>
                            ))}
                            <div className="comment-status">
                              <span className={"status " + c.status}>
                                {
                                  {
                                    open: "Queued for agent",
                                    in_progress: "Being addressed",
                                    addressed: "Ready for review",
                                    resolved: "Resolved",
                                  }[c.status]
                                }
                              </span>
                              <button
                                title={
                                  c.status === "resolved"
                                    ? "Reopen comment"
                                    : "Resolve comment"
                                }
                                onClick={() =>
                                  run(async () => {
                                    await api(
                                      `/artifacts/${artifact.id}/comments/${c.id}`,
                                      {
                                        method: "PATCH",
                                        body: JSON.stringify({
                                          status:
                                            c.status === "resolved"
                                              ? "open"
                                              : "resolved",
                                        }),
                                      },
                                    );
                                    await refresh();
                                  })
                                }
                              >
                                {c.status === "resolved" ? (
                                  <RotateCcw size={13} />
                                ) : (
                                  <Check size={14} />
                                )}
                              </button>
                            </div>
                            <form
                              className="reply-form"
                              onSubmit={(e) => {
                                e.preventDefault();
                                const form = e.currentTarget;
                                const input = form.elements.namedItem(
                                  "reply",
                                ) as HTMLInputElement;
                                run(async () => {
                                  await api(
                                    `/artifacts/${artifact.id}/comments/${c.id}`,
                                    {
                                      method: "PATCH",
                                      body: JSON.stringify({
                                        reply: input.value,
                                        author: "You",
                                      }),
                                    },
                                  );
                                  form.reset();
                                  await refresh();
                                });
                              }}
                            >
                              <input
                                name="reply"
                                aria-label="Reply to comment"
                                placeholder="Reply…"
                                required
                              />
                              <button aria-label="Send reply">
                                <ArrowUpRight size={14} />
                              </button>
                            </form>
                          </div>
                        ))}
                      </div>
                      <div className="composer">
                        {anchor && (
                          <div className="selected-quote">
                            <span>{anchor.quote || `<${anchor.tag}>`}</span>
                            <button
                              aria-label="Clear selection"
                              onClick={() => setAnchor(null)}
                            >
                              <X size={13} />
                            </button>
                          </div>
                        )}
                        <textarea
                          aria-label="Comment"
                          placeholder="What would you like to change?"
                          value={body}
                          onChange={(e) => setBody(e.target.value)}
                        />
                        <div>
                          <span>For your connected agent</span>
                          <button
                            className="send-button"
                            aria-label="Send comment"
                            disabled={!body.trim()}
                            onClick={() => run(addComment)}
                          >
                            <ArrowUpRight size={17} />
                          </button>
                        </div>
                        <small>Queued until an agent reads it.</small>
                      </div>{" "}
                    </>
                  ) : panel === "history" ? (
                    <>
                      <p className="panel-description">
                        Previous revisions are preserved.
                      </p>
                      <div className="history-list">
                        {history.map((r) => (
                          <div
                            key={r.number}
                            className={
                              "history-item " +
                              (r.number === revision.number ? "current" : "")
                            }
                          >
                            <div className="history-dot" />
                            <button
                              onClick={() => navigate(artifact.id, r.number)}
                            >
                              <strong>
                                Revision {r.number}{" "}
                                {r.number === artifact.head && (
                                  <span>Latest</span>
                                )}
                              </strong>
                              <p>{r.summary}</p>
                              <small>
                                {r.author} ·{" "}
                                {new Date(r.createdAt).toLocaleString()}
                              </small>
                            </button>
                            <button
                              className="compare-link"
                              onClick={() =>
                                run(async () => {
                                  const compared = await api<Revision>(
                                    `/artifacts/${artifact.id}/revisions/${r.number}`,
                                  );
                                  setCompare(compared);
                                  setPanel("source");
                                })
                              }
                            >
                              Compare source
                            </button>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : panel === "source" ? (
                    <>
                      <p className="panel-description">
                        Written by {revision.author} · revision{" "}
                        {revision.number}. Ask your agent for changes.
                      </p>
                      <div className="file-tabs">
                        {Object.keys(revision.content.files).map((file) => (
                          <button
                            className={file === sourceFile ? "selected" : ""}
                            key={file}
                            onClick={() => setSourceFile(file)}
                          >
                            {file}
                          </button>
                        ))}
                        <button
                          title="Copy file"
                          onClick={() =>
                            run(async () => {
                              await navigator.clipboard.writeText(
                                revision.content.files[sourceFile],
                              );
                              notify("Source copied");
                            })
                          }
                        >
                          <Copy size={14} />
                        </button>
                      </div>
                      {compare ? (
                        <div className="comparison">
                          <div>
                            <label>Revision {compare.number}</label>
                            <pre>
                              {compare.content.files[sourceFile] ??
                                "File not present in this revision"}
                            </pre>
                          </div>
                          <div>
                            <label>Revision {revision.number}</label>
                            <pre>{revision.content.files[sourceFile]}</pre>
                          </div>
                        </div>
                      ) : (
                        <pre
                          className="source-code"
                          aria-label="Read-only source"
                        >
                          {revision.content.files[sourceFile]}
                        </pre>
                      )}
                    </>
                  ) : (
                    <div className="share-options">
                      <p>
                        Share revision {revision.number} with its current state.
                        Recipients see only the document, without Atelier’s
                        header or review controls.
                      </p>
                      <button
                        disabled={busy}
                        onClick={() => exportArtifact("html")}
                      >
                        <Code2 size={20} />
                        <span>
                          Save as HTML
                          <small>A standalone, interactive page</small>
                        </span>
                        <Download size={15} />
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => exportArtifact("pdf")}
                      >
                        <Download size={20} />
                        <span>
                          Save as PDF
                          <small>A static, print-ready snapshot</small>
                        </span>
                        <Download size={15} />
                      </button>
                      <button
                        onClick={() =>
                          download(
                            new Blob(
                              [JSON.stringify(revision.content, null, 2)],
                              { type: "application/json" },
                            ),
                            `${artifact.title}-source.json`,
                          )
                        }
                      >
                        <Copy size={20} />
                        <span>
                          Download source
                          <small>All files in a JSON manifest</small>
                        </span>
                        <Download size={15} />
                      </button>
                      {busy && <div role="status">Preparing your export…</div>}
                    </div>
                  )}
                </aside>
              )}
            </>
          )}
        </>
      ) : (
        <main className="library">
          <header className="library-header">
            <div className="brand">
              <span className="brand-mark">a</span>atelier
              <span className="brand-dot">.</span>
            </div>
            <span className="local-label">
              <i /> Local to this computer
            </span>
          </header>
          <div className="library-heading">
            <h1>Artifacts</h1>
            <p>View, comment on, and export artifacts created by your agent.</p>
          </div>
          {artifacts.length > 0 ? (
            <>
              <div className="library-toolbar">
                <h2>
                  Your artifacts <span>{artifacts.length}</span>
                </h2>
                <label className="search">
                  <Search size={15} />
                  <input
                    aria-label="Search artifacts"
                    placeholder="Find an artifact…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
              </div>
              <div className="artifact-list">
                {filtered.map((a) => (
                  <button
                    className="artifact-row"
                    key={a.id}
                    onClick={() => navigate(a.id)}
                  >
                    <span className="artifact-initial">
                      {a.title.charAt(0)}
                    </span>
                    <span className="artifact-description">
                      <strong>{a.title}</strong>
                      <small>{a.description || "Open artifact"}</small>
                    </span>
                    <span className="row-version">v{a.head}</span>
                    <ArrowUpRight size={17} />
                  </button>
                ))}
                {!filtered.length && (
                  <p className="no-results">No artifacts match your search.</p>
                )}
              </div>
            </>
          ) : (
            <section className="empty-library">
              <h2>No artifacts yet</h2>
              <p>Ask your connected agent to create an artifact in Atelier.</p>
            </section>
          )}
        </main>
      )}
      {management && (
        <dialog
          ref={managementDialog}
          className="management-dialog"
          aria-labelledby="management-title"
          onCancel={(event) => {
            if (managing) event.preventDefault();
            else setManagement(null);
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submitManagement();
            }}
          >
            <h2 id="management-title">
              {management.action === "rename"
                ? "Rename artifact"
                : "Delete artifact?"}
            </h2>
            {management.action === "rename" ? (
              <label>
                Artifact name
                <input
                  autoFocus
                  value={nameDraft}
                  onChange={(event) => setNameDraft(event.target.value)}
                  required
                  maxLength={160}
                />
              </label>
            ) : (
              <p>
                Delete “{management.artifact.title}” and all its revisions,
                comments, and saved data? This cannot be undone.
              </p>
            )}
            {managementError && (
              <p role="alert" className="management-error">
                {managementError}
              </p>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                autoFocus={management.action === "delete"}
                disabled={managing}
                onClick={() => setManagement(null)}
              >
                Cancel
              </button>
              <button
                className={
                  management.action === "delete"
                    ? "delete-confirm"
                    : "rename-confirm"
                }
                disabled={
                  managing ||
                  (management.action === "rename" && !nameDraft.trim())
                }
              >
                {managing
                  ? "Saving…"
                  : management.action === "rename"
                    ? "Save name"
                    : "Delete artifact"}
              </button>
            </div>
          </form>
        </dialog>
      )}
      {error && (
        <div className="error-banner" role="alert">
          {error}
          <button aria-label="Dismiss error" onClick={() => setError("")}>
            <X size={16} />
          </button>
        </div>
      )}
      {notice && (
        <div className="toast" role="status">
          <Check size={15} />
          {notice}
        </div>
      )}
    </div>
  );
}
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
createRoot(document.getElementById("root")!).render(<App />);
