"use client";

import type { ConnectionState } from "@/logic/connection";
import { formatMoney, formatPercent, formatSignedMoney, signOf } from "@/logic/format";
import type { LivePortfolio } from "@/logic/portfolio";

const CONNECTION_COPY: Record<ConnectionState, { label: string; dot: string; text: string }> = {
  connected: { label: "Live", dot: "bg-up text-up", text: "text-dim" },
  reconnecting: { label: "Reconnecting", dot: "bg-brand text-brand", text: "text-brand" },
  disconnected: { label: "Offline", dot: "bg-down text-down", text: "text-down" },
};

const toneClass = { positive: "text-up", negative: "text-down", flat: "text-dim" } as const;

interface Props {
  live: LivePortfolio | null;
  connection: ConnectionState;
  loadError: string | null;
}

export function Header({ live, connection, loadError }: Props) {
  const invested = live ? live.totalValue - live.cash : 0;
  const investedShare = live && live.totalValue > 0 ? Math.min(Math.max(invested / live.totalValue, 0), 1) : 0;
  const pnlTone = toneClass[signOf(live?.totalUnrealizedPnl)];
  const pnlPct = live && invested - live.totalUnrealizedPnl > 0 ? (live.totalUnrealizedPnl / (invested - live.totalUnrealizedPnl)) * 100 : 0;
  const conn = CONNECTION_COPY[connection];

  return (
    <header className="relative border-b border-rule bg-panel">
      <div className="flex flex-wrap items-end gap-x-10 gap-y-3 px-5 pt-3 pb-4">
        <div className="flex items-center gap-2.5 self-center pr-2">
          <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
            <rect x="1" y="12" width="4" height="9" fill="#209dd7" />
            <rect x="7" y="7" width="4" height="14" fill="#209dd7" opacity="0.7" />
            <rect x="13" y="2" width="4" height="19" fill="#ecad0a" />
            <rect x="19" y="9" width="2" height="12" fill="#753991" />
          </svg>
          <span className="text-[17px] font-bold tracking-tight" style={{ fontStretch: "118%" }}>
            FinAlly
          </span>
        </div>

        <div className="min-w-0">
          <div className="text-[11px] text-dim">Portfolio value</div>
          <div
            data-testid="total-value"
            className="num text-[34px] leading-none font-extrabold tracking-tight text-text"
            style={{ fontStretch: "125%" }}
          >
            {live ? formatMoney(live.totalValue) : "—"}
          </div>
        </div>

        <Figure label="Cash" testId="cash-balance" value={live ? formatMoney(live.cash) : "—"} />
        <Figure label="Invested" value={live ? formatMoney(invested) : "—"} />
        <Figure
          label="Unrealized P&L"
          value={live ? `${formatSignedMoney(live.totalUnrealizedPnl)}  ${formatPercent(pnlPct)}` : "—"}
          className={pnlTone}
        />

        <div className="ml-auto flex items-center gap-4 self-center">
          {loadError && <span className="max-w-72 text-xs text-down">{loadError}</span>}
          <div className="flex items-center gap-2" title="Price stream status">
            <span
              data-testid="connection-status"
              data-state={connection}
              aria-label={`Price stream: ${conn.label}`}
              role="status"
              className={`live-dot inline-block h-2.5 w-2.5 rounded-full ${conn.dot}`}
            />
            <span className={`text-xs ${conn.text}`}>{conn.label}</span>
          </div>
        </div>
      </div>

      {/* Allocation strip: invested (yellow) vs cash (blue) as a share of total value. */}
      <div className="absolute inset-x-0 bottom-0 flex h-[3px]" aria-hidden="true">
        <div className="bg-brand transition-[width] duration-500" style={{ width: `${investedShare * 100}%` }} />
        <div className="flex-1 bg-info/45" />
      </div>
    </header>
  );
}

function Figure({ label, value, testId, className = "" }: { label: string; value: string; testId?: string; className?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-dim">{label}</div>
      <div data-testid={testId} className={`num text-[17px] leading-tight font-semibold whitespace-pre ${className}`}>
        {value}
      </div>
    </div>
  );
}
