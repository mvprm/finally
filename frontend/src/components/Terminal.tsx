"use client";

import { useMemo, useState } from "react";
import { useAccount } from "@/hooks/useAccount";
import { usePriceStream } from "@/hooks/usePriceStream";
import { computeLivePortfolio } from "@/logic/portfolio";
import { ChatPanel } from "./ChatPanel";
import { Header } from "./Header";
import { Heatmap } from "./Heatmap";
import { MainChart } from "./MainChart";
import { PnlChart } from "./PnlChart";
import { PositionsTable } from "./PositionsTable";
import { TradeTicket } from "./TradeTicket";
import { Watchlist } from "./Watchlist";

export function Terminal() {
  const market = usePriceStream();
  const account = useAccount();
  const [selected, setSelected] = useState<string | null>(null);
  const [chatCollapsed, setChatCollapsed] = useState(false);

  const livePrices = useMemo(() => {
    const out: Record<string, number | undefined> = {};
    for (const [ticker, update] of Object.entries(market.latest)) out[ticker] = update.price;
    return out;
  }, [market.latest]);

  // Live values are recomputed on every SSE event (PLAN.md §10).
  const live = useMemo(
    () => (account.portfolio ? computeLivePortfolio(account.portfolio, livePrices) : null),
    [account.portfolio, livePrices],
  );

  const holdings = useMemo(() => {
    const out: Record<string, number> = {};
    for (const p of account.portfolio?.positions ?? []) out[p.ticker] = p.quantity;
    return out;
  }, [account.portfolio]);

  const activeTicker = selected ?? account.watchlist?.[0]?.ticker ?? null;
  const activePosition = live?.positions.find((p) => p.ticker === activeTicker) ?? null;
  const watchPrice = account.watchlist?.find((w) => w.ticker === activeTicker)?.price ?? null;

  return (
    <div className="flex min-h-screen flex-col lg:h-screen lg:min-h-0">
      <Header live={live} connection={market.connection} loadError={account.loadError} />

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <main className="grid min-h-0 min-w-0 flex-1 gap-px bg-rule md:grid-cols-[290px_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]">
          <Watchlist
            items={account.watchlist}
            prices={livePrices}
            first={market.first}
            buffers={market.buffers}
            selected={activeTicker}
            onSelect={setSelected}
            onAdd={account.addTicker}
            onRemove={account.removeTicker}
          />

          <div className="grid min-h-0 min-w-0 gap-px lg:grid-rows-[minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,280px)]">
            <div className="h-[340px] min-h-0 lg:h-auto">
              <MainChart
                ticker={activeTicker}
                points={activeTicker ? market.buffers[activeTicker] : undefined}
                price={(activeTicker ? livePrices[activeTicker] : undefined) ?? watchPrice}
                firstPrice={activeTicker ? market.first[activeTicker] : undefined}
                avgCost={activePosition?.avgCost ?? null}
              />
            </div>
            <div className="grid min-h-0 gap-px md:grid-cols-2">
              <div className="h-[280px] min-h-0 lg:h-auto">
                <Heatmap positions={live?.positions ?? []} selected={activeTicker} onSelect={setSelected} />
              </div>
              <div className="h-[280px] min-h-0 lg:h-auto">
                <PnlChart history={account.history} />
              </div>
            </div>
            <div className="grid min-h-0 gap-px md:grid-cols-[minmax(0,1fr)_300px]">
              <div className="min-h-[200px] lg:min-h-0">
                <PositionsTable positions={live?.positions ?? []} selected={activeTicker} onSelect={setSelected} />
              </div>
              <TradeTicket
                selected={activeTicker}
                prices={livePrices}
                cash={live?.cash ?? null}
                holdings={holdings}
                onTrade={account.trade}
              />
            </div>
          </div>
        </main>

        <div className="flex h-[560px] min-h-0 lg:h-auto">
          <ChatPanel
            messages={account.messages}
            pending={account.chatPending}
            collapsed={chatCollapsed}
            onToggle={() => setChatCollapsed((c) => !c)}
            onSend={account.sendChat}
          />
        </div>
      </div>
    </div>
  );
}
