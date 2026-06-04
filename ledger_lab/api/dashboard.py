import frappe
from frappe import _
from frappe.query_builder import Criterion, DocType
from frappe.query_builder.functions import Max, Sum
from frappe.utils import cint, flt, nowdate

from ledger_lab.accounting import ROOT_TYPES, get_account_root_types, get_natural_balance

DEFAULT_RECENT_VOUCHER_LIMIT = 15
MAX_RECENT_VOUCHER_LIMIT = 50
VALID_SCOPES = frozenset({"fy", "all"})


def _first_accessible_company() -> str | None:
	"""Oldest company the current user can read, or None if there are none."""
	companies = frappe.get_list("Company", pluck="name", order_by="creation asc", limit=1)
	return companies[0] if companies else None


def _resolve_company(company: str | None) -> str:
	company = company.strip() if company else None
	if not company:
		company = frappe.defaults.get_user_default("Company") or frappe.db.get_single_value(
			"Global Defaults", "default_company"
		)
	# A missing or stale default (e.g. a deleted/renamed company, or a leftover
	# user default pointing at a company that no longer exists) shouldn't blank
	# out the dashboard. Fall back to the first company the user can access so
	# the page always opens with data. The Company picker only ever submits real
	# companies, so this lenient fallback never masks a genuine bad selection.
	if not company or not frappe.db.exists("Company", company):
		company = _first_accessible_company()
	if not company:
		frappe.throw(_("No company found. Please create a company first."))

	frappe.has_permission("Company", ptype="read", doc=company, throw=True)
	return company


def _validate_accounting_read_permission() -> None:
	frappe.has_permission("GL Entry", ptype="read", throw=True)
	frappe.has_permission("Account", ptype="read", throw=True)


def _normalize_scope(scope: str | None) -> str:
	scope = (scope or "fy").strip().lower()
	if scope not in VALID_SCOPES:
		frappe.throw(_("Unknown scope: {0}").format(scope))

	return scope


def _clamp_limit(limit: int | None) -> int:
	return max(1, min(cint(limit) or DEFAULT_RECENT_VOUCHER_LIMIT, MAX_RECENT_VOUCHER_LIMIT))


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

	fy = get_fiscal_year(nowdate(), company=company, as_dict=True, raise_on_missing=False)
	if not fy:
		# No fiscal year configured for this date/company; fall back to all-time
		# rather than erroring out the whole dashboard.
		return None, None

	return str(fy.year_start_date), str(fy.year_end_date)


def _get_request_context(company: str | None, scope: str) -> tuple[str, str, str | None, str | None]:
	company = _resolve_company(company)
	_validate_accounting_read_permission()
	scope = _normalize_scope(scope)
	start, end = _date_range(company, scope)

	return company, scope, start, end


def _apply_posting_date_range(query, gl_entry, start: str | None, end: str | None):
	if start:
		query = query.where(gl_entry.posting_date >= start)
	if end:
		query = query.where(gl_entry.posting_date <= end)

	return query


@frappe.whitelist(methods=["GET", "POST"])
def get_balances(company: str | None = None, scope: str = "fy") -> dict:
	"""Aggregate GL Entry balances grouped by Account root_type.

	`scope` is "fy" (current fiscal year, default) or "all" (all time). Returns
	natural-sign balances so each box shows a positive number under normal
	conditions, plus the active date range so the client can gate realtime events.
	"""
	company, scope, start, end = _get_request_context(company, scope)
	gl_entry = DocType("GL Entry")
	account = DocType("Account")

	query = (
		frappe.qb.from_(gl_entry)
		.inner_join(account)
		.on(account.name == gl_entry.account)
		.select(
			account.root_type.as_("root_type"),
			Sum(gl_entry.debit).as_("debit"),
			Sum(gl_entry.credit).as_("credit"),
		)
		.where(
			(gl_entry.company == company)
			& (gl_entry.is_cancelled == 0)
			& (account.root_type.isin(ROOT_TYPES))
		)
		.groupby(account.root_type)
	)
	rows = _apply_posting_date_range(query, gl_entry, start, end).run(as_dict=True)

	boxes = {rt: 0.0 for rt in ROOT_TYPES}
	for row in rows:
		boxes[row.root_type] = get_natural_balance(row.root_type, row.debit, row.credit)

	return {
		"company": company,
		"scope": scope,
		"date_range": {"start": start, "end": end},
		"boxes": boxes,
		"currency": frappe.get_cached_value("Company", company, "default_currency"),
	}


@frappe.whitelist(methods=["GET", "POST"])
def get_recent_vouchers(company: str | None = None, limit: int = 15, scope: str = "fy") -> list[dict]:
	"""Most recent vouchers (newest first) with their full double-entry lines.

	Used to seed the journal feed on page load. Each voucher carries its Dr/Cr
	lines and each line's root_type so the client can render and color them.
	`scope` ("fy"/"all") matches get_balances so the feed and boxes agree.
	"""
	company, _scope, start, end = _get_request_context(company, scope)
	limit = _clamp_limit(limit)
	gl_entry = DocType("GL Entry")

	voucher_query = (
		frappe.qb.from_(gl_entry)
		.select(
			gl_entry.voucher_type,
			gl_entry.voucher_no,
			Max(gl_entry.posting_date).as_("posting_date"),
			Max(gl_entry.creation).as_("creation"),
		)
		.where((gl_entry.company == company) & (gl_entry.is_cancelled == 0))
		.groupby(gl_entry.voucher_type, gl_entry.voucher_no)
		.orderby(Max(gl_entry.creation), order=frappe.qb.desc)
		.limit(limit)
	)
	vouchers = _apply_posting_date_range(voucher_query, gl_entry, start, end).run(as_dict=True)
	if not vouchers:
		return []

	voucher_conditions = [
		(gl_entry.voucher_type == voucher.voucher_type) & (gl_entry.voucher_no == voucher.voucher_no)
		for voucher in vouchers
	]
	lines = (
		frappe.qb.from_(gl_entry)
		.select(gl_entry.voucher_type, gl_entry.voucher_no, gl_entry.account, gl_entry.debit, gl_entry.credit)
		.where(
			(gl_entry.company == company) & (gl_entry.is_cancelled == 0) & Criterion.any(voucher_conditions)
		)
		.orderby(gl_entry.debit, order=frappe.qb.desc)
		.run(as_dict=True)
	)
	root_map = get_account_root_types(line.account for line in lines)

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


@frappe.whitelist(methods=["GET", "POST"])
def get_account_breakdown(company: str, root_type: str, scope: str = "fy") -> list[dict]:
	"""Per-account balances making up one root-type box, for the company + scope.

	Returns the non-group accounts of `root_type` that have (non-cancelled) GL
	activity in scope, each with its natural-sign balance, sorted by absolute
	balance descending. The balances sum to the matching get_balances box total,
	so the drill-down reconciles to the box the learner clicked.
	"""
	if root_type not in ROOT_TYPES:
		frappe.throw(_("Unknown root type: {0}").format(root_type))
	company, _scope, start, end = _get_request_context(company, scope)
	gl_entry = DocType("GL Entry")
	account = DocType("Account")

	query = (
		frappe.qb.from_(gl_entry)
		.inner_join(account)
		.on(account.name == gl_entry.account)
		.select(
			gl_entry.account.as_("account"),
			Sum(gl_entry.debit).as_("debit"),
			Sum(gl_entry.credit).as_("credit"),
		)
		.where(
			(gl_entry.company == company)
			& (gl_entry.is_cancelled == 0)
			& (account.root_type == root_type)
			& (account.is_group == 0)
		)
		.groupby(gl_entry.account)
	)
	rows = _apply_posting_date_range(query, gl_entry, start, end).run(as_dict=True)

	out = []
	for row in rows:
		balance = get_natural_balance(root_type, row.debit, row.credit)
		if abs(balance) < 0.005:
			# Fully offset within scope (e.g. an account that netted to zero) —
			# omit so the list shows only accounts that actually carry the total.
			continue
		out.append({"account": row.account, "balance": balance})

	out.sort(key=lambda a: abs(a["balance"]), reverse=True)
	return out
