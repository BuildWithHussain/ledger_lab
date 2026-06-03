"""Seed script for E2E Playwright tests.

A fresh CI site has no ERPNext company, so the Ledger Lab dashboard's
`get_balances` API would throw. This script creates a company (which installs a
standard chart of accounts), marks it the default, and posts one submitted
Journal Entry so the dashboard has live figures and a feed entry to show.

Run via: bench --site <site> execute ledger_lab.e2e_seed.setup_e2e_data
"""

import frappe
from frappe.utils import nowdate

COMPANY_NAME = "Ledger Lab"
COMPANY_ABBR = "LL"
COUNTRY = "United States"
CURRENCY = "USD"


def setup_e2e_data():
	"""Create the company + chart of accounts and post a seed Journal Entry."""
	_ensure_fiscal_year()
	company = _ensure_company()
	_ensure_default_company(company)
	_post_seed_journal_entry(company)
	frappe.db.commit()
	print(f"E2E seed complete for company {company!r}")


def _ensure_fiscal_year() -> None:
	"""A bare `install-app erpnext` (no setup wizard) has no Fiscal Year, which
	Journal Entry submission requires. Create one covering today if missing."""
	from erpnext.accounts.utils import get_fiscal_year

	today = nowdate()
	try:
		get_fiscal_year(today, as_dict=True)
		return
	except Exception:
		pass

	year = int(today[:4])
	if not frappe.db.exists("Fiscal Year", str(year)):
		frappe.get_doc(
			{
				"doctype": "Fiscal Year",
				"year": str(year),
				"year_start_date": f"{year}-01-01",
				"year_end_date": f"{year}-12-31",
			}
		).insert(ignore_permissions=True)


def _ensure_company() -> str:
	existing = frappe.db.get_value("Company", {"company_name": COMPANY_NAME}, "name")
	if existing:
		return existing

	# Inserting a Company triggers ERPNext's chart-of-accounts installation.
	company = frappe.get_doc(
		{
			"doctype": "Company",
			"company_name": COMPANY_NAME,
			"abbr": COMPANY_ABBR,
			"default_currency": CURRENCY,
			"country": COUNTRY,
		}
	).insert(ignore_permissions=True)
	return company.name


def _ensure_default_company(company: str) -> None:
	defaults = frappe.get_single("Global Defaults")
	if defaults.default_company != company:
		defaults.default_company = company
		defaults.save(ignore_permissions=True)
	# Used by ERPNext + Ledger Lab's _resolve_company fallback.
	frappe.db.set_default("company", company)


def _post_seed_journal_entry(company: str) -> None:
	"""Dr a cash/asset account, Cr an income account — a tiny balanced entry."""
	if frappe.db.exists("Journal Entry", {"company": company, "title": "E2E Seed"}):
		return

	debit_account = _leaf_account(company, root_type="Asset")
	credit_account = _leaf_account(company, root_type="Income")
	# P&L (income) JE lines require a cost center; harmless on the asset line.
	cost_center = frappe.db.get_value("Company", company, "cost_center")

	je = frappe.get_doc(
		{
			"doctype": "Journal Entry",
			"voucher_type": "Journal Entry",
			"title": "E2E Seed",
			"company": company,
			"posting_date": nowdate(),
			"accounts": [
				{
					"account": debit_account,
					"debit_in_account_currency": 1000,
					"cost_center": cost_center,
				},
				{
					"account": credit_account,
					"credit_in_account_currency": 1000,
					"cost_center": cost_center,
				},
			],
		}
	)
	je.insert(ignore_permissions=True)
	je.submit()


def _leaf_account(company: str, root_type: str) -> str:
	account = frappe.db.get_value(
		"Account",
		{"company": company, "root_type": root_type, "is_group": 0},
		"name",
		order_by="lft",
	)
	if not account:
		frappe.throw(f"No leaf {root_type} account found for company {company}")
	return account
