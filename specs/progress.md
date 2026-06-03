# Ledger Lab — Build Progress

Status of the tracer-bullet phases (see [README.md](README.md) for the phase index).
Repo: <https://github.com/BuildWithHussain/ledger_lab> (default branch `develop`).

| Phase | Status | Verified |
|------|--------|----------|
| 1 — Tracer bullet: live boxes | ✅ Done | agent-browser on `ledger.localhost` |
| 2 — Per-voucher payload + journal feed | ✅ Done | agent-browser (incl. live cancel) |
| 3 — Teaching layer & polish | ✅ Done | agent-browser (flash up/down, count-up, reduced-motion, no client drift) |
| 4 — Controls: company & time scope | ⬜ Not started | — |
| 5 — Account-level drill-down | ⬜ Not started | — |

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

## Next

- **Phase 4** — company dropdown + FY/All-Time scope tabs (`get_balances`/`get_recent_vouchers`
  gain a `scope` param; client realtime already filters by company). See
  [phase-4-controls.md](phase-4-controls.md).
- **Phase 5** — account-level drill-down dialog. See [phase-5-drilldown.md](phase-5-drilldown.md).
