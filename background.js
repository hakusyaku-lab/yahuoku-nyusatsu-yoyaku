// ヤフオク入札予約 - 裏方（予約の保存・時間になったら商品ページを開く）

const PRE_OPEN_MS = 90 * 1000;      // 入札時刻の90秒前に商品ページを開いて準備
const GIVE_UP_AFTER_END_MS = 120 * 1000; // 終了2分後まで結果が出なければ失敗扱い
const ACTIVE = ["待機中", "準備中", "入札中"];
const FINISHED = ["完了", "失敗", "練習完了", "取消"];

// ---- 保存（同時書き込みで壊れないよう順番に処理） ----
let queue = Promise.resolve();
function withStore(fn) {
  const run = queue.then(async () => {
    const { reservations = {} } = await chrome.storage.local.get("reservations");
    const result = await fn(reservations);
    await chrome.storage.local.set({ reservations });
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

function stamp() {
  const d = new Date();
  return d.toLocaleTimeString("ja-JP", { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
}

function addLog(r, text) {
  r.log = r.log || [];
  r.log.push(`${stamp()} ${text}`);
  if (r.log.length > 50) r.log.splice(0, r.log.length - 50);
}

// ---- タイマー ----
function schedule(r) {
  const openAt = Math.max(Date.now() + 1000, r.fireAt - PRE_OPEN_MS);
  chrome.alarms.create("open:" + r.id, { when: openAt });
  chrome.alarms.create("timeout:" + r.id, { when: r.endTime + GIVE_UP_AFTER_END_MS });
}

function clearTimers(id) {
  chrome.alarms.clear("open:" + id);
  chrome.alarms.clear("timeout:" + id);
}

async function updateAwake() {
  const { reservations = {} } = await chrome.storage.local.get("reservations");
  const anyActive = Object.values(reservations).some((r) => ACTIVE.includes(r.status));
  // 予約がある間はPCがスリープしないようにする（画面は消えてもOK）
  if (chrome.power) { // Firefox には無い
    if (anyActive) chrome.power.requestKeepAwake("system");
    else chrome.power.releaseKeepAwake();
  }
  chrome.action.setBadgeText({ text: anyActive ? String(Object.values(reservations).filter((r) => ACTIVE.includes(r.status)).length) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#d9480f" });
}

function notify(title, message) {
  chrome.notifications.create({ type: "basic", iconUrl: "icons/icon128.png", title, message, priority: 2 });
}

// ---- タイマーが鳴ったとき ----
chrome.alarms.onAlarm.addListener(async (alarm) => {
  const [kind, id] = alarm.name.split(":");
  if (kind === "open") {
    const r = await withStore((all) => all[id]);
    if (!r || r.status !== "待機中") return;
    const tab = await chrome.tabs.create({ url: r.url, active: false });
    await withStore((all) => {
      const x = all[id];
      if (!x) return;
      x.status = "準備中";
      x.tabId = tab.id;
      addLog(x, "商品ページを開きました（タブは閉じないでください）");
    });
  } else if (kind === "timeout") {
    const r = await withStore((all) => {
      const x = all[id];
      if (!x || !ACTIVE.includes(x.status)) return null;
      x.status = "失敗";
      addLog(x, "時間切れ：入札まで進めませんでした（PCのスリープ・ログイン切れ・画面の変更などが原因の可能性）");
      return x;
    });
    if (r) notify("入札予約：失敗", `${r.title}\n時間内に入札できませんでした`);
    updateAwake();
  }
});

// PC・ブラウザ再起動のときに予約を立て直す
chrome.runtime.onStartup.addListener(async () => {
  await withStore((all) => {
    for (const r of Object.values(all)) {
      if (r.status === "準備中" || r.status === "入札中") {
        // 開いていたタブは消えているので、まだ間に合うなら待機に戻す
        if (Date.now() < r.fireAt) { r.status = "待機中"; r.tabId = null; addLog(r, "ブラウザ再起動のため予約を立て直しました"); }
      }
      if (r.status === "待機中") {
        if (Date.now() > r.fireAt) { r.status = "失敗"; addLog(r, "ブラウザが閉じていたため入札時刻を過ぎました"); }
        else schedule(r);
      }
    }
  });
  updateAwake();
});

// ---- 画面とのやり取り ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (e) => sendResponse({ error: String(e && e.message || e) }));
  return true;
});

async function handle(msg, sender) {
  switch (msg.type) {
    case "add": {
      const p = msg.data;
      const fireAt = p.endTime - p.secondsBefore * 1000;
      if (!(p.amount > 0)) throw new Error("金額が正しくありません");
      if (fireAt <= Date.now() + 20 * 1000) throw new Error("入札時刻まで20秒もないので予約できません");
      const r = await withStore((all) => {
        // 同じ商品の予約は上書き（古い方を取消）
        for (const x of Object.values(all)) {
          if (x.auctionId === p.auctionId && ACTIVE.includes(x.status)) {
            x.status = "取消"; addLog(x, "新しい予約で上書きしました"); clearTimers(x.id);
          }
        }
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const r = { ...p, id, fireAt, status: "待機中", tabId: null, stage: {}, log: [], createdAt: Date.now() };
        addLog(r, `予約しました：${p.amount.toLocaleString()}円／終了${p.secondsBefore}秒前${p.dryRun ? "（練習モード）" : ""}`);
        all[id] = r;
        return r;
      });
      schedule(r);
      updateAwake();
      return { ok: true, reservation: r };
    }
    case "cancel": {
      const r = await withStore((all) => {
        const x = all[msg.id];
        if (!x || !ACTIVE.includes(x.status)) return null;
        x.status = "取消"; addLog(x, "取り消しました");
        return x;
      });
      clearTimers(msg.id);
      if (r && r.tabId) chrome.tabs.remove(r.tabId).catch(() => {});
      updateAwake();
      return { ok: true };
    }
    case "remove": {
      await withStore((all) => { if (all[msg.id] && FINISHED.includes(all[msg.id].status)) delete all[msg.id]; });
      return { ok: true };
    }
    case "clearFinished": {
      await withStore((all) => { for (const k of Object.keys(all)) if (FINISHED.includes(all[k].status)) delete all[k]; });
      return { ok: true };
    }
    case "list": {
      const { reservations = {} } = await chrome.storage.local.get("reservations");
      return { reservations };
    }
    case "whoami": {
      // 商品ページ（またはその先の入札画面）から「自分は予約の作業中か？」を聞かれる
      const tabId = sender.tab && sender.tab.id;
      const { reservations = {} } = await chrome.storage.local.get("reservations");
      const r = Object.values(reservations).find((x) => x.tabId === tabId && (x.status === "準備中" || x.status === "入札中"));
      return { reservation: r || null, now: Date.now() };
    }
    case "findForAuction": {
      const { reservations = {} } = await chrome.storage.local.get("reservations");
      const r = Object.values(reservations).find((x) => x.auctionId === msg.auctionId && ACTIVE.includes(x.status));
      return { reservation: r || null };
    }
    case "patch": {
      const r = await withStore((all) => {
        const x = all[msg.id];
        if (!x || !ACTIVE.includes(x.status)) return null;
        Object.assign(x, msg.changes || {});
        if (msg.changes && msg.changes.endTime) x.fireAt = x.endTime - x.secondsBefore * 1000;
        if (msg.log) addLog(x, msg.log);
        return x;
      });
      if (r && FINISHED.includes(r.status)) {
        clearTimers(r.id);
        const titles = { "完了": "入札予約：入札しました", "失敗": "入札予約：失敗", "練習完了": "入札予約：練習完了" };
        notify(titles[r.status] || "入札予約", `${r.title}\n${msg.log || ""}`);
      }
      updateAwake();
      return { ok: true, reservation: r };
    }
  }
  return { error: "unknown" };
}
