// Shapes from PLAN.md §6 (SSE) and §8 (REST).

export type Direction = "up" | "down" | "flat";

export interface PriceUpdate {
  ticker: string;
  price: number;
  previous_price: number;
  timestamp: number; // Unix seconds
  change: number;
  change_percent: number;
  direction: Direction;
}

export type PriceEvent = Record<string, PriceUpdate>;

export interface Position {
  ticker: string;
  quantity: number;
  avg_cost: number;
  current_price: number | null;
  market_value: number;
  unrealized_pnl: number;
  unrealized_pnl_percent: number;
}

export interface Portfolio {
  cash_balance: number;
  total_value: number;
  total_unrealized_pnl: number;
  positions: Position[];
}

export interface Trade {
  id: string;
  ticker: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  executed_at: string;
}

export interface TradeResponse {
  trade: Trade;
  portfolio: Portfolio;
}

export interface Snapshot {
  total_value: number;
  recorded_at: string;
}

export interface WatchlistItem {
  ticker: string;
  price: number | null;
  previous_price: number | null;
  direction: Direction | null;
}

export interface ChatTradeOutcome {
  ticker: string;
  side: "buy" | "sell";
  quantity: number;
  price: number;
}

export interface ChatWatchlistOutcome {
  ticker: string;
  action: "add" | "remove";
}

export interface ChatActions {
  trades: ChatTradeOutcome[];
  watchlist_changes: ChatWatchlistOutcome[];
  errors: string[];
}

export interface ChatResponse {
  message: string;
  actions: ChatActions;
  portfolio: Portfolio | null;
  watchlist: WatchlistItem[] | null;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  actions: ChatActions | null;
  created_at: string;
}
