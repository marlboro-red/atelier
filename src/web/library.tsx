import React from "react";
import { Search, Code2, Pencil, Trash2 } from "lucide-react";
import type { Artifact } from "../shared/schema";
type Props = {
  artifacts: Artifact[];
  search: string;
  hasMoreArtifacts: boolean;
  onSearch: (value: string) => void;
  onOpen: (id: string) => void;
  onManage: (action: "rename" | "delete", artifact: Artifact) => void;
  onLoadMore: () => void;
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
  return (
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
      {artifacts.length > 0 || search ? (
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
                onChange={(e) => onSearch(e.target.value)}
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
                  onClick={() => onOpen(a.id)}
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
            {hasMoreArtifacts && (
              <button onClick={onLoadMore}>Load more artifacts</button>
            )}
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
  );
});
