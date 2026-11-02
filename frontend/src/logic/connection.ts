// Connection-status state machine for the SSE price stream (PLAN.md §6, §10).
// The indicator follows EventSource state, not event arrival:
//   open                          -> connected     (green)
//   error while CONNECTING        -> reconnecting  (yellow; the browser retries by itself)
//   error while CLOSED            -> disconnected  (red; the browser has given up)
//   manual retry after CLOSED     -> reconnecting  (yellow)
// Before the first open the stream is "reconnecting" (connecting), shown yellow.

export type ConnectionState = "connected" | "reconnecting" | "disconnected";

/** Mirrors EventSource.readyState values. */
export const READY_STATE = { CONNECTING: 0, OPEN: 1, CLOSED: 2 } as const;

export type ConnectionEvent =
  | { type: "open" }
  | { type: "error"; readyState: number }
  | { type: "retry" }
  | { type: "close" };

export const INITIAL_CONNECTION_STATE: ConnectionState = "reconnecting";

export function connectionReducer(state: ConnectionState, event: ConnectionEvent): ConnectionState {
  switch (event.type) {
    case "open":
      return "connected";
    case "error":
      if (event.readyState === READY_STATE.CLOSED) return "disconnected";
      if (event.readyState === READY_STATE.OPEN) return state;
      return "reconnecting";
    case "retry":
      return state === "connected" ? state : "reconnecting";
    case "close":
      return "disconnected";
  }
}

/** Whether the client must re-open the stream itself (the browser won't). */
export function needsManualRetry(event: ConnectionEvent): boolean {
  return event.type === "error" && event.readyState === READY_STATE.CLOSED;
}
