import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
  type RefObject,
} from "react";
import { api, ApiError } from "./api";
import {
  workspaceChangeSchema,
  type WorkspaceChange,
} from "../shared/bridge-messages";
import type {
  Artifact,
  Revision,
  RevisionMetadata,
  Comment,
  FeedbackStatus,
} from "../shared/schema";
type Setter<T> = Dispatch<SetStateAction<T>>;
type Options = {
  locationState: { id: string; revision: number | null };
  search: string;
  setArtifacts: Setter<Artifact[]>;
  setHasMoreArtifacts: Setter<boolean>;
  setArtifact: Setter<Artifact | null>;
  setRevision: Setter<Revision | null>;
  setHistory: Setter<RevisionMetadata[]>;
  setComments: Setter<Comment[]>;
  setFeedback: Setter<FeedbackStatus | null>;
  streamConnected: RefObject<boolean>;
  onMissing: () => void;
  onError: (message: string) => void;
};
export function useResources(options: Options) {
  const current = useRef(options);
  current.current = options;
  const loading = useRef(0);
  const refreshController = useRef<AbortController | null>(null);
  const loadedRevision = useRef<Revision | null>(null);
  const loadedHistory = useRef<{
    id: string;
    head: number;
    rows: RevisionMetadata[];
  } | null>(null);
  const refresh = useCallback(
    async (kind: WorkspaceChange["type"] = "artifact") => {
      const {
        locationState,
        search,
        setArtifacts,
        setHasMoreArtifacts,
        setArtifact,
        setRevision,
        setHistory,
        setComments,
        setFeedback,
        onMissing,
      } = current.current;
      refreshController.current?.abort();
      const controller = new AbortController();
      refreshController.current = controller;
      const read = <T>(path: string) =>
        api<T>(path, { signal: controller.signal });
      try {
        const token = ++loading.current;
        if (locationState.id && (kind === "comments" || kind === "feedback")) {
          const [status, comments] = await Promise.all([
            read<FeedbackStatus>(`/artifacts/${locationState.id}/feedback`),
            kind === "comments"
              ? read<Comment[]>(`/artifacts/${locationState.id}/comments`)
              : Promise.resolve(null),
          ]);
          if (token !== loading.current) return;
          setFeedback(status);
          if (comments)
            setComments((old) =>
              JSON.stringify(old) === JSON.stringify(comments) ? old : comments,
            );
          return;
        }
        if (!locationState.id) {
          const list = await read<Artifact[]>(
            `/artifacts?search=${encodeURIComponent(search)}`,
          );
          if (token !== loading.current) return;
          setHasMoreArtifacts(list.length === 200);
          setArtifacts(list);
          setArtifact(null);
          setRevision(null);
          return;
        }
        const a = await read<Artifact>(`/artifacts/${locationState.id}`);
        const number = locationState.revision ?? a.head;
        const [r, h, c] = await Promise.all([
          loadedRevision.current?.artifactId === a.id &&
          loadedRevision.current.number === number
            ? loadedRevision.current
            : read<Revision>(`/artifacts/${a.id}/revisions/${number}`),
          loadedHistory.current?.id === a.id &&
          loadedHistory.current.head === a.head
            ? loadedHistory.current.rows
            : read<RevisionMetadata[]>(`/artifacts/${a.id}/revisions`),
          read<Comment[]>(`/artifacts/${a.id}/comments`),
        ]);
        if (token !== loading.current) return;
        loadedRevision.current = r;
        loadedHistory.current = { id: a.id, head: a.head, rows: h };
        setArtifact(a);
        setRevision(r);
        setHistory(h);
        setComments((old) =>
          JSON.stringify(old) === JSON.stringify(c) ? old : c,
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 404) {
          onMissing();
          return;
        }
        throw error;
      }
    },
    [],
  );
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let kind: WorkspaceChange["type"] | undefined;
    const schedule = (next: WorkspaceChange["type"] = "artifact") => {
      kind =
        kind === "artifact" || next === "artifact"
          ? "artifact"
          : kind === "comments" || next === "comments"
            ? "comments"
            : next;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const requested = kind;
        kind = undefined;
        void refresh(requested).catch((error) =>
          current.current.onError(String(error.message ?? error)),
        );
      }, 50);
    };
    schedule();
    const events = new EventSource("/api/events");
    events.onmessage = (event) => {
      let value: unknown;
      try {
        value = JSON.parse(event.data);
      } catch {
        return;
      }
      const parsed = workspaceChangeSchema.safeParse(value);
      if (!parsed.success) return;
      const change = parsed.data;
      const id = current.current.locationState.id;
      if (
        id
          ? change.id === id && change.type !== "thumbnail"
          : ["artifact", "thumbnail"].includes(change.type)
      )
        schedule(change.type);
    };
    events.onerror = () => {
      options.streamConnected.current = false;
    };
    events.onopen = () => {
      options.streamConnected.current = true;
      schedule();
    };
    return () => {
      clearTimeout(timer);
      events.close();
      options.streamConnected.current = false;
      refreshController.current?.abort();
      loading.current++;
    };
  }, [options.locationState.id, options.locationState.revision, refresh]);
  const previousSearch = useRef(options.search);
  useEffect(() => {
    if (previousSearch.current === options.search) return;
    previousSearch.current = options.search;
    refreshController.current?.abort();
    const timer = setTimeout(() => {
      void refresh().catch((error) =>
        current.current.onError(String(error.message ?? error)),
      );
    }, 150);
    return () => clearTimeout(timer);
  }, [options.search, refresh]);
  return refresh;
}
