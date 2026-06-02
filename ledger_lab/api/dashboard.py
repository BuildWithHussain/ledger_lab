import frappe
from frappe import _
from frappe.utils import flt

# The five GL root types, displayed as the five boxes on the dashboard.
ROOT_TYPES = ("Asset", "Liability", "Equity", "Income", "Expense")

# Debit-normal root types: their balance grows on the debit side.
# The rest (Liability, Equity, Income) are credit-normal. This sign
# convention makes every box read as a positive number normally and keeps
# the accounting identities honest (Assets = Liabilities + Equity, etc.).
DEBIT_NORMAL = {"Asset", "Expense"}


def _resolve_company(company: str | None) -> str:
	if not company:
		company = frappe.defaults.get_user_default("Company") or frappe.db.get_single_value(
			"Global Defaults", "default_company"
		)
	if not company:
		frappe.throw(_("No company found. Please set a default company."))
	return company


@frappe.whitelist()
def get_balances(company: str | None = None) -> dict:
	"""Aggregate GL Entry balances grouped by Account root_type.

	Phase 1: default company, all-time. Returns natural-sign balances so each
	box shows a positive number under normal conditions.
	"""
	company = _resolve_company(company)

	rows = frappe.db.sql(
		"""
		SELECT acc.root_type AS root_type,
		       SUM(gle.debit) AS debit,
		       SUM(gle.credit) AS credit
		FROM `tabGL Entry` gle
		INNER JOIN `tabAccount` acc ON acc.name = gle.account
		WHERE gle.company = %(company)s
		  AND gle.is_cancelled = 0
		GROUP BY acc.root_type
		""",
		{"company": company},
		as_dict=True,
	)

	boxes = {rt: 0.0 for rt in ROOT_TYPES}
	for r in rows:
		if r.root_type not in boxes:
			continue
		if r.root_type in DEBIT_NORMAL:
			boxes[r.root_type] = flt(r.debit) - flt(r.credit)
		else:
			boxes[r.root_type] = flt(r.credit) - flt(r.debit)

	return {
		"company": company,
		"boxes": boxes,
		"currency": frappe.get_cached_value("Company", company, "default_currency"),
	}


@frappe.whitelist()
def get_recent_vouchers(company: str | None = None, limit: int = 15) -> list[dict]:
	"""Most recent vouchers (newest first) with their full double-entry lines.

	Used to seed the journal feed on page load. Each voucher carries its Dr/Cr
	lines and each line's root_type so the client can render and (later) color them.
	"""
	company = _resolve_company(company)
	limit = min(int(limit or 15), 50)

	vouchers = frappe.db.sql(
		"""
		SELECT voucher_type, voucher_no,
		       MAX(posting_date) AS posting_date,
		       MAX(creation) AS creation
		FROM `tabGL Entry`
		WHERE company = %(company)s AND is_cancelled = 0
		GROUP BY voucher_type, voucher_no
		ORDER BY MAX(creation) DESC
		LIMIT %(limit)s
		""",
		{"company": company, "limit": limit},
		as_dict=True,
	)
	if not vouchers:
		return []

	voucher_nos = list({v.voucher_no for v in vouchers})
	lines = frappe.get_all(
		"GL Entry",
		filters={"company": company, "is_cancelled": 0, "voucher_no": ["in", voucher_nos]},
		fields=["voucher_type", "voucher_no", "account", "debit", "credit"],
		order_by="debit desc",
	)

	root_map = _root_type_map([line.account for line in lines])

	by_voucher = {}
	for line in lines:
		by_voucher.setdefault((line.voucher_type, line.voucher_no), []).append(
			{
				"account": line.account,
				"root_type": root_map.get(line.account),
				"debit": flt(line.debit),
				"credit": flt(line.credit),
			}
		)

	return [
		{
			"voucher_type": v.voucher_type,
			"voucher_no": v.voucher_no,
			"posting_date": str(v.posting_date) if v.posting_date else None,
			"lines": by_voucher.get((v.voucher_type, v.voucher_no), []),
		}
		for v in vouchers
	]


def _root_type_map(accounts: list[str]) -> dict:
	unique = list({a for a in accounts if a})
	if not unique:
		return {}
	return dict(
		frappe.get_all(
			"Account",
			filters={"name": ["in", unique]},
			fields=["name", "root_type"],
			as_list=True,
		)
	)
