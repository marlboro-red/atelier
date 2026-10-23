import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Plus,
  Search,
  ArrowUpRight,
  Code2,
  MessageSquare,
  History,
  Download,
  ChevronDown,
  ChevronLeft,
  Copy,
  Check,
  X,
  MousePointer2,
  FileText,
  LayoutDashboard,
  Layers,
  ArrowRight,
  RotateCcw,
  ExternalLink,
  PanelRightClose,
  Maximize2,
} from "lucide-react";
import type {
  Artifact,
  Revision,
  Comment,
  Anchor,
  Content,
} from "../shared/schema";
import { templates } from "./templates";
import { contentSchema } from "../shared/schema";
import "./style.css";
async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const r = await fetch("/api" + path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (!r.ok) {
    const e = await r.json();
    throw new Error(e.error ?? r.statusText);
  }
  return r.json();
}
const post = (body: unknown) => ({
  method: "POST",
  body: JSON.stringify(body),
});
const route = () => {
  const m = location.pathname.match(/^\/a\/([^/]+)(?:\/revisions\/(\d+))?/);
  return { id: m?.[1] ?? "", revision: m?.[2] ? Number(m[2]) : null };
};
function App() {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]),
    [locationState, setLocationState] = useState(route),
    [artifact, setArtifact] = useState<Artifact | null>(null),
    [revision, setRevision] = useState<Revision | null>(null),
    [history, setHistory] = useState<Revision[]>([]),
    [comments, setComments] = useState<Comment[]>([]);
  const [search, setSearch] = useState(""),
    [view, setView] = useState<"preview" | "source">("preview"),
    [panel, setPanel] = useState<"comments" | "history" | null>("comments"),
    [selecting, setSelecting] = useState(false),
    [anchor, setAnchor] = useState<Anchor | null>(null),
    [body, setBody] = useState(""),
    [error, setError] = useState(""),
    [runtimeErrors, setRuntimeErrors] = useState<string[]>([]),
    [notice, setNotice] = useState(""),
    [creating, setCreating] = useState(false),
    [template, setTemplate] = useState(0),
    [title, setTitle] = useState(""),
    [busy, setBusy] = useState(false),
    [share, setShare] = useState(false),
    [previewPort, setPreviewPort] = useState(4311),
    [sourceFile, setSourceFile] = useState(""),
    [draft, setDraft] = useState<Record<string, string>>({}),
    [summary, setSummary] = useState(""),
    [compare, setCompare] = useState<Revision | null>(null);
  const draftStatus = useRef({ dirty: false, id: "" });
  const importInput = useRef<HTMLInputElement>(null);
  const [imported, setImported] = useState<Content | null>(null);
  const iframe = useRef<HTMLIFrameElement>(null);
  const snapshotResolvers = useRef(new Map<string, (v: any) => void>());
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
    historyPush(id ? `/a/${id}${n ? "/revisions/" + n : ""}` : "/");
    setLocationState(route());
    setCompare(null);
    setAnchor(null);
  };
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
    if (!(draftStatus.current.dirty && draftStatus.current.id === a.id))
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
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    if (revision) {
      setDraft(revision.content.files);
      setSourceFile(revision.content.entry);
      setSummary("");
      setRuntimeErrors([]);
      setSelecting(false);
    }
  }, [revision?.artifactId, revision?.number]);
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
        setPanel("comments");
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
  async function create() {
    setBusy(true);
    await run(async () => {
      const t = templates[template];
      const a = await api<Artifact>(
        "/artifacts",
        post({
          title: title.trim() || t.name,
          description: imported ? "Imported artifact" : t.description,
          author: "You",
          content: imported ?? t.content,
        }),
      );
      setCreating(false);
      setTitle("");
      setImported(null);
      navigate(a.id);
      await refresh();
    });
    setBusy(false);
  }
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
    setShare(false);
    setBusy(true);
    await run(async () => {
      let snapshot: any = null;
      if (view === "preview") {
        const requestId = String(++requestCounter.current);
        snapshot = await new Promise((resolve) => {
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
      }
      const response = await fetch(`/api/artifacts/${artifact.id}/export`, {
        ...post({ revision: revision.number, format, snapshot }),
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) throw new Error((await response.json()).error);
      const blob = await response.blob();
      download(blob, `${artifact.title}-v${revision.number}.${format}`);
      notify(`${format.toUpperCase()} exported · revision ${revision.number}`);
    });
    setBusy(false);
  }
  async function importFiles(files: FileList | null) {
    if (!files?.length) return;
    await run(async () => {
      const entries: Record<string, string> = {};
      for (const f of Array.from(files)) {
        entries[f.name] =
          f.type.startsWith("image/") && !f.name.endsWith(".svg")
            ? await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result));
                reader.onerror = reject;
                reader.readAsDataURL(f);
              })
            : await f.text();
      }
      const names = Object.keys(entries);
      if (names.length === 1 && names[0].endsWith(".json")) {
        setImported(contentSchema.parse(JSON.parse(entries[names[0]])));
        setTitle(names[0].replace(/\.json$/, ""));
        return;
      }
      let entry =
        names.find((n) => /\.(tsx|jsx|html|md)$/.test(n)) ??
        names.find((n) => n.endsWith(".svg"));
      if (!entry) {
        entry = "index.html";
        entries[entry] =
          '<main style="display:grid;gap:24px;padding:40px">' +
          names
            .map((n) => '<img style="max-width:100%" src="' + entries[n] + '">')
            .join("") +
          "</main>";
      }
      const kind = entry.endsWith(".md")
        ? "markdown"
        : entry.endsWith(".svg")
          ? "svg"
          : entry.endsWith(".html")
            ? "html"
            : "react";
      setImported({ kind, entry, files: entries });
      setTitle(entry.replace(/\.[^.]+$/, ""));
    });
  }
  const filtered = artifacts.filter((a) =>
    (a.title + " " + a.description)
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const dirty =
    revision &&
    JSON.stringify(draft) !== JSON.stringify(revision.content.files);
  draftStatus.current = { dirty: !!dirty, id: artifact?.id ?? "" };
  return (
    <div className="app">
      <aside className="sidebar">
        <button className="brand" onClick={() => navigate("")}>
          <span className="brand-mark">a</span>
          <span>
            atelier<span className="brand-dot">.</span>
          </span>
        </button>
        <div className="workspace-label">
          YOUR WORKSPACE <span className="local-dot" title="Local workspace" />
        </div>
        <button className="new-button" onClick={() => setCreating(true)}>
          <Plus size={16} /> New artifact <span>＋</span>
        </button>
        <label className="search">
          <Search size={15} />
          <input
            aria-label="Search artifacts"
            placeholder="Find something…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div className="section-label">
          ARTIFACTS <span>{artifacts.length.toString().padStart(2, "0")}</span>
        </div>
        <nav className="artifact-list">
          {filtered.map((a) => (
            <button
              key={a.id}
              className={
                "artifact-link " + (artifact?.id === a.id ? "active" : "")
              }
              onClick={() => navigate(a.id)}
            >
              {a.kind === "markdown" ? (
                <FileText size={17} />
              ) : (
                <LayoutDashboard size={17} />
              )}
              <span>
                {a.title}
                <small>
                  {a.kind} · v{a.head}
                </small>
              </span>
            </button>
          ))}
          {!filtered.length && (
            <p className="sidebar-empty">
              {search ? "No matching artifacts." : "Your ideas will live here."}
            </p>
          )}
        </nav>
        <div className="sidebar-bottom">
          <span className="local-indicator" /> Local to this computer
          <small>Made with any agent. Kept by you.</small>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>Workspace</span>
            <span className="slash">/</span>
            <strong>{artifact?.title ?? "All artifacts"}</strong>
          </div>
          <span className="local-badge">LOCAL WORKSPACE</span>
        </header>
        {error && (
          <div className="error-banner" role="alert">
            {error}
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              <X size={16} />
            </button>
          </div>
        )}
        {!artifact ? (
          <div className="home">
            <div className="eyebrow">A PLACE FOR WHAT YOU MAKE</div>
            <h1>
              Give your ideas
              <br />
              <em>somewhere to live.</em>
            </h1>
            <p className="home-intro">
              From a first thought to the final detail.
              <br />
              Create with any agent. Refine it here. Make it yours.
            </p>
            <button className="primary" onClick={() => setCreating(true)}>
              Create an artifact <ArrowUpRight size={16} />
            </button>
            <div className="home-section">
              <h2>
                {artifacts.length
                  ? "On your workbench"
                  : "Start with a little inspiration"}
              </h2>
              <span>
                {artifacts.length
                  ? "Pick up where you left off"
                  : "A few things you can make"}
              </span>
            </div>
            <div className="cards">
              {artifacts.length
                ? filtered.map((a) => (
                    <button
                      className="artifact-card"
                      key={a.id}
                      onClick={() => navigate(a.id)}
                    >
                      <div className={"card-art " + a.kind}>
                        {a.kind === "markdown" ? (
                          <FileText size={45} />
                        ) : (
                          <Layers size={45} />
                        )}
                        <span>v{a.head}</span>
                      </div>
                      <h3>{a.title}</h3>
                      <p>{a.description || "An idea in progress"}</p>
                      <footer>
                        {a.kind}
                        <ArrowUpRight size={15} />
                      </footer>
                    </button>
                  ))
                : templates.slice(0, 3).map((t, i) => (
                    <button
                      key={t.name}
                      className="artifact-card"
                      onClick={() => {
                        setTemplate(i);
                        setCreating(true);
                      }}
                    >
                      <div className={"card-art template-" + i}>
                        {i === 0 ? (
                          <div className="mini-chart">
                            {[30, 48, 37, 65, 55, 84, 72].map((h, j) => (
                              <i key={j} style={{ height: h }} />
                            ))}
                          </div>
                        ) : i === 1 ? (
                          <div className="mini-doc">
                            <b>
                              A thought,
                              <br />
                              well expressed.
                            </b>
                            <i />
                            <i />
                            <i />
                          </div>
                        ) : (
                          <div className="mini-flow">
                            <i />
                            <span>→</span>
                            <i />
                            <span>→</span>
                            <i />
                          </div>
                        )}
                      </div>
                      <h3>{t.name}</h3>
                      <p>{t.description}</p>
                      <footer>
                        Explore template <ArrowUpRight size={15} />
                      </footer>
                    </button>
                  ))}
            </div>
            <div className="agent-note">
              <Code2 size={18} />
              <div>
                <strong>Your agent is welcome here.</strong>
                <p>Connect through MCP, the CLI, or the local HTTP API.</p>
              </div>
              <code>atelier mcp</code>
            </div>
          </div>
        ) : (
          revision && (
            <>
              <div className="artifact-heading">
                <div>
                  <div className="eyebrow">
                    {revision.content.kind.toUpperCase()} ARTIFACT{" "}
                    <span> / </span>{" "}
                    {locationState.revision
                      ? "HISTORICAL REVISION"
                      : "ON YOUR WORKBENCH"}
                  </div>
                  <h1>{artifact.title}</h1>
                  <p>
                    {artifact.description ||
                      "A work in progress, with room to grow."}
                  </p>
                </div>
                <div className="heading-actions">
                  <button
                    className="icon-button"
                    title="Duplicate this revision"
                    onClick={() =>
                      run(async () => {
                        const a = await api(
                          `/artifacts/${artifact.id}/duplicate`,
                          post({ revision: revision.number }),
                        );
                        navigate(a.id);
                      })
                    }
                  >
                    <Copy size={17} />
                  </button>
                  <div className="share-wrapper">
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => setShare(!share)}
                    >
                      <Download size={15} />
                      {busy ? "Preparing…" : "Share"}
                      <ChevronDown size={14} />
                    </button>
                    {share && (
                      <div className="dropdown">
                        <button onClick={() => exportArtifact("html")}>
                          Save as HTML
                          <small>Interactive, standalone file</small>
                        </button>
                        <button onClick={() => exportArtifact("pdf")}>
                          Save as PDF<small>Print-ready snapshot</small>
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
                          Download source
                          <small>All files, ready for an agent</small>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <div className="editor-layout">
                <section className="preview-shell">
                  <div className="preview-toolbar">
                    <div className="segmented">
                      <button
                        className={view === "preview" ? "selected" : ""}
                        onClick={() => {
                          setView("preview");
                          setCompare(null);
                        }}
                      >
                        Preview
                      </button>
                      <button
                        className={view === "source" ? "selected" : ""}
                        onClick={() => setView("source")}
                      >
                        <Code2 size={14} /> Source
                      </button>
                    </div>
                    <div className="toolbar-right">
                      <span className="version-tag">
                        v{revision.number}
                        {revision.number === artifact.head ? " · latest" : ""}
                      </span>
                      <button
                        className={
                          "icon-button " + (selecting ? "toggled" : "")
                        }
                        title="Select text or an element to comment"
                        disabled={view !== "preview"}
                        onClick={() => {
                          setSelecting(!selecting);
                          setPanel("comments");
                        }}
                      >
                        <MousePointer2 size={16} />
                      </button>
                      <button
                        className={
                          "icon-button " +
                          (panel === "history" ? "toggled" : "")
                        }
                        title="Revision history"
                        onClick={() =>
                          setPanel(panel === "history" ? null : "history")
                        }
                      >
                        <History size={17} />
                      </button>
                      <button
                        className={
                          "icon-button " +
                          (panel === "comments" ? "toggled" : "")
                        }
                        title="Comments"
                        onClick={() =>
                          setPanel(panel === "comments" ? null : "comments")
                        }
                      >
                        <MessageSquare size={16} />
                      </button>
                      <button
                        className="icon-button"
                        title="Fullscreen preview"
                        onClick={() => iframe.current?.requestFullscreen()}
                      >
                        <Maximize2 size={16} />
                      </button>
                    </div>
                  </div>
                  {locationState.revision && (
                    <div className="revision-banner">
                      Viewing revision {revision.number}
                      <button onClick={() => navigate(artifact.id)}>
                        Return to latest <ArrowRight size={13} />
                      </button>
                    </div>
                  )}
                  {selecting && view === "preview" && (
                    <div className="selection-banner">
                      Highlight text or click an element to leave feedback.
                      <button onClick={() => setSelecting(false)}>
                        <X size={14} />
                      </button>
                    </div>
                  )}
                  {view === "preview" ? (
                    <iframe
                      key={`${artifact.id}:${revision.number}`}
                      ref={iframe}
                      title="Artifact preview"
                      sandbox="allow-scripts"
                      src={`http://127.0.0.1:${previewPort}/preview/${artifact.id}/${revision.number}`}
                      className="preview-frame"
                    />
                  ) : (
                    <div className="source-view">
                      <div className="file-tabs">
                        {Object.keys(draft).map((f) => (
                          <button
                            className={f === sourceFile ? "selected" : ""}
                            key={f}
                            onClick={() => setSourceFile(f)}
                          >
                            {f}
                          </button>
                        ))}
                        <button
                          title="Copy file"
                          onClick={() =>
                            run(async () => {
                              await navigator.clipboard.writeText(
                                draft[sourceFile],
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
                        <textarea
                          aria-label="Artifact source"
                          spellCheck={false}
                          value={draft[sourceFile] ?? ""}
                          onChange={(e) =>
                            setDraft({ ...draft, [sourceFile]: e.target.value })
                          }
                        />
                      )}
                      <div className="source-save">
                        {dirty && (
                          <button
                            title="Discard local edits"
                            onClick={() => {
                              draftStatus.current.dirty = false;
                              setDraft(revision.content.files);
                              run(refresh);
                            }}
                          >
                            <RotateCcw size={15} />
                          </button>
                        )}
                        <input
                          aria-label="Change summary"
                          placeholder="What changed?"
                          value={summary}
                          onChange={(e) => setSummary(e.target.value)}
                        />
                        <button
                          className="primary"
                          disabled={!dirty || !summary.trim()}
                          onClick={() =>
                            run(async () => {
                              const saved = await api<Revision>(
                                `/artifacts/${artifact.id}/revisions`,
                                post({
                                  baseRevision: revision.number,
                                  author: "You",
                                  summary,
                                  content: {
                                    ...revision.content,
                                    files: draft,
                                  },
                                }),
                              );
                              draftStatus.current.dirty = false;
                              setRevision(saved);
                              setDraft(saved.content.files);
                              navigate(artifact.id);
                              await refresh();
                              notify("New revision saved");
                            })
                          }
                        >
                          Save revision
                        </button>
                      </div>
                    </div>
                  )}
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
                            setPanel("comments");
                            await refresh();
                            notify("Error details queued for your agent");
                          })
                        }
                      >
                        Send errors to agent <ArrowUpRight size={14} />
                      </button>
                    </div>
                  )}
                  <div className="preview-footer">
                    <span>
                      <span className="local-indicator" /> {revision.author} ·{" "}
                      {new Date(revision.createdAt).toLocaleDateString(
                        undefined,
                        { month: "short", day: "numeric" },
                      )}
                    </span>
                    <span>{revision.summary}</span>
                  </div>
                </section>
                {panel && (
                  <aside className="detail-panel">
                    <header>
                      <h2>
                        {panel === "comments"
                          ? "Conversation"
                          : "Version history"}
                      </h2>
                      <button
                        className="icon-button"
                        title="Close panel"
                        onClick={() => setPanel(null)}
                      >
                        <PanelRightClose size={16} />
                      </button>
                    </header>
                    {panel === "comments" ? (
                      <>
                        <p className="panel-description">
                          A little feedback goes a long way.
                        </p>
                        <div className="comments-list">
                          {!comments.length && (
                            <div className="empty-comments">
                              <MessageSquare size={27} strokeWidth={1} />
                              <h3>Make it a conversation.</h3>
                              <p>
                                Select a detail in the preview, or leave a
                                thought below.
                              </p>
                              <button onClick={() => setSelecting(true)}>
                                <MousePointer2 size={14} /> Select something
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
                        </div>
                      </>
                    ) : (
                      <>
                        <p className="panel-description">
                          One artifact. Every step along the way.
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
                              <div className="history-actions">
                                <button
                                  onClick={() =>
                                    run(async () => {
                                      setCompare(
                                        await api(
                                          `/artifacts/${artifact.id}/revisions/${r.number}`,
                                        ),
                                      );
                                      setView("source");
                                    })
                                  }
                                >
                                  Compare
                                </button>
                                {r.number !== artifact.head && (
                                  <button
                                    onClick={() =>
                                      run(async () => {
                                        await api(
                                          `/artifacts/${artifact.id}/restore`,
                                          post({
                                            revision: r.number,
                                            baseRevision: artifact.head,
                                          }),
                                        );
                                        navigate(artifact.id);
                                        await refresh();
                                        notify("Restored as a new revision");
                                      })
                                    }
                                  >
                                    <RotateCcw size={12} /> Restore
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </aside>
                )}
              </div>
            </>
          )
        )}
      </main>
      {notice && (
        <div className="toast" role="status">
          <Check size={15} />
          {notice}
        </div>
      )}
      {creating && (
        <div className="modal-backdrop" onClick={() => setCreating(false)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-title"
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <div className="eyebrow">A NEW BEGINNING</div>
              <button
                aria-label="Close dialog"
                onClick={() => setCreating(false)}
              >
                <X size={19} />
              </button>
            </header>
            <h2 id="create-title">What will you make?</h2>
            <p>Start with a working example. Make it your own.</p>
            <label className="field-label">
              ARTIFACT NAME
              <input
                autoFocus
                placeholder={templates[template].name}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <div className="template-options">
              {templates.map((t, i) => (
                <button
                  className={!imported && template === i ? "chosen" : ""}
                  key={t.name}
                  onClick={() => {
                    setTemplate(i);
                    setImported(null);
                  }}
                >
                  <span>
                    {i === 1 ? <FileText size={20} /> : <Layers size={20} />}
                  </span>
                  <div>
                    <strong>{t.name}</strong>
                    <small>{t.description}</small>
                  </div>
                  {!imported && template === i && <Check size={16} />}
                </button>
              ))}
            </div>
            <div className="import-row">
              <input
                ref={importInput}
                type="file"
                multiple
                accept=".tsx,.jsx,.html,.md,.svg,.json,.css,.js,.png,.jpg,.jpeg,.webp,.gif"
                hidden
                onChange={(e) => importFiles(e.target.files)}
              />
              <button onClick={() => importInput.current?.click()}>
                <Download size={14} />
                {imported
                  ? `Imported ${Object.keys(imported.files ?? {}).length} files`
                  : "Import your own files"}
              </button>
              <span>Source, images, or an artifact manifest</span>
            </div>
            <footer>
              <span>Saved locally. Yours to keep.</span>
              <button className="primary" disabled={busy} onClick={create}>
                {busy ? "Creating…" : "Create artifact"}
                <ArrowRight size={16} />
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}
function historyPush(url: string) {
  window.history.pushState({}, "", url);
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
