import { describe, expect, it } from "vitest";
import {
  connectionReducer,
  INITIAL_CONNECTION_STATE,
  needsManualRetry,
  READY_STATE,
  type ConnectionEvent,
  type ConnectionState,
} from "../connection";

const run = (events: ConnectionEvent[], start: ConnectionState = INITIAL_CONNECTION_STATE) =>
  events.reduce(connectionReducer, start);

describe("connection state machine", () => {
  it("starts yellow (connecting)", () => {
    expect(INITIAL_CONNECTION_STATE).toBe("reconnecting");
  });

  it("goes green when the stream opens", () => {
    expect(run([{ type: "open" }])).toBe("connected");
  });

  it("goes yellow when the connection drops and the browser is retrying", () => {
    expect(run([{ type: "open" }, { type: "error", readyState: READY_STATE.CONNECTING }])).toBe("reconnecting");
  });

  it("returns to green after a successful reconnect", () => {
    expect(
      run([
        { type: "open" },
        { type: "error", readyState: READY_STATE.CONNECTING },
        { type: "error", readyState: READY_STATE.CONNECTING },
        { type: "open" },
      ]),
    ).toBe("connected");
  });

  it("goes red when the browser gives up (CLOSED)", () => {
    expect(run([{ type: "open" }, { type: "error", readyState: READY_STATE.CLOSED }])).toBe("disconnected");
  });

  it("goes yellow on a manual retry after giving up, then green on open", () => {
    const afterRetry = run([
      { type: "open" },
      { type: "error", readyState: READY_STATE.CLOSED },
      { type: "retry" },
    ]);
    expect(afterRetry).toBe("reconnecting");
    expect(connectionReducer(afterRetry, { type: "open" })).toBe("connected");
  });

  it("ignores an error event while the stream is still open", () => {
    expect(run([{ type: "open" }, { type: "error", readyState: READY_STATE.OPEN }])).toBe("connected");
  });

  it("goes red when closed by the client", () => {
    expect(run([{ type: "open" }, { type: "close" }])).toBe("disconnected");
  });

  it("asks for a manual retry only when the browser won't retry", () => {
    expect(needsManualRetry({ type: "error", readyState: READY_STATE.CLOSED })).toBe(true);
    expect(needsManualRetry({ type: "error", readyState: READY_STATE.CONNECTING })).toBe(false);
    expect(needsManualRetry({ type: "open" })).toBe(false);
  });
});
