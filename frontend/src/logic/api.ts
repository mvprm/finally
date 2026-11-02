import { API_BASE } from "@/config";
import type {
  ChatMessage,
  ChatResponse,
  Portfolio,
  Snapshot,
  TradeResponse,
  WatchlistItem,
} from "./types";

/** An API error carrying the backend's human-readable `detail`. */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Pull a readable message out of FastAPI's 400 `{"detail": "..."}` or 422 `{"detail": [...]}`. */
export function errorDetail(body: unknown, status: number): string {
  if (body && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail) && detail.length) {
      const first = detail[0] as { msg?: unknown; loc?: unknown };
      const field = Array.isArray(first.loc) ? first.loc[first.loc.length - 1] : null;
      if (typeof first.msg === "string") return field ? `${String(field)}: ${first.msg}` : first.msg;
    }
  }
  return `Request failed (${status})`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
    });
  } catch {
    throw new ApiError("Can't reach the server. Check that FinAlly is running.", 0);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) throw new ApiError(errorDetail(body, res.status), res.status);
  return body as T;
}

export const api = {
  portfolio: () => request<Portfolio>("/api/portfolio"),
  history: () => request<Snapshot[]>("/api/portfolio/history"),
  trade: (ticker: string, quantity: number, side: "buy" | "sell") =>
    request<TradeResponse>("/api/portfolio/trade", {
      method: "POST",
      body: JSON.stringify({ ticker, quantity, side }),
    }),
  watchlist: () => request<WatchlistItem[]>("/api/watchlist"),
  addTicker: (ticker: string) =>
    request<WatchlistItem[]>("/api/watchlist", { method: "POST", body: JSON.stringify({ ticker }) }),
  removeTicker: (ticker: string) =>
    request<WatchlistItem[]>(`/api/watchlist/${encodeURIComponent(ticker)}`, { method: "DELETE" }),
  chat: (message: string) =>
    request<ChatResponse>("/api/chat", { method: "POST", body: JSON.stringify({ message }) }),
  chatHistory: () => request<ChatMessage[]>("/api/chat/history"),
};

export const streamUrl = () => `${API_BASE}/api/stream/prices`;
