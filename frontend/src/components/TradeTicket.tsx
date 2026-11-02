"use client";

import { useState, type FormEvent } from "react";
import { formatMoney, formatQty } from "@/logic/format";
import { isValidTicker, normalizeTicker, parseQuantity } from "@/logic/ticker";
import type { TradeResponse } from "@/logic/types";
import { Panel } from "./Panel";

interface Props {
  selected: string | null;
  prices: Record<string, number | undefined>;
  cash: number | null;
  holdings: Record<string, number>;
  onTrade: (ticker: string, quantity: number, side: "buy" | "sell") => Promise<TradeResponse>;
}

type Result = { kind: "ok" | "error"; text: string } | null;

export function TradeTicket({ selected, prices, cash, holdings, onTrade }: Props) {
  const [ticker, setTicker] = useState(selected ?? "");
  const [lastSelected, setLastSelected] = useState(selected);
  const [qty, setQty] = useState("");
  const [busy, setBusy] = useState<"buy" | "sell" | null>(null);
  const [result, setResult] = useState<Result>(null);

  // Follow the selected symbol (watchlist, table or map click) into the ticket.
  if (selected !== lastSelected) {
    setLastSelected(selected);
    if (selected) setTicker(selected);
  }

  const symbol = normalizeTicker(ticker);
  const price = prices[symbol];
  const quantity = parseQuantity(qty);
  const estimate = price != null && quantity != null ? price * quantity : null;
  const held = holdings[symbol] ?? 0;

  const submit = async (side: "buy" | "sell") => {
    if (!isValidTicker(symbol)) {
      setResult({ kind: "error", text: "Enter a symbol of 1–10 letters or dots, like AAPL." });
      return;
    }
    if (quantity == null) {
      setResult({ kind: "error", text: "Enter a quantity greater than zero." });
      return;
    }
    setBusy(side);
    try {
      const res = await onTrade(symbol, quantity, side);
      const t = res.trade;
      setResult({
        kind: "ok",
        text: `${t.side === "buy" ? "Bought" : "Sold"} ${formatQty(t.quantity)} ${t.ticker} at ${formatMoney(t.price)}`,
      });
    } catch (err) {
      setResult({ kind: "error", text: err instanceof Error ? err.message : "The trade didn't go through." });
    } finally {
      setBusy(null);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit("buy");
  };

  const field = "h-8 w-full rounded-sm border border-rule bg-ink px-2 text-[13px] placeholder:text-faint";

  return (
    <Panel title="Trade" aside="market order, fills at the last price" bodyClassName="flex flex-col gap-2.5 overflow-y-auto p-3">
      <form onSubmit={onSubmit} className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-[11px] text-dim">
          Symbol
          <input
            data-testid="trade-ticker"
            value={ticker}
            onChange={(e) => setTicker(e.target.value.toUpperCase())}
            placeholder="AAPL"
            maxLength={12}
            autoComplete="off"
            className={`${field} font-bold uppercase text-text`}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-dim">
          Quantity
          <input
            data-testid="trade-quantity"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder="10"
            inputMode="decimal"
            autoComplete="off"
            className={`${field} num text-text`}
          />
        </label>
        <div className="col-span-2 grid grid-cols-2 gap-2 pt-0.5">
          <button
            data-testid="buy-button"
            type="submit"
            disabled={busy !== null}
            className="h-9 rounded-sm bg-submit text-[13px] font-bold text-white transition-colors hover:bg-submit-hover disabled:opacity-50"
          >
            {busy === "buy" ? "Buying…" : "Buy"}
          </button>
          <button
            data-testid="sell-button"
            type="button"
            onClick={() => submit("sell")}
            disabled={busy !== null}
            className="h-9 rounded-sm border border-submit/70 bg-transparent text-[13px] font-bold text-text transition-colors hover:bg-submit/20 disabled:opacity-50"
          >
            {busy === "sell" ? "Selling…" : "Sell"}
          </button>
        </div>
      </form>

      <dl className="num grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
        <dt className="text-dim">Last price</dt>
        <dd className="text-right">{formatMoney(price)}</dd>
        <dt className="text-dim">Estimated total</dt>
        <dd className="text-right">{formatMoney(estimate)}</dd>
        <dt className="text-dim">Cash available</dt>
        <dd className="text-right">{formatMoney(cash)}</dd>
        <dt className="text-dim">Shares held</dt>
        <dd className="text-right">{symbol ? formatQty(held) : "—"}</dd>
      </dl>

      {result?.kind === "error" && (
        <p data-testid="trade-error" role="alert" className="rounded-sm border border-down/40 bg-down/10 px-2 py-1.5 text-[12px] text-down">
          {result.text}
        </p>
      )}
      {result?.kind === "ok" && (
        <p role="status" className="rounded-sm border border-up/30 bg-up/10 px-2 py-1.5 text-[12px] text-up">
          {result.text}
        </p>
      )}
    </Panel>
  );
}
