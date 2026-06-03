# Ledger Lab — Build Progress

Status of the tracer-bullet phases (see [README.md](README.md) for the phase index).
Repo: <https://github.com/BuildWithHussain/ledger_lab> (default branch `develop`).

| Phase | Status | Verified |
|------|--------|----------|
| 1 — Tracer bullet: live boxes | ✅ Done | agent-browser on `ledger.localhost` |
| 2 — Per-voucher payload + journal feed | ✅ Done | agent-browser (incl. live cancel) |
| 3 — Teaching layer & polish | ✅ Done | agent-browser (flash up/down, count-up, reduced-motion, no client drift) |
| 4 — Controls: company & time scope | ✅ Done | agent-browser (scope toggle re-scopes 3k↔11k; in-FY event flashes, out-of-FY event gated out) |
| 5 — Account-level drill-down | ✅ Done | agent-browser (Assets/Income dialogs reconcile to box; FY↔All-Time re-scope; GL report links) |
| 6 — Visual redesign, persistent impact & per-line teaching | ✅ Done | agent-browser (light+dark redesign; sticky badges persist/update-in-place/reset; expand teaching; cancel→red reversal; reduced-motion) |

Commit `1921848` ("feat: Live ledger impact dashboard (phases 1-3)") covers phases 1–3.

## What's built (phases 1–3)

- **Desk Page** `/app/ledger-lab` — `ledger_lab/ledger_lab/page/ledger_lab/` (`.json` fixture + `.js` controller). Vanilla JS + scoped `<style>`, no build framework.
- **API** `ledger_lab/api/dashboard.py`:
  - `get_balances(company=None) -> dict` — root-type aggregation, natural-sign balances.
  - `get_recent_vouchers(company=None, limit=15) -> list[dict]` — newest-first vouchers with full Dr/Cr lines + `root_type` (seeds the feed).
- **Realtime** `ledger_lab/realtime/gl_entry.py` — `collect_gl_entry` (buffers GL lines in `frappe.flags`) + `flush_gl_entries` (one event per voucher on `after_commit`).
- **Hook** `ledger_lab/hooks.py` — `doc_events: GL Entry → after_insert → collect_gl_entry`.
- **UI** — grouped Balance Sheet / P&L sections, live equation bar, green/red flash + count-up, colored Dr/Cr feed chips, voucher links, live cancellation rows, `prefers-reduced-motion` support.

## Deviations from the original plan/spec (reconciled below into the specs)

These are the things we learned only by building against the real bench:

1. **Package/import paths.** App python package root is `ledger_lab/ledger_lab/`, so dotted
   paths are `ledger_lab.api.dashboard` and `ledger_lab.realtime.gl_entry` — **not**
   `ledger_lab.ledger_lab.realtime…` as `plan.md` wrote. The Page lives under the *module*
   folder: `ledger_lab/ledger_lab/ledger_lab/page/ledger_lab/`.

2. **Hook event = `after_insert`, not `on_update`.** `after_insert` fires exactly once per
   GL line at creation — clean for buffering. No `get_doc_before_save()` guard needed.

3. **Cancellations must NOT be skipped.** ERPNext's default (non-immutable) cancel inserts
   swapped reversal lines with `is_cancelled=1` and UPDATEs the originals (no `after_insert`).
   The plan said "skip `is_cancelled`" — doing so left the dashboard stale on cancel. We keep
   cancelled lines, flag the event `is_cancelled: true`, refetch-safe balances drop, and the
   feed shows a muted **Cancelled** reversal row. (Immutable-ledger mode inserts reversals with
   `is_cancelled=0` instead; our code handles both since it no longer filters them out.)

4. **Frappe 17 `get_all` rejects SQL functions in SELECT** ("SQL functions are not allowed as
   strings"). `get_recent_vouchers` uses raw `frappe.db.sql` for the `MAX(...)/GROUP BY` query.

5. **`frappe.db.after_commit` is a `CallbackManager`** (`.add(fn)`); it drains itself after
   running, so we re-register per transaction (guarded by the buffer being `None`).

6. **Equation is `Assets = Liabilities + Equity + Net Profit`** (not `Assets = Liabilities +
   Equity`). In a live/open period, current-period profit isn't yet closed into Equity, so the
   short form doesn't balance. The full form is the trial-balance closure and **always**
   balances. (If we ever want to mirror ERPNext's *Balance Sheet* exactly — profit rolled into
   Equity as "Provisional Profit / Loss" — that's a deliberate, separate change.)

7. **Net Profit is a derived 6th box** (Income − Expense), shown in the P&L row; not a GL
   `root_type`. The five root-type boxes remain the source of truth.

8. **Client-side delta engine (phase 3).** After the initial `get_balances` load, box values
   are updated by applying each realtime payload's line deltas locally (no per-event refetch).
   Verified to stay exactly in sync with server truth across many submit/cancel events,
   including events triggered from other browser sessions. Manual **Refresh** re-syncs
   authoritatively.

9. **Root-type boxes ≠ account-level direction.** A customer Payment Entry (Dr Bank, Cr
   Debtors) moves two **Asset** accounts in opposite directions, so the **Asset box nets to
   zero and does not flash** — total assets are unchanged, only their composition. The
   green-up/red-down split between Bank and Debtors is an **account-level** effect, visible in
   the phase-5 drill-down, not in the root-type boxes. (Earlier spec acceptance steps that
   expected a Payment Entry to flash one box green and one red were written against an
   account-level mental model and have been corrected.)

## Test fixtures created during verification

On `ledger.localhost`, company **BWH** (currency INR): Customer `Acme Learning Co`, non-stock
Item `TUTORIAL-SERVICE`, plus several Sales/Purchase Invoices (some cancelled) used to exercise
the live updates. Safe to delete; not part of the app.

## What's built (phase 4)

- **API** `ledger_lab/api/dashboard.py` — `get_balances` and `get_recent_vouchers` gain
  `scope: str = "fy"` ("fy" current fiscal year / "all" all time). New `_date_range(company,
  scope)` resolves the FY bounds via `erpnext.accounts.utils.get_fiscal_year(nowdate(),
  company=company, as_dict=True)`; the SQL gates `posting_date` between them. `get_balances`
  now also returns `scope` and `date_range: {start, end}` so the client can gate realtime.
- **UI** `…/page/ledger_lab/ledger_lab.js` —
  - **Company picker**: a Desk Link field (`page.add_field`, options `Company`) in the header,
    defaulting to `frappe.defaults.get_default("company")`. Changing it calls `reload()`.
  - **Scope tabs**: a small segmented control (`This Fiscal Year` / `All Time`); clicking
    re-scopes via `reload()` (authoritative refetch + feed reseed, no animation).
  - **Realtime scope gating**: `in_scope(posting_date)` ignores events whose `posting_date`
    falls outside the active `date_range` (null bounds = All Time admits everything). Company
    filtering (from phases 1–3) is unchanged.

## Deviations from the phase-4 spec (reconciled)

10. **No `frappe.realtime.off/on` re-bind on company/scope change.** The spec called for
    off-before-resubscribe to avoid duplicate handlers. Instead we keep a **single** persistent
    handler bound once in `bind_realtime`; it reads `this.company`/`this.scope`/`this.date_range`
    from live instance state on every event, so changing controls needs no re-subscribe. Simpler
    and equally correct — there is never more than one handler.

11. **FY gating is client-side off the echoed `date_range`**, not a client recomputation of the
    fiscal year. `get_balances` returns `date_range: {start, end}` (ISO `YYYY-MM-DD`); `in_scope`
    compares lexically. One source of truth (the server's `get_fiscal_year`).

12. **Cross-company filtering not re-exercised on this bench** — only company **BWH** exists, so
    the "switch company" / "submit for company A while viewing B → no flash" acceptance steps
    are N/A here. That logic is unchanged from phases 1–3 (already verified). Phase-4 verification
    focused on the genuinely-new **scope** dimension and **FY realtime gating** (below).

## Phase-4 verification (agent-browser, `ledger.localhost`)

Active BWH data at test time (older fixture invoices are all cancelled): three Journal Entries —
`1000` dated 2025-06-01, `3000` dated 2026-06-03 (in FY), `7000` dated 2025-06-15 (out of FY).

- Page defaults to company **BWH**, scope **This Fiscal Year**. FY boxes = 3,000; equation balances.
- **In-FY** submit (`2026-06-03`, +3,000) while in FY scope → boxes update live to 3,000, feed
  prepends the JE, equation stays balanced. (Phase-3 realtime survives filtering.)
- **Out-of-FY** submit (`2025-06-15`, +7,000) while in FY scope → **ignored**: boxes stay 3,000,
  feed top unchanged. (New `in_scope` gate.)
- Toggle **All Time** → re-aggregates to 11,000 (1,000 + 3,000 + 7,000), all 3 JEs in feed,
  equation balances. Toggle back to FY → re-scopes to 3,000.

## What's built (phase 5)

- **API** `ledger_lab/api/dashboard.py` — `get_account_breakdown(company, root_type, scope="fy")
  -> list[dict]`: the non-group accounts of `root_type` with (non-cancelled) GL activity in
  scope, each `{account, balance}` (same natural-sign convention as the boxes), sorted by
  absolute balance desc. Accounts that net to zero in scope are omitted. Reuses `_date_range`,
  so it honors company + FY/All-Time exactly like the boxes — the rows sum to the box total.
- **UI** `…/page/ledger_lab/ledger_lab.js` —
  - The five root-type boxes are clickable (`role=button`, keyboard Enter/Space, hover
    "VIEW ACCOUNTS →" affordance). **Net Profit is not clickable** — it's derived, not a
    root_type.
  - Click → `get_account_breakdown` → a **single, reused** `frappe.ui.Dialog` (titled
    "Assets — account breakdown", with a "Company · scope" subline) listing each account, its
    balance (negative balances in red), and a **Total** row that reconciles to the box.
  - Each account links to the **General Ledger** report filtered to that account + company,
    bounded by the active scope's dates (All Time → wide range `2000-01-01 … today`).

## Deviations from the phase-5 spec (reconciled)

13. **GL link route is `/app/query-report/General Ledger`**, not `/app/general-ledger`. The
    General Ledger is a **Script Report** (`ref_doctype` GL Entry); the bare `/app/general-ledger`
    resolves to a non-existent *Page* ("Page general-ledger not found"). Query reports route
    under `/app/query-report/<Report Name>` (name URL-encoded). Filters pass as query params
    (`company`, `account`, `from_date`, `to_date`).

14. **Single reused dialog instance.** Each `frappe.ui.Dialog` persists in the DOM after `hide()`;
    creating a new one per click leaks orphaned hidden modals. We keep one `this.breakdown_dialog`
    and re-`set_title`/re-fill its body on each drill-down. (In normal use the modal backdrop
    blocks clicking another box while one is open, so dialogs never visibly stack.)

15. **Zero-net accounts omitted.** An account whose in-scope balance nets to ~0 is dropped from
    the list (it carries none of the box total). The remaining rows still sum exactly to the box.

## Phase-5 verification (agent-browser, `ledger.localhost`)

Added one in-FY composition JE — Dr **Buildings** 2,000 / Cr **Cash** 2,000 (`2026-06-03`) — so
the Asset box (unchanged at 3,000) splits across two accounts, illustrating account-level
direction the root-type box can't show.

- Click **Assets** (FY) → dialog lists **Buildings 2,000 + Cash 1,000 = Total 3,000** = box total.
- Switch **All Time**, reopen → **Cash 9,000 + Buildings 2,000 = Total 11,000** = all-time box.
- Click an account link → lands on **General Ledger** with `account` filter applied (e.g.
  `Buildings - BWH`, 4 GL rows), dates matching the active scope.
- Click **Income** → lists **Service 11,000** (credit-normal, positive) = Income box.
- Dialog reuse confirmed: repeated drill-downs keep exactly **one** modal in the DOM.

## What's built (phase 6)

Pure frontend/UX phase — **no backend changes**. All in
`…/page/ledger_lab/ledger_lab.js` (scoped `<style>` + markup + controller).

- **Design refresh.** A "financial-instrument" layout: a hero **equation bar** (accent rail,
  `THE ACCOUNTING EQUATION` kicker, subtle accent gradient, status pill) at the top; **Balance
  Sheet** and **P&L** rendered as two clearly distinct, dotted, tinted-panel groups; refined
  type scale, larger tabular-num box values, cleaner feed. Drill-down (clickable boxes, hover
  "View accounts →", `:focus-visible`) and the derived **Net Profit** box (now tagged
  *Derived*, not clickable) are preserved.
- **Sticky last-impact badges.** Each box carries a persistent badge of the most recent event
  that moved it — `▲ +₹500 · from Journal Entry … · just now` — direction-colored, updated in
  place by the latest event, cleared on any authoritative reload (company/scope change, manual
  Refresh). Net Profit gets the same badge from its Income−Expense delta. A 30s timer refreshes
  the relative-time captions. The flash is lengthened (~0.9s → **2s**, stronger inset ring); the
  old transient `ll-box-delta` chip is **removed** (superseded by the badge).
- **Per-line teaching.** Each feed row has an expand toggle (`button`, `aria-expanded`,
  `aria-controls`; chevron) revealing an optional voucher-type summary plus, per line,
  `{Account} ({Root Type}) increased|decreased by {amount}` — direction from `ll_line_delta`,
  i18n template with interpolated tokens. Cancelled vouchers read as a reversal (decreases +
  "this entry was cancelled…"). Collapse uses the `grid-template-rows 0fr→1fr` trick, disabled
  under `prefers-reduced-motion`.

## Deviations from the phase-6 spec (reconciled)

16. **Accent is a fixed blue (`#3b82f6`), not `var(--primary)`.** The spec suggested reading the
    Frappe accent token. On this bench `--primary` resolves to a near-black (`#171717`) that does
    **not** flip for dark mode, so an accent keyed to it vanishes on the dark surface. We use a
    fixed blue with sufficient contrast on both light and dark backgrounds (the dark-mode-safe
    story the spec requires for fixed colors). Green/red direction tints and all other surfaces
    still ride Frappe theme tokens / `color-mix()`.

17. **Relative time is computed client-side from a captured epoch**, not via
    `frappe.datetime.comment_when`/`prettyDate`. Those apply `convert_to_user_tz` to the input
    while comparing against an already-user-tz "now", double-shifting a freshly-stamped client
    timestamp (often yielding an empty string). A tiny `ll_rel_time(ms)` helper off `Date.now()`
    is tz-safe and dependency-free.

18. **Reduced motion keeps the badge AND applies values instantly.** Count-up and flash are
    suppressed (existing `ll_reduced_motion()` guard); `set_impact`/`render_impact` have no motion
    guard, so the sticky badge and expandable teaching still render — a net win for reduced-motion
    users, who previously got nothing lingering.

## Phase-6 verification (agent-browser, `ledger.localhost`)

- **Redesign** renders in **light and dark** (verified by forcing `data-theme`): equation hero,
  blue accent rail/kicker/section-dots/active-scope-tab, distinct BS vs P&L panels, `✓ Balanced`
  pill — all legible in both themes after the accent fix (deviation #16).
- **Submit** JE (Dr Cash 500 / Cr Service 500, in-FY) → **Assets / Income / Net Profit** count up
  and grow a sticky badge `▲ +₹500 · from Journal Entry ACC-JV-2026-00005`; badge **persists**
  after the flash; untouched boxes (Liabilities/Equity/Expense) stay blank.
- **Second** JE (+100) → the three badges **update in place** to `…00006`; untouched boxes keep
  prior state.
- **Cancel** `…00006` → boxes count **down**, badges flip **red** `▼ −₹100`, feed prepends the
  muted **Cancelled** reversal row; expanding it reads *"This entry was cancelled — …"* with
  `… decreased by ₹100` lines (red dots).
- **Expand** any feed row → per-line plain English (`Cash - BWH (Asset) increased by ₹…`),
  `aria-expanded` toggles, chevron rotates.
- **Scope** FY → All Time → re-aggregates (3.5k→21.5k all-time) and **clears all badges**.
- **Reduced motion** (`set media reduced-motion`) → values apply instantly (no count-up/flash),
  **but** the sticky badge and the expand-teaching panel still render and work.

## Next

- All planned tracer-bullet phases (1–6) are complete and verified. Future work (e.g. curated
  voucher-type narratives, multi-company exercises) would be new specs.
