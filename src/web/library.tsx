import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Search, ArrowUpRight, Pencil, Trash2 } from "lucide-react";
import type { Artifact } from "../shared/schema";
type Props = {
  artifacts: Artifact[];
  search: string;
  hasMoreArtifacts: boolean;
  onSearch: (value: string) => void;
  onOpen: (id: string) => void;
  onManage: (action: "rename" | "delete", artifact: Artifact) => void;
  onLoadMore: () => Promise<boolean>;
};
export const Library = React.memo(function Library({
  artifacts,
  search,
  hasMoreArtifacts,
  onSearch,
  onOpen,
  onManage,
  onLoadMore,
}: Props) {
  const filtered = artifacts.filter((a) =>
    (a.title + " " + a.description)
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  // Bound the DOM independently of how much metadata has been fetched.
  const pageSize = 50;
  const [requestedPage, setPage] = useState(0);
  const [loadingPage, setLoadingPage] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusPage = useRef(false);
  const activeSearch = useRef(search);
  activeSearch.current = search;
  const page = Math.min(
    requestedPage,
    Math.max(0, Math.ceil(filtered.length / pageSize) - 1),
  );
  useEffect(() => {
    setPage(0);
  }, [search]);
  useLayoutEffect(() => {
    if (!focusPage.current) return;
    focusPage.current = false;
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({ block: "start" });
  }, [page]);
  const changePage = async (next: number) => {
    if (loadingPage) return;
    if (next * pageSize >= filtered.length) {
      setLoadingPage(true);
      try {
        if (!(await onLoadMore())) return;
      } finally {
        setLoadingPage(false);
      }
    }
    if (activeSearch.current !== search) return;
    focusPage.current = true;
    setPage(next);
  };
  const visible = filtered.slice(page * pageSize, (page + 1) * pageSize);
  return (
    <main className="library">
      <header className="library-header">
        <div className="brand" aria-label="atelier">
          atelier
        </div>
        <span className="local-label">Local workspace</span>
      </header>
      {artifacts.length > 0 || search ? (
        <>
          <div className="library-toolbar">
            <h1 ref={heading} tabIndex={-1}>
              Artifacts{" "}
              <span>
                {artifacts.length}
                {hasMoreArtifacts ? "+" : ""}
              </span>
            </h1>
            <label className="search">
              <Search size={15} />
              <input
                aria-label="Search artifacts"
                placeholder="Search artifacts…"
                value={search}
                onChange={(e) => onSearch(e.target.value)}
              />
            </label>
          </div>
          <div className="artifact-list">
            {visible.map((a) => (
              <article
                className="artifact-card"
                key={a.id}
                data-artifact-id={a.id}
              >
                <button
                  className="artifact-card-open"
                  aria-label={`Open ${a.title}`}
                  onClick={() => onOpen(a.id)}
                >
                  <span className="artifact-thumbnail" data-kind={a.kind}>
                    {a.thumbnailVersion ? (
                      <img
                        src={`/api/artifacts/${a.id}/thumbnail?v=${encodeURIComponent(a.thumbnailVersion)}`}
                        alt={`Preview of ${a.title}`}
                        loading="lazy"
                      />
                    ) : (
                      <span className="thumbnail-placeholder">
                        <span className="folio-monogram">a</span>
                        <span className="folio-format">
                          {a.kind === "markdown"
                            ? "Markdown"
                            : a.kind === "svg"
                              ? "SVG"
                              : "Web page"}
                        </span>
                        <span className="preview-unavailable">
                          Preview unavailable
                        </span>
                      </span>
                    )}
                  </span>
                  <span className="artifact-card-caption">
                    <span className="artifact-card-title">{a.title}</span>
                    <ArrowUpRight className="artifact-open-arrow" size={17} />
                  </span>
                  <span className="artifact-card-description">
                    {a.description ||
                      (a.kind === "markdown"
                        ? "Markdown"
                        : a.kind === "svg"
                          ? "SVG"
                          : "Web page")}
                  </span>
                </button>
                <div className="artifact-card-footer">
                  <span>
                    <time dateTime={a.updatedAt}>
                      {new Intl.DateTimeFormat("en", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      }).format(new Date(a.updatedAt))}
                    </time>
                    <span className="card-version">Revision {a.head}</span>
                  </span>
                  <div>
                    <button
                      aria-label={`Rename ${a.title}`}
                      title="Rename"
                      onClick={() => onManage("rename", a)}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      aria-label={`Delete ${a.title}`}
                      title="Delete artifact"
                      className="danger-action"
                      onClick={() => onManage("delete", a)}
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
          {(filtered.length > pageSize || hasMoreArtifacts) && (
            <nav
              className="collection-pagination"
              aria-label="Collection pages"
              aria-busy={loadingPage}
            >
              <button
                disabled={page === 0 || loadingPage}
                onClick={() => void changePage(page - 1)}
              >
                Previous
              </button>
              <span aria-live="polite">
                {page * pageSize + 1}–{page * pageSize + visible.length} of{" "}
                {filtered.length}
                {hasMoreArtifacts ? "+" : ""}
              </span>
              <button
                disabled={
                  loadingPage ||
                  ((page + 1) * pageSize >= filtered.length &&
                    !hasMoreArtifacts)
                }
                onClick={() => void changePage(page + 1)}
              >
                {loadingPage ? "Loading…" : "Next"}
              </button>
            </nav>
          )}
        </>
      ) : (
        <section className="empty-library">
          <div className="empty-library-copy">
            <h2>No artifacts yet.</h2>
            <p>Ask your connected agent to create an artifact.</p>
          </div>
        </section>
      )}
    </main>
  );
});
