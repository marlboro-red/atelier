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
  MoreHorizontal,
} from "lucide-react";
import { anchorSchema } from "../shared/schema";
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
  const [composerPosition, setComposerPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [feedback, setFeedback] = useState<{
    provider: string | null;
    connected: boolean;
    state: string;
    queued: number;
    uncertain: number;
  } | null>(null);
  const [sending, setSending] = useState(false);
  const [connectionProvider, setConnectionProvider] = useState("codex");
  const [openSessions, setOpenSessions] = useState<
    { id: string; title: string; project: string; state: string }[]
  >([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState("");
  const [connectingSession, setConnectingSession] = useState<string | null>(
    null,
  );
  async function loadSessions() {
    setSessionsLoading(true);
    setSessionsError("");
    try {
      setOpenSessions(await api("/agents/codex/sessions"));
    } catch (error) {
      setOpenSessions([]);
      setSessionsError(error instanceof Error ? error.message : String(error));
    } finally {
      setSessionsLoading(false);
    }
  }
  const connectionCommand = `atelier watch ${artifact?.id ?? "ARTIFACT_ID"} --agent ${connectionProvider} --cwd .`;
  useEffect(() => {
    if (!locationState.id) {
      setFeedback(null);
      return;
    }
    let cancelled = false;
    const update = () =>
      api(`/artifacts/${locationState.id}/feedback`)
        .then((value) => {
          if (!cancelled) setFeedback(value);
        })
        .catch(() => {
          if (!cancelled) setFeedback(null);
        });
    void update();
    const timer = setInterval(update, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [locationState.id]);
  function popupPosition(x: number, y: number) {
    return {
      x: Math.max(8, Math.min(x, innerWidth - 348)),
      y: Math.max(48, Math.min(y, innerHeight - 285)),
    };
  }
  const [search, setSearch] = useState(""),
    [reviewOpen, setReviewOpen] = useState(false),
    [activeComment, setActiveComment] = useState<string | null>(null),
    [selectionCandidate, setSelectionCandidate] = useState<{
      anchor: Anchor;
      x: number;
      y: number;
    } | null>(null),
    [panel, setPanel] = useState<Panel>(null),
    [selecting, setSelecting] = useState(false),
    [selectionScope, setSelectionScope] = useState<"element" | "section">(
      "element",
    ),
    [anchor, setAnchor] = useState<Anchor | null>(null),
    [body, setBody] = useState(""),
    [error, setError] = useState(""),
    [runtimeErrors, setRuntimeErrors] = useState<string[]>([]),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState<{ key: string; html: string } | null>(
      null,
    ),
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
  const thumbnailAttempts = useRef(new Set<string>());
  const thumbnailQueue = useRef(Promise.resolve());
  useEffect(() => {
    if (locationState.id) return;
    let cancelled = false;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const item = artifacts.find(
            (a) => a.id === (entry.target as HTMLElement).dataset.artifactId,
          );
          if (!item || item.thumbnailVersion) continue;
          observer.unobserve(entry.target);
          thumbnailQueue.current = thumbnailQueue.current.then(async () => {
            const key = `${item.id}:${item.head}`;
            if (cancelled || thumbnailAttempts.current.has(key)) return;
            thumbnailAttempts.current.add(key);
            try {
              await api(
                `/artifacts/${item.id}/check`,
                post({ revision: item.head }),
              );
            } catch {}
          });
        }
      },
      { rootMargin: "200px" },
    );
    document
      .querySelectorAll(".artifact-card")
      .forEach((card) => observer.observe(card));
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [artifacts, locationState.id, search]);
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
    setSelectionCandidate(null);
    setComposerPosition(null);
  }
  function openPanel(next: Panel) {
    setReviewOpen(false);
    setPanel(next);
    setComposerPosition(null);
    setSelecting(false);
    if (next !== "source") setCompare(null);
  }
  function startSelection() {
    setSelecting(true);
    setPanel(null);
    setReviewOpen(false);
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
    if (!revision) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const key = `${revision.artifactId}:${revision.number}`;
    api<{ html: string }>(
      `/artifacts/${revision.artifactId}/revisions/${revision.number}/preview`,
    )
      .then(({ html }) => {
        if (!cancelled) setPreview({ key, html });
      })
      .catch((error) => {
        if (!cancelled) setError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [revision?.artifactId, revision?.number]);
  useEffect(() => {
    if (revision) {
      setSourceFile(revision.content.entry);
      setRuntimeErrors([]);
      setSelecting(false);
      setSelectionCandidate(null);
      setComposerPosition(null);
      setAnchor(null);
    }
  }, [revision?.artifactId, revision?.number]);
  useEffect(() => {
    document.title = artifact ? `${artifact.title} · atelier` : "atelier";
  }, [artifact?.title]);
  useEffect(() => {
    setReviewOpen(false);
    setPanel(null);
    setActiveComment(null);
    setSelectionCandidate(null);
    setComposerPosition(null);
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
      if (msg.type === "selection-cancel") {
        setSelecting(false);
        return;
      }
      if (msg.type === "selection") {
        const selection = anchorSchema.safeParse(msg.anchor);
        if (!selecting || !selection.success) return;
        setAnchor(selection.data);
        setSelecting(false);
        setPanel(null);
        setComposerPosition(
          popupPosition(
            Number.isFinite(msg.x) ? msg.x : 24,
            Number.isFinite(msg.y) ? msg.y + 44 : 80,
          ),
        );
        setReviewOpen(false);
        setSelectionCandidate(null);
        setActiveComment(null);
      }
      if (msg.type === "selection-candidate") {
        const candidate = anchorSchema.safeParse(msg.anchor);
        if (
          !candidate.success ||
          !Number.isFinite(msg.x) ||
          !Number.isFinite(msg.y)
        ) {
          setSelectionCandidate(null);
        } else
          setSelectionCandidate({
            anchor: candidate.data,
            x: Math.max(8, Math.min(msg.x, innerWidth - 120)),
            y: Math.max(48, Math.min(msg.y + 44, innerHeight - 48)),
          });
      }
      if (
        msg.type === "open-comment" &&
        comments.some((c) => c.id === msg.id)
      ) {
        setActiveComment(msg.id);
        openPanel("comments");
      }
      if (msg.type === "runtime-error" && typeof msg.message === "string")
        setRuntimeErrors((old) =>
          [...new Set([...old, msg.message.slice(0, 1500)])].slice(0, 20),
        );
      if (msg.type === "snapshot") {
        snapshotResolvers.current.get(msg.requestId)?.(msg.snapshot);
        snapshotResolvers.current.delete(msg.requestId);
      }
      if (msg.type === "anchor-missing")
        notify(
          "This selection has changed. Open its original revision to locate it.",
        );
      if (msg.type === "escape") closeReview();
      if (msg.type === "ready") {
        iframe.current?.contentWindow?.postMessage(
          {
            atelier: true,
            type: "selection-mode",
            enabled: selecting,
            scope: selectionScope,
          },
          "*",
        );
        iframe.current?.contentWindow?.postMessage(
          {
            atelier: true,
            type: "annotations",
            comments: comments
              .filter((c) => c.status !== "resolved")
              .map((c) => ({ id: c.id, anchor: c.anchor })),
          },
          "*",
        );
      }
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
  }, [artifact?.id, selecting, selectionScope, comments]);
  useEffect(() => {
    iframe.current?.contentWindow?.postMessage(
      {
        atelier: true,
        type: "annotations",
        comments: comments
          .filter((c) => c.status !== "resolved")
          .map((c) => ({ id: c.id, anchor: c.anchor })),
      },
      "*",
    );
  }, [comments, preview]);
  useEffect(() => {
    if (panel === "comments" && activeComment)
      document
        .getElementById("comment-" + activeComment)
        ?.scrollIntoView({ block: "nearest" });
    if ((panel === "comments" || composerPosition) && anchor)
      document
        .querySelector<HTMLTextAreaElement>(".composer textarea")
        ?.focus();
  }, [panel, activeComment, anchor, composerPosition]);
  useEffect(() => {
    iframe.current?.contentWindow?.postMessage(
      {
        atelier: true,
        type: "selection-mode",
        enabled: selecting,
        scope: selectionScope,
      },
      "*",
    );
  }, [selecting, selectionScope]);
  async function addComment() {
    if (!artifact || !revision || sending) return;
    setSending(true);
    try {
      const created = await api<Comment>(
        `/artifacts/${artifact.id}/comments`,
        post({
          revision: revision.number,
          body,
          anchor,
          author: "You",
          notifyAgent: true,
        }),
      );
      setBody("");
      setAnchor(null);
      setComposerPosition(null);
      setActiveComment(created.id);
      await refresh();
      notify(
        feedback?.connected
          ? "Comment queued for your agent"
          : "Comment saved. Connect an agent to handle it automatically.",
      );
    } finally {
      setSending(false);
    }
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
  const composer = (
    <div className="composer">
      {anchor && (
        <div className="selected-quote">
          <span>{anchor.label || anchor.quote || `<${anchor.tag}>`}</span>
          <button aria-label="Clear selection" onClick={() => setAnchor(null)}>
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
        <span>
          {feedback?.connected ? `For ${feedback.provider}` : "For your agent"}
        </span>
        <button
          className="send-button"
          aria-label="Send comment"
          disabled={!body.trim() || sending}
          onClick={() => run(addComment)}
        >
          <ArrowUpRight size={17} />
        </button>
      </div>
      <small>
        {feedback?.connected
          ? "Delivered automatically while connected."
          : "Saved until an agent connects or reads it."}
      </small>
    </div>
  );
  return (
    <div
      className={
        showingArtifact
          ? "artifact-page" + (panel ? " panel-open" : "")
          : "library-page"
      }
    >
      {showingArtifact ? (
        <>
          {artifact &&
          revision &&
          preview?.key === `${artifact.id}:${revision.number}` ? (
            <iframe
              key={`${artifact.id}:${revision.number}`}
              ref={iframe}
              title="Artifact"
              sandbox="allow-scripts"
              srcDoc={preview.html}
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
                  <MousePointer2 size={15} />
                  <span>Choose what to comment on</span>
                  <button
                    aria-pressed={selectionScope === "element"}
                    onClick={() => setSelectionScope("element")}
                  >
                    Element
                  </button>
                  <button
                    aria-pressed={selectionScope === "section"}
                    onClick={() => setSelectionScope("section")}
                  >
                    Section
                  </button>
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
                <nav className="toolbar-actions" aria-label="Artifact actions">
                  <button
                    aria-label={`Comments (${comments.filter((c) => c.status !== "resolved").length})`}
                    aria-expanded={panel === "comments"}
                    className={panel === "comments" ? "selected" : ""}
                    onClick={() =>
                      openPanel(panel === "comments" ? null : "comments")
                    }
                  >
                    <MessageSquare size={16} />
                    <span>Comments</span>
                    <b>
                      {comments.filter((c) => c.status !== "resolved").length ||
                        ""}
                    </b>
                  </button>
                  <button
                    aria-label="Comment on an element"
                    title="Comment on an element"
                    aria-pressed={selecting}
                    onClick={() =>
                      selecting ? setSelecting(false) : startSelection()
                    }
                  >
                    <MousePointer2 size={16} />
                  </button>
                  <button
                    aria-label="History"
                    title="History"
                    onClick={() =>
                      openPanel(panel === "history" ? null : "history")
                    }
                  >
                    <History size={16} />
                  </button>
                  <button
                    aria-label="Share"
                    onClick={() =>
                      openPanel(panel === "share" ? null : "share")
                    }
                  >
                    <Download size={16} />
                    <span>Share</span>
                  </button>
                  <button
                    aria-label="More actions"
                    title="More actions"
                    aria-expanded={reviewOpen}
                    onClick={() => setReviewOpen(!reviewOpen)}
                  >
                    <MoreHorizontal size={18} />
                    {runtimeErrors.length > 0 && <span className="error-dot" />}
                  </button>
                </nav>
                {reviewOpen && (
                  <div className="review-menu">
                    <button onClick={() => openPanel("source")}>
                      <Code2 size={14} /> Source
                    </button>
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
                                  notifyAgent: true,
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
              {selectionCandidate && !selecting && (
                <button
                  className="selection-comment"
                  style={{
                    left: selectionCandidate.x,
                    top: selectionCandidate.y,
                  }}
                  onClick={() => {
                    setAnchor(selectionCandidate.anchor);
                    setSelectionCandidate(null);
                    setActiveComment(null);
                    setPanel(null);
                    setComposerPosition(
                      popupPosition(selectionCandidate.x, selectionCandidate.y),
                    );
                  }}
                >
                  <MessageSquare size={14} /> Comment
                </button>
              )}
              {composerPosition && (
                <section
                  role="dialog"
                  aria-label="New comment"
                  className="comment-popover"
                  style={{
                    left: `clamp(8px, ${composerPosition.x}px, max(8px, calc(100vw - 348px)))`,
                    top: `clamp(48px, ${composerPosition.y}px, max(48px, calc(100dvh - 285px)))`,
                  }}
                >
                  <header>
                    <strong>Comment</strong>
                    <button
                      aria-label="Close comment"
                      onClick={() => setComposerPosition(null)}
                    >
                      <X size={15} />
                    </button>
                  </header>
                  {composer}
                </section>
              )}
              {panel && (
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
                      <div className="feedback-status" role="status">
                        <span>
                          {feedback?.connected
                            ? feedback.state === "needs_permission"
                              ? `${feedback.provider} needs permission in the terminal`
                              : feedback.state === "awaiting_agent"
                                ? "Waiting for Claude to read the comments"
                                : feedback.state === "working"
                                  ? `${feedback.provider} is handling feedback`
                                  : `${feedback.provider} connected`
                            : "No agent connected"}
                        </span>
                        {feedback?.connected && (
                          <button
                            onClick={() =>
                              run(async () => {
                                await api(
                                  `/artifacts/${artifact.id}/feedback/disconnect`,
                                  post({}),
                                );
                                setFeedback(null);
                              })
                            }
                          >
                            Disconnect
                          </button>
                        )}
                        {!!feedback?.queued && (
                          <small>
                            {feedback.queued} feedback event
                            {feedback.queued === 1 ? "" : "s"} queued
                          </small>
                        )}
                        {!!feedback?.uncertain && (
                          <div>
                            <small>
                              Delivery was interrupted. Check the thread before
                              retrying.
                            </small>
                            <button
                              onClick={() =>
                                run(async () => {
                                  await api(
                                    `/artifacts/${artifact.id}/feedback/retry`,
                                    post({}),
                                  );
                                  setFeedback(
                                    await api(
                                      `/artifacts/${artifact.id}/feedback`,
                                    ),
                                  );
                                })
                              }
                            >
                              Retry uncertain deliveries
                            </button>
                          </div>
                        )}
                      </div>
                      {!feedback?.connected && (
                        <details
                          className="agent-connect"
                          onToggle={(event) => {
                            if (
                              event.currentTarget.open &&
                              connectionProvider === "codex"
                            )
                              void loadSessions();
                          }}
                        >
                          <summary>Connect an agent</summary>
                          <label>
                            Agent{" "}
                            <select
                              value={connectionProvider}
                              onChange={(event) => {
                                setConnectionProvider(event.target.value);
                                if (event.target.value === "codex")
                                  void loadSessions();
                              }}
                            >
                              <option value="codex">Codex</option>
                              <option value="claude">Claude Code</option>
                              <option value="copilot">
                                GitHub Copilot CLI
                              </option>
                            </select>
                          </label>
                          {connectionProvider === "codex" ? (
                            <>
                              <p>
                                Choose the conversation that should receive your
                                comments. Keep Codex open.
                              </p>
                              {sessionsLoading && (
                                <p role="status">
                                  Looking for open conversations…
                                </p>
                              )}
                              {sessionsError && (
                                <p role="alert">{sessionsError}</p>
                              )}
                              {!sessionsLoading &&
                                !sessionsError &&
                                !openSessions.length && (
                                  <p>
                                    No open conversations. Open your
                                    conversation in Codex, then refresh.
                                  </p>
                                )}
                              <div className="conversation-list">
                                {openSessions.map((session) => (
                                  <div
                                    className="conversation-option"
                                    key={session.id}
                                  >
                                    <div>
                                      <strong>{session.title}</strong>
                                      <small title={session.project}>
                                        {session.project
                                          .split(/[\\/]/)
                                          .filter(Boolean)
                                          .slice(-2)
                                          .join("/") || "No project"}{" "}
                                        ·{" "}
                                        {session.state === "active"
                                          ? "Working"
                                          : "Ready"}
                                      </small>
                                    </div>
                                    <button
                                      disabled={connectingSession !== null}
                                      aria-label={`Connect to ${session.title}`}
                                      onClick={async () => {
                                        setConnectingSession(session.id);
                                        setSessionsError("");
                                        try {
                                          const targetId = artifact.id;
                                          const status = await api(
                                            `/artifacts/${targetId}/feedback/codex`,
                                            post({ session: session.id }),
                                          );
                                          if (route().id !== targetId) return;
                                          setFeedback(status);
                                          notify(
                                            "Comments connected to your Codex conversation",
                                          );
                                        } catch (error) {
                                          setSessionsError(
                                            error instanceof Error
                                              ? error.message
                                              : String(error),
                                          );
                                        } finally {
                                          setConnectingSession(null);
                                        }
                                      }}
                                    >
                                      {connectingSession === session.id
                                        ? "Connecting…"
                                        : "Connect"}
                                    </button>
                                  </div>
                                ))}
                              </div>
                              <button
                                disabled={sessionsLoading}
                                onClick={() => void loadSessions()}
                              >
                                Refresh conversations
                              </button>
                            </>
                          ) : (
                            <>
                              <p>
                                Run this command in the agent's working
                                directory. Keep the terminal open.
                              </p>
                              <code>{connectionCommand}</code>
                              <button
                                onClick={() =>
                                  run(async () => {
                                    await navigator.clipboard.writeText(
                                      connectionCommand,
                                    );
                                    notify("Connection command copied");
                                  })
                                }
                              >
                                <Copy size={12} /> Copy command
                              </button>
                            </>
                          )}
                        </details>
                      )}
                      <div className="comment-intro">
                        <p>Highlight text on the page to comment.</p>
                        <button onClick={startSelection}>
                          <MousePointer2 size={14} /> Select an element
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
                            id={"comment-" + c.id}
                            data-active={activeComment === c.id}
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
                                onClick={() => {
                                  setActiveComment(c.id);
                                  iframe.current?.contentWindow?.postMessage(
                                    {
                                      atelier: true,
                                      type: "locate",
                                      anchor: c.anchor,
                                    },
                                    "*",
                                  );
                                }}
                              >
                                {c.anchor.label ||
                                  c.anchor.quote ||
                                  `<${c.anchor.tag}>`}
                              </button>
                            )}
                            <p>{c.body}</p>
                            {history
                              .filter((r) => r.commentIds.includes(c.id))
                              .map((r) => (
                                <button
                                  className="comment-revision"
                                  key={r.number}
                                  onClick={() =>
                                    navigate(artifact.id, r.number)
                                  }
                                >
                                  Updated in revision {r.number}{" "}
                                  <ArrowUpRight size={12} />
                                </button>
                              ))}
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
                                          notifyAgent: true,
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
                                        notifyAgent: true,
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
                      {!composerPosition && composer}
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
                        Recipients see only the document, without atelier’s
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
                  <article
                    className="artifact-card"
                    key={a.id}
                    data-artifact-id={a.id}
                  >
                    <button
                      className="artifact-card-open"
                      aria-label={`Open ${a.title}`}
                      onClick={() => navigate(a.id)}
                    >
                      <span className="artifact-thumbnail">
                        {a.thumbnailVersion ? (
                          <img
                            src={`/api/artifacts/${a.id}/thumbnail?v=${encodeURIComponent(a.thumbnailVersion)}`}
                            alt={`Preview of ${a.title}`}
                            loading="lazy"
                          />
                        ) : (
                          <span className="thumbnail-placeholder">
                            <Code2 size={28} />
                            <span>Preview unavailable</span>
                          </span>
                        )}
                      </span>
                      <span className="artifact-card-title">{a.title}</span>
                      <span className="artifact-card-description">
                        {a.description || a.kind.toUpperCase()}
                      </span>
                    </button>
                    <div className="artifact-card-footer">
                      <span>v{a.head}</span>
                      <div>
                        <button
                          aria-label={`Rename ${a.title}`}
                          title="Rename"
                          onClick={() => manage("rename", a)}
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          aria-label={`Delete ${a.title}`}
                          title="Delete artifact"
                          className="danger-action"
                          onClick={() => manage("delete", a)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
                {!filtered.length && (
                  <p className="no-results">No artifacts match your search.</p>
                )}
              </div>
            </>
          ) : (
            <section className="empty-library">
              <h2>No artifacts yet</h2>
              <p>Ask your connected agent to create an artifact in atelier.</p>
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
