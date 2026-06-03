from collections.abc import Iterable

import frappe
from frappe.utils import flt

# The five GL root types displayed as the dashboard boxes.
ROOT_TYPES = ("Asset", "Liability", "Equity", "Income", "Expense")

# Debit-normal root types grow on the debit side. Credit-normal types grow on
# the credit side, so natural balances stay positive under normal conditions.
DEBIT_NORMAL = frozenset({"Asset", "Expense"})


def get_natural_balance(root_type: str, debit: float | None, credit: float | None) -> float:
	if root_type in DEBIT_NORMAL:
		return flt(debit) - flt(credit)

	return flt(credit) - flt(debit)


def get_account_root_types(accounts: Iterable[str | None]) -> dict[str, str]:
	account_names = sorted({account for account in accounts if account})
	if not account_names:
		return {}

	return dict(
		frappe.get_all(
			"Account",
			filters={"name": ["in", account_names]},
			fields=["name", "root_type"],
			as_list=True,
		)
	)
