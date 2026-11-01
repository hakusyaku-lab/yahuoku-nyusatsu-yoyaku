// ヤフオク入札予約 - 商品ページ側（予約パネル表示と、時間になったら入札ボタンを押す）
(() => {
  if (window.__yahuokuYoyaku) return;
  window.__yahuokuYoyaku = true;

  const send = (msg) => chrome.runtime.sendMessage(msg);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const PREP_MS = 12 * 1000; // 入札時刻の12秒前から入札画面を開いて金額を入れておく

  // ---------- ページを読む ----------
  function auctionIdFromUrl(u = location.href) {
    const m = u.match(/auction\/([a-z]?\d{6,})/i) || u.match(/[?&]aID=([a-z]?\d{6,})/i);
    return m ? m[1] : null;
  }
  function isItemPage() {
    return /\/auction\/[a-z]?\d{6,}/i.test(location.pathname);
  }
  function bodyText() {
    return (document.body && document.body.innerText) || "";
  }
  // ページに埋め込まれた商品データ（__NEXT_DATA__）から、この商品の情報を取り出す
  function itemFromNextData(jsonText, auctionId) {
    let d;
    try { d = JSON.parse(jsonText); } catch (e) { return null; }
    const cands = [];
    const direct = [d?.props?.pageProps?.initialState?.item?.detail?.item, d?.props?.initialState?.item?.detail?.item];
    for (const x of direct) if (x) cands.push(x);
    if (!cands.length) {
      (function walk(o, depth) {
        if (!o || typeof o !== "object" || depth > 12) return;
        if ("auctionId" in o && "price" in o && "endTime" in o) cands.push(o);
        for (const k in o) walk(o[k], depth + 1);
      })(d, 0);
    }
    const it = cands.find((x) => x.auctionId === auctionId);
    if (!it) return null;
    const end = typeof it.endTime === "number" ? (it.endTime < 1e12 ? it.endTime * 1000 : it.endTime) : Date.parse(it.endTime);
    return {
      auctionId: it.auctionId,
      title: String(it.title || "").slice(0, 80),
      price: typeof it.price === "number" ? it.price : null,
      bids: typeof it.bids === "number" ? it.bids : null,
      endTime: end || null,
      autoExtend: it.isAutomaticExtension === true ? "あり" : it.isAutomaticExtension === false ? "なし" : null,
      open: it.status ? it.status === "open" : true,
    };
  }
  // 今のページから読む（ページ移動で中身が古いときは null）
  function readItemFromDom() {
    const el = document.getElementById("__NEXT_DATA__");
    return el ? itemFromNextData(el.textContent, auctionIdFromUrl()) : null;
  }
  // サーバーから最新の商品ページを取り直して読む（価格・終了時刻の最新値）
  async function fetchItem() {
    try {
      const res = await fetch(location.href.split("#")[0], { credentials: "include", cache: "no-store" });
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const el = doc.getElementById("__NEXT_DATA__");
      return el ? itemFromNextData(el.textContent, auctionIdFromUrl()) : null;
    } catch (e) { return null; }
  }
  async function getItem(fresh) {
    return (!fresh && readItemFromDom()) || (await fetchItem()) || readItemFromText();
  }
  // 予備：データが無いときだけ画面の文字から読む
  function readItemFromText() {
    const text = bodyText().replace(/\s+/g, " ");
    let endTime = null;
    const m = text.match(/(\d{1,2})月(\d{1,2})日[^\d]{0,6}(\d{1,2})時(\d{1,2})分\s*終了/);
    if (m) {
      const now = new Date();
      let d = new Date(now.getFullYear(), +m[1] - 1, +m[2], +m[3], +m[4]);
      if (d.getTime() < now.getTime() - 30 * 86400000) d = new Date(now.getFullYear() + 1, +m[1] - 1, +m[2], +m[3], +m[4]);
      endTime = d.getTime();
    }
    const h = document.querySelector("h1");
    return { auctionId: auctionIdFromUrl(), title: ((h && h.innerText) || document.title || "").trim().slice(0, 80), price: null, bids: null, endTime, autoExtend: null, open: true };
  }
  function needsLogin() {
    const btn = [...document.querySelectorAll("button")].find((b) => norm(b.innerText) === "入札する");
    return !!(btn && btn.disabled) || /ログインしてください/.test(bodyText());
  }
  // ヤフオクの入札単位（価格帯ごとの上げ幅）
  function bidStep(price) {
    if (price < 1000) return 10;
    if (price < 5000) return 100;
    if (price < 10000) return 250;
    if (price < 50000) return 500;
    return 1000;
  }
  // 最低入札額：入札がまだ無ければ現在価格（開始価格）、あれば現在価格＋入札単位
  function minBid(price, bids) {
    if (!price) return null;
    return bids === 0 ? price : price + bidStep(price);
  }

  // ---------- ボタン・入力欄を探す ----------
  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none" && !el.disabled;
  }
  function norm(s) { return (s || "").replace(/\s+/g, ""); }
  // 表示中のポップアップ（role="dialog"）。入札のポップアップを優先する
  function dialogs() {
    return [...document.querySelectorAll('[role="dialog"],[aria-modal="true"]')]
      .filter((d) => visible(d) && !d.closest("#yyk-panel"));
  }
  function scope() {
    const ds = dialogs();
    const bid = ds.filter((d) => /入札/.test(d.innerText || ""));
    if (bid.length) return bid[bid.length - 1];
    return document;
  }
  // 入札と関係ないお知らせ（クーポンなど）が出ていたら閉じる
  function closeOtherPopups() {
    let closed = false;
    for (const d of dialogs()) {
      if (/入札/.test(d.innerText || "")) continue;
      const b = findButton(d, ["閉じる", "とじる", "キャンセル", "あとで"], []) ||
        [...d.querySelectorAll('button,[role="button"]')].find((x) => visible(x) && /閉じる|close/i.test(x.getAttribute("aria-label") || ""));
      if (b) { b.click(); closed = true; }
    }
    return closed;
  }
  function findButton(root, texts, avoid = []) {
    const els = [...root.querySelectorAll('button, a, input[type="submit"], input[type="button"], [role="button"]')]
      .filter((el) => !el.closest("#yyk-panel, #yyk-banner") && visible(el));
    for (const t of texts) {
      const hit = els.filter((el) => {
        const s = norm(el.innerText || el.value || el.getAttribute("aria-label"));
        return s && (s === t || s.startsWith(t)) && !avoid.some((a) => s.includes(a));
      });
      if (hit.length) return hit[hit.length - 1];
    }
    return null;
  }
  function findAmountInput(root) {
    const cands = [...root.querySelectorAll('input[name="Bid"], input[name*="bid" i], input[name*="price" i], input[type="number"], input[inputmode="numeric"], input[type="text"], input[type="tel"]')]
      .filter((el) => visible(el) && !el.readOnly && !el.closest("#yyk-panel"));
    // 「入札額」の文字が近く（数段上まで）にある入力欄を優先
    const near = cands.find((el) => {
      let box = el.parentElement;
      for (let i = 0; i < 5 && box && box !== root; i++, box = box.parentElement) {
        if (/入札金額|入札額/.test(box.innerText || "")) return true;
      }
      return false;
    });
    if (near) return near;
    const byName = cands.find((el) => /bid/i.test(el.name || ""));
    if (byName) return byName;
    // 入札ポップアップの中に入力欄が1つだけなら、それが金額欄
    if (root !== document && cands.length === 1) return cands[0];
    return null;
  }
  // 最後の入札ボタン（例：「上記のガイドライン等、情報提供に同意して入札する」）
  function findFinal(root) {
    const els = [...root.querySelectorAll('button, input[type="submit"], [role="button"]')]
      .filter((el) => !el.closest("#yyk-panel, #yyk-banner") && visible(el));
    const hit = els.filter((el) => {
      const t = norm(el.innerText || el.value || el.getAttribute("aria-label"));
      return t && (/同意して入札する$/.test(t) || t === "入札する" || t === "入札を確定する") && !AVOID.some((a) => t.includes(a));
    });
    return hit.length ? hit[hit.length - 1] : null;
  }
  function setValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    input.focus();
    setter.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.blur();
  }
  function highlight(el) {
    el.style.outline = "4px solid #e8590c";
    el.style.outlineOffset = "3px";
    el.scrollIntoView({ block: "center" });
  }

  const OPEN_TEXTS = ["入札する"];
  const CONFIRM_TEXTS = ["確認する", "入札内容を確認する", "入札内容を確認", "確認画面へ", "次へ"];
  const AVOID = ["今すぐ落札", "即決", "取り消"];
  const OK_RE = /入札しました|入札を受け付けました|あなたが(現在の)?最高額入札者|最高額入札者です/;
  const NG_RE = /入札できません|入札額が(低|不足)|より高い金額|エラーが発生|ログインしてください|入札の権限がありません/;

  // ---------- 作業中の帯 ----------
  let banner;
  function showBanner(text) {
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "yyk-banner";
      document.documentElement.appendChild(banner);
    }
    banner.textContent = text;
  }
  function fmtLeft(ms) {
    if (ms < 0) ms = 0;
    const s = Math.ceil(ms / 1000);
    return s >= 60 ? `${Math.floor(s / 60)}分${s % 60}秒` : `${s}秒`;
  }

  // ---------- 予約の実行 ----------
  async function patch(r, changes, log) {
    const res = await send({ type: "patch", id: r.id, changes, log });
    if (res && res.reservation) Object.assign(r, res.reservation);
    return res;
  }
  async function waitUntil(t, label) {
    while (Date.now() < t) {
      showBanner(`入札予約が動いています：${label}まで あと${fmtLeft(t - Date.now())}（このタブは閉じないでください）`);
      await sleep(Math.min(500, Math.max(10, t - Date.now())));
    }
  }

  async function runJob(r) {
    if (r.status === "準備中") {
      const item = await getItem(true);
      if (item.open === false) return patch(r, { status: "失敗" }, "オークションはすでに終了していました");
      if (needsLogin()) return patch(r, { status: "失敗" }, "ヤフオクにログインしていないため入札できませんでした");
      const end = item.endTime;
      if (end && Math.abs(end - r.endTime) > 30 * 1000) {
        await patch(r, { endTime: end }, `終了時刻が変わっていました（延長など）→ ${new Date(end).toLocaleString("ja-JP")}`);
      }
      const price = item.price;
      const min = minBid(price, item.bids);
      if (min && r.amount < min) {
        return patch(r, { status: "失敗" }, `最低入札額 ${min.toLocaleString()}円（現在価格 ${price.toLocaleString()}円）が予約金額 ${r.amount.toLocaleString()}円 を上回ったので入札しませんでした`);
      }
      await waitUntil(r.fireAt - PREP_MS, "入札準備");
      // 準備中に取り消されていないか確認
      const chk = await send({ type: "whoami" });
      if (!chk || !chk.reservation) { showBanner("入札予約は取り消されました"); return; }
      await patch(r, { status: "入札中", stage: {} }, "入札画面を開きます");
    }
    return bidFlow(r);
  }

  async function bidFlow(r) {
    const st = r.stage || {};
    const deadline = Date.now() + 40 * 1000;
    while (Date.now() < deadline) {
      const text = bodyText();
      if (st.finalClicked) {
        if (OK_RE.test(text)) return patch(r, { status: "完了", stage: st }, `入札しました（${r.amount.toLocaleString()}円）`);
        if (NG_RE.test(text)) {
          const m = text.match(NG_RE);
          return patch(r, { status: "失敗", stage: st }, `入札できませんでした：「${m[0]}」と表示されました`);
        }
        showBanner("入札ボタンを押しました。結果を確認中…");
        await sleep(300);
        continue;
      }
      if (closeOtherPopups()) { await sleep(500); continue; }
      const root = scope();
      // 最後の「入札する」ボタン（確認を済ませた後、または金額入力後に確認なしで出る場合）
      let finalBtn = null;
      if (st.confirmed && root !== document) finalBtn = findFinal(root);
      if (!finalBtn && st.filled && root !== document && !findButton(root, CONFIRM_TEXTS, AVOID)) {
        finalBtn = findFinal(root);
      }
      if (finalBtn) {
        if (r.dryRun) {
          highlight(finalBtn);
          showBanner("練習モード：ここで最後の「入札する」を押すところで止めました（オレンジの枠のボタン）");
          return patch(r, { status: "練習完了", stage: st }, `練習完了：最後のボタン「${norm(finalBtn.innerText || finalBtn.value)}」まで進めました。本番ならここで押します`);
        }
        await waitUntil(r.fireAt, "入札");
        st.finalClicked = true;
        await patch(r, { stage: st }, `入札ボタンを押します（終了${Math.round((r.endTime - Date.now()) / 1000)}秒前）`);
        finalBtn.click();
        continue;
      }
      // 金額入力欄
      if (!st.confirmed && root !== document) {
        const input = findAmountInput(root);
        if (input) {
          if (!st.filled || input.value.replace(/[^\d]/g, "") !== String(r.amount)) {
            setValue(input, r.amount);
            st.filled = true;
            await patch(r, { stage: st }, `金額 ${r.amount.toLocaleString()}円 を入力しました`);
            await sleep(400);
          }
          const conf = findButton(root, CONFIRM_TEXTS, AVOID);
          if (conf) {
            st.confirmed = true;
            await patch(r, { stage: st }, `「${norm(conf.innerText || conf.value)}」を押します`);
            conf.click();
            await sleep(600);
          } else {
            await sleep(300);
          }
          continue;
        }
      }
      // 最初の「入札する」ボタン（商品ページ）
      if (!st.opened) {
        const open = findButton(document, OPEN_TEXTS, AVOID);
        if (open) {
          st.opened = true;
          await patch(r, { stage: st }, "「入札する」を押して入札画面を開きます");
          open.click();
          await sleep(800);
          continue;
        }
      }
      if (NG_RE.test(text)) {
        const m = text.match(NG_RE);
        return patch(r, { status: "失敗", stage: st }, `入札できませんでした：「${m[0]}」と表示されました`);
      }
      showBanner("入札画面を探しています…");
      await sleep(300);
    }
    const where = !st.opened ? "「入札する」ボタンが見つかりません" : !st.filled ? "金額の入力欄が見つかりません" : !st.confirmed ? "確認ボタンが見つかりません" : "最後の入札ボタンが見つかりません";
    return patch(r, { status: "失敗", stage: st }, `入札できませんでした：${where}。ログイン状態を確認するか、画面の形が変わっている可能性があります`);
  }

  // ---------- 予約パネル ----------
  function toLocalInput(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  async function showPanel() {
    const auctionId = auctionIdFromUrl();
    if (!auctionId || document.getElementById("yyk-panel")) return;
    const item = await getItem(false);
    if (auctionIdFromUrl() !== auctionId || document.getElementById("yyk-panel")) return; // 読み込み中にページが変わった
    const end = item.endTime;
    const price = item.price;
    const bids = item.bids;
    const min = minBid(price, bids);
    const ext = item.autoExtend;
    const login = needsLogin();
    // 終了済み・終了間近（予約が間に合わない）かどうか
    const left = end ? end - Date.now() : null;
    const closed = item.open === false || (left !== null && left <= 0);
    const tooSoon = !closed && left !== null && left < 60 * 1000;
    const existing = (await send({ type: "findForAuction", auctionId })).reservation;

    const box = document.createElement("div");
    box.id = "yyk-panel";
    box.innerHTML = `
      <div class="yyk-head"><b>入札予約</b><button class="yyk-x" title="小さくする">－</button></div>
      <div class="yyk-body">
        ${existing ? `<div class="yyk-note yyk-on">予約中：${existing.amount.toLocaleString()}円／終了${existing.secondsBefore}秒前${existing.dryRun ? "（練習）" : ""}<br>新しく予約すると上書きします</div>` : ""}
        ${closed ? `<div class="yyk-note yyk-end">この商品は終了時刻を過ぎています（${end ? new Date(end).toLocaleString("ja-JP") : "終了"}）<br>予約はできません。再出品されている場合は、新しい商品ページから予約してください</div>` : ""}
        ${tooSoon ? `<div class="yyk-note yyk-warn">終了まで1分を切っています。予約は間に合わない可能性があります</div>` : ""}
        ${login ? `<div class="yyk-note yyk-warn">ヤフオクにログインしていません。予約はできますが、入札時にログインしていないと失敗します</div>` : ""}
        ${ext === "あり" ? `<div class="yyk-note yyk-warn">自動延長：あり<br>終了5分前以降に入札すると5分延長されます（延長後の再入札はしません）</div>` : ""}
        <label>入札金額（円）
          <div class="yyk-amt">
            <button type="button" class="yyk-step" data-d="-1" title="入札単位ぶん下げる">－</button>
            <input id="yyk-amount" type="number" min="1" step="1" value="${min || ""}">
            <button type="button" class="yyk-step" data-d="1" title="入札単位ぶん上げる">＋</button>
          </div>
        </label>
        <div class="yyk-small" id="yyk-min-info">${min ? `最低入札額 ${min.toLocaleString()}円（現在 ${price.toLocaleString()}円・入札${bids == null ? "?" : bids}件）<button type="button" id="yyk-to-min" class="yyk-link">最低額に戻す</button>` : '<span class="yyk-red">現在価格を読み取れませんでした。金額を入力してください</span>'}</div>
        <label>入札のタイミング
          <select id="yyk-sec">
            <option value="300">終了 5分前</option>
            <option value="180">終了 3分前</option>
            <option value="120">終了 2分前</option>
            <option value="60">終了 1分前</option>
            <option value="30" selected>終了 30秒前</option>
            <option value="20">終了 20秒前</option>
            <option value="15">終了 15秒前</option>
            <option value="custom">秒数を入力…</option>
          </select>
        </label>
        <label id="yyk-custom-wrap" style="display:none">終了何秒前（10秒以上）<input id="yyk-custom" type="number" min="10" step="1" value="45"></label>
        <label>終了日時 ${end ? "" : '<span class="yyk-red">（読み取れませんでした。入力してください）</span>'}<input id="yyk-end" type="datetime-local" step="1" value="${end ? toLocalInput(end) : ""}"></label>
        <label class="yyk-check"><input id="yyk-dry" type="checkbox" ${existing ? "" : "checked"}> 練習モード（最後のボタンは押さない）</label>
        <button id="yyk-go" ${closed ? "disabled" : ""}>${closed ? "終了した商品です" : "予約する"}</button>
        <div class="yyk-small">時間の約90秒前にこの商品を新しいタブで開いて入札します。PCとブラウザは開いたままにしてください。</div>
      </div>`;
    document.documentElement.appendChild(box);

    const $ = (s) => box.querySelector(s);
    $(".yyk-x").onclick = () => box.classList.toggle("yyk-min");
    // ＋－は、その金額での入札単位ぶん動かす（最低入札額より下にはしない）
    box.querySelectorAll(".yyk-step").forEach((b) => {
      b.onclick = () => {
        const cur = parseInt($("#yyk-amount").value, 10) || min || 0;
        const d = parseInt(b.dataset.d, 10);
        let next = d > 0 ? cur + bidStep(cur) : cur - bidStep(Math.max(0, cur - 1));
        if (min && next < min) next = min;
        if (next > 0) $("#yyk-amount").value = next;
      };
    });
    if ($("#yyk-to-min")) $("#yyk-to-min").onclick = () => { $("#yyk-amount").value = min; };
    $("#yyk-sec").onchange = () => { $("#yyk-custom-wrap").style.display = $("#yyk-sec").value === "custom" ? "" : "none"; };
    $("#yyk-go").onclick = async () => {
      const amount = parseInt($("#yyk-amount").value, 10);
      const secondsBefore = $("#yyk-sec").value === "custom" ? parseInt($("#yyk-custom").value, 10) : parseInt($("#yyk-sec").value, 10);
      const endTime = $("#yyk-end").value ? new Date($("#yyk-end").value).getTime() : NaN;
      const dryRun = $("#yyk-dry").checked;
      if (!(amount > 0)) return alert("入札金額を入れてください");
      if (!(secondsBefore >= 10)) return alert("タイミングは終了10秒前以上にしてください");
      if (!endTime) return alert("終了日時を入れてください");
      if (endTime <= Date.now()) return alert("終了日時を過ぎています。終了前の商品で予約してください");
      if (min && amount < min) return alert(`最低入札額（${min.toLocaleString()}円）以上の金額にしてください`);
      const fireAt = endTime - secondsBefore * 1000;
      const msg = `${dryRun ? "【練習モード】" : "【本番】"}この内容で予約しますか？\n\n商品：${item.title}\n金額：${amount.toLocaleString()}円\n入札時刻：${new Date(fireAt).toLocaleString("ja-JP")}（終了${secondsBefore}秒前）` +
        (dryRun ? "\n\n練習モードなので、最後の入札ボタンは押しません。" : "\n\n落札したら購入の義務があります。");
      if (!confirm(msg)) return;
      const res = await send({ type: "add", data: { auctionId, url: location.href.split("#")[0], title: item.title, amount, secondsBefore, endTime, dryRun } });
      if (res && res.error) return alert("予約できませんでした：" + res.error);
      box.remove();
      showPanel();
      alert("予約しました。ツールバーのアイコンから一覧・取り消しができます。");
    };
  }

  // ---------- 起動 ----------
  (async () => {
    let res;
    try { res = await send({ type: "whoami" }); } catch (e) { return; }
    if (res && res.reservation) {
      runJob(res.reservation).catch((e) => patch(res.reservation, { status: "失敗" }, "エラー：" + (e && e.message || e)));
    } else {
      if (isItemPage()) showPanel();
      // 検索結果から商品へ移ったときなど、ページ全体を読み直さない移動にも対応
      let last = location.href;
      setInterval(() => {
        if (location.href === last) return;
        const prev = auctionIdFromUrl(last);
        last = location.href;
        if (prev === auctionIdFromUrl()) return;
        const old = document.getElementById("yyk-panel");
        if (old) old.remove();
        if (isItemPage()) setTimeout(showPanel, 800);
      }, 1000);
    }
  })();
})();
