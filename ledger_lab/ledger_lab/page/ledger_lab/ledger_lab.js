frappe.pages["ledger-lab"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Ledger Lab"),
		single_column: true,
	});

	const lab = new LedgerLab(page);
	page.set_secondary_action(__("Refresh"), () => lab.reload(), "refresh");
};

const LL_ROOT_TYPES = ["Asset", "Liability", "Equity", "Income", "Expense"];
const LL_ALL_BOXES = [...LL_ROOT_TYPES, "NetProfit"];
const LL_DEBIT_NORMAL = new Set(["Asset", "Expense"]);
const LL_LABELS = {
	Asset: __("Assets"),
	Liability: __("Liabilities"),
	Equity: __("Equity"),
	Income: __("Income"),
	Expense: __("Expense"),
};
const LL_ANIM_MS = 450;
const LL_FLASH_MS = 2000;

// Plain-English, data-driven one-liners keyed by voucher_type. Intentionally
// generic — no per-document narratives that could go stale. A type not in the
// map simply gets no summary (the per-line clauses still explain the entry).
const LL_VOUCHER_SUMMARY = {
	"Sales Invoice": __("A sale recorded revenue and a receivable (money owed to you)."),
	"Purchase Invoice": __("A purchase recorded a cost and a payable (money you owe)."),
	"Payment Entry": __("A payment moved funds between accounts."),
	"Journal Entry": __("A manual journal entry adjusted these accounts directly."),
	"Sales Order": __("A sales order was booked."),
	"Purchase Order": __("A purchase order was booked."),
};

function ll_reduced_motion() {
	return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Natural-sign contribution of a single GL line to its account's balance:
// debit-normal accounts grow on debit, credit-normal on credit.
function ll_line_delta(root_type, debit, credit) {
	const d = flt(debit);
	const c = flt(credit);
	return LL_DEBIT_NORMAL.has(root_type) ? d - c : c - d;
}

// Compact, tz-safe relative time from a captured epoch (ms). We stamp events on
// receipt and compute locally, so there's no timezone round-trip to get wrong.
function ll_rel_time(ms) {
	const diff = Math.max(0, (Date.now() - ms) / 1000);
	if (diff < 45) return __("just now");
	if (diff < 90) return __("1m ago");
	if (diff < 3600) return __("{0}m ago", [Math.round(diff / 60)]);
	if (diff < 7200) return __("1h ago");
	if (diff < 86400) return __("{0}h ago", [Math.round(diff / 3600)]);
	return __("{0}d ago", [Math.round(diff / 86400)]);
}

class LedgerLab {
	constructor(page) {
		this.page = page;
		this.company = frappe.defaults.get_default("company");
		this.currency = frappe.boot.sysdefaults.currency;
		// scope: "fy" (current fiscal year, default) or "all" (all time).
		this.scope = "fy";
		// Active posting-date bounds for the scope, echoed by get_balances; used
		// to gate incoming realtime events to the current scope (null = all time).
		this.date_range = { start: null, end: null };
		// state.boxes is authoritative; state.displayed tracks what's on screen
		// so deltas/flash are computed client-side from each realtime payload.
		this.boxes = { Asset: 0, Liability: 0, Equity: 0, Income: 0, Expense: 0 };
		this.displayed = { ...this.boxes, NetProfit: 0 };
		// Persistent "last impact" per box: {delta, voucher_type, voucher_no, ts}.
		// Survives the transient flash so a learner can read what moved; cleared on
		// any authoritative reload (company/scope change, manual Refresh).
		this.lastImpact = {};
		this._seq = 0; // unique ids for expandable teaching panels
		this.render_skeleton();
		this.setup_controls();
		this.bind_realtime();
		// Resolve a company before the first load so the dashboard always opens
		// with data instead of erroring out when no default company is set.
		this.init_company().then(() => {
			this.refresh();
			this.load_feed();
		});
		// Keep the sticky badges' relative times ("just now" → "2m ago") fresh.
		this.impact_timer = setInterval(() => this.tick_impact_times(), 30000);
	}

	// Ensure a company is always selected on open. Frappe's default ("company")
	// can be unset for a user or a freshly-set-up site; rather than letting the
	// server error out with "No company found", fall back to the first available
	// company so the page opens with data. Keeps the header picker in sync.
	async init_company() {
		if (!this.company) {
			try {
				const rows = await frappe.db.get_list("Company", {
					fields: ["name"],
					order_by: "creation asc",
					limit: 1,
				});
				if (rows && rows.length) this.company = rows[0].name;
			} catch (e) {
				// Permission/query issue — leave unset; refresh() surfaces the
				// server's message rather than masking it.
			}
		}
		if (this.company) this.company_field.set_value(this.company);
	}

	render_skeleton() {
		// All boxes except the derived Net Profit are clickable to reveal the
		// constituent accounts of that root type (phase 5 drill-down).
		const box = (root, label, kind) => {
			const clickable = root !== "NetProfit";
			return `
			<div class="ll-box ${kind} ${clickable ? "ll-clickable" : "ll-derived"}" data-root="${root}"${
				clickable ? ' role="button" tabindex="0"' : ""
			}>
				${
					clickable
						? `<div class="ll-box-hint">${__("View accounts")} →</div>`
						: `<div class="ll-box-hint ll-derived-tag">${__("Derived")}</div>`
				}
				<div class="ll-box-label">${label}</div>
				<div class="ll-box-value"><span class="ll-num" data-num="${root}">—</span></div>
				<div class="ll-box-impact" data-impact="${root}"></div>
			</div>`;
		};

		const eqterm = (root, label) =>
			`<span class="ll-eq-t"><span class="ll-eq-lbl">${label}</span> <span class="ll-num" data-num="${root}">—</span></span>`;

		$(`
			<style>
				.ll-wrap {
					--ll-green: #16a34a; --ll-red: #dc2626;
					--ll-green-bg: rgba(34, 197, 94, 0.16);
					--ll-red-bg: rgba(239, 68, 68, 0.16);
					/* Fixed brand accent. Deliberately NOT var(--primary): this
					   Frappe build's --primary is a near-black that doesn't flip
					   for dark mode, so it vanishes on the dark surface. This blue
					   has sufficient contrast on both light and dark backgrounds. */
					--ll-accent: #3b82f6;
					max-width: 1100px; margin: 0 auto;
				}

				/* ---- Hero: the accounting equation ---- */
				.ll-equation {
					position: relative; overflow: hidden;
					border: 1px solid var(--border-color);
					border-radius: 14px;
					padding: 22px 26px 20px;
					margin: 14px 0 6px;
					background:
						radial-gradient(140% 160% at 0% 0%,
							color-mix(in srgb, var(--ll-accent) 8%, var(--card-bg, var(--fg-color))) 0%,
							var(--card-bg, var(--fg-color)) 58%);
				}
				.ll-equation::before {
					content: ""; position: absolute; left: 0; width: 4px;
					/* inset by the card radius so the rail stays clear of the
					   rounded corners instead of poking its square top/bottom
					   past them (overflow:hidden alone doesn't clip it cleanly) */
					top: 14px; bottom: 14px;
					background: var(--ll-accent);
					border-radius: 0 3px 3px 0;
				}
				.ll-eq-kicker {
					font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase;
					font-weight: 700; color: var(--ll-accent); margin-bottom: 12px;
				}
				.ll-eq-main {
					display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 12px;
					font-size: 19px; line-height: 1.4;
				}
				.ll-eq-t { display: inline-flex; align-items: baseline; gap: 7px; }
				.ll-eq-lbl { color: var(--text-muted); }
				.ll-eq-main .ll-num {
					font-weight: 700; color: var(--text-color);
					font-variant-numeric: tabular-nums; letter-spacing: -0.01em;
				}
				.ll-eq-op { color: var(--text-muted); font-weight: 600; }
				.ll-eq-status {
					margin-left: auto; font-weight: 700; font-size: 12.5px;
					padding: 4px 12px; border-radius: 999px; white-space: nowrap;
				}
				.ll-eq-status.ok { color: var(--ll-green); background: var(--ll-green-bg); }
				.ll-eq-status.warn { color: var(--ll-red); background: var(--ll-red-bg); }
				.ll-eq-sub { color: var(--text-muted); font-size: var(--text-sm); margin-top: 10px; }
				.ll-eq-sub .ll-num { font-variant-numeric: tabular-nums; color: var(--text-color); }

				/* ---- Section groups: Balance Sheet vs P&L ---- */
				.ll-section { margin-top: 22px; }
				.ll-section-head {
					display: flex; align-items: center; gap: 9px; margin: 0 2px 10px;
				}
				.ll-section-dot {
					width: 8px; height: 8px; border-radius: 2px;
					background: var(--ll-accent);
				}
				.ll-section.pl .ll-section-dot {
					background: color-mix(in srgb, var(--ll-accent) 45%, var(--text-muted));
				}
				.ll-section-title {
					font-size: var(--text-sm); font-weight: 600; letter-spacing: 0.06em;
					text-transform: uppercase; color: var(--text-muted);
				}
				.ll-section-body {
					display: flex; gap: 12px; flex-wrap: wrap;
					border: 1px solid var(--border-color); border-radius: 12px;
					padding: 14px;
					background: color-mix(in srgb, var(--text-muted) 3%, var(--card-bg, var(--fg-color)));
				}

				/* ---- Boxes ---- */
				.ll-box {
					flex: 1 1 180px; min-width: 168px; position: relative; overflow: hidden;
					border: 1px solid var(--border-color);
					border-radius: 10px;
					padding: 16px 18px 14px;
					background: var(--card-bg, var(--fg-color));
				}
				.ll-box-label {
					font-size: var(--text-sm); color: var(--text-muted);
					text-transform: uppercase; letter-spacing: 0.04em;
				}
				.ll-box-value {
					font-size: 27px; font-weight: 600; margin-top: 4px; letter-spacing: -0.02em;
					color: var(--text-color); font-variant-numeric: tabular-nums;
				}
				.ll-box.ll-clickable { cursor: pointer; transition: border-color 0.12s ease; }
				.ll-box.ll-clickable:hover { border-color: var(--ll-accent); }
				.ll-box.ll-clickable:focus-visible { outline: 2px solid var(--ll-accent); outline-offset: 1px; }
				.ll-box-hint {
					position: absolute; top: 14px; right: 16px;
					font-size: 10px; font-weight: 700; letter-spacing: 0.04em;
					text-transform: uppercase; color: var(--ll-accent);
					opacity: 0; transition: opacity 0.12s ease;
				}
				.ll-box.ll-clickable:hover .ll-box-hint,
				.ll-box.ll-clickable:focus-visible .ll-box-hint { opacity: 1; }
				.ll-box-hint.ll-derived-tag { opacity: 0.55; color: var(--text-muted); }

				/* Persistent last-impact badge (supersedes the old transient chip). */
				.ll-box-impact {
					margin-top: 13px; min-height: 31px;
					display: flex; flex-direction: column; justify-content: flex-end; gap: 2px;
				}
				.ll-impact-delta {
					font-size: var(--text-sm); font-weight: 700;
					font-variant-numeric: tabular-nums;
				}
				.ll-impact-delta.up { color: var(--ll-green); }
				.ll-impact-delta.down { color: var(--ll-red); }
				.ll-impact-cap { font-size: 11px; line-height: 1.35; color: var(--text-muted); }

				/* Longer, more prominent flash than phase 3 (~0.9s → 2s). */
				.ll-box.flash-up { animation: ll-flash-up 2s ease-out; }
				.ll-box.flash-down { animation: ll-flash-down 2s ease-out; }
				@keyframes ll-flash-up {
					0%, 30% { background: var(--ll-green-bg); box-shadow: inset 0 0 0 2px var(--ll-green); }
					100% { background: var(--card-bg, var(--fg-color)); box-shadow: inset 0 0 0 0 transparent; }
				}
				@keyframes ll-flash-down {
					0%, 30% { background: var(--ll-red-bg); box-shadow: inset 0 0 0 2px var(--ll-red); }
					100% { background: var(--card-bg, var(--fg-color)); box-shadow: inset 0 0 0 0 transparent; }
				}

				/* ---- Scope tabs ---- */
				.ll-toolbar { display: flex; align-items: center; margin-top: 4px; }
				.ll-scope {
					display: inline-flex; margin-left: auto;
					border: 1px solid var(--border-color);
					border-radius: 8px; overflow: hidden;
				}
				.ll-scope-tab {
					border: none; background: transparent; cursor: pointer;
					padding: 6px 14px; font-size: var(--text-sm); font-weight: 500;
					color: var(--text-muted); border-right: 1px solid var(--border-color);
					transition: background 0.12s ease, color 0.12s ease;
				}
				.ll-scope-tab:last-child { border-right: none; }
				.ll-scope-tab:hover { color: var(--text-color); }
				.ll-scope-tab.active {
					background: var(--ll-accent); color: #fff; font-weight: 600;
				}

				/* ---- Feed ---- */
				.ll-feed { margin-top: 26px; }
				.ll-feed-head-row { display: flex; align-items: center; gap: 9px; margin: 0 2px 10px; }
				.ll-feed-title {
					font-size: var(--text-sm); font-weight: 600; letter-spacing: 0.06em;
					text-transform: uppercase; color: var(--text-muted);
				}
				.ll-feed-list {
					max-height: 480px; overflow-y: auto;
					border: 1px solid var(--border-color);
					border-radius: 12px;
				}
				.ll-feed-row { padding: 12px 16px; border-bottom: 1px solid var(--border-color); }
				.ll-feed-row:last-child { border-bottom: none; }
				.ll-feed-row.ll-new { animation: ll-row-in 0.5s ease-out; }
				@keyframes ll-row-in {
					0% { opacity: 0; transform: translateY(-8px); background: var(--ll-green-bg); }
					100% { opacity: 1; transform: translateY(0); background: transparent; }
				}
				.ll-feed-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
				.ll-feed-voucher { font-weight: 600; flex: 1 1 auto; min-width: 0; }
				.ll-feed-voucher a { word-break: break-word; }
				.ll-feed-row.is-cancelled { opacity: 0.7; }
				.ll-badge-cancelled {
					display: inline-block; margin-left: 8px;
					font-size: 11px; font-weight: 600; padding: 1px 6px;
					border-radius: 4px; background: var(--bg-light-gray, #f0f0f0);
					color: var(--text-muted); text-transform: uppercase;
				}
				.ll-feed-expand {
					flex: 0 0 auto; width: 27px; height: 27px;
					border: 1px solid var(--border-color); border-radius: 7px;
					background: transparent; color: var(--text-muted); cursor: pointer;
					display: inline-flex; align-items: center; justify-content: center;
					transition: color 0.12s ease, border-color 0.12s ease, background 0.12s ease;
				}
				.ll-feed-expand:hover {
					color: var(--text-color);
					background: color-mix(in srgb, var(--text-muted) 8%, transparent);
				}
				.ll-feed-expand[aria-expanded="true"] {
					color: var(--ll-accent); border-color: var(--ll-accent);
				}
				.ll-feed-expand .ll-chev { transition: transform 0.2s ease; }
				.ll-feed-expand[aria-expanded="true"] .ll-chev { transform: rotate(180deg); }

				.ll-feed-line {
					display: flex; gap: 8px; align-items: baseline;
					font-size: var(--text-sm); color: var(--text-color); padding: 1px 0;
				}
				.ll-tag {
					display: inline-block; min-width: 26px; text-align: center;
					font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 4px;
					background: var(--bg-light-gray, #f0f0f0); color: var(--text-muted);
				}
				.ll-tag.up { background: var(--ll-green-bg); color: var(--ll-green); }
				.ll-tag.down { background: var(--ll-red-bg); color: var(--ll-red); }
				.ll-feed-acct { flex: 1 1 auto; word-break: break-word; }
				.ll-feed-amt { font-variant-numeric: tabular-nums; }
				.ll-feed-empty { padding: 16px; color: var(--text-muted); }

				/* Expandable per-line teaching panel (grid-rows collapse trick). */
				.ll-teach-wrap {
					display: grid; grid-template-rows: 0fr;
					transition: grid-template-rows 0.22s ease;
				}
				.ll-teach-wrap.open { grid-template-rows: 1fr; }
				.ll-teach-inner { overflow: hidden; min-height: 0; }
				.ll-teach {
					margin-top: 10px; padding: 12px 14px; border-radius: 9px;
					background: color-mix(in srgb, var(--ll-accent) 5%, var(--card-bg, var(--fg-color)));
					border: 1px solid color-mix(in srgb, var(--ll-accent) 16%, var(--border-color));
				}
				.ll-teach-summary {
					font-size: var(--text-sm); color: var(--text-color);
					font-style: italic; margin-bottom: 8px;
				}
				.ll-teach-line {
					display: flex; gap: 9px; align-items: baseline;
					font-size: var(--text-sm); color: var(--text-color); padding: 3px 0;
				}
				.ll-teach-dot {
					width: 6px; height: 6px; border-radius: 50%; flex: 0 0 auto;
					transform: translateY(-1px);
				}
				.ll-teach-line.up .ll-teach-dot { background: var(--ll-green); }
				.ll-teach-line.down .ll-teach-dot { background: var(--ll-red); }

				/* Drill-down dialog (rendered outside .ll-wrap, so explicit tokens). */
				.ll-bd-scope { color: var(--text-muted); font-size: var(--text-sm); margin-bottom: 8px; }
				.ll-bd-row {
					display: flex; justify-content: space-between; gap: 12px;
					padding: 8px 2px; border-bottom: 1px solid var(--border-color);
				}
				.ll-bd-row:last-child { border-bottom: none; }
				.ll-bd-acct { flex: 1 1 auto; }
				.ll-bd-amt { font-variant-numeric: tabular-nums; font-weight: 600; }
				.ll-bd-amt.down { color: var(--ll-red, #dc2626); }
				.ll-bd-total {
					font-weight: 700; border-top: 2px solid var(--border-color);
					border-bottom: none; margin-top: 4px; padding-top: 10px;
				}
				.ll-bd-empty { padding: 12px 2px; color: var(--text-muted); }

				@media (prefers-reduced-motion: reduce) {
					.ll-teach-wrap { transition: none; }
					.ll-feed-expand .ll-chev { transition: none; }
					.ll-feed-row.ll-new { animation: none; }
				}
			</style>
			<div class="ll-wrap">
				<div class="ll-toolbar">
					<div class="ll-scope" role="tablist" aria-label="${__("Time scope")}">
						<button class="ll-scope-tab active" data-scope="fy" role="tab">${__("This Fiscal Year")}</button>
						<button class="ll-scope-tab" data-scope="all" role="tab">${__("All Time")}</button>
					</div>
				</div>

				<div class="ll-equation">
					<div class="ll-eq-kicker">${__("The Accounting Equation")}</div>
					<div class="ll-eq-main">
						${eqterm("Asset", __("Assets"))}
						<span class="ll-eq-op">=</span>
						${eqterm("Liability", __("Liabilities"))}
						<span class="ll-eq-op">+</span>
						${eqterm("Equity", __("Equity"))}
						<span class="ll-eq-op">+</span>
						${eqterm("NetProfit", __("Net Profit"))}
						<span class="ll-eq-status" data-eq-status></span>
					</div>
					<div class="ll-eq-sub">
						${__("Net Profit")} = ${__("Income")} <span class="ll-num" data-num="Income">—</span> − ${__(
			"Expense"
		)} <span class="ll-num" data-num="Expense">—</span>
					</div>
				</div>

				<div class="ll-section bs">
					<div class="ll-section-head">
						<span class="ll-section-dot"></span>
						<span class="ll-section-title">${__("Balance Sheet")}</span>
					</div>
					<div class="ll-section-body">
						${box("Asset", __("Assets"), "bs")}
						${box("Liability", __("Liabilities"), "bs")}
						${box("Equity", __("Equity"), "bs")}
					</div>
				</div>

				<div class="ll-section pl">
					<div class="ll-section-head">
						<span class="ll-section-dot"></span>
						<span class="ll-section-title">${__("Profit & Loss")}</span>
					</div>
					<div class="ll-section-body">
						${box("Income", __("Income"), "pl")}
						${box("Expense", __("Expense"), "pl")}
						${box("NetProfit", __("Net Profit"), "pl")}
					</div>
				</div>

				<div class="ll-feed">
					<div class="ll-feed-head-row">
						<span class="ll-section-dot"></span>
						<span class="ll-feed-title">${__("Recent Transactions")}</span>
					</div>
					<div class="ll-feed-list"></div>
				</div>
			</div>
		`).appendTo(this.page.main);

		this.$feed = this.page.main.find(".ll-feed-list");
	}

	setup_controls() {
		// Company picker (Desk Link field in the page header).
		this.company_field = this.page.add_field({
			fieldname: "company",
			label: __("Company"),
			fieldtype: "Link",
			options: "Company",
			change: () => {
				const val = this.company_field.get_value();
				if (val && val !== this.company) {
					this.company = val;
					this.reload();
				}
			},
		});
		if (this.company) this.company_field.set_value(this.company);

		// Scope tabs: This Fiscal Year / All Time.
		// (sync_company_field below keeps the picker honest once the server
		// echoes the authoritatively-resolved company.)
		this.page.main.find(".ll-scope-tab").on("click", (e) => {
			const scope = e.currentTarget.getAttribute("data-scope");
			if (scope === this.scope) return;
			this.scope = scope;
			this.page.main
				.find(".ll-scope-tab")
				.toggleClass("active", false)
				.filter(`[data-scope="${scope}"]`)
				.toggleClass("active", true);
			this.reload();
		});

		// Drill-down: click (or Enter/Space) a root-type box to see its accounts.
		const $boxes = this.page.main.find(".ll-box.ll-clickable");
		$boxes.on("click", (e) => this.open_breakdown(e.currentTarget.getAttribute("data-root")));
		$boxes.on("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				this.open_breakdown(e.currentTarget.getAttribute("data-root"));
			}
		});

		// Feed: expand/collapse the per-line teaching panel (delegated, so it
		// survives the feed being re-rendered on reload).
		this.$feed.on("click", ".ll-feed-expand", (e) => {
			const btn = e.currentTarget;
			const wrap = document.getElementById(btn.getAttribute("aria-controls"));
			if (!wrap) return;
			const open = btn.getAttribute("aria-expanded") === "true";
			btn.setAttribute("aria-expanded", String(!open));
			wrap.classList.toggle("open", !open);
			wrap.setAttribute("aria-hidden", String(open));
		});
	}

	// Open the account-breakdown dialog for one root-type box, honoring the
	// active company + scope. Figures reconcile to the box total.
	open_breakdown(root) {
		if (!root || root === "NetProfit") return;
		const label = LL_LABELS[root] || root;
		frappe.call({
			method: "ledger_lab.api.dashboard.get_account_breakdown",
			args: { company: this.company, root_type: root, scope: this.scope },
			callback: (r) => {
				const rows = r.message || [];
				const scope_label = this.scope === "all" ? __("All Time") : __("This Fiscal Year");
				// Reuse one dialog instance so repeated drill-downs don't leave
				// orphaned (hidden) modals accumulating in the DOM.
				if (!this.breakdown_dialog) {
					this.breakdown_dialog = new frappe.ui.Dialog({ size: "small" });
				}
				const d = this.breakdown_dialog;
				d.set_title(__("{0} — account breakdown", [label]));
				d.$body.html(
					`<div class="ll-bd-scope">${frappe.utils.escape_html(
						this.company
					)} · ${scope_label}</div>` + this.render_breakdown(rows)
				);
				d.show();
			},
		});
	}

	render_breakdown(rows) {
		if (!rows.length) {
			return `<div class="ll-bd-empty">${__("No account activity in this scope.")}</div>`;
		}
		const total = rows.reduce((s, a) => s + flt(a.balance), 0);
		const body = rows
			.map((a) => {
				const neg = flt(a.balance) < 0;
				return `
					<div class="ll-bd-row">
						<a class="ll-bd-acct" href="${this.gl_url(a.account)}">${frappe.utils.escape_html(a.account)}</a>
						<span class="ll-bd-amt ${neg ? "down" : ""}">${format_currency(a.balance, this.currency)}</span>
					</div>`;
			})
			.join("");
		return `
			${body}
			<div class="ll-bd-row ll-bd-total">
				<span class="ll-bd-acct">${__("Total")}</span>
				<span class="ll-bd-amt">${format_currency(total, this.currency)}</span>
			</div>`;
	}

	// Link to the General Ledger query report filtered to this account + company,
	// bounded by the active scope's dates (all-time uses a wide range).
	gl_url(account) {
		const { start, end } = this.date_range || {};
		const params = new URLSearchParams({
			company: this.company || "",
			account: account,
			from_date: start || "2000-01-01",
			to_date: end || frappe.datetime.get_today(),
		});
		return `/app/query-report/${encodeURIComponent("General Ledger")}?${params.toString()}`;
	}

	// Re-scope: authoritative refetch + feed reseed, no animation. Clears sticky
	// impact badges (a fresh scope has no "last impact" yet). Same path the
	// Refresh action drives.
	reload() {
		this.refresh();
		this.load_feed();
	}

	// Point the picker at the server-resolved company without re-triggering a
	// reload (the change handler no-ops when the value already matches
	// this.company, which refresh() sets just before calling this).
	sync_company_field() {
		if (!this.company_field || !this.company) return;
		if (this.company_field.get_value() !== this.company) {
			this.company_field.set_value(this.company);
		}
	}

	bind_realtime() {
		frappe.realtime.off("ledger_lab_gl_posted");
		frappe.realtime.on("ledger_lab_gl_posted", (data) => {
			if (!data) return;
			if (this.company && data.company && data.company !== this.company) {
				return;
			}
			// FY scope: ignore postings dated outside the active fiscal year so a
			// prior/future-dated voucher doesn't flash boxes it doesn't belong to.
			if (!this.in_scope(data.posting_date)) return;
			this.apply_event(data);
			this.prepend_feed_row(data);
		});
	}

	// Is a posting_date within the active scope's date range? "All Time" (null
	// bounds) admits everything. ISO "YYYY-MM-DD" strings compare lexically.
	in_scope(posting_date) {
		const { start, end } = this.date_range || {};
		if (!start && !end) return true;
		if (!posting_date) return true;
		if (start && posting_date < start) return false;
		if (end && posting_date > end) return false;
		return true;
	}

	// Authoritative reload from the server; paints instantly (no animation).
	refresh() {
		frappe.call({
			method: "ledger_lab.api.dashboard.get_balances",
			args: { company: this.company, scope: this.scope },
			callback: (r) => {
				if (!r.message) return;
				this.company = r.message.company;
				// Reflect the server-resolved company in the picker. Handles the
				// case where the client-side default was empty or stale (pointing
				// at a company that no longer exists): the box loads data for the
				// real fallback company, so the picker should show it too.
				this.sync_company_field();
				this.currency = r.message.currency;
				this.date_range = r.message.date_range || { start: null, end: null };
				const b = r.message.boxes || {};
				LL_ROOT_TYPES.forEach((rt) => (this.boxes[rt] = flt(b[rt])));
				this.paint_instant();
			},
		});
	}

	paint_instant() {
		// Authoritative repaint clears the per-box "last impact" — the new scope
		// hasn't seen any live events yet.
		this.lastImpact = {};
		LL_ALL_BOXES.forEach((root) => this.render_impact(root));

		const values = {
			...this.boxes,
			NetProfit: this.boxes.Income - this.boxes.Expense,
		};
		Object.keys(values).forEach((root) => {
			this.displayed[root] = values[root];
			this.page.main
				.find(`[data-num="${root}"]`)
				.text(format_currency(values[root], this.currency));
		});
		this.update_equation();
	}

	apply_event(data) {
		const deltas = { Asset: 0, Liability: 0, Equity: 0, Income: 0, Expense: 0 };
		(data.lines || []).forEach((line) => {
			if (!(line.root_type in deltas)) return;
			deltas[line.root_type] += ll_line_delta(line.root_type, line.debit, line.credit);
		});

		LL_ROOT_TYPES.forEach((rt) => {
			if (Math.abs(deltas[rt]) < 0.005) return;
			const from = this.displayed[rt];
			const to = from + deltas[rt];
			this.boxes[rt] = to;
			this.animate_num(rt, from, to);
			this.flash_box(rt, deltas[rt] > 0);
			this.set_impact(rt, deltas[rt], data);
		});

		// Net Profit is derived: Income − Expense.
		const npFrom = this.displayed.NetProfit;
		const npTo = this.boxes.Income - this.boxes.Expense;
		if (Math.abs(npTo - npFrom) >= 0.005) {
			this.animate_num("NetProfit", npFrom, npTo);
			this.flash_box("NetProfit", npTo > npFrom);
			this.set_impact("NetProfit", npTo - npFrom, data);
		}

		this.update_equation();
	}

	update_equation() {
		// Assets = Liabilities + Equity + Net Profit  (profit not yet closed to equity)
		const net_profit = this.boxes.Income - this.boxes.Expense;
		const lhs = this.boxes.Asset;
		const rhs = this.boxes.Liability + this.boxes.Equity + net_profit;
		const balanced = Math.abs(lhs - rhs) < 0.005;
		const $status = this.page.main.find("[data-eq-status]");
		$status
			.text(
				balanced
					? "✓ " + __("Balanced")
					: "⚠ " + __("Off by {0}", [format_currency(lhs - rhs, this.currency)])
			)
			.toggleClass("ok", balanced)
			.toggleClass("warn", !balanced);
	}

	animate_num(root, from, to) {
		const els = this.page.main.find(`[data-num="${root}"]`);
		const cur = this.currency;
		if (ll_reduced_motion() || from === to) {
			els.text(format_currency(to, cur));
			this.displayed[root] = to;
			return;
		}
		this.displayed[root] = to;
		const start = performance.now();
		const step = (now) => {
			const t = Math.min(1, (now - start) / LL_ANIM_MS);
			const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
			els.text(format_currency(from + (to - from) * eased, cur));
			if (t < 1) requestAnimationFrame(step);
			else els.text(format_currency(to, cur));
		};
		requestAnimationFrame(step);
	}

	flash_box(root, up) {
		if (ll_reduced_motion()) return;
		const el = this.page.main.find(`.ll-box[data-root="${root}"]`).get(0);
		if (!el) return;
		const cls = up ? "flash-up" : "flash-down";
		el.classList.remove("flash-up", "flash-down");
		void el.offsetWidth; // restart the animation
		el.classList.add(cls);
		setTimeout(() => el.classList.remove(cls), LL_FLASH_MS + 50);
	}

	// Record the most recent event that moved this box and render its persistent
	// badge. Renders regardless of reduced motion — it's information, not motion.
	set_impact(root, delta, data) {
		this.lastImpact[root] = {
			delta,
			voucher_type: data.voucher_type,
			voucher_no: data.voucher_no,
			cancelled: !!data.is_cancelled,
			ts: Date.now(),
		};
		this.render_impact(root);
	}

	render_impact(root) {
		const $el = this.page.main.find(`.ll-box-impact[data-impact="${root}"]`);
		if (!$el.length) return;
		const imp = this.lastImpact[root];
		if (!imp) {
			$el.empty();
			return;
		}
		const up = imp.delta >= 0;
		const amount = format_currency(Math.abs(imp.delta), this.currency);
		const src = imp.voucher_no
			? __("from {0} {1}", [__(imp.voucher_type), imp.voucher_no])
			: "";
		const caption = [src, ll_rel_time(imp.ts)].filter(Boolean).join(" · ");
		$el.html(`
			<span class="ll-impact-delta ${up ? "up" : "down"}">${up ? "▲" : "▼"} ${
			up ? "+" : "−"
		}${amount}</span>
			<span class="ll-impact-cap">${frappe.utils.escape_html(caption)}</span>
		`);
	}

	// Refresh just the relative-time captions on the sticky badges.
	tick_impact_times() {
		Object.keys(this.lastImpact).forEach((root) => this.render_impact(root));
	}

	load_feed() {
		frappe.call({
			method: "ledger_lab.api.dashboard.get_recent_vouchers",
			args: { company: this.company, limit: 15, scope: this.scope },
			callback: (r) => {
				this.$feed.empty();
				const vouchers = r.message || [];
				if (!vouchers.length) {
					this.$feed.append(
						`<div class="ll-feed-empty">${__("No transactions yet.")}</div>`
					);
					return;
				}
				vouchers.forEach((v) => this.$feed.append(this.render_feed_row(v)));
			},
		});
	}

	prepend_feed_row(voucher) {
		if (!voucher || !voucher.voucher_no) return;
		this.$feed.find(".ll-feed-empty").remove();
		const $row = $(this.render_feed_row(voucher));
		if (!ll_reduced_motion()) $row.addClass("ll-new");
		this.$feed.prepend($row);
	}

	render_feed_row(voucher) {
		const url = `/app/${frappe.router.slug(voucher.voucher_type)}/${encodeURIComponent(
			voucher.voucher_no
		)}`;
		const title = `${__(voucher.voucher_type)} ${frappe.utils.escape_html(
			voucher.voucher_no
		)}`;
		const cancelled = !!voucher.is_cancelled;
		const badge = cancelled
			? `<span class="ll-badge-cancelled">${__("Cancelled")}</span>`
			: "";

		const lines = (voucher.lines || [])
			.map((line) => {
				const is_debit = flt(line.debit) > 0;
				const tag = is_debit ? __("Dr") : __("Cr");
				const amount = format_currency(is_debit ? line.debit : line.credit, this.currency);
				// Color by whether this line increased (green) or decreased (red)
				// its own account's natural balance.
				const up = ll_line_delta(line.root_type, line.debit, line.credit) >= 0;
				const dir = up ? "up" : "down";
				return `
					<div class="ll-feed-line">
						<span class="ll-tag ${dir}">${tag}</span>
						<span class="ll-feed-acct">${frappe.utils.escape_html(line.account)}</span>
						<span class="ll-feed-amt">${amount}</span>
					</div>`;
			})
			.join("");

		const teach_id = `ll-teach-${++this._seq}`;
		const teach = this.render_teach(voucher);

		return `
			<div class="ll-feed-row ${
				cancelled ? "is-cancelled" : ""
			}" data-voucher="${frappe.utils.escape_html(voucher.voucher_no)}">
				<div class="ll-feed-head">
					<div class="ll-feed-voucher"><a href="${url}">${title}</a>${badge}</div>
					<button class="ll-feed-expand" aria-expanded="false" aria-controls="${teach_id}"
						aria-label="${__("Explain this transaction")}" title="${__("Explain this transaction")}">
						<svg class="ll-chev" width="14" height="14" viewBox="0 0 24 24" fill="none"
							stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
							<polyline points="6 9 12 15 18 9"></polyline>
						</svg>
					</button>
				</div>
				<div class="ll-feed-lines">${lines}</div>
				<div class="ll-teach-wrap" id="${teach_id}" aria-hidden="true">
					<div class="ll-teach-inner">${teach}</div>
				</div>
			</div>`;
	}

	// Plain-English teaching panel: an optional voucher-type summary plus, for
	// each line, "{Account} ({Root Type}) increased|decreased by {amount}".
	render_teach(voucher) {
		const cancelled = !!voucher.is_cancelled;
		let summary = "";
		if (cancelled) {
			summary = __(
				"This entry was cancelled — the lines below reverse its original effect."
			);
		} else if (LL_VOUCHER_SUMMARY[voucher.voucher_type]) {
			summary = LL_VOUCHER_SUMMARY[voucher.voucher_type];
		}
		const summary_html = summary
			? `<div class="ll-teach-summary">${frappe.utils.escape_html(summary)}</div>`
			: "";

		const lines = (voucher.lines || [])
			.map((line) => {
				const delta = ll_line_delta(line.root_type, line.debit, line.credit);
				const up = delta >= 0;
				const gross = flt(line.debit) > 0 ? line.debit : line.credit;
				const dir = up ? __("increased") : __("decreased");
				// Single i18n template with root-type & direction as interpolated
				// tokens so translations stay grammatical. Account is pre-escaped;
				// direction is wrapped in <strong>; amount comes from format_currency.
				const clause = __("{0} ({1}) {2} by {3}", [
					frappe.utils.escape_html(line.account),
					__(line.root_type || ""),
					`<strong>${dir}</strong>`,
					format_currency(Math.abs(gross), this.currency),
				]);
				return `
					<div class="ll-teach-line ${up ? "up" : "down"}">
						<span class="ll-teach-dot"></span>
						<span>${clause}</span>
					</div>`;
			})
			.join("");

		return `<div class="ll-teach">${summary_html}${lines}</div>`;
	}
}
