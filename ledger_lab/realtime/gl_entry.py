import frappe
from frappe.utils import flt


def collect_gl_entry(doc, method=None):
	"""Buffer each posted GL line, then publish ONE event per voucher on commit.

	GL Entries are created one line at a time within a voucher's submit. Publishing
	per line would spam N events and force the client to reassemble the double-entry.
	Instead we accumulate lines in a request-scoped buffer and register a single
	after_commit callback that groups by voucher and emits one rich event each.

	Cancellations are included: ERPNext reverses a voucher by inserting swapped
	GL lines (with is_cancelled=1 under the default, non-immutable ledger). We keep
	those so the dashboard updates live on cancel — the client refetches balances
	(which exclude cancelled entries) and shows a reversal row in the feed.
	"""
	buffer = frappe.flags.ledger_lab_gle_buffer
	if buffer is None:
		buffer = frappe.flags.ledger_lab_gle_buffer = []
		# Runs once the transaction actually commits, so rolled-back postings
		# never reach the dashboard. The CallbackManager drains itself after
		# running, hence we re-register (via the None check) for the next commit.
		frappe.db.after_commit.add(flush_gl_entries)

	buffer.append(
		{
			"company": doc.company,
			"voucher_type": doc.voucher_type,
			"voucher_no": doc.voucher_no,
			"posting_date": str(doc.posting_date) if doc.posting_date else None,
			"account": doc.account,
			"debit": flt(doc.debit),
			"credit": flt(doc.credit),
			"is_cancelled": bool(doc.is_cancelled),
		}
	)


def flush_gl_entries():
	"""Group the buffered lines by voucher and publish one event per voucher."""
	buffer = frappe.flags.ledger_lab_gle_buffer
	# Clear immediately so a subsequent commit in the same request re-registers.
	frappe.flags.ledger_lab_gle_buffer = None
	if not buffer:
		return

	# Resolve root_type for every account in one query.
	accounts = list({row["account"] for row in buffer})
	root_map = dict(
		frappe.get_all(
			"Account",
			filters={"name": ["in", accounts]},
			fields=["name", "root_type"],
			as_list=True,
		)
	)

	by_voucher = {}
	for row in buffer:
		key = (row["company"], row["voucher_type"], row["voucher_no"])
		group = by_voucher.setdefault(key, {"lines": [], "posting_date": row["posting_date"]})
		group["lines"].append(
			{
				"account": row["account"],
				"root_type": root_map.get(row["account"]),
				"debit": row["debit"],
				"credit": row["credit"],
				"is_cancelled": row["is_cancelled"],
			}
		)

	for (company, voucher_type, voucher_no), group in by_voucher.items():
		lines = group["lines"]
		# A reversal-only batch (every line cancelled) means the voucher was cancelled.
		is_cancelled = all(line["is_cancelled"] for line in lines)
		frappe.publish_realtime(
			"ledger_lab_gl_posted",
			{
				"company": company,
				"voucher_type": voucher_type,
				"voucher_no": voucher_no,
				"posting_date": group["posting_date"],
				"is_cancelled": is_cancelled,
				"lines": lines,
			},
			# We are already inside the after-commit phase; emit immediately.
			after_commit=False,
		)
