"use client";

import { useEffect, useReducer } from "react";
import { PRICE_BUFFER_POINTS, SSE_MANUAL_RETRY_MS } from "@/config";
import { streamUrl } from "@/logic/api";
import {
  connectionReducer,
  INITIAL_CONNECTION_STATE,
  needsManualRetry,
  type ConnectionEvent,
  type ConnectionState,
} from "@/logic/connection";
import { applyEventToBuffers, type PriceBuffers } from "@/logic/priceBuffer";
import type { PriceEvent } from "@/logic/types";

export interface MarketState {
  /** Latest update per tracked ticker (watchlist ∪ held). */
  latest: PriceEvent;
  /** First price seen per ticker since page load: the session-change baseline. */
  first: Record<string, number>;
  /** Rolling price history per ticker for sparklines and the main chart. */
  buffers: PriceBuffers;
  connection: ConnectionState;
}

type Action = { type: "prices"; event: PriceEvent } | { type: "connection"; event: ConnectionEvent };

const initialState: MarketState = {
  latest: {},
  first: {},
  buffers: {},
  connection: INITIAL_CONNECTION_STATE,
};

function reducer(state: MarketState, action: Action): MarketState {
  if (action.type === "connection") {
    const connection = connectionReducer(state.connection, action.event);
    return connection === state.connection ? state : { ...state, connection };
  }
  const { event } = action;
  let first = state.first;
  for (const [ticker, update] of Object.entries(event)) {
    if (first[ticker] === undefined) {
      if (first === state.first) first = { ...state.first };
      first[ticker] = update.price;
    }
  }
  return {
    ...state,
    latest: event,
    first,
    buffers: applyEventToBuffers(state.buffers, event, PRICE_BUFFER_POINTS),
  };
}

/** Subscribe to the SSE price stream with native EventSource. */
export function usePriceStream(): MarketState {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      source = new EventSource(streamUrl());
      source.onopen = () => dispatch({ type: "connection", event: { type: "open" } });
      source.onerror = () => {
        if (!source) return;
        const event: ConnectionEvent = { type: "error", readyState: source.readyState };
        dispatch({ type: "connection", event });
        if (needsManualRetry(event)) {
          // The browser gave up (e.g. a non-200 response). Re-open it ourselves.
          source.close();
          retryTimer = setTimeout(() => {
            dispatch({ type: "connection", event: { type: "retry" } });
            connect();
          }, SSE_MANUAL_RETRY_MS);
        }
      };
      source.onmessage = (msg: MessageEvent<string>) => {
        try {
          const event = JSON.parse(msg.data) as PriceEvent;
          if (event && typeof event === "object") dispatch({ type: "prices", event });
        } catch {
          // Ignore malformed frames; the next tick replaces them.
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
    };
  }, []);

  return state;
}
