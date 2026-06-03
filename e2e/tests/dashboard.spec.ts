import { test, expect } from "@playwright/test";

/**
 * Basic smoke test for the Ledger Lab desk page (/app/ledger-lab).
 *
 * Verifies that the dashboard renders its core structure and that the
 * live balances load from the backend `get_balances` API — proven by the
 * accounting-equation status pill resolving to "Balanced" (a trial-balance
 * closure that only appears once real numbers replace the "—" placeholders).
 */
test.describe("Ledger Lab dashboard", () => {
	test("renders the equation, the six boxes, and loads balanced figures", async ({
		page,
	}) => {
		await page.goto("/app/ledger-lab");

		const wrap = page.locator(".ll-wrap");
		await expect(wrap).toBeVisible();

		// Hero: the accounting equation.
		await expect(page.locator(".ll-eq-kicker")).toHaveText(
			"The Accounting Equation",
		);

		// Five root-type boxes + the derived Net Profit box.
		await expect(page.locator(".ll-box")).toHaveCount(6);

		// Balance Sheet and P&L sections both render.
		await expect(page.locator(".ll-section.bs")).toBeVisible();
		await expect(page.locator(".ll-section.pl")).toBeVisible();
		await expect(page.locator(".ll-feed")).toBeVisible();

		// Live data path: once get_balances resolves, the equation pill reports
		// the books are balanced (Assets = Liabilities + Equity + Net Profit).
		const status = page.locator("[data-eq-status]");
		await expect(status).toContainText("Balanced", { timeout: 15000 });

		// And the box values are no longer the "—" placeholder.
		const assetValue = page.locator('.ll-box[data-root="Asset"] .ll-num');
		await expect(assetValue).not.toHaveText("—");
	});
});
