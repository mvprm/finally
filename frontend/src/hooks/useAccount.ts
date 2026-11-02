"use client";

import { useCallback, useEffect, useState } from "react";
import { PNL_HISTORY_POLL_MS } from "@/config";
import { api, ApiError } from "@/logic/api";
import type { ChatMessage, Portfolio, Snapshot, TradeResponse, WatchlistItem } from "@/logic/types";

let localId = 0;
const nextLocalId = () => `local-${Date.now()}-${++localId}`;

/**
 * Server-owned state: portfolio, watchlist, P&L snapshots and chat.
 * Loaded once on mount; after every write the response replaces local state (no refetch).
 */
export function useAccount() {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [watchlist, setWatchlist] = useState<WatchlistItem[] | null>(null);
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatPending, setChatPending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([api.portfolio(), api.watchlist(), api.history(), api.chatHistory()]).then(
      ([p, w, h, c]) => {
        if (cancelled) return;
        if (p.status === "fulfilled") setPortfolio(p.value);
        if (w.status === "fulfilled") setWatchlist(w.value);
        if (h.status === "fulfilled") setHistory(h.value);
        if (c.status === "fulfilled") setMessages(c.value);
        const failed = [p, w].find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
        setLoadError(failed ? (failed.reason instanceof Error ? failed.reason.message : "Couldn't load your account.") : null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Pick up the backend's periodic snapshots for the P&L chart.
  useEffect(() => {
    const id = setInterval(() => {
      api.history().then(setHistory).catch(() => {});
    }, PNL_HISTORY_POLL_MS);
    return () => clearInterval(id);
  }, []);

  /** A trade's response carries the new portfolio; the backend also recorded a snapshot of it. */
  const applyPortfolio = useCallback((next: Portfolio) => {
    setPortfolio(next);
    setHistory((h) => [...h, { total_value: next.total_value, recorded_at: new Date().toISOString() }]);
  }, []);

  const trade = useCallback(
    async (ticker: string, quantity: number, side: "buy" | "sell"): Promise<TradeResponse> => {
      const res = await api.trade(ticker, quantity, side);
      applyPortfolio(res.portfolio);
      // A buy of an unwatched ticker adds it to the watchlist server-side; sells never change it.
      setWatchlist((wl) =>
        side === "buy" && wl && !wl.some((w) => w.ticker === res.trade.ticker)
          ? [...wl, { ticker: res.trade.ticker, price: res.trade.price, previous_price: null, direction: null }]
          : wl,
      );
      return res;
    },
    [applyPortfolio],
  );

  const addTicker = useCallback(async (ticker: string) => {
    setWatchlist(await api.addTicker(ticker));
  }, []);

  const removeTicker = useCallback(async (ticker: string) => {
    setWatchlist(await api.removeTicker(ticker));
  }, []);

  const sendChat = useCallback(
    async (text: string) => {
      const userMsg: ChatMessage = {
        id: nextLocalId(),
        role: "user",
        content: text,
        actions: null,
        created_at: new Date().toISOString(),
      };
      setMessages((m) => [...m, userMsg]);
      setChatPending(true);
      try {
        const res = await api.chat(text);
        setMessages((m) => [
          ...m,
          {
            id: nextLocalId(),
            role: "assistant",
            content: res.message,
            actions: res.actions,
            created_at: new Date().toISOString(),
          },
        ]);
        if (res.portfolio) applyPortfolio(res.portfolio);
        if (res.watchlist) setWatchlist(res.watchlist);
      } catch (err) {
        const reason = err instanceof ApiError ? err.message : "Something went wrong sending your message.";
        setMessages((m) => [
          ...m,
          {
            id: nextLocalId(),
            role: "assistant",
            content: `Message not sent. ${reason}`,
            actions: null,
            created_at: new Date().toISOString(),
          },
        ]);
      } finally {
        setChatPending(false);
      }
    },
    [applyPortfolio],
  );

  return {
    portfolio,
    watchlist,
    history,
    messages,
    chatPending,
    loadError,
    trade,
    addTicker,
    removeTicker,
    sendChat,
  };
}

export type Account = ReturnType<typeof useAccount>;
