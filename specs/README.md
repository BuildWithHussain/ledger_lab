# Ledger Lab — Build Specs (Tracer-Bullet Phases)

See [`../plan.md`](../plan.md) for the full design, settled decisions, and validated technical facts.

## Philosophy

We build with **tracer bullets** (Pragmatic Programmer): the first phase is the thinnest
possible end-to-end slice that passes through **every architectural layer** of the real
feature — so we get the whole pipeline lit up and validated before investing in polish.
Each later phase enriches **one dimension** without breaking the working slice.

The feature is *live ledger impact*. The architectural spine the tracer bullet must prove is:

```
ERPNext voucher submit → GL Entry doc_event (server hook) → frappe.publish_realtime
        → socketio → frappe.realtime.on (client) → repaint boxes from get_balances API
```

A static balance report is NOT a slice of this feature — the tracer bullet includes realtime.

## Phases

| Phase | Spec | Proves / Adds | Shippable outcome |
|------|------|---------------|-------------------|
| 1 | [phase-1-tracer-bullet.md](phase-1-tracer-bullet.md) | The **whole spine** end-to-end, minimal | Open `/app/ledger-lab`, submit an invoice elsewhere, watch 5 plain boxes update live |
| 2 | [phase-2-journal-feed.md](phase-2-journal-feed.md) | Per-voucher realtime payload + journal feed | Each transaction appears as a Dr/Cr feed row linking to the voucher |
| 3 | [phase-3-teaching-layer.md](phase-3-teaching-layer.md) | Grouped BS/PL layout, equation bar, flash + count-up, color coding | The beginner "aha" — equation balances, boxes flash green/red |
| 4 | [phase-4-controls.md](phase-4-controls.md) | Company dropdown + FY/All-Time scope tabs | Switch company & time scope; realtime filtered by company |
| 5 | [phase-5-drilldown.md](phase-5-drilldown.md) | Account-level drill-down | Click a box → dialog of constituent accounts |

Build in order. Each phase ends with an acceptance test you can run before moving on.

## Test environment (all phases)

- **Site:** `ledger.localhost`
- **Login:** `Administrator` / `admin`
- **Tool:** the **agent-browser** skill drives the UI for acceptance tests.
- After backend changes: `bench --site ledger.localhost migrate` (registers Page fixtures),
  `bench restart` (reloads `doc_events` hooks), `bench build` if assets changed.
- A populated demo company should exist so balances are non-trivial; if none, create one
  company + a customer + an item before testing invoices.
