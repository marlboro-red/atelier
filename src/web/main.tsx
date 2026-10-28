import { loadPreview } from "./preview-cache";
import { SourcePanel } from "./source-panel";
import { useResources } from "./use-resources";
import { artifactMessageSchema } from "../shared/bridge-messages";
import { Library } from "./library";
import { useFeedback } from "./use-feedback";
import { useThumbnails } from "./use-thumbnails";
import { api, post } from "./api";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
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
import type {
  Artifact,
  Revision,
  RevisionMetadata,
  Comment,
  Anchor,
  FeedbackStatus,
} from "../shared/schema";
import "./style.css";
import "./workshop.css";
const route = () => {
  const match = location.pathname.match(/^\/a\/([^/]+)(?:\/revisions\/(\d+))?/);
  return {
    id: match?.[1] ?? "",
    revision: match?.[2] ? Number(match[2]) : null,
  };
};
type Panel = "comments" | "history" | "source" | "share" | null;
function App() {
  const [hasMoreArtifacts, setHasMoreArtifacts] = useState(false);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]),
    [locationState, setLocationState] = useState(route),
    [artifact, setArtifact] = useState<Artifact | null>(null),
    [revision, setRevision] = useState<Revision | null>(null),
    [history, setHistory] = useState<RevisionMetadata[]>([]),
    [comments, setComments] = useState<Comment[]>([]);
  const [composerPosition, setComposerPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [threadPosition, setThreadPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [feedback, setFeedback] = useState<FeedbackStatus | null>(null);
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
  const streamConnected = useRef(false);
  const connectionCommand = `atelier watch ${artifact?.id ?? "ARTIFACT_ID"} --agent ${connectionProvider} --cwd .`;
  useFeedback(locationState.id, streamConnected, setFeedback, setComments);
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
  const collectionContext = useRef("");
  collectionContext.current = JSON.stringify([locationState.id, search]);
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
  useThumbnails(artifacts, locationState.id, search);
  const iframe = useRef<HTMLIFrameElement>(null);
  const snapshotResolvers = useRef(
    new Map<
      string,
      {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >(),
  );
  useEffect(
    () => () => {
      for (const request of snapshotResolvers.current.values()) {
        clearTimeout(request.timer);
        request.reject(
          new Error(
            "Artifact changed during export. Retry from the current revision.",
          ),
        );
      }
      snapshotResolvers.current.clear();
    },
    [locationState.id, locationState.revision],
  );
  const requestCounter = useRef(0);
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
    setThreadPosition(null);
    setSelecting(false);
    if (next !== "source") setCompare(null);
  }
  function startSelection() {
    setSelecting(true);
    setPanel(null);
    setReviewOpen(false);
  }
  const refresh = useResources({
    locationState,
    search,
    setArtifacts,
    setHasMoreArtifacts,
    setArtifact,
    setRevision,
    setHistory,
    setComments,
    setFeedback,
    streamConnected,
    onMissing: () => navigate(""),
    onError: setError,
  });
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
    if (!revision || revision.artifactId !== locationState.id) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const key = `${revision.artifactId}:${revision.number}`;
    loadPreview(
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
  }, [revision?.artifactId, revision?.number, locationState.id]);
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
      const parsed = artifactMessageSchema.safeParse(event.data);
      if (!parsed.success) return;
      const msg = parsed.data;
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
            msg.x !== undefined ? msg.x : 24,
            msg.y !== undefined ? msg.y + 44 : 80,
          ),
        );
        setReviewOpen(false);
        setSelectionCandidate(null);
        setActiveComment(null);
      }
      if (msg.type === "selection-candidate") {
        const candidate = anchorSchema.safeParse(msg.anchor);
        if (!candidate.success || msg.x === undefined || msg.y === undefined) {
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
        if (msg.x !== undefined && msg.y !== undefined)
          setThreadPosition(popupPosition(msg.x, msg.y + 44));
      }
      if (msg.type === "runtime-error" && typeof msg.message === "string")
        setRuntimeErrors((old) =>
          [...new Set([...old, msg.message.slice(0, 1500)])].slice(0, 20),
        );
      if (msg.type === "snapshot") {
        const request = snapshotResolvers.current.get(msg.requestId);
        if (request) {
          clearTimeout(request.timer);
          msg.error
            ? request.reject(new Error(String(msg.error)))
            : request.resolve(msg.snapshot);
          snapshotResolvers.current.delete(msg.requestId);
        }
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
          const saved = await api<{ dataVersion: number }>(
            `/artifacts/${artifact.id}/data`,
            {
              method: "PUT",
              body: JSON.stringify({
                data: msg.data,
                baseVersion: msg.baseVersion,
              }),
            },
          );
          event.source?.postMessage(
            {
              atelier: true,
              type: "data-result",
              requestId: msg.requestId,
              dataVersion: saved.dataVersion,
            },
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
      setThreadPosition(composerPosition);
      setComposerPosition(null);
      setPanel("comments");
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
      const snapshot = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          snapshotResolvers.current.delete(requestId);
          reject(
            new Error(
              "The artifact did not finish capturing its state. Wait for it to finish loading, then retry export.",
            ),
          );
        }, 15000);
        snapshotResolvers.current.set(requestId, { resolve, reject, timer });
        iframe.current?.contentWindow?.postMessage(
          { atelier: true, type: "snapshot", requestId },
          "*",
        );
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
          ? "artifact-page" +
            (panel && panel !== "comments" ? " panel-open" : "")
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
                  <span className="toolbar-wordmark" aria-hidden="true">
                    a
                  </span>
                  <ArrowLeft size={13} />
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
                    onClick={() => (
                      setActiveComment(null),
                      openPanel(panel === "comments" ? null : "comments")
                    )}
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
                <div
                  role={panel === "comments" ? "dialog" : "complementary"}
                  className={
                    panel === "comments"
                      ? "comment-popover comment-threads"
                      : "review-panel " +
                        (panel === "source" ? "source-panel" : "")
                  }
                  style={
                    panel === "comments"
                      ? {
                          left: threadPosition
                            ? `clamp(8px, ${threadPosition.x}px, max(8px, calc(100vw - 348px)))`
                            : undefined,
                          right: threadPosition ? undefined : 12,
                          maxHeight: threadPosition
                            ? `min(560px, calc(100dvh - clamp(52px, ${threadPosition.y}px, max(52px, calc(100dvh - 400px))) - 8px))`
                            : undefined,
                          top: threadPosition
                            ? `clamp(52px, ${threadPosition.y}px, max(52px, calc(100dvh - 400px)))`
                            : 52,
                        }
                      : undefined
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
                      {activeComment && (
                        <button
                          className="all-comments"
                          onClick={() => setActiveComment(null)}
                        >
                          ← All comments
                        </button>
                      )}
                      {!activeComment && (
                        <div className="comment-intro">
                          <p>Highlight text on the page to comment.</p>
                          <button onClick={startSelection}>
                            <MousePointer2 size={14} /> Select an element
                          </button>
                        </div>
                      )}
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
                        {comments
                          .filter(
                            (c) => !activeComment || c.id === activeComment,
                          )
                          .map((c) => (
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
                              <div className="comment-status" role="status">
                                <span
                                  className={"status " + c.status}
                                  data-read={!!c.acknowledgedAt}
                                  title={
                                    c.acknowledgedAt
                                      ? `Acknowledged ${new Date(c.acknowledgedAt).toLocaleString()}`
                                      : undefined
                                  }
                                >
                                  {
                                    {
                                      open: c.acknowledgedAt
                                        ? "Acknowledged"
                                        : "Not yet acknowledged",
                                      in_progress: "Being addressed",
                                      addressed: "Ready for review",
                                      resolved: "Resolved",
                                    }[c.status]
                                  }
                                </span>
                                <button
                                  aria-label={
                                    c.status === "resolved"
                                      ? "Reopen comment"
                                      : "Resolve comment"
                                  }
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
                                  <span>
                                    {c.status === "resolved"
                                      ? "Reopen"
                                      : "Resolve"}
                                  </span>
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
                      {!composerPosition && !activeComment && composer}
                      <div className="comment-connection">
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
                                Delivery was interrupted. Check the thread
                                before retrying.
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
                                  Choose the conversation that should receive
                                  your comments. Keep Codex open.
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
                      </div>
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
                        {history.length > 0 && history.at(-1)!.number > 1 && (
                          <button
                            onClick={() =>
                              run(async () => {
                                const rows = await api<RevisionMetadata[]>(
                                  `/artifacts/${artifact.id}/revisions?before=${history.at(-1)!.number}`,
                                );
                                setHistory((old) => [
                                  ...old,
                                  ...rows.filter(
                                    (row) =>
                                      !old.some(
                                        (item) => item.number === row.number,
                                      ),
                                  ),
                                ]);
                              })
                            }
                          >
                            Load older revisions
                          </button>
                        )}
                      </div>
                    </>
                  ) : panel === "source" ? (
                    <SourcePanel
                      revision={revision}
                      compare={compare}
                      sourceFile={sourceFile}
                      onSelect={setSourceFile}
                      onCopy={() =>
                        run(async () => {
                          await navigator.clipboard.writeText(
                            revision.content.files[sourceFile],
                          );
                          notify("Source copied");
                        })
                      }
                    />
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
                </div>
              )}
            </>
          )}
        </>
      ) : (
        <Library
          artifacts={artifacts}
          search={search}
          hasMoreArtifacts={hasMoreArtifacts}
          onSearch={setSearch}
          onOpen={navigate}
          onManage={manage}
          onLoadMore={async () => {
            let loaded = false;
            await run(async () => {
              const context = collectionContext.current;
              const last = artifacts.at(-1)!;
              const rows = await api<Artifact[]>(
                `/artifacts?cursor=${encodeURIComponent(last.updatedAt + "|" + last.id)}&search=${encodeURIComponent(search)}`,
              );
              if (context !== collectionContext.current) return;
              setArtifacts((old) => [
                ...old,
                ...rows.filter(
                  (row) => !old.some((item) => item.id === row.id),
                ),
              ]);
              setHasMoreArtifacts(rows.length === 200);
              loaded = rows.length > 0;
            });
            return loaded;
          }}
        />
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
