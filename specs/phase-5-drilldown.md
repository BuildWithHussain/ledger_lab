# Phase 5 — Account-Level Drill-Down

**Goal:** let a learner click a box to see *which accounts* make up that root-type total —
closing the loop from abstract root type → real chart-of-accounts entries.

> This is also where **account-level direction** becomes visible: a receivable Payment Entry
> (Dr Bank, Cr Debtors) leaves the **Asset box unchanged** (both are Assets), but the Assets
> drill-down shows Bank up and Debtors down — the green/red split the root-type box can't show.

## In scope
- Click a box → open a `frappe.ui.Dialog` titled e.g. "Assets — account breakdown".
- Dialog lists each non-group account of that `root_type` for the selected company/scope with
  its balance (applying the same sign convention), sorted by absolute balance desc.
- Each account row links to its Account / its General Ledger report filtered to that account.
- Respects the current company + scope (FY/All Time) from phase 4.

## Files

**Modified:**
- `ledger_lab/ledger_lab/api/dashboard.py` — add `get_account_breakdown(company: str, root_type: str, scope: str = "fy") -> list[dict]` (typed, whitelisted): per-account `{account, balance}` for the given root_type, company, and scope, `is_group = 0`, `is_cancelled = 0`.
- `ledger_lab/ledger_lab/page/ledger_lab/ledger_lab.js` — make boxes clickable; on click call `get_account_breakdown` and render the dialog; add account links.

## Acceptance test (agent-browser, `ledger.localhost`, Administrator/admin)
1. Open `/app/ledger-lab`; click the **Assets** box.
2. Assert a dialog opens listing accounts (e.g. Debtors, Bank/Cash) with balances that **sum
   to the Assets box total** for the current company/scope.
3. Switch scope to All Time, re-open the dialog; assert balances reflect all-time totals.
4. Click an account link; assert it navigates to that account's record / GL report.
5. Click the Income box; assert it lists income accounts with credit-normal positive balances.

**Done when:** clicking any box reveals its constituent accounts, the figures reconcile to the box total, and the breakdown honors the active company + scope.
