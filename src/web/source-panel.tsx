import { Copy } from "lucide-react";
import type { Revision } from "../shared/schema";
export function SourcePanel({
  revision,
  compare,
  sourceFile,
  onSelect,
  onCopy,
}: {
  revision: Revision;
  compare: Revision | null;
  sourceFile: string;
  onSelect: (file: string) => void;
  onCopy: () => void;
}) {
  return (
    <>
      <p className="panel-description">
        Written by {revision.author} · revision {revision.number}. Ask your
        agent for changes.
      </p>
      <div className="file-tabs">
        {Object.keys(revision.content.files).map((file) => (
          <button
            className={file === sourceFile ? "selected" : ""}
            key={file}
            onClick={() => onSelect(file)}
          >
            {file}
          </button>
        ))}
        <button title="Copy file" onClick={onCopy}>
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
        <pre className="source-code" aria-label="Read-only source">
          {revision.content.files[sourceFile]}
        </pre>
      )}
    </>
  );
}
