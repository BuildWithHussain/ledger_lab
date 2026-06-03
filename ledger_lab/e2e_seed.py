"""Seed script for E2E Playwright tests.

A fresh CI site (bare `bench install-app erpnext`, no setup wizard) has no
company, fiscal year, or chart of accounts, so the Ledger Lab dashboard's
`get_balances` API would throw. Creating a Company directly also fails because
ERPNext's company hooks reference preset records (e.g. Warehouse Type "Transit")
that only the setup wizard installs.

So we run ERPNext's programmatic setup-wizard entrypoint, which installs the
country presets + chart of accounts, creates the company + fiscal year, and sets
it as the default — then we post one submitted Journal Entry so the dashboard has
live figures and a feed entry to show.

Run via: bench --site <site> execute ledger_lab.e2e_seed.setup_e2e_data
"""

import frappe
from frappe.utils import nowdate

COMPANY_NAME = "Ledger Lab"
COMPANY_ABBR = "LL"
COUNTRY = "India"
CURRENCY = "INR"


def setup_e2e_data():
	"""Run the ERPNext setup wizard (if needed) and post a seed Journal Entry."""
	company = _ensure_company()
	_ensure_default_company(company)
	_mark_setup_complete()
	_post_seed_journal_entry(company)
	frappe.db.commit()
	print(f"E2E seed complete for company {company!r}")


def _mark_setup_complete() -> None:
	"""Flip Frappe's global setup-complete flag.

	ERPNext's `setup_complete` stage-runner installs the company/fixtures but
	does not set `System Settings.setup_complete`, so the desk would otherwise
	redirect every route (including /app/ledger-lab) to the onboarding wizard.
	"""
	frappe.db.set_single_value("System Settings", "setup_complete", 1)


def _ensure_company() -> str:
	"""Create a fully-configured company via ERPNext's setup wizard.

	`setup_complete` is ERPNext's documented programmatic entrypoint: it installs
	country fixtures (Warehouse Types, UOMs, …), the chart of accounts, the
	company, a fiscal year, price lists, and global defaults in one call.
	"""
	existing = frappe.db.get_value("Company", {"company_name": COMPANY_NAME}, "name")
	if existing:
		return existing

	from erpnext.setup.setup_wizard.setup_wizard import setup_complete

	year = int(nowdate()[:4])
	frappe.flags.in_setup_wizard = True
	try:
		setup_complete(
			frappe._dict(
				{
					"country": COUNTRY,
					"company_name": COMPANY_NAME,
					"company_abbr": COMPANY_ABBR,
					"currency": CURRENCY,
					"chart_of_accounts": "Standard",
					"domain": "Distribution",
					"fy_start_date": f"{year}-01-01",
					"fy_end_date": f"{year}-12-31",
				}
			)
		)
	finally:
		frappe.flags.in_setup_wizard = False

	# `make_records` swallows insert errors (rollback + log), so verify the
	# company actually materialized rather than failing later with a vaguer error.
	company = frappe.db.get_value("Company", {"company_name": COMPANY_NAME}, "name")
	if not company:
		frappe.throw(f"Setup wizard did not create company {COMPANY_NAME!r}")
	return company


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
