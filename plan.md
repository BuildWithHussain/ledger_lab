# Ledger Lab — Live Ledger Impact Dashboard

## Context

`ledger_lab` is a teaching app to help beginners learn accounting foundations *through* ERPNext. The core idea: as a learner creates real transactions in ERPNext (Sales Invoice, Purchase Invoice, payments, journal entries), they watch — on a single, clean page — how those actions move the general ledger in **real time**, with beginner-friendly color coding and the double-entry behind every change made explicit.

The app is a blank-slate Frappe 17 app; ERPNext is installed in the same bench. Nothing frontend exists yet. This plan builds the dashboard from scratch.

## Design decisions (settled with the user)

- **Real ERPNext docs**, not a simulation. The dashboard is a **passive observer** — learners create transactions in normal ERPNext; the page updates live via socketio. ERPNext stays the real teacher.
- **Data source: GL Entry** (the actual ledger). Trigger listens to **any GL Entry** (not just invoices) so payments and journal entries also visibly move the ledger.
- **Five boxes** = the five GL `root_type`s: Asset, Liability, Equity, Income, Expense (Equity included so no posting is ever invisible).
- **Grouped, equation-teaching layout** + a live equation bar:
  - Balance Sheet row: `Assets = Liabilities + Equity`
  - P&L row: `Income − Expense = Net Profit`
- Each box shows a **running balance** and, on a new transaction, **flashes green (balance up) / red (balance down)** with the number **counting up/down**. A small **Dr/Cr tag** teaches the vocabulary.
- **Live journal feed** below/beside the quadrant: each transaction appears as one row showing its full double-entry (e.g. `Sales Invoice ACC-001 → Dr Debtors 5,000 | Cr Sales 5,000`), with a **click-through link to the real voucher** (`/app/sales-invoice/ACC-001`).
- **Company dropdown** (default = user's default company); **scope tabs** to switch balances between **This Fiscal Year** and **All Time**.
- **Click a box → account-level drill-down** (which accounts make up that total).
- **Surface: Frappe Desk Page** at `/app/ledger-lab`. **Stack: vanilla JS + CSS, no build step** (`frappe.realtime` / `frappe.call` work out of the box).
- Interaction feel: **subtle flash + count-up**, feed row slides in at top.

## Key technical facts (validated against bench source)

- **GL Entry fields:** `account`, `debit`, `credit` (company currency), `voucher_type`, `voucher_no`, `company`, `posting_date`, `party`/`party_type`, `is_cancelled`, `fiscal_year`. Always filter `is_cancelled = 0`. GL Entry is submittable; entries are created **one line at a time** within a voucher's submit (`erpnext/accounts/general_ledger.py` → `save_entries` → `gle.submit()`).
- **Account.root_type** is a Select: `Asset | Liability | Income | Expense | Equity`. Join `GL Entry.account → Account.name`, group by `Account.root_type` (well-indexed on company+posting_date).
- **Sign convention** (so all boxes read positive and the equations hold):
  - Asset, Expense (debit-normal): `balance = SUM(debit) − SUM(credit)`
  - Liability, Equity, Income (credit-normal): `balance = SUM(credit) − SUM(debit)`
  - Flash direction = sign of (new natural balance − previous).
- **Realtime:** one event **per voucher**, not per line. Hook GL Entry `on_update`, collect lines into a request-scoped buffer in `frappe.flags`, register a single `frappe.db.after_commit` callback, and on commit publish one `frappe.publish_realtime("ledger_lab_gl_posted", …)` per voucher carrying all its lines (+ each line's `root_type`). Guard against the GLE rename/repost pass (skip when `doc.get_doc_before_save() is not None`, and skip `is_cancelled`). Client listens with `frappe.realtime.on("ledger_lab_gl_posted", cb)` and filters by current company.
- **Type-annotated APIs required** (`require_type_annotated_api_methods = True` in hooks.py) — every whitelisted method must annotate all params + return.
- **Fiscal year / company:** `erpnext.accounts.utils.get_fiscal_year(nowdate(), company=company, as_dict=True)` → `year_start_date`/`year_end_date`; client default company via `frappe.defaults.get_default("company")`.

## Implementation

### New files (under `apps/ledger_lab/ledger_lab/`)

1. **`ledger_lab/page/ledger_lab/__init__.py`** — empty.
2. **`ledger_lab/page/ledger_lab/ledger_lab.json`** — Page fixture: `name: "ledger-lab"`, `page_name/title: "Ledger Lab"`, `module: "Ledger Lab"`, `standard: "Yes"`, `roles: [Accounts User, Accounts Manager]`. Serves `/app/ledger-lab`.
   - Model on `erpnext/erpnext/stock/page/warehouse_capacity_summary/`.
3. **`ledger_lab/page/ledger_lab/ledger_lab.js`** — `frappe.pages["ledger-lab"].on_page_load`:
   - `frappe.ui.make_app_page` (single_column).
   - Company `add_field` (Link → Company, default = user default), scope tab bar (FY / All Time).
   - Render: equation bar, Balance-Sheet row (Asset | Liability | Equity), P&L row (Income | Expense → Net Profit), journal feed container, all with a scoped `<style>` block injected from JS (no global CSS).
   - On load + on company/scope change: `frappe.call` → `get_balances`; paint boxes + equation bar.
   - `frappe.realtime.on("ledger_lab_gl_posted", cb)` (filter by company): flash affected boxes green/red, count-up numbers, prepend feed row with Dr/Cr lines + voucher link. Call `frappe.realtime.off(...)` before re-binding to avoid dup handlers.
   - Box click → `get_account_breakdown` → show breakdown in a `frappe.ui.Dialog`.
4. **`ledger_lab/api/__init__.py`** + **`ledger_lab/api/dashboard.py`**:
   - `get_balances(company: str, scope: str = "fy") -> dict` — aggregate GL Entry × Account by `root_type` for company + (FY or all-time); return `{boxes, net_profit, currency, company, scope}` applying the sign convention.
   - `get_account_breakdown(company: str, root_type: str, scope: str = "fy") -> list[dict]` — per-account balances for a clicked box.
   - Both `@frappe.whitelist()` and fully type-annotated.
5. **`ledger_lab/realtime/__init__.py`** + **`ledger_lab/realtime/gl_entry.py`**:
   - `collect_gl_entry(doc, method=None)` — buffer fresh, non-cancelled lines in `frappe.flags`; register `flush_gl_entries` on first hit via `frappe.db.after_commit`.
   - `flush_gl_entries()` — group buffer by `(company, voucher_type, voucher_no)`, attach `root_type` per line, publish one realtime event per voucher.

### Modified files

6. **`ledger_lab/hooks.py`** — uncomment/add:
   ```python
   doc_events = {
       "GL Entry": {"on_update": "ledger_lab.ledger_lab.realtime.gl_entry.collect_gl_entry"},
   }
   ```

### Reference (read-only)
- `erpnext/erpnext/accounts/doctype/gl_entry/gl_entry.json` — field names.
- `erpnext/erpnext/accounts/general_ledger.py` — posting flow.
- `erpnext/erpnext/stock/page/warehouse_capacity_summary/` — Desk Page scaffold pattern.
- `frappe/frappe/realtime.py`, `frappe/public/js/frappe/socketio_client.js` — realtime signatures.

## Verification (end-to-end)

TEST USING AGENT BROWSER skill on legder.localhost using Administrator/admin

1. `bench --site ledger.localhost migrate` (registers the Page) and `bench restart` (loads the new `doc_events` hook); `bench build` if needed for assets.
2. Open `/app/ledger-lab`. Confirm 5 boxes render with current balances for the default company, equation bar balances (`Assets = Liabilities + Equity`), and FY/All-Time tabs change the numbers.
3. In another tab, create + **submit** a Sales Invoice. Confirm within ~1s: Assets (Debtors) and Income boxes flash green, numbers count up, and one feed row appears showing `Dr Debtors / Cr Sales` linking to the invoice.
4. Submit a Payment Entry against it → Assets shifts (Bank up, Debtors down: one green, one red), feed shows the payment's double-entry. Confirms the "any GL Entry" trigger.
5. Create a Purchase Invoice → Expense + Liabilities flash; equation still balances.
6. Click the Assets box → drill-down dialog lists Debtors, Bank, etc. with balances.
7. Switch the company dropdown → boxes re-aggregate; realtime events for other companies are ignored.
8. Cancel a voucher → confirm no spurious flash (guarded by `is_cancelled` / fresh-insert check).
