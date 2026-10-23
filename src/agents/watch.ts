import { setTimeout as delay } from "node:timers/promises";
import { createInterface } from "node:readline/promises";
import type { Adapter, Approval } from "./adapters.js";
import type { FeedbackEvent, Provider } from "../server/feedback.js";

export type Request = (
  path: string,
  method?: string,
  body?: unknown,
) => Promise<any>;
export function feedbackRequest(base: string): Request {
  return async (path, method = "GET", body) => {
    const response = await fetch(base + "/api" + path, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error ?? `atelier returned ${response.status}`);
    return result;
  };
}
export function feedbackPrompt(id: string, events: FeedbackEvent[]) {
  return `New user feedback for atelier artifact ${id}. Read this artifact and its comments through atelier MCP, then address these events: ${JSON.stringify(events)}. Check whether each request was already handled before changing anything. Reply in the threads and link addressed commentIds when publishing a revision. Do not process other artifacts.`;
}
export function terminalApproval(
  onState: (state: string) => void,
  signal?: AbortSignal,
): Approval {
  let queue = Promise.resolve(false);
  return (description) => {
    queue = queue.then(async () => {
      onState("needs_permission");
      if (!process.stdin.isTTY) {
        console.error(
          "Agent needs permission. Run atelier watch in an interactive terminal.",
        );
        onState("working");
        return false;
      }
      const rl = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        const safe = description.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
        return (
          (
            await rl.question(
              `\nAgent permission request:\n${safe}\nAllow this action once? [y/N] `,
              { signal },
            )
          )
            .trim()
            .toLowerCase() === "y"
        );
      } catch {
        return false;
      } finally {
        rl.close();
        onState("working");
      }
    });
    return queue;
  };
}
export async function watchFeedback(options: {
  id: string;
  provider: Provider;
  adapter: Adapter;
  request: Request;
  signal: AbortSignal;
  state: () => string;
  log: (text: string) => void;
  interval?: number;
  onConnected?: () => void;
  dispatch?: (prompt: string, beforeSend: () => Promise<void>) => Promise<void>;
}) {
  const { id, provider, adapter, request, signal, state, log } = options;
  const path = `/artifacts/${encodeURIComponent(id)}/feedback`;
  const control = new AbortController();
  const stop = () => {
    control.abort();
    adapter.close();
  };
  signal.addEventListener("abort", stop, { once: true });
  let token: string | undefined;
  let fatal: unknown;
  let busy = false;
  void adapter.closed?.then((error) => {
    if (!control.signal.aborted) {
      fatal = error;
      stop();
    }
  });
  let heartbeat: Promise<void> | undefined;
  try {
    if (signal.aborted) return;
    ({ token } = await request(path + "/connect", "POST", {
      provider,
      session: adapter.sessionId,
    }));
    options.onConnected?.();
    log(
      `Connected ${provider} session ${adapter.sessionId}. New feedback is delivered automatically. Ctrl+C disconnects.\n`,
    );
    heartbeat = (async () => {
      while (!control.signal.aborted) {
        try {
          await delay(5000, undefined, { signal: control.signal });
          await request(path + "/heartbeat", "POST", {
            token,
            state:
              state() === "needs_permission"
                ? "needs_permission"
                : busy
                  ? provider === "claude"
                    ? "awaiting_agent"
                    : "working"
                  : "connected",
          });
        } catch (error) {
          if (!control.signal.aborted) {
            fatal = error;
            stop();
          }
          break;
        }
      }
    })();
    while (!control.signal.aborted) {
      const events: FeedbackEvent[] = await request(path + "/claim", "POST", {
        token,
      });
      if (control.signal.aborted) break;
      if (!events.length) {
        await delay(options.interval ?? 1000, undefined, {
          signal: control.signal,
        });
        continue;
      }
      try {
        busy = true;
        const beforeSend = async () => {
          control.signal.throwIfAborted();
          await request(path + "/heartbeat", "POST", {
            token,
            state: provider === "claude" ? "awaiting_agent" : "working",
          });
        };
        const prompt = feedbackPrompt(id, events);
        if (options.dispatch) await options.dispatch(prompt, beforeSend);
        else {
          await beforeSend();
          await adapter.send(prompt);
        }
        await request(path + "/finish", "POST", {
          token,
          ids: events.map((e) => e.id),
        });
        await request(path + "/heartbeat", "POST", {
          token,
          state: "connected",
        });
        busy = false;
        log(
          "Feedback delivered. Check the comment thread for the agent's result.\n",
        );
      } catch (error) {
        await request(path + "/finish", "POST", {
          token,
          ids: events.map((e) => e.id),
          error: String(error).slice(0, 1000),
        }).catch(() => {});
        throw error;
      }
    }
  } catch (error) {
    if (!control.signal.aborted) throw error;
  } finally {
    stop();
    signal.removeEventListener("abort", stop);
    await heartbeat;
    if (token)
      await request(path + "/disconnect", "POST", { token }).catch(() => {});
  }
  if (fatal) throw fatal;
}
