document.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  btn.classList.add("is-busy");
  clearTimeout(btn._t);
  btn._t = setTimeout(() => btn.classList.remove("is-busy"), 650);
}, true);

const toast = document.createElement("div");
toast.id = "sayinToast";
toast.innerHTML = '<span class="sayin-dot"></span><span id="sayinToastMsg"></span>';
document.addEventListener("DOMContentLoaded", () => document.body.appendChild(toast));

let hideTimer;
window.showSayinToast = function(msg, tone) {
  if (!msg) return;
  const s = String(msg).toLowerCase();
  const kind = tone || (/fail|error|invalid|unauthor|not found|required/.test(s) ? "error" : /sent|saved|updated|synced|success|created/.test(s) ? "success" : "info");
  toast.setAttribute("data-tone", kind);
  const el = document.getElementById("sayinToastMsg");
  if (el) el.textContent = String(msg);
  toast.classList.add("show");
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => toast.classList.remove("show"), 3500);
};

new MutationObserver((muts) => {
  for (const m of muts) {
    const target = m.target.nodeType === 1 ? m.target : m.target.parentElement;
    if (!target || target.id === "sayinToast" || target.closest("#sayinToast")) continue;
    const txt = (target.textContent || "").trim();
    if (txt && txt.length < 180 && target.children.length === 0) window.showSayinToast(txt);
  }
}).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
document.addEventListener("pointerdown", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  b.style.outline = "2px solid rgba(129, 140, 248, 0.65)";
  setTimeout(() => { b.style.outline = ""; }, 220);
}, true);
(function initSayinSuite() {
  const num = (v) => Number(String(v || 0).replace(/[^0-9.-]/g, "")) || 0;

  // 1. Align Category "+" button beside Category input/select cleanly
  function alignCategoryPlus() {
    document.querySelectorAll("button").forEach((b) => {
      if (b.textContent.trim() !== "+" || b.dataset.sayinAligned) return;
      const prev = b.previousElementSibling;
      const parent = b.parentElement;
      if (prev && (prev.tagName === "SELECT" || prev.tagName === "INPUT") && !prev.closest("table")) {
        const wrap = document.createElement("div");
        wrap.className = "sayin-field-row";
        parent.insertBefore(wrap, prev);
        wrap.appendChild(prev);
        wrap.appendChild(b);
        b.classList.add("sayin-mini-btn");
        b.dataset.sayinAligned = "1";
      }
    });
  }

  // 2. Render Visual Bar Chart (Income vs Expense + Top Categories from existing tables/cards)
  function renderVisualAnalytics() {
    if (document.querySelector("table")) {
      // Nothing to block
    }
    let host = document.getElementById("sayinAnalyticsCard");
    const tables = Array.from(document.querySelectorAll("table"));
    if (!tables.length) return;

    if (!host) {
      host = document.createElement("div");
      host.id = "sayinAnalyticsCard";
      host.className = "card";
      host.style.marginTop = "18px";
      host.innerHTML = '<h3 style="margin:0 0 12px;">Sayin Visual Insights</h3><div class="grid-2" id="sayinChartGrid"></div>';
      tables[0].closest(".card")?.parentElement?.insertBefore(host, tables[0].closest(".card")) || document.body.appendChild(host);
    }

    // Read summary totals from page text if present
    let inc = 0, exp = 0;
    document.querySelectorAll(".card, div").forEach((el) => {
      if (el.children.length <= 3) {
        const t = el.textContent || "";
        if (/income/i.test(t) && /mmk/i.test(t) && !inc) inc = num(t.replace(/income/i, ""));
        if (/expense/i.test(t) && /mmk/i.test(t) && !exp) exp = num(t.replace(/expense/i, ""));
      }
    });
    const maxIO = Math.max(inc, exp, 1);

    // Read category rows if a table has Category & Total columns
    const catMap = new Map();
    tables.forEach((tbl) => {
      const headers = Array.from(tbl.querySelectorAll("th")).map((h) => h.textContent.trim().toLowerCase());
      const cIdx = headers.findIndex((h) => h.includes("category"));
      const aIdx = headers.findIndex((h) => h.includes("total") || h.includes("amount"));
      if (cIdx >= 0 && aIdx >= 0) {
        tbl.querySelectorAll("tbody tr").forEach((tr) => {
          const cells = tr.querySelectorAll("td");
          if (cells.length > Math.max(cIdx, aIdx)) {
            const name = cells[cIdx].textContent.trim();
            const val = num(cells[aIdx].textContent);
            if (name && name.toLowerCase() !== "no data" && val > 0) {
              catMap.set(name, (catMap.get(name) || 0) + val);
            }
          }
        });
      }
    });

    const topCats = Array.from(catMap.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const maxCat = Math.max(...topCats.map((x) => x[1]), 1);

    const grid = document.getElementById("sayinChartGrid");
    if (!grid) return;
    grid.innerHTML = `
      <div>
        <div style="font-size:13px;font-weight:600;color:#cbd5e1;margin-bottom:8px;">Income vs Expense</div>
        <div class="sayin-chart-box">
          <div class="sayin-bar-item">
            <div class="sayin-bar-meta"><span>Income</span><span>${inc.toLocaleString()} MMK</span></div>
            <div class="sayin-bar-track"><div class="sayin-bar-fill inc" style="width:${Math.min(100, (inc / maxIO) * 100)}%"></div></div>
          </div>
          <div class="sayin-bar-item">
            <div class="sayin-bar-meta"><span>Expense</span><span>${exp.toLocaleString()} MMK</span></div>
            <div class="sayin-bar-track"><div class="sayin-bar-fill exp" style="width:${Math.min(100, (exp / maxIO) * 100)}%"></div></div>
          </div>
        </div>
      </div>
      <div>
        <div style="font-size:13px;font-weight:600;color:#cbd5e1;margin-bottom:8px;">Top Spending Categories</div>
        <div class="sayin-chart-box">
          ${topCats.length ? topCats.map(([k, v]) => `
            <div class="sayin-bar-item">
              <div class="sayin-bar-meta"><span>${k}</span><span>${v.toLocaleString()} MMK</span></div>
              <div class="sayin-bar-track"><div class="sayin-bar-fill" style="width:${Math.min(100, (v / maxCat) * 100)}%"></div></div>
            </div>
          `).join("") : '<div style="font-size:13px;color:#94a3b8;padding:12px 0;">No transaction breakdown yet. Add a transaction to see bars.</div>'}
        </div>
      </div>
    `;
  }

  // 3. Add CSV Export button next to Transactions table
  function ensureCsvExport() {
    if (document.getElementById("sayinExportCsvBtn")) return;
    const tables = Array.from(document.querySelectorAll("table"));
    const txTable = tables[tables.length - 1];
    if (!txTable) return;
    const btn = document.createElement("button");
    btn.id = "sayinExportCsvBtn";
    btn.type = "button";
    btn.textContent = "Export CSV";
    btn.style.marginLeft = "8px";
    btn.onclick = () => {
      const rows = Array.from(txTable.querySelectorAll("tr"));
      const csv = rows.map((tr) =>
        Array.from(tr.querySelectorAll("th,td"))
          .map((td) => `"${td.textContent.trim().replace(/"/g, '""')}"`)
          .join(",")
      ).join("\n");
      const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `sayin-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      if (window.showSayinToast) window.showSayinToast("CSV downloaded!", "success");
    };
    const card = txTable.closest(".card") || txTable.parentElement;
    const headerRow = card.querySelector("h2, h3, .card-header") || card;
    headerRow.appendChild(btn);
  }

  const refreshAll = () => {
    alignCategoryPlus();
    renderVisualAnalytics();
    ensureCsvExport();
  };

  document.addEventListener("DOMContentLoaded", refreshAll);
  setInterval(refreshAll, 1500);
})();
