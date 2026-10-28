import { useEffect, useRef, useState } from "react";
import type { Artifact } from "../shared/schema";
import { api, post } from "./api";
export function useThumbnails(
  artifacts: Artifact[],
  artifactId: string,
  search: string,
) {
  const thumbnailAttempts = useRef(
    new Map<string, { attempts: number; retryAt: number; done: boolean }>(),
  );
  const thumbnailPending = useRef(new Set<string>());
  const thumbnailQueue = useRef(Promise.resolve());
  const [thumbnailRetry, setThumbnailRetry] = useState(0);
  useEffect(() => {
    if (artifactId) return;
    let cancelled = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const retry = (delay: number) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!cancelled) setThumbnailRetry((value) => value + 1);
      }, delay);
      timers.add(timer);
    };
    const items = new Map(artifacts.map((item) => [item.id, item]));
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting || document.visibilityState !== "visible")
            continue;
          const item = items.get(
            (entry.target as HTMLElement).dataset.artifactId!,
          );
          if (!item || item.thumbnailVersion) continue;
          const key = `${item.id}:${item.head}`;
          const state = thumbnailAttempts.current.get(key) ?? {
            attempts: 0,
            retryAt: 0,
            done: false,
          };
          if (
            state.done ||
            state.attempts >= 5 ||
            thumbnailPending.current.has(key)
          )
            continue;
          if (state.retryAt > Date.now()) {
            retry(state.retryAt - Date.now());
            continue;
          }
          observer.unobserve(entry.target);
          thumbnailPending.current.add(key);
          thumbnailQueue.current = thumbnailQueue.current.then(async () => {
            try {
              if (cancelled || document.visibilityState !== "visible") return;
              state.attempts++;
              thumbnailAttempts.current.set(key, state);
              const result = await api<{ thumbnailAvailable?: boolean }>(
                `/artifacts/${item.id}/check`,
                post({ revision: item.head }),
              );
              state.done = result.thumbnailAvailable === true;
            } catch {
              /* Retry transient checker and transport failures. */
            } finally {
              thumbnailPending.current.delete(key);
              state.retryAt =
                Date.now() +
                Math.min(30000, 1000 * 2 ** Math.max(0, state.attempts - 1));
              setThumbnailRetry((value) => value + 1);
            }
          });
        }
      },
      { rootMargin: "200px" },
    );
    document
      .querySelectorAll(".artifact-card")
      .forEach((card) => observer.observe(card));
    const visible = () => {
      if (document.visibilityState === "visible")
        setThumbnailRetry((value) => value + 1);
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      cancelled = true;
      observer.disconnect();
      for (const timer of timers) clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [artifacts, artifactId, search, thumbnailRetry]);
}
