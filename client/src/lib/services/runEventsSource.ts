/* runEventsSource.ts — framework-agnostic SSE subscription over one or more
   runs' event streams. No React: testable without React Testing Library.
   `hooks/reviews.ts#useRunEvents` wraps this with React state. */

import { API_BASE } from "../api";
import { notify } from "../toast";
import type { RunEvent } from "@devdigest/shared";

export interface RunEventsSourceCallbacks {
  onEvent: (event: RunEvent) => void;
  /** Called once every subscribed run's stream has closed. */
  onAllClosed: () => void;
}

/** Opens one EventSource per runId; returns an unsubscribe fn that closes them all. */
export function createRunEventsSource(
  runIds: string[],
  { onEvent, onAllClosed }: RunEventsSourceCallbacks,
): () => void {
  const sources: EventSource[] = [];
  let open = runIds.length;

  for (const runId of runIds) {
    const es = new EventSource(`${API_BASE}/runs/${runId}/events`);
    const onMsg = (ev: MessageEvent) => {
      try {
        const parsed = JSON.parse(ev.data) as RunEvent;
        onEvent(parsed);
        // Runtime agent failures arrive as SSE `error` events (not as a
        // mutation/query error), so the global error toast never sees them —
        // surface them here so the user gets a notification without a reload.
        if (parsed.kind === "error" && parsed.msg) notify.error(parsed.msg);
      } catch {
        /* ignore non-JSON keepalive frames (and dataless native error events) */
      }
    };
    // The server tags events with kind as the SSE `event:` name AND emits them
    // as default messages too in some clients — listen broadly.
    es.onmessage = onMsg;
    for (const kind of ["info", "tool", "result", "error"]) {
      es.addEventListener(kind, onMsg as EventListener);
    }
    es.onerror = () => {
      es.close();
      open -= 1;
      if (open <= 0) onAllClosed();
    };
    sources.push(es);
  }

  return () => {
    for (const es of sources) es.close();
  };
}
