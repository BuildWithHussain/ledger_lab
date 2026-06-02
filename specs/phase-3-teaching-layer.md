# Phase 3 — Teaching Layer & Polish

**Goal:** deliver the beginner "aha" — the accounting equation made visual, plus the
color/motion that connects a transaction to the boxes it moves.

Pure frontend/UX phase. No new APIs; reuses the per-voucher payload from phase 2.

## In scope
- **Grouped layout:**
  - Balance Sheet row: `Assets` | `Liabilities` | `Equity`
  - P&L row: `Income` | `Expense` → `Net Profit`
- **Live equation bar** at top: `Assets {a} = Liabilities {l} + Equity {e}` with a ✓/⚠ balance indicator, and `Income {i} − Expense {x} = Net Profit {p}`.
- **Flash on change:** when an event's `lines` touch a box's `root_type`, that box briefly
  flashes **green if its natural balance went up, red if down** (compare new vs previous value held in JS state). Use the per-line payload to compute the delta locally instead of only refetching.
- **Count-up animation:** numbers tween from old → new value (~400ms).
- **Dr/Cr tags:** feed rows and box deltas show a small `Dr`/`Cr` chip; color coding = green (increase) / red (decrease) with the chip teaching the literal term.
- Scoped `<style>` block injected from the page JS (no global CSS, no build step).
- Respect `prefers-reduced-motion`: skip flash/count-up, apply values instantly.

## Out of scope
Company dropdown, scope tabs, drill-down.

## Files

**Modified:**
- `ledger_lab/ledger_lab/page/ledger_lab/ledger_lab.js` — restructure render into grouped rows + equation bar; maintain a JS `state.boxes` so deltas/flash direction are computed client-side from the realtime payload (stop blindly refetching on every event — refetch only on company/scope change, added in phase 4). Add count-up tween + flash classes + Dr/Cr chips. Inject scoped CSS.

## Acceptance test (agent-browser, `ledger.localhost`, Administrator/admin)
1. Open `/app/ledger-lab`; assert two grouped rows and an equation bar; verify
   `Assets == Liabilities + Equity` shows the ✓ indicator and `Income − Expense` equals the shown Net Profit.
2. Submit a Sales Invoice; assert Assets and Income boxes **flash green** and their numbers
   **count up** (capture before/after screenshots to confirm motion), and the equation bar stays balanced.
3. Submit a Payment Entry that reduces Debtors; assert one box flashes green (Bank) and one
   flashes red (Debtors).
4. Toggle OS reduced-motion (or emulate) and confirm values update instantly without animation.

**Done when:** the equation visibly balances and transactions cause the correct boxes to flash the correct color while counting to their new value.
