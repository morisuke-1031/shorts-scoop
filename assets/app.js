const $ = (sel) => document.querySelector(sel);

function fmtNum(n){
  if (n == null) return "-";
  const x = Number(n);
  if (!Number.isFinite(x)) return String(n);
  return x.toLocaleString("ja-JP");
}
function fmtAgeSec(sec){
  if (sec == null) return "-";
  const s = Number(sec);
  if (!Number.isFinite(s)) return "-";
  if (s < 3600) return `${Math.max(1, Math.floor(s/60))}分前`;
  if (s < 86400) return `${Math.floor(s/3600)}時間前`;
  return `${Math.floor(s/86400)}日前`;
}

let RAW = null;

async function loadLatest(){
  $("#headline").textContent = "読み込み中...";
  $("#hint").textContent = "—";

  const url = `./latest.json?t=${Date.now()}`; // cache-bust
  const res = await fetch(url, { cache: "no-store" });
  if(!res.ok) throw new Error(`latest.json load failed: ${res.status}`);
  RAW = await res.json();

  $("#updatedAt").textContent = `更新: ${RAW.updated_at || "-"}`;
  $("#sourceNote").textContent = `ソース: ${RAW.source || "—"}`;

  render();
}

function render(){
  if(!RAW || !Array.isArray(RAW.items)) return;

  const limit = Number($("#limitSelect").value || 20);
  const sort = $("#sortSelect").value;
  const q = ($("#qInput").value || "").trim().toLowerCase();

  let items = [...RAW.items];

  if (q){
    items = items.filter(it => {
      const t = (it.title || "").toLowerCase();
      const c = (it.channel_title || "").toLowerCase();
      const tag = (it.topic || "").toLowerCase();
      return t.includes(q) || c.includes(q) || tag.includes(q);
    });
  }

  if (sort === "age_asc"){
    items.sort((a,b)=> (a.published_ago_sec ?? 9e18) - (b.published_ago_sec ?? 9e18));
  } else {
    // views_desc
    items.sort((a,b)=> (b.views ?? 0) - (a.views ?? 0));
  }

  const shown = items.slice(0, limit);

  $("#countInfo").textContent = `表示: ${shown.length} / ${items.length}（全体: ${RAW.items.length}）`;

  // 今日の結論（雑に）
  if (shown.length > 0){
    const top = shown[0];
    $("#headline").textContent = `今は「${top.topic || "この系統"}」が強い。まずは1本、これを真似て作る。`;
    $("#hint").textContent = `上位は再生数で並べています。迷ったら1位の「タイトル構成」と「テンポ」をコピー。`;
  } else {
    $("#headline").textContent = "該当なし（フィルタ条件を緩めてください）";
    $("#hint").textContent = "—";
  }

  const root = $("#items");
  root.innerHTML = "";

  shown.forEach((it, idx) => {
    const rank = idx + 1;
    const href = it.url || (it.video_id ? `https://www.youtube.com/shorts/${it.video_id}` : "#");
    const thumb = it.thumbnail_url || "";

    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div class="rank">${rank}</div>

      <div class="thumbWrap">
        ${thumb ? `<img class="thumb" src="${escapeHtml(thumb)}" alt="" loading="lazy" />` : `<div class="thumbPh"></div>`}
      </div>

      <div class="main">
        <div class="title">${escapeHtml(it.title || "(no title)")}</div>
        <div class="meta2">
          <span class="badge">${escapeHtml(it.topic || "未分類")}</span>
          <span class="badge">Ch: ${escapeHtml(it.channel_title || "-")}</span>
          <span class="badge">投稿: ${fmtAgeSec(it.published_ago_sec)}</span>
          <span class="badge"><span class="views">${fmtNum(it.views)}</span> 再生</span>
        </div>
      </div>

      <div class="go">
        <a href="${href}" target="_blank" rel="noopener">YouTubeで見る →</a>
      </div>
    `;
    root.appendChild(el);
  });
}

function escapeHtml(str){
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

$("#btnReload").addEventListener("click", () => loadLatest().catch(err => alert(err.message)));
$("#limitSelect").addEventListener("change", render);
$("#sortSelect").addEventListener("change", render);
$("#qInput").addEventListener("input", () => {
  clearTimeout(window.__t);
  window.__t = setTimeout(render, 120);
});

loadLatest().catch(err => {
  console.error(err);
  $("#headline").textContent = "読み込み失敗";
  $("#hint").textContent = err.message;
});
