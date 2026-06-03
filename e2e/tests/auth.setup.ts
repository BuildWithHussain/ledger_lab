import * as fs from "fs";
import * as path from "path";
import { expect, test as setup } from "@playwright/test";

const authFile = "e2e/.auth/user.json";
const csrfFile = "e2e/.auth/csrf.json";

/**
 * Authentication setup - runs once before all tests.
 * Uses browser fetch() so cookies are saved for the correct domain
 * (Chromium resolves ledger.localhost via --host-resolver-rules).
 */
setup("authenticate", async ({ page }) => {
	const authDir = path.dirname(authFile);
	if (!fs.existsSync(authDir)) {
		fs.mkdirSync(authDir, { recursive: true });
	}

	const usr = process.env.FRAPPE_USER || "Administrator";
	const pwd = process.env.FRAPPE_PASSWORD || "admin";

	// Navigate to login page first to establish the domain context.
	await page.goto("/login");
	await page.waitForLoadState("domcontentloaded");

	// Login via browser fetch (keeps cookies on the correct domain).
	const loginResult = await page.evaluate(
		async ({ usr, pwd }) => {
			const resp = await fetch("/api/method/login", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: `usr=${encodeURIComponent(usr)}&pwd=${encodeURIComponent(pwd)}`,
			});
			return { ok: resp.ok, status: resp.status };
		},
		{ usr, pwd },
	);
	expect(loginResult.ok).toBeTruthy();

	// Verify login succeeded.
	const loggedUser = await page.evaluate(async () => {
		const resp = await fetch("/api/method/frappe.auth.get_logged_user");
		const data = await resp.json();
		return data.message as string;
	});
	expect(loggedUser).toBeTruthy();
	expect(loggedUser).not.toBe("Guest");
	console.log(`Authenticated as: ${loggedUser}`);

	// The session cookies (set by the login fetch above) are what matter for
	// authenticated tests, so save the storage state first and unconditionally.
	await page.context().storageState({ path: authFile });

	// CSRF token is best-effort: only needed for write requests via the API
	// helpers. Navigating to the freshly-booted desk in CI can trigger a
	// client-side redirect that destroys the execution context mid-evaluate, so
	// retrieve it defensively and never let it fail the whole setup.
	try {
		await page.goto("/app", { waitUntil: "domcontentloaded" });
		await page
			.waitForFunction(
				() =>
					(window as unknown as { frappe?: { csrf_token?: string } }).frappe
						?.csrf_token !== undefined,
				{ timeout: 30000 },
			)
			.catch(() => {});

		const csrfToken = await page
			.evaluate(
				() =>
					(window as unknown as { frappe?: { csrf_token?: string } }).frappe
						?.csrf_token,
			)
			.catch(() => undefined);

		if (csrfToken) {
			fs.writeFileSync(csrfFile, JSON.stringify({ csrf_token: csrfToken }));
			console.log("CSRF token saved");
		} else {
			console.warn("CSRF token not found, continuing without it");
		}
	} catch {
		console.warn("CSRF retrieval skipped (desk navigation race)");
	}
});
