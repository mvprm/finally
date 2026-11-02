# FinAlly frontend

Next.js (App Router, TypeScript, Tailwind v4) built as a static export (`out/`) that FastAPI serves on the same origin.

```bash
npm ci
npm run build        # static export -> out/
npm test             # Vitest unit tests (pure logic in src/logic)
npm run lint         # ESLint
npm run typecheck    # tsc --noEmit
```

Local development against a backend on :8000 (the backend allows CORS from localhost:3000):

```bash
NEXT_PUBLIC_API_BASE=http://localhost:8000 npm run dev
```

Layout:

- `src/config.ts`: tunable constants (`PRICE_BUFFER_POINTS`, poll and retry intervals, `API_BASE`)
- `src/logic/`: framework-free logic with unit tests: live portfolio valuation, session change, price flash, squarified treemap, SSE connection-state machine, price buffers, API client
- `src/hooks/`: `usePriceStream` (EventSource), `useAccount` (portfolio, watchlist, P&L history, chat), `useFlash`
- `src/components/`: header, watchlist with sparklines, main and P&L charts (Lightweight Charts), heatmap, positions table, trade ticket, chat panel
