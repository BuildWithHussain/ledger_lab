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
const LL_DEBIT_NORMAL = new Set(["Asset", "Expense"]);
const LL_LABELS = {
	Asset: __("Assets"),
	Liability: __("Liabilities"),
	Equity: __("Equity"),
	Income: __("Income"),
	Expense: __("Expense"),
};
const LL_ANIM_MS = 450;

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
		this.render_skeleton();
		this.setup_controls();
		this.bind_realtime();
		this.refresh();
		this.load_feed();
	}

	render_skeleton() {
		// All boxes except the derived Net Profit are clickable to reveal the
		// constituent accounts of that root type (phase 5 drill-down).
		const box = (root, label) => {
			const clickable = root !== "NetProfit";
			return `
			<div class="ll-box ${clickable ? "ll-clickable" : ""}" data-root="${root}"${
				clickable ? ' role="button" tabindex="0"' : ""
			}>
				<div class="ll-box-label">${label}</div>
				<div class="ll-box-value"><span class="ll-num" data-num="${root}">—</span></div>
				<div class="ll-box-delta"></div>
				${clickable ? `<div class="ll-box-hint">${__("View accounts")} →</div>` : ""}
			</div>`;
		};

		const num = (root) => `<span class="ll-num" data-num="${root}">—</span>`;

		$(`
			<style>
				.ll-equation {
					border: 1px solid var(--border-color);
					border-radius: var(--border-radius-lg, 8px);
					padding: 16px 20px; margin: 12px 0 4px;
					background: var(--card-bg, var(--fg-color));
				}
				.ll-eq-main {
					display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
					font-size: 16px;
				}
				.ll-eq-main .ll-num { font-weight: 700; }
				.ll-eq-op { color: var(--text-muted); font-weight: 600; padding: 0 2px; }
				.ll-eq-t { color: var(--text-color); }
				.ll-eq-status { margin-left: auto; font-weight: 700; font-size: 14px; }
				.ll-eq-status.ok { color: var(--ll-green); }
				.ll-eq-status.warn { color: var(--ll-red); }
				.ll-eq-sub { color: var(--text-muted); font-size: var(--text-sm); margin-top: 6px; }

				.ll-section-title {
					font-size: var(--text-sm); color: var(--text-muted);
					text-transform: uppercase; letter-spacing: 0.04em;
					margin: 18px 0 6px;
				}
				.ll-grid { display: flex; gap: 12px; flex-wrap: wrap; }
				.ll-box {
					flex: 1 1 160px; min-width: 160px; position: relative; overflow: hidden;
					border: 1px solid var(--border-color);
					border-radius: var(--border-radius-lg, 8px);
					padding: 20px; background: var(--card-bg, var(--fg-color));
				}
				.ll-box-label {
					font-size: var(--text-sm); color: var(--text-muted);
					text-transform: uppercase; letter-spacing: 0.04em;
				}
				.ll-box-value {
					font-size: 24px; font-weight: 600; margin-top: 8px;
					color: var(--text-color); font-variant-numeric: tabular-nums;
				}
				.ll-box.ll-clickable { cursor: pointer; transition: border-color 0.12s ease; }
				.ll-box.ll-clickable:hover { border-color: var(--text-muted); }
				.ll-box.ll-clickable:focus-visible { outline: 2px solid var(--text-muted); outline-offset: 1px; }
				.ll-box-hint {
					margin-top: 10px; font-size: 11px; font-weight: 600;
					text-transform: uppercase; letter-spacing: 0.04em;
					color: var(--text-muted); opacity: 0; transition: opacity 0.12s ease;
				}
				.ll-box.ll-clickable:hover .ll-box-hint,
				.ll-box.ll-clickable:focus-visible .ll-box-hint { opacity: 1; }
				.ll-box-delta {
					position: absolute; top: 14px; right: 16px;
					font-size: var(--text-sm); font-weight: 600;
					opacity: 0; transform: translateY(-4px);
				}
				.ll-box-delta.show { animation: ll-delta-pop 1.6s ease-out forwards; }
				.ll-box-delta.up { color: var(--ll-green); }
				.ll-box-delta.down { color: var(--ll-red); }
				@keyframes ll-delta-pop {
					0% { opacity: 0; transform: translateY(-4px); }
					15% { opacity: 1; transform: translateY(0); }
					70% { opacity: 1; transform: translateY(0); }
					100% { opacity: 0; transform: translateY(-4px); }
				}
				.ll-box.flash-up { animation: ll-flash-up 0.9s ease-out; }
				.ll-box.flash-down { animation: ll-flash-down 0.9s ease-out; }
				@keyframes ll-flash-up {
					0% { background: var(--ll-green-bg); box-shadow: inset 0 0 0 2px var(--ll-green); }
					100% { background: var(--card-bg, var(--fg-color)); box-shadow: none; }
				}
				@keyframes ll-flash-down {
					0% { background: var(--ll-red-bg); box-shadow: inset 0 0 0 2px var(--ll-red); }
					100% { background: var(--card-bg, var(--fg-color)); box-shadow: none; }
				}

				.ll-feed { margin-top: 24px; }
				.ll-feed-title {
					font-size: var(--text-sm); color: var(--text-muted);
					text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 8px;
				}
				.ll-feed-list {
					max-height: 460px; overflow-y: auto;
					border: 1px solid var(--border-color);
					border-radius: var(--border-radius-lg, 8px);
				}
				.ll-feed-row { padding: 12px 16px; border-bottom: 1px solid var(--border-color); }
				.ll-feed-row:last-child { border-bottom: none; }
				.ll-feed-row.ll-new { animation: ll-row-in 0.5s ease-out; }
				@keyframes ll-row-in {
					0% { opacity: 0; transform: translateY(-8px); background: var(--ll-green-bg); }
					100% { opacity: 1; transform: translateY(0); background: transparent; }
				}
				.ll-feed-voucher { font-weight: 600; margin-bottom: 6px; }
				.ll-feed-row.is-cancelled { opacity: 0.7; }
				.ll-badge-cancelled {
					display: inline-block; margin-left: 8px;
					font-size: 11px; font-weight: 600; padding: 1px 6px;
					border-radius: 4px; background: var(--bg-light-gray, #f0f0f0);
					color: var(--text-muted); text-transform: uppercase;
				}
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
				.ll-feed-acct { flex: 1 1 auto; }
				.ll-feed-amt { font-variant-numeric: tabular-nums; }
				.ll-feed-empty { padding: 16px; color: var(--text-muted); }

				/* Drill-down dialog (rendered outside .ll-wrap, so explicit colors). */
				.ll-bd-row {
					display: flex; justify-content: space-between; gap: 12px;
					padding: 8px 2px; border-bottom: 1px solid var(--border-color);
				}
				.ll-bd-row:last-child { border-bottom: none; }
				.ll-bd-acct { flex: 1 1 auto; }
				.ll-bd-amt { font-variant-numeric: tabular-nums; font-weight: 600; }
				.ll-bd-amt.down { color: #dc2626; }
				.ll-bd-total {
					font-weight: 700; border-top: 2px solid var(--border-color);
					border-bottom: none; margin-top: 4px; padding-top: 10px;
				}
				.ll-bd-empty { padding: 12px 2px; color: var(--text-muted); }

				.ll-scope {
					display: inline-flex; gap: 0; margin: 4px 0 0;
					border: 1px solid var(--border-color);
					border-radius: var(--border-radius, 6px); overflow: hidden;
				}
				.ll-scope-tab {
					border: none; background: transparent; cursor: pointer;
					padding: 6px 14px; font-size: var(--text-sm); font-weight: 500;
					color: var(--text-muted); border-right: 1px solid var(--border-color);
				}
				.ll-scope-tab:last-child { border-right: none; }
				.ll-scope-tab:hover { color: var(--text-color); }
				.ll-scope-tab.active {
					background: var(--control-bg, var(--bg-light-gray, #f0f0f0));
					color: var(--text-color); font-weight: 600;
				}

				.ll-wrap {
					--ll-green: #16a34a; --ll-red: #dc2626;
					--ll-green-bg: rgba(34, 197, 94, 0.16);
					--ll-red-bg: rgba(239, 68, 68, 0.16);
				}
			</style>
			<div class="ll-wrap">
				<div class="ll-scope" role="tablist">
					<button class="ll-scope-tab active" data-scope="fy" role="tab">${__("This Fiscal Year")}</button>
					<button class="ll-scope-tab" data-scope="all" role="tab">${__("All Time")}</button>
				</div>
				<div class="ll-equation">
					<div class="ll-eq-main">
						<span class="ll-eq-t">${__("Assets")} ${num("Asset")}</span>
						<span class="ll-eq-op">=</span>
						<span class="ll-eq-t">${__("Liabilities")} ${num("Liability")}</span>
						<span class="ll-eq-op">+</span>
						<span class="ll-eq-t">${__("Equity")} ${num("Equity")}</span>
						<span class="ll-eq-op">+</span>
						<span class="ll-eq-t">${__("Net Profit")} ${num("NetProfit")}</span>
						<span class="ll-eq-status" data-eq-status></span>
					</div>
					<div class="ll-eq-sub">
						${__("Net Profit")} = ${__("Income")} ${num("Income")} − ${__("Expense")} ${num("Expense")}
					</div>
				</div>

				<div class="ll-section-title">${__("Balance Sheet")}</div>
				<div class="ll-grid">
					${box("Asset", __("Assets"))}
					${box("Liability", __("Liabilities"))}
					${box("Equity", __("Equity"))}
				</div>

				<div class="ll-section-title">${__("Profit & Loss")}</div>
				<div class="ll-grid">
					${box("Income", __("Income"))}
					${box("Expense", __("Expense"))}
					${box("NetProfit", __("Net Profit"))}
				</div>

				<div class="ll-feed">
					<div class="ll-feed-title">${__("Recent Transactions")}</div>
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
					`<div class="ll-bd-scope" style="color:var(--text-muted);font-size:var(--text-sm);margin-bottom:8px;">${frappe.utils.escape_html(
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
						<a class="ll-bd-acct" href="${this.gl_url(a.account)}">${frappe.utils.escape_html(
							a.account
						)}</a>
						<span class="ll-bd-amt ${neg ? "down" : ""}">${format_currency(
							a.balance,
							this.currency
						)}</span>
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

	// Re-scope: authoritative refetch + feed reseed, no animation. Used on
	// company/scope change (and the same path the Refresh action drives).
	reload() {
		this.refresh();
		this.load_feed();
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
				this.currency = r.message.currency;
				this.date_range = r.message.date_range || { start: null, end: null };
				const b = r.message.boxes || {};
				LL_ROOT_TYPES.forEach((rt) => (this.boxes[rt] = flt(b[rt])));
				this.paint_instant();
			},
		});
	}

	paint_instant() {
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
			this.show_delta(rt, deltas[rt]);
		});

		// Net Profit is derived: Income − Expense.
		const npFrom = this.displayed.NetProfit;
		const npTo = this.boxes.Income - this.boxes.Expense;
		if (Math.abs(npTo - npFrom) >= 0.005) {
			this.animate_num("NetProfit", npFrom, npTo);
			this.flash_box("NetProfit", npTo > npFrom);
			this.show_delta("NetProfit", npTo - npFrom);
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
			.text(balanced ? "✓ " + __("Balanced") : "⚠ " + __("Off by {0}", [format_currency(lhs - rhs, this.currency)]))
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
		setTimeout(() => el.classList.remove(cls), 950);
	}

	show_delta(root, delta) {
		if (ll_reduced_motion()) return;
		const chip = this.page.main.find(`.ll-box[data-root="${root}"] .ll-box-delta`).get(0);
		if (!chip) return;
		const up = delta > 0;
		chip.textContent = (up ? "+" : "−") + format_currency(Math.abs(delta), this.currency);
		chip.className = "ll-box-delta " + (up ? "up" : "down");
		void chip.offsetWidth;
		chip.classList.add("show");
		setTimeout(() => chip.classList.remove("show"), 1650);
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
		const title = `${__(voucher.voucher_type)} ${frappe.utils.escape_html(voucher.voucher_no)}`;
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

		return `
			<div class="ll-feed-row ${cancelled ? "is-cancelled" : ""}" data-voucher="${frappe.utils.escape_html(
				voucher.voucher_no
			)}">
				<div class="ll-feed-voucher">
					<a href="${url}">${title}</a>${badge}
				</div>
				${lines}
			</div>`;
	}
}
