const ACTIVE = ["待機中", "準備中", "入札中"];
const list = document.getElementById("list");

function left(ms) {
  if (ms <= 0) return "まもなく";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  if (d) return `あと${d}日${h}時間`;
  if (h) return `あと${h}時間${m}分`;
  if (m) return `あと${m}分${ss}秒`;
  return `あと${ss}秒`;
}

function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }

async function render() {
  const { reservations = {} } = await chrome.runtime.sendMessage({ type: "list" });
  const items = Object.values(reservations).sort((a, b) => {
    const aa = ACTIVE.includes(a.status) ? 0 : 1, bb = ACTIVE.includes(b.status) ? 0 : 1;
    return aa - bb || (aa === 0 ? a.fireAt - b.fireAt : b.fireAt - a.fireAt);
  });
  if (!items.length) {
    list.innerHTML = `<div class="empty">予約はありません。<br>ヤフオクの商品ページ右下の「入札予約」から予約できます。</div>`;
    return;
  }
  list.innerHTML = items.map((r) => `
    <div class="card">
      <div class="title"><a href="${esc(r.url)}" target="_blank">${esc(r.title || r.auctionId)}</a></div>
      <div class="row">
        <span>${r.amount.toLocaleString()}円／終了${r.secondsBefore}秒前 ${r.dryRun ? '<span class="dry">練習</span>' : ""}</span>
        <span class="st ${esc(r.status)}">${esc(r.status)}</span>
      </div>
      <div class="row">
        <span class="left">入札 ${new Date(r.fireAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })}${ACTIVE.includes(r.status) ? "（" + left(r.fireAt - Date.now()) + "）" : ""}</span>
        ${ACTIVE.includes(r.status) ? `<button class="btn" data-cancel="${esc(r.id)}">取り消す</button>` : `<button class="btn" data-remove="${esc(r.id)}">消す</button>`}
      </div>
      <details><summary>記録</summary><pre>${esc((r.log || []).join("\n"))}</pre></details>
    </div>`).join("");
}

list.addEventListener("click", async (e) => {
  const c = e.target.getAttribute("data-cancel");
  const rm = e.target.getAttribute("data-remove");
  if (c && confirm("この予約を取り消しますか？")) { await chrome.runtime.sendMessage({ type: "cancel", id: c }); render(); }
  if (rm) { await chrome.runtime.sendMessage({ type: "remove", id: rm }); render(); }
});
document.getElementById("clear").onclick = async () => { await chrome.runtime.sendMessage({ type: "clearFinished" }); render(); };

render();
setInterval(() => { if (!document.querySelector("details[open]")) render(); }, 1000);
