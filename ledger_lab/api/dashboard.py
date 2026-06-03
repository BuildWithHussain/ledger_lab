import frappe
from frappe import _
from frappe.utils import flt, nowdate

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


def _date_range(company: str, scope: str) -> tuple[str | None, str | None]:
	"""Posting-date bounds for the requested scope.

	scope="fy"  -> the company's current fiscal year (year_start_date..year_end_date).
	scope="all" -> all time, i.e. no date filter (None, None).

	The returned bounds are also echoed to the client so it can gate incoming
	realtime events to the active scope without a round-trip.
	"""
	if scope != "fy":
		return None, None
	from erpnext.accounts.utils import get_fiscal_year

	try:
		fy = get_fiscal_year(nowdate(), company=company, as_dict=True)
	except Exception:
		# No fiscal year configured for this date/company — fall back to all-time
		# rather than erroring out the whole dashboard.
		return None, None
	return str(fy.year_start_date), str(fy.year_end_date)


@frappe.whitelist()
def get_balances(company: str | None = None, scope: str = "fy") -> dict:
	"""Aggregate GL Entry balances grouped by Account root_type.

	`scope` is "fy" (current fiscal year, default) or "all" (all time). Returns
	natural-sign balances so each box shows a positive number under normal
	conditions, plus the active date range so the client can gate realtime events.
	"""
	company = _resolve_company(company)
	start, end = _date_range(company, scope)

	rows = frappe.db.sql(
		"""
		SELECT acc.root_type AS root_type,
		       SUM(gle.debit) AS debit,
		       SUM(gle.credit) AS credit
		FROM `tabGL Entry` gle
		INNER JOIN `tabAccount` acc ON acc.name = gle.account
		WHERE gle.company = %(company)s
		  AND gle.is_cancelled = 0
		  AND (%(start)s IS NULL OR gle.posting_date >= %(start)s)
		  AND (%(end)s IS NULL OR gle.posting_date <= %(end)s)
		GROUP BY acc.root_type
		""",
		{"company": company, "start": start, "end": end},
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
		"scope": scope,
		"date_range": {"start": start, "end": end},
		"boxes": boxes,
		"currency": frappe.get_cached_value("Company", company, "default_currency"),
	}


@frappe.whitelist()
def get_recent_vouchers(company: str | None = None, limit: int = 15, scope: str = "fy") -> list[dict]:
	"""Most recent vouchers (newest first) with their full double-entry lines.

	Used to seed the journal feed on page load. Each voucher carries its Dr/Cr
	lines and each line's root_type so the client can render and color them.
	`scope` ("fy"/"all") matches get_balances so the feed and boxes agree.
	"""
	company = _resolve_company(company)
	limit = min(int(limit or 15), 50)
	start, end = _date_range(company, scope)

	vouchers = frappe.db.sql(
		"""
		SELECT voucher_type, voucher_no,
		       MAX(posting_date) AS posting_date,
		       MAX(creation) AS creation
		FROM `tabGL Entry`
		WHERE company = %(company)s AND is_cancelled = 0
		  AND (%(start)s IS NULL OR posting_date >= %(start)s)
		  AND (%(end)s IS NULL OR posting_date <= %(end)s)
		GROUP BY voucher_type, voucher_no
		ORDER BY MAX(creation) DESC
		LIMIT %(limit)s
		""",
		{"company": company, "limit": limit, "start": start, "end": end},
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


@frappe.whitelist()
def get_account_breakdown(company: str, root_type: str, scope: str = "fy") -> list[dict]:
	"""Per-account balances making up one root-type box, for the company + scope.

	Returns the non-group accounts of `root_type` that have (non-cancelled) GL
	activity in scope, each with its natural-sign balance, sorted by absolute
	balance descending. The balances sum to the matching get_balances box total,
	so the drill-down reconciles to the box the learner clicked.
	"""
	if root_type not in ROOT_TYPES:
		frappe.throw(_("Unknown root type: {0}").format(root_type))
	company = _resolve_company(company)
	start, end = _date_range(company, scope)

	rows = frappe.db.sql(
		"""
		SELECT gle.account AS account,
		       SUM(gle.debit) AS debit,
		       SUM(gle.credit) AS credit
		FROM `tabGL Entry` gle
		INNER JOIN `tabAccount` acc ON acc.name = gle.account
		WHERE gle.company = %(company)s
		  AND gle.is_cancelled = 0
		  AND acc.root_type = %(root_type)s
		  AND acc.is_group = 0
		  AND (%(start)s IS NULL OR gle.posting_date >= %(start)s)
		  AND (%(end)s IS NULL OR gle.posting_date <= %(end)s)
		GROUP BY gle.account
		""",
		{"company": company, "root_type": root_type, "start": start, "end": end},
		as_dict=True,
	)

	debit_normal = root_type in DEBIT_NORMAL
	out = []
	for r in rows:
		balance = flt(r.debit) - flt(r.credit) if debit_normal else flt(r.credit) - flt(r.debit)
		if abs(balance) < 0.005:
			# Fully offset within scope (e.g. an account that netted to zero) —
			# omit so the list shows only accounts that actually carry the total.
			continue
		out.append({"account": r.account, "balance": balance})

	out.sort(key=lambda a: abs(a["balance"]), reverse=True)
	return out


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
