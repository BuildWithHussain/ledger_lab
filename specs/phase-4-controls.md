# Phase 4 — Controls: Company & Time Scope

**Goal:** let learners choose which company's ledger they watch and switch the balances
between **This Fiscal Year** and **All Time**.

> **Carried over:** realtime **company filtering** and `frappe.realtime.off(...)` re-bind safety
> already landed in phases 1–3 (the client ignores events whose `company` ≠ selected). What's
> genuinely new here is the **scope** dimension (FY/All-Time) and the **company dropdown UI**.

## In scope
- **Company dropdown** in the page header (Link → Company), default = `frappe.defaults.get_default("company")`. Changing it re-aggregates and re-seeds the feed.
- **Scope tabs / toggle:** `This Fiscal Year` (default) vs `All Time`.
- `get_balances` gains `scope: str = "fy"`; for `"fy"` filter `posting_date` between the
  current fiscal year's `year_start_date`/`year_end_date` via `erpnext.accounts.utils.get_fiscal_year(nowdate(), company=company, as_dict=True)`. `get_recent_vouchers` and (phase 5) `get_account_breakdown` take the same `company` + `scope`.
- **Realtime filtering:** client ignores `ledger_lab_gl_posted` events whose `company` ≠ the
  selected company. (FY scope: a new posting dated outside the FY shouldn't flash — gate on `posting_date` within range before applying.)
- Re-bind safety: call `frappe.realtime.off("ledger_lab_gl_posted", handler)` before
  re-subscribing on company/scope change to avoid duplicate handlers.

## Out of scope
Drill-down (phase 5).

## Files

**Modified:**
- `ledger_lab/ledger_lab/api/dashboard.py` — add `scope` param + fiscal-year date filtering to `get_balances` and `get_recent_vouchers`.
- `ledger_lab/ledger_lab/page/ledger_lab/ledger_lab.js` — add company `add_field` + scope tab bar; on change, refetch balances + feed and reset JS state; apply the company/scope/date filters to incoming realtime events.

## Acceptance test (agent-browser, `ledger.localhost`, Administrator/admin)
1. Open `/app/ledger-lab`; company defaults to the user default; scope defaults to This Fiscal Year.
2. Switch scope to All Time; assert box numbers change (all-time totals differ from FY) and the equation still balances.
3. If multiple companies exist, switch company; assert boxes + feed re-aggregate to that company.
4. Submit an invoice for company A while viewing company B; assert **no flash** on the page.
5. Submit an invoice for the selected company; assert it flashes (regression check that phase-3 behavior survives filtering).

**Done when:** company and scope controls correctly re-scope the data and realtime is filtered to the selected company/scope.
