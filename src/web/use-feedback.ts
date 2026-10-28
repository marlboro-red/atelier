import {
  useEffect,
  type RefObject,
  type Dispatch,
  type SetStateAction,
} from "react";
import { api } from "./api";
import type { Comment, FeedbackStatus } from "../shared/schema";
export function useFeedback(
  id: string,
  streamConnected: RefObject<boolean>,
  setFeedback: Dispatch<SetStateAction<FeedbackStatus | null>>,
  setComments: Dispatch<SetStateAction<Comment[]>>,
) {
  useEffect(() => {
    if (!id) {
      setFeedback(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    let updating = false;
    let lastRead = 0;
    const update = async () => {
      if (updating || document.visibilityState !== "visible") return;
      if (streamConnected.current && Date.now() - lastRead < 15000) return;
      updating = true;
      lastRead = Date.now();
      try {
        const [status, threads] = await Promise.all([
          api<FeedbackStatus>(`/artifacts/${id}/feedback`, {
            signal: controller.signal,
          }),
          streamConnected.current
            ? Promise.resolve(null)
            : api<Comment[]>(`/artifacts/${id}/comments`, {
                signal: controller.signal,
              }),
        ]);
        if (!cancelled) {
          setFeedback(status);
          if (threads)
            setComments((old) =>
              JSON.stringify(old) === JSON.stringify(threads) ? old : threads,
            );
        }
      } catch {
        // Preserve the last known thread state during a transient outage.
      } finally {
        updating = false;
      }
    };
    const visible = () => {
      if (document.visibilityState === "visible") void update();
    };
    document.addEventListener("visibilitychange", visible);
    void update();
    const timer = setInterval(update, 3000);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [id]);
}
