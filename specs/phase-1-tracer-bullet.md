# Phase 1 — Tracer Bullet: Live Boxes

**Goal:** the thinnest possible slice that lights up the *entire* architectural spine — page
served, API aggregating real GL data, doc_event firing, realtime reaching the client, boxes
repainting live. Everything else (feed, animation, tabs, dropdown, drill-down, equation bar,
grouping) is deliberately deferred.

## In scope
- Desk Page at `/app/ledger-lab` rendering **5 plain boxes** (Asset, Liability, Equity, Income, Expense) with their current balances.
- `get_balances` API: aggregate GL Entry × Account by `root_type` for the **default company, all-time only** (no scope param yet).
- A `doc_events` hook on GL Entry that publishes a **bare** `ledger_lab_gl_posted` event (no payload detail needed yet).
- Client subscribes; on any event it **re-calls `get_balances` and repaints** the numbers.

## Out of scope (later phases)
Company dropdown, FY/All-Time tabs, per-voucher payload, journal feed, animation/flash,
count-up, Dr/Cr tags, grouped layout, equation bar, drill-down.

## Files

**New:**
- `ledger_lab/ledger_lab/page/ledger_lab/__init__.py` — empty.
- `ledger_lab/ledger_lab/page/ledger_lab/ledger_lab.json` — Page fixture (`name: "ledger-lab"`, `module: "Ledger Lab"`, `standard: "Yes"`, roles: Accounts User/Manager). Model on `erpnext/erpnext/stock/page/warehouse_capacity_summary/`.
- `ledger_lab/ledger_lab/page/ledger_lab/ledger_lab.js` — `frappe.pages["ledger-lab"].on_page_load`: build page, render 5 boxes from a single `frappe.call` to `get_balances`, and `frappe.realtime.on("ledger_lab_gl_posted", () => refetch())`. Plain inline markup, no styling beyond minimal.
- `ledger_lab/api/__init__.py` — empty.
- `ledger_lab/api/dashboard.py` — `get_balances(company: str | None = None) -> dict` (typed, whitelisted). Default `company` to `frappe.defaults.get_user_default("Company")` → Global Defaults fallback. Returns `{company, boxes: {Asset, Liability, Equity, Income, Expense}, currency}` using the sign convention from plan.md (Asset/Expense = Dr−Cr; Liability/Equity/Income = Cr−Dr). Filter `is_cancelled = 0`.
- `ledger_lab/realtime/__init__.py` — empty.
- `ledger_lab/realtime/gl_entry.py` — `notify_gl_entry(doc, method=None)`: if `doc.is_cancelled`, return; else `frappe.publish_realtime("ledger_lab_gl_posted", {"company": doc.company}, after_commit=True)`. (Bare per-line publish is fine for phase 1; phase 2 replaces it with per-voucher buffering — and renames the fn to `collect_gl_entry`.)

> **As built:** the hook fires on **`after_insert`** (fires once per GL line at creation —
> clean and guard-free), not `on_update`. The dotted path is `ledger_lab.realtime.gl_entry…`
> (package root is `ledger_lab/ledger_lab/`), not `ledger_lab.ledger_lab.realtime…`.

**Modified:**
- `ledger_lab/hooks.py` — add:
  ```python
  doc_events = {
      "GL Entry": {"after_insert": "ledger_lab.realtime.gl_entry.notify_gl_entry"},
  }
  ```

## Acceptance test (agent-browser, `ledger.localhost`, Administrator/admin)
1. `bench --site ledger.localhost migrate && bench restart`.
2. Browse to `/app/ledger-lab`; assert 5 boxes render with numeric balances for the default company.
3. In a second tab, create + submit a Sales Invoice.
4. Within ~2s, the `ledger-lab` page's Income and Asset numbers change **without a manual reload**. (Phase 1 may repaint all boxes; that's acceptable.)

**Done when:** an invoice submitted elsewhere visibly moves the numbers on the page, proving the full server→socketio→client loop.
