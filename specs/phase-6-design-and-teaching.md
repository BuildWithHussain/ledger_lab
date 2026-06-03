# Phase 6 — Visual Redesign, Persistent Impact & Per-Line Teaching

**Goal:** raise the dashboard from "functional" to a polished teaching instrument. Three
threads, all in the existing Desk Page (no new architectural spine — phases 1–5 already
proved realtime, scope, and drill-down):

1. **Design refresh** — a distinctive, production-grade look (via the `frontend-design` skill),
   not the generic default-Frappe-card aesthetic.
2. **Persistent live impact** — when a transaction posts, the effect on each box must *linger*
   so a learner can actually read what moved and where, instead of catching a ~1s flash.
3. **Per-line teaching** — each transaction explains, in plain English, what it did to each
   account (e.g. "Debtors (an Asset) increased by ₹3,000"), available on demand.

Pure frontend/UX phase. **No new APIs** — reuses `get_balances`, `get_recent_vouchers`
(per-voucher `lines[]` with `root_type`), and the realtime payload. One optional backend
touch noted under "Possible backend" below.

---

## Thread 1 — Design refresh

Use the **`frontend-design`** skill to drive this; the constraints below are the brief.

### In scope
- A cohesive visual system for the page: type scale, spacing rhythm, the five (+Net Profit)
  boxes, the equation bar, the scope tabs, and the transaction feed.
- Keep it **inside the Desk Page** — scoped `<style>` block injected from `ledger_lab.js`,
  no global CSS, no build framework (consistent with phases 1–5).
- **Respect Frappe theming**: continue to read Frappe CSS variables (`--text-color`,
  `--border-color`, `--card-bg`, `--text-muted`, the `--text-sm`/radius tokens, etc.) so the
  page survives **light and dark** mode. The bespoke accent palette (`--ll-green`/`--ll-red`
  and their `-bg` tints, defined on `.ll-wrap`) may grow, but new fixed colors must have a
  dark-mode-safe story — prefer theme tokens or `color-mix()`/alpha over hardcoded hex.
- The **Balance Sheet** row and **Profit & Loss** row should read as two clearly distinct
  groups; the equation bar is the hero element at the top.

### Out of scope
- No change to the data model, the realtime contract, or the drill-down API.
- No new dependencies / icon libraries beyond what Frappe ships (`frappe.utils`, existing
  Frappe icons). Inline SVG is fine.

### Constraints / honor existing behavior
- `prefers-reduced-motion` must still suppress motion (see Thread 2).
- `font-variant-numeric: tabular-nums` on all money figures (no digit jitter during count-up).
- The boxes stay clickable (phase-5 drill-down) — preserve `role="button"`, `tabindex`,
  `:focus-visible` affordance, and the "View accounts →" hint.

---

## Thread 2 — Persistent live impact ("sticky last-impact" + longer flash)

**Decision (confirmed):** do **both** — a persistent per-box "last impact" badge **and** a
longer, more prominent flash. The transient flash draws the eye; the sticky badge lets the
learner study what happened at their own pace.

### Behavior
- **Sticky last-impact badge.** Each box carries a persistent annotation of the *most recent*
  event that moved it, e.g. `▲ +₹3,000` with a muted caption `from Sales Invoice SINV-001`
  (and a relative time, `just now` → `2m ago`, via `frappe.datetime` / `comment_when`).
  - It **stays visible until the next event touches that box**, then updates in place.
  - Direction-colored (green up / red down), same sign convention as today
    (`ll_line_delta`).
  - Cleared/reset on authoritative `reload()` (company or scope change, manual Refresh) —
    a fresh scope has no "last impact" yet.
  - The Net Profit derived box gets the same badge, computed from its Income−Expense delta.
- **Longer, more prominent flash.** Keep the green/red box flash but lengthen and strengthen
  it (current `ll-flash-up/down` ~0.9s → ~2s, slightly stronger inset ring), so the moment of
  change is unmistakable. The current transient floating delta chip (`ll-box-delta`, the
  `ll-delta-pop` animation) is **superseded by** the sticky badge — fold it in rather than
  having two competing delta indicators.
- **Count-up** of the number stays (~450ms, `easeOutCubic`) — unchanged.

### Reduced motion
- `prefers-reduced-motion: reduce`: **no flash, no count-up** (apply values instantly) — but
  the **sticky badge still renders** (it's information, not motion). It simply appears without
  animating in. This is a net win for reduced-motion users, who today get *nothing* lingering.

### Edge cases
- A box not touched by an event keeps its previous sticky badge (don't blank it).
- Rapid successive events: the badge always reflects the latest event for that box (last write
  wins); the flash restarts (existing `void el.offsetWidth` reflow trick).
- A receivable **Payment Entry** (Dr Bank / Cr Debtors, both Assets) still nets to zero on the
  **Asset** box, so that box neither flashes nor updates its badge — correct, and the
  account-level split remains a phase-5 drill-down concern (see progress.md deviation #9).

---

## Thread 3 — Per-line teaching (expandable detail)

**Decision (confirmed):** **expandable detail**. Feed rows stay compact by default; an
info/expand affordance reveals plain-English teaching per line. Keeps the feed dense while
making the lesson one click away.

### Behavior
- Each feed row keeps its current compact form (voucher link + `Dr/Cr` chip + account +
  amount), plus an **expand toggle** (an `ⓘ`/chevron affordance on the row).
- Expanding reveals, for **each line**, a plain-English clause built client-side from the
  data already in the payload (`account`, `root_type`, `debit`, `credit`):
  - Template: `{Account} ({Root Type}) {increased|decreased} by {amount}`.
  - Direction from `ll_line_delta(root_type, debit, credit)` sign (the same up/down already
    used to color the chip): debit-normal accounts (Asset, Expense) increase on debit;
    credit-normal (Liability, Equity, Income) increase on credit.
  - Example (Sales Invoice): `Debtors (Asset) increased by ₹3,000` /
    `Sales (Income) increased by ₹3,000`.
- Optionally a **one-line voucher summary** at the top of the expanded panel, composed from
  the voucher type (e.g. "A sale recorded revenue and a receivable"). Keep this a small,
  data-driven lookup keyed by `voucher_type` with a generic fallback — **do not** hardcode
  per-document narratives that could go stale; if a type isn't in the map, omit the summary
  and just show the per-line clauses.
- **Cancelled** vouchers: the expanded text should read as a reversal
  (`{Account} ({Root Type}) decreased by {amount}` / "this entry was cancelled, reversing…"),
  consistent with the muted **Cancelled** badge.

### Accessibility / interaction
- The toggle is keyboard-operable (`button`, `aria-expanded`), and the expanded region is
  associated via `aria-controls`. Expansion is independent per row.
- Expand/collapse height transition respects `prefers-reduced-motion`.
- The teaching text is i18n-wrapped (`__()`), with root-type and direction as interpolated
  tokens so translations stay grammatical.

### Possible backend (only if needed)
- All teaching text is derivable client-side from the existing payload, so **no API change is
  expected**. If we later want curated voucher-type narratives or per-account learner notes,
  add a small static map in `ledger_lab.api.dashboard` (or a JSON constant in the JS) — note
  it here rather than scattering strings. Default: pure client-side.

---

## Files

**Modified:**
- `ledger_lab/ledger_lab/page/ledger_lab/ledger_lab.js`
  - **Design:** restructure the scoped `<style>` + markup per the `frontend-design` output;
    keep theme-variable usage and dark-mode safety.
  - **Sticky impact:** replace the transient `ll-box-delta`/`ll-delta-pop` chip with a
    persistent per-box badge element; track `this.lastImpact[root] = {delta, voucher, ts}` in
    instance state; render it in `apply_event`, clear it in `paint_instant`/`reload`. Lengthen
    `ll-flash-up/down`.
  - **Teaching:** extend `render_feed_row` to add the expand toggle + an expandable panel that
    composes per-line plain-English clauses; add a small `voucher_type → summary` map and a
    `ll_line_phrase(line)` helper (reuse `ll_line_delta`).

**No backend changes expected.** (`dashboard.py` untouched unless the optional curated-narrative
map lands.)

---

## Acceptance test (agent-browser, `ledger.localhost`, Administrator/admin)

1. Open `/app/ledger-lab`. Assert the redesigned layout renders in **both light and dark**
   theme without unreadable/hardcoded colors; equation bar is the visual hero; BS and P&L
   rows are clearly distinct.
2. Submit a Sales Invoice elsewhere. Assert:
   - the Assets, Income, and Net Profit boxes **flash green** and count up;
   - each grows a **sticky badge** (`▲ +₹… · from Sales Invoice …`) that **remains visible**
     after the flash ends (wait > 3s, badge still there).
3. Submit a second, different voucher. Assert the touched boxes' badges **update in place** to
   the newest event; untouched boxes keep their prior badge.
4. In the feed, click a row's **expand** toggle. Assert a panel reveals per-line plain English,
   e.g. `Debtors (Asset) increased by ₹3,000` and `Sales (Income) increased by ₹3,000`, and
   that `aria-expanded` toggles. Collapse it again.
5. Cancel the invoice. Assert boxes flash red / count down, badges update to the reversal, and
   the expanded text for the cancelled row reads as a decrease/reversal.
6. Switch **scope** (FY ↔ All Time) or **company**: assert the sticky badges **reset** (no
   stale "last impact" carried across an authoritative reload).
7. Emulate `prefers-reduced-motion: reduce`: assert **no flash/count-up**, values apply
   instantly, **but** the sticky badge and expandable teaching still render and work.

**Done when:** the page looks deliberately designed (light+dark), every transaction leaves a
**persistent, readable** record of what it moved on each box, and any feed row can be expanded
to explain — in plain accounting English — what each line did to its account.

---

## Notes / ties to prior phases
- Honors the corrected mental model from progress.md: root-type boxes show **net** root-type
  movement; account-level direction (Bank↑/Debtors↓ on a Payment Entry) lives in the phase-5
  drill-down, **not** in a box flash. The per-line teaching panel (Thread 3) is the other place
  a learner sees account-level direction spelled out.
- The equation identity stays `Assets = Liabilities + Equity + Net Profit` (progress.md
  deviation #6); the redesign must not regress the ✓ Balanced / ⚠ Off-by indicator.
