import { formatMoney, formatQty } from "./format";
import type { ChatActions } from "./types";

export interface ActionLine {
  kind: "trade" | "watchlist" | "error";
  tone: "buy" | "sell" | "neutral" | "error";
  text: string;
}

/** Turn a chat response's action outcomes into the inline confirmation lines. */
export function describeActions(actions: ChatActions | null | undefined): ActionLine[] {
  if (!actions) return [];
  const lines: ActionLine[] = [];
  for (const t of actions.trades ?? []) {
    lines.push({
      kind: "trade",
      tone: t.side,
      text: `${t.side === "buy" ? "Bought" : "Sold"} ${formatQty(t.quantity)} ${t.ticker} at ${formatMoney(t.price)}`,
    });
  }
  for (const c of actions.watchlist_changes ?? []) {
    lines.push({
      kind: "watchlist",
      tone: "neutral",
      text: c.action === "add" ? `Added ${c.ticker} to the watchlist` : `Removed ${c.ticker} from the watchlist`,
    });
  }
  for (const e of actions.errors ?? []) {
    lines.push({ kind: "error", tone: "error", text: e });
  }
  return lines;
}
