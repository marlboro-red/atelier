import { Ornament } from "./ornament";
import React from "react";
import { Search, ArrowUpRight, Pencil, Trash2 } from "lucide-react";
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
        <span className="library-imprint">A personal workshop</span>
        <div className="brand" aria-label="atelier">
          atelier<span className="brand-period">.</span>
        </div>
        <span className="local-label">
          <span className="local-dot" />
          Saved on this computer
        </span>
      </header>
      <div className="library-heading">
        <div>
          <span className="collection-kicker">
            Pages, studies & experiments
          </span>
          <h1>
            Collected work<span>.</span>
          </h1>
          <p>
            A place to return to your ideas, and give them a little more care.
          </p>
        </div>
        <Ornament className="library-ornament" />
      </div>
      {artifacts.length > 0 || search ? (
        <>
          <div className="library-toolbar">
            <h2>
              The collection{" "}
              <span>
                {artifacts.length}
                {hasMoreArtifacts ? "+" : ""}{" "}
                {artifacts.length === 1 ? "piece" : "pieces"}
              </span>
            </h2>
            <label className="search">
              <Search size={15} />
              <input
                aria-label="Search artifacts"
                placeholder="Find something…"
                value={search}
                onChange={(e) => onSearch(e.target.value)}
              />
            </label>
          </div>
          <div className="artifact-list">
            {filtered.map((a, index) => (
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
                            ? "A written piece"
                            : a.kind === "svg"
                              ? "A visual study"
                              : "An interactive page"}
                        </span>
                        <span className="preview-unavailable">
                          Preview unavailable
                        </span>
                      </span>
                    )}
                  </span>
                  <span className="artifact-card-caption">
                    <span className="folio-number">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="artifact-card-title">{a.title}</span>
                    <ArrowUpRight className="artifact-open-arrow" size={17} />
                  </span>
                  <span className="artifact-card-description">
                    {a.description ||
                      (a.kind === "markdown"
                        ? "Notes & writing"
                        : a.kind === "svg"
                          ? "A visual study"
                          : "An interactive page")}
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
            {hasMoreArtifacts && (
              <button className="load-more" onClick={onLoadMore}>
                More from the collection <span aria-hidden="true">↓</span>
              </button>
            )}
            {!filtered.length && (
              <p className="no-results">No artifacts match your search.</p>
            )}
          </div>
        </>
      ) : (
        <section className="empty-library">
          <span className="empty-folio" aria-hidden="true">
            <span>a</span>
          </span>
          <div className="empty-library-copy">
            <span className="collection-kicker">An open beginning</span>
            <h2>Your first piece belongs here.</h2>
            <p>
              Ask your connected agent to make a page in atelier.
              <br />
              It will find a home in this collection.
            </p>
          </div>
        </section>
      )}
      <footer className="library-footer">
        <span>
          atelier <i>— a space for making</i>
        </span>
        <span>Made with attention. Kept close.</span>
      </footer>
    </main>
  );
});
