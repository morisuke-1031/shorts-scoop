// scripts/build_latest_youtube.js
// YouTube Data API v3 から「今伸びてそうなJPのShorts候補」を集めて latest.json を生成する。
// 方針: 厳密Shorts判定はしない。まずは「60秒以下」+ 簡易収集でOK。
// Node 20 以上（GitHub Actions の node 20 は fetch が使える）

const fs = require("fs");
const path = require("path");

const API_KEY = process.env.YOUTUBE_API_KEY;

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function pad(n) { return String(n).padStart(2, "0"); }
function jstNowString() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} JST`;
}
function toIso(d) { return d.toISOString(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    maxItems: 50,
    lookbackHours: 36,
    perQuery: 25,
    delayMs: 150,
    selftest: false,
    debug: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--max") out.maxItems = Number(args[++i]);
    else if (a === "--hours") out.lookbackHours = Number(args[++i]);
    else if (a === "--perQuery") out.perQuery = Number(args[++i]);
    else if (a === "--delayMs") out.delayMs = Number(args[++i]);
    else if (a === "--selftest") out.selftest = true;
    else if (a === "--debug") out.debug = true;
  }
  if (!Number.isFinite(out.maxItems) || out.maxItems <= 0) out.maxItems = 50;
  if (!Number.isFinite(out.lookbackHours) || out.lookbackHours <= 0) out.lookbackHours = 36;
  if (!Number.isFinite(out.perQuery) || out.perQuery <= 0) out.perQuery = 25;
  if (!Number.isFinite(out.delayMs) || out.delayMs < 0) out.delayMs = 150;
  return out;
}

// ISO 8601 duration ("PT1M3S" etc.) -> seconds
function parseISODurationToSec(iso) {
  if (!iso || typeof iso !== "string") return null;
  // PT#H#M#S
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  const mi = m[2] ? Number(m[2]) : 0;
  const s = m[3] ? Number(m[3]) : 0;
  return h * 3600 + mi * 60 + s;
}

function topicFromTitle(title) {
  const t = (title || "").toLowerCase();

  // 雑なルールで十分（あとで改善）
  const rules = [
    { topic: "雑学", keys: ["雑学", "豆知識", "知らない", "知ってた", "意外", "保存"] },
    { topic: "筋トレ", keys: ["筋トレ", "腹筋", "腕立て", "スクワット", "ダイエット", "脂肪", "ストレッチ"] },
    { topic: "英語", keys: ["英語", "english", "発音", "フレーズ", "toeic"] },
    { topic: "料理", keys: ["料理", "レシピ", "簡単", "レンジ", "作り方", "うまい"] },
    { topic: "恋愛", keys: ["恋愛", "モテ", "彼女", "彼氏", "デート", "結婚"] },
    { topic: "ライフハック", keys: ["裏技", "便利", "ライフハック", "時短", "節約", "神", "損"] },
    { topic: "副業", keys: ["副業", "稼ぐ", "収益", "アフィ", "仕事", "在宅"] },
    { topic: "エンタメ", keys: ["shorts", "切り抜き", "ドッキリ", "検証", "あるある", "爆笑"] },
  ];

  for (const r of rules) {
    for (const k of r.keys) {
      if (t.includes(String(k).toLowerCase())) return r.topic;
    }
  }
  return "未分類";
}

async function fetchJson(url, { retries = 3, delayMs = 400, debug = false } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url);
    const text = await res.text();

    if (res.ok) {
      try {
        return JSON.parse(text);
      } catch (e) {
        if (debug) console.error("JSON parse error:", text.slice(0, 200));
        throw e;
      }
    }

    // 403 quota / 429 rate limit などはリトライ
    if ([403, 429, 500, 502, 503, 504].includes(res.status) && attempt < retries) {
      if (debug) console.error(`HTTP ${res.status} retrying... attempt=${attempt}`);
      await sleep(delayMs * attempt);
      continue;
    }

    // それ以外はエラー終了
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  throw new Error("fetchJson failed after retries");
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function searchIds({ q, publishedAfterISO, perQuery, delayMs, debug }) {
  // search.list: type=video, videoDuration=short（4分未満）で候補収集
  // ※Shortsは厳密には60秒以下なので後段で duration<=60 に絞る
  const params = new URLSearchParams({
    key: API_KEY,
    part: "id",
    type: "video",
    maxResults: String(perQuery),
    order: "viewCount",
    regionCode: "JP",
    relevanceLanguage: "ja",
    safeSearch: "none",
    videoDuration: "short",
    publishedAfter: publishedAfterISO,
  });
  if (q) params.set("q", q);

  const url = `https://www.googleapis.com/youtube/v3/search?${params.toString()}`;
  if (debug) console.log("search:", q, url);

  const data = await fetchJson(url, { retries: 3, delayMs: 500, debug });
  await sleep(delayMs);

  const ids = [];
  for (const it of (data.items || [])) {
    const vid = it?.id?.videoId;
    if (vid) ids.push(vid);
  }
  return ids;
}

async function getVideoDetails(videoIds, { delayMs, debug }) {
  // videos.list: snippet/statistics/contentDetails をまとめて取得
  const out = [];
  const groups = chunk(videoIds, 50);
  for (const g of groups) {
    const params = new URLSearchParams({
      key: API_KEY,
      part: "snippet,statistics,contentDetails",
      id: g.join(","),
    });
    const url = `https://www.googleapis.com/youtube/v3/videos?${params.toString()}`;
    if (debug) console.log("videos.list:", url);

    const data = await fetchJson(url, { retries: 3, delayMs: 500, debug });
    await sleep(delayMs);

    for (const it of (data.items || [])) out.push(it);
  }
  return out;
}

function buildLatestJson(items) {
  return {
    updated_at: jstNowString(),
    source: "youtube-data-api",
    region: "JP",
    items,
  };
}

function validateLatestJson(obj) {
  if (!obj || typeof obj !== "object") return "latest.json is not an object";
  if (!obj.updated_at || !obj.source || !obj.region) return "missing meta fields";
  if (!Array.isArray(obj.items)) return "items must be array";
  for (const it of obj.items) {
    if (!it.video_id || !it.url || !it.title) return "item missing required fields";
    if (typeof it.views !== "number") return "views must be number";
  }
  return null;
}

async function main() {
  if (!API_KEY) die("Missing env YOUTUBE_API_KEY. Set it in GitHub Actions Secrets.");

  const opt = parseArgs();
  const now = new Date();
  const publishedAfter = new Date(now.getTime() - opt.lookbackHours * 3600 * 1000);
  const publishedAfterISO = toIso(publishedAfter);

  // 収集クエリ（“広く薄く”でOK）
  // Shorts専用APIは無いので、ここは割り切り。後で改善可能。
  const queries = [
    "shorts",
    "切り抜き",
    "雑学",
    "ライフハック",
    "筋トレ",
    "ダイエット",
    "料理",
    "英語",
    "恋愛",
    "検証",
    "あるある",
  ];

  const idSet = new Set();

  for (const q of queries) {
    const ids = await searchIds({
      q,
      publishedAfterISO,
      perQuery: opt.perQuery,
      delayMs: opt.delayMs,
      debug: opt.debug,
    });
    ids.forEach(id => idSet.add(id));
  }

  const idsAll = Array.from(idSet);
  if (opt.debug) console.log("collected ids:", idsAll.length);

  if (idsAll.length === 0) {
    die("No videos found. Try increasing --hours or adjusting queries.");
  }

  const details = await getVideoDetails(idsAll, { delayMs: opt.delayMs, debug: opt.debug });

  const nowMs = Date.now();
  const candidates = [];

  for (const v of details) {
    const id = v.id;
    const sn = v.snippet || {};
    const st = v.statistics || {};
    const cd = v.contentDetails || {};

    const title = sn.title || "";
    const channelTitle = sn.channelTitle || "";
    const publishedAt = sn.publishedAt ? Date.parse(sn.publishedAt) : null;

    const durationSec = parseISODurationToSec(cd.duration);
    if (durationSec == null) continue;

    // Shorts簡易判定: 60秒以下
    if (durationSec > 60) continue;

    const views = Number(st.viewCount || 0);
    if (!Number.isFinite(views)) continue;

    const agoSec = publishedAt ? Math.max(0, Math.floor((nowMs - publishedAt) / 1000)) : null;

    candidates.push({
      video_id: id,
      url: `https://www.youtube.com/shorts/${id}`,
      title,
      channel_title: channelTitle,
      views,
      published_ago_sec: agoSec,
      topic: topicFromTitle(title),
    });
  }

  candidates.sort((a, b) => (b.views ?? 0) - (a.views ?? 0));

  const top = candidates.slice(0, opt.maxItems);

  const payload = buildLatestJson(top);
  const err = validateLatestJson(payload);
  if (err) die("latest.json validation failed: " + err);

  const outPath = path.join(process.cwd(), "latest.json");
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf-8");
  console.log("Wrote:", outPath, "items:", top.length);

  if (opt.selftest) {
    if (top.length === 0) die("selftest failed: no items");
    const sample = top[0];
    console.log("selftest ok. sample:", {
      video_id: sample.video_id,
      views: sample.views,
      topic: sample.topic,
    });
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
