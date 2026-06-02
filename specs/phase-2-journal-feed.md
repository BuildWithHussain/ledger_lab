# Phase 2 — Per-Voucher Payload + Journal Feed

**Goal:** turn the bare realtime ping into a rich **per-voucher** event carrying the full
double-entry, and render a **live journal feed** so learners see the Dr/Cr lines behind each
box movement.

Builds directly on phase 1's working loop.

## In scope
- Replace per-line publish with **one event per voucher**: buffer lines in `frappe.flags`,
  register a single `frappe.db.after_commit` callback, group by `(company, voucher_type, voucher_no)`, attach each line's `root_type`, publish one `ledger_lab_gl_posted` per voucher with `{company, voucher_type, voucher_no, posting_date, lines: [{account, root_type, debit, credit}]}`.
- Journal feed UI: a scrollable list; each new event **prepends** a row showing
  `<voucher_type> <voucher_no> → Dr <acct> <amt> | Cr <acct> <amt>` for every line.
- Each feed row links to the real voucher: `/app/<doctype-slug>/<voucher_no>`.
- On page load, seed the feed with the **most recent ~15 GL vouchers** via a new API.
- Boxes still repaint via `get_balances` refetch on each event (keep phase-1 behavior).
- **Cancellations fire live too.** ERPNext's default (non-immutable) cancel inserts swapped
  reversal GL lines with `is_cancelled=1` (originals are UPDATEd, so no `after_insert`). The
  collector keeps cancelled lines, the event carries `is_cancelled: true`, the client refetches
  balances (which exclude cancelled entries → totals drop) and prepends a muted **Cancelled**
  reversal row. (Without this, cancelling a voucher left the dashboard stale.)

## Out of scope
Animation/flash, count-up, color coding, grouped/equation layout, company dropdown, scope tabs, drill-down.

## Files

**Modified:**
- `ledger_lab/ledger_lab/realtime/gl_entry.py` — implement `collect_gl_entry` (buffer) + `flush_gl_entries` (group + publish per voucher) per plan.md. Update `hooks.py` mapping to `collect_gl_entry` if the function name changed.
- `ledger_lab/ledger_lab/api/dashboard.py` — add `get_recent_vouchers(company: str = None, limit: int = 15) -> list[dict]` (typed, whitelisted): recent distinct vouchers with their Dr/Cr lines + `root_type`, newest first.
- `ledger_lab/ledger_lab/page/ledger_lab/ledger_lab.js` — add feed container + `render_feed_row(voucher)` helper; on init call `get_recent_vouchers`; on realtime event, prepend the row (and still refetch balances). Build the voucher URL with `frappe.utils.get_link_to_form` / `/app/<slug>`.

## Acceptance test (agent-browser, `ledger.localhost`, Administrator/admin)
1. `bench restart` after the hook change.
2. Open `/app/ledger-lab`; assert the feed shows recent vouchers, each with Dr/Cr lines.
3. Submit a Sales Invoice elsewhere; assert **exactly one** new feed row appears (not one per GL line), showing both `Dr Debtors` and `Cr Sales`, and the row links to the invoice.
4. Click the feed row link → lands on the correct Sales Invoice form.
5. Submit a Payment Entry → one feed row with the payment's two lines.
6. Cancel a submitted invoice → boxes drop back live (no reload) and a muted **Cancelled**
   reversal row (swapped Dr/Cr) prepends to the feed.

**Done when:** every submitted voucher produces a single, correct, clickable double-entry feed row in realtime, and cancelling a voucher updates the boxes and feed live.
