# Phase 3 — Teaching Layer & Polish

**Goal:** deliver the beginner "aha" — the accounting equation made visual, plus the
color/motion that connects a transaction to the boxes it moves.

Pure frontend/UX phase. No new APIs; reuses the per-voucher payload from phase 2.

## In scope
- **Grouped layout:**
  - Balance Sheet row: `Assets` | `Liabilities` | `Equity`
  - P&L row: `Income` | `Expense` → `Net Profit`
- **Live equation bar** at top: `Assets {a} = Liabilities {l} + Equity {e} + Net Profit {p}`
  with a ✓ Balanced / ⚠ Off-by indicator, plus a sub-line `Net Profit = Income {i} − Expense {x}`.
  > **As built:** the identity includes **Net Profit** because in a live/open period current
  > profit isn't yet closed into Equity, so `Assets = Liabilities + Equity` alone won't balance.
  > The full form is the trial-balance closure and always balances. `Net Profit` is rendered as
  > a derived 6th box (Income − Expense) in the P&L row.
- **Flash on change:** when an event's `lines` touch a box's `root_type`, that box briefly
  flashes **green if its natural balance went up, red if down** (compare new vs previous value held in JS state). Use the per-line payload to compute the delta locally instead of only refetching.
  > **As built (client-delta engine):** after the initial `get_balances` load, boxes update by
  > applying each realtime payload's per-line deltas locally — no per-event refetch. Verified to
  > stay exactly in sync with server truth across many submit/cancel events (incl. from other
  > sessions); manual **Refresh** re-syncs authoritatively.
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
1. Open `/app/ledger-lab`; assert two grouped sections + an equation bar; verify
   `Assets == Liabilities + Equity + Net Profit` shows the ✓ Balanced indicator and the sub-line
   `Net Profit = Income − Expense` matches the Net Profit box.
2. Submit a Sales Invoice; assert Assets, Income **and Net Profit** boxes **flash green** and
   their numbers **count up** (a `+₹…` delta chip pops), and the equation bar stays balanced.
3. Cancel that invoice; assert the same boxes **flash red** and count down (`−₹…` chips), and
   the equation stays balanced. (A receivable **Payment Entry** is *not* a good flash test here:
   Dr Bank / Cr Debtors are both **Asset** accounts, so the Asset box nets to zero and won't
   flash — that green/red split is account-level, seen in the phase-5 drill-down.)
4. Toggle OS reduced-motion (or emulate `prefers-reduced-motion`) and confirm values update
   instantly with no flash/chip animation.

**Done when:** the equation visibly balances and transactions cause the correct boxes to flash the correct color while counting to their new value.
