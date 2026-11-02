"use client";

import { memo, useState, type FormEvent } from "react";
import { useFlash } from "@/hooks/useFlash";
import { formatPercent, formatPrice, signOf } from "@/logic/format";
import { sessionChangePercent } from "@/logic/portfolio";
import type { PricePoint } from "@/logic/priceBuffer";
import { isValidTicker, normalizeTicker } from "@/logic/ticker";
import type { WatchlistItem } from "@/logic/types";
import { Panel } from "./Panel";
import { Sparkline } from "./Sparkline";

const tone = { positive: "text-up", negative: "text-down", flat: "text-dim" } as const;

interface Props {
  items: WatchlistItem[] | null;
  prices: Record<string, number | undefined>;
  first: Record<string, number>;
  buffers: Record<string, PricePoint[]>;
  selected: string | null;
  onSelect: (ticker: string) => void;
  onAdd: (ticker: string) => Promise<void>;
  onRemove: (ticker: string) => Promise<void>;
}

export function Watchlist({ items, prices, first, buffers, selected, onSelect, onAdd, onRemove }: Props) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ticker = normalizeTicker(draft);
    if (!isValidTicker(ticker)) {
      setError("Use 1–10 letters or dots, like PYPL or BRK.B.");
      return;
    }
    setBusy(true);
    try {
      await onAdd(ticker);
      setDraft("");
      setError(null);
      onSelect(ticker);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add that symbol.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (ticker: string) => {
    try {
      await onRemove(ticker);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Couldn't remove ${ticker}.`);
    }
  };

  return (
    <Panel title="Watchlist" aside="change since page load" testId="watchlist" bodyClassName="flex flex-col">
      <form onSubmit={submit} className="flex shrink-0 gap-1.5 border-b border-rule p-2">
        <input
          data-testid="add-ticker-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value.toUpperCase())}
          placeholder="Add a symbol, e.g. PYPL"
          aria-label="Symbol to add to the watchlist"
          maxLength={12}
          className="h-7 min-w-0 flex-1 rounded-sm border border-rule bg-ink px-2 text-[12.5px] uppercase placeholder:normal-case placeholder:text-faint"
        />
        <button
          data-testid="add-ticker-button"
          type="submit"
          disabled={busy || !draft.trim()}
          className="h-7 rounded-sm bg-submit px-3 text-[12px] font-semibold text-white transition-colors hover:bg-submit-hover disabled:opacity-40"
        >
          Add
        </button>
      </form>
      {error && (
        <p role="alert" className="shrink-0 border-b border-rule px-3 py-1.5 text-[11.5px] text-down">
          {error}
        </p>
      )}

      <ul className="min-h-0 flex-1 overflow-y-auto">
        {items === null && <li className="px-3 py-4 text-[12px] text-faint">Loading watchlist…</li>}
        {items?.length === 0 && (
          <li className="px-3 py-4 text-[12px] text-dim">Your watchlist is empty. Add a symbol above to start streaming it.</li>
        )}
        {items?.map((item) => (
          <WatchRow
            key={item.ticker}
            ticker={item.ticker}
            price={prices[item.ticker] ?? item.price ?? null}
            firstPrice={first[item.ticker]}
            points={buffers[item.ticker]}
            selected={selected === item.ticker}
            onSelect={onSelect}
            onRemove={remove}
          />
        ))}
      </ul>
    </Panel>
  );
}

interface RowProps {
  ticker: string;
  price: number | null;
  firstPrice: number | undefined;
  points: PricePoint[] | undefined;
  selected: boolean;
  onSelect: (ticker: string) => void;
  onRemove: (ticker: string) => void;
}

const WatchRow = memo(function WatchRow({ ticker, price, firstPrice, points, selected, onSelect, onRemove }: RowProps) {
  const priceRef = useFlash<HTMLSpanElement>(price);
  const change = sessionChangePercent(firstPrice, price);

  return (
    <li
      data-testid={`watchlist-row-${ticker}`}
      className={`group relative grid cursor-pointer grid-cols-[1fr_auto_auto_18px] items-center gap-x-2.5 border-b border-rule/60 py-1.5 pr-1.5 pl-3 transition-colors hover:bg-raised ${
        selected ? "bg-raised" : ""
      }`}
      onClick={() => onSelect(ticker)}
    >
      {selected && <span className="absolute inset-y-0 left-0 w-[2px] bg-brand" aria-hidden="true" />}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onSelect(ticker);
        }}
        aria-pressed={selected}
        className="min-w-0 text-left"
      >
        <span className="block truncate text-[13px] font-bold" style={{ fontStretch: "108%" }}>
          {ticker}
        </span>
        <span className={`num block text-[11px] ${tone[signOf(change)]}`}>{formatPercent(change)}</span>
      </button>
      <Sparkline points={points} baseline={firstPrice} />
      <span
        ref={priceRef}
        data-testid={`price-${ticker}`}
        className="num min-w-[4.75rem] rounded-sm px-1 py-0.5 text-right text-[13px] font-semibold"
      >
        {formatPrice(price)}
      </span>
      <button
        type="button"
        data-testid={`remove-ticker-${ticker}`}
        aria-label={`Remove ${ticker} from watchlist`}
        title={`Remove ${ticker}`}
        onClick={(e) => {
          e.stopPropagation();
          onRemove(ticker);
        }}
        className="flex h-[18px] w-[18px] items-center justify-center rounded-sm text-faint opacity-40 transition-opacity group-hover:opacity-100 hover:bg-down/20 hover:text-down focus-visible:opacity-100"
      >
        <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
          <path d="M1 1l7 7M8 1L1 8" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
    </li>
  );
});
