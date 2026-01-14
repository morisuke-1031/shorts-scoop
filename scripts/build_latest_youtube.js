#!/usr/bin/env node
/**
 * Build latest.json from YouTube Data API v3
 * - regionCode=JP を基本にしつつ、クエリで「日本っぽさ」を優先
 * - search.list -> videos.list で詳細(views, thumbnails)を付与
 *
 * Usage:
 *   node scripts/build_latest_youtube.js --max 200 --hours 36 --perQuery 25 --selftest
 */
"use strict";

const fs = require("fs");
const path = require("path");

const API_BASE = "https://www.googleapis.com/youtube/v3";

function die(msg){
  console.error(msg);
  process.exit(1);
}

function parseArgs(argv){
  const out = { max: 200, hours: 36, perQuery: 25, selftest: false };
  for (let i=2; i<argv.length; i++){
    const a = argv[i];
    if (a === "--selftest") { out.selftest = true; continue; }
    if (a.startsWith("--max")) out.max = Number(argv[++i]);
    else if (a.startsWith("--hours")) out.hours = Number(argv[++i]);
    else if (a.startsWith("--perQuery")) out.perQuery = Number(argv[++i]);
    else die(`unknown arg: ${a}`);
  }
  if (!Number.isFinite(out.max) || out.max <= 0) die("--max must be positive number");
  if (!Number.isFinite(out.hours) || out.hours <= 0) die("--hours must be positive number");
  if (!Number.isFinite(out.perQuery) || out.perQuery <= 0) die("--perQuery must be positive number");
  // YouTube search.list maxResults is 50
  out.perQuery = Math.min(50, Math.max(1, Math.floor(out.perQuery)));
  out.max = Math.min(500, Math.max(1, Math.floor(out.max))); // 安全ガード（将来拡張の余地）
  return out;
}

async function ytFetch(endpoint, params){
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) die("Missing env: YOUTUBE_API_KEY");

  const usp = new URLSearchParams({ ...params, key });
  const url = `${API_BASE}/${endpoint}?${usp.toString()}`;
  const res = await fetch(url);
  if (!res.ok){
    const text = await res.text().catch(()=> "");
    throw new Error(`YouTube API error ${res.status}: ${text.slice(0,300)}`);
  }
  return await res.json();
}

function toISO(d){
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function pickBestThumb(th){
  if (!th) return null;
  // maxres は存在しないことも多いので、high/standard/medium/default の順で
  return (th.maxres && th.maxres.url) ||
         (th.standard && th.standard.url) ||
         (th.high && th.high.url) ||
         (th.medium && th.medium.url) ||
         (th.default && th.default.url) ||
         null;
}

// ゆるいカテゴリ推定（MVP用途）
function guessTopic(title, channelTitle){
  const s = `${title || ""} ${channelTitle || ""}`.toLowerCase();

  const has = (...words) => words.some(w => s.includes(w));

  if (has("筋トレ","ダイエット","腹筋","腕立て","プロテイン","workout","fitness","diet")) return "筋トレ";
  if (has("料理","レシピ","ごはん","飯","グルメ","cooking","recipe")) return "料理";
  if (has("英語","english","toeic","発音","フレーズ")) return "英語";
  if (has("恋愛","line","彼氏","彼女","カップル","片思い","告白","デート")) return "恋愛";
  if (has("雑学","豆知識","知らない","ランキング","top","知ってた","トリビア","やばい理由")) return "雑学";
  if (has("ライフハック","裏技","時短","便利","lifehack","hack")) return "ライフハック";

  // コント/あるある/お笑い/エンタメ寄り
  if (has("コント","あるある","お笑い","爆笑","comed","funny","meme","ネタ","ドッキリ","検証","vlog","ゲーム","実況")) return "エンタメ";

  return "未分類";
}

async function searchIds({ q, publishedAfterISO, perQuery, regionCode="JP" }){
  const js = await ytFetch("search", {
    part: "id",
    type: "video",
    videoDuration: "short",
    order: "viewCount",
    maxResults: String(perQuery),
    regionCode,
    relevanceLanguage: "ja",
    publishedAfter: publishedAfterISO,
    q,
  });

  const items = js.items || [];
  const ids = [];
  for (const it of items){
    const vid = it && it.id && it.id.videoId;
    if (vid) ids.push(vid);
  }
  return ids;
}

async function fetchVideoDetails(ids){
  if (ids.length === 0) return [];

  // videos.list: 1回で最大50
  const js = await ytFetch("videos", {
    part: "snippet,statistics",
    id: ids.join(","),
    maxResults: "50",
  });

  const out = [];
  for (const v of (js.items || [])){
    const video_id = v.id;
    const sn = v.snippet || {};
    const st = v.statistics || {};
    const title = sn.title || "";
    const channel_title = sn.channelTitle || "";
    const publishedAt = sn.publishedAt ? Date.parse(sn.publishedAt) : null;

    const thumbnail_url = pickBestThumb(sn.thumbnails);
    const views = st.viewCount != null ? Number(st.viewCount) : null;

    out.push({
      video_id,
      url: `https://www.youtube.com/shorts/${video_id}`,
      title,
      channel_title,
      views,
      published_at: sn.publishedAt || null,
      published_ms: Number.isFinite(publishedAt) ? publishedAt : null,
      thumbnail_url,
      topic: guessTopic(title, channel_title),
    });
  }
  return out;
}

async function main(){
  const args = parseArgs(process.argv);
  const { max, hours, perQuery, selftest } = args;

  const now = Date.now();
  const publishedAfterISO = toISO(new Date(now - hours * 3600 * 1000));

  // 200件を取りに行くので、クエリを増やして枯渇を防ぐ（JP優先・ただしガチガチにしない）
  const queries = [
    // ベース
    "shorts",
    "YouTube shorts",

    // 日本寄り
    "日本",
    "あるある",
    "コント",
    "切り抜き",
    "検証",
    "ドッキリ",
    "料理",
    "レシピ",
    "筋トレ",
    "ダイエット",
    "雑学",
    "豆知識",
    "英語",
    "恋愛",
    "カップル",
    "line",
    "ライフハック",
    "裏技",
    "時短",
    "便利",

    // ジャンル拡張
    "ゲーム",
    "実況",
    "アニメ",
    "漫画",
    "vtuber",
    "kpop",
    "音楽",
    "解説",
    "ランキング",
    "top",
    "衝撃",
    "泣ける",
    "感動",
  ];

  const idSet = new Set();
  const ids = [];

  for (const q of queries){
    if (ids.length >= max) break;

    const got = await searchIds({ q, publishedAfterISO, perQuery, regionCode: "JP" });
    for (const vid of got){
      if (ids.length >= max) break;
      if (idSet.has(vid)) continue;
      idSet.add(vid);
      ids.push(vid);
    }
  }

  // まだ足りない場合は、クエリ無しで1回拾う（JP優先で広く）
  if (ids.length < max){
    const got = await searchIds({ q: "", publishedAfterISO, perQuery, regionCode: "JP" });
    for (const vid of got){
      if (ids.length >= max) break;
      if (idSet.has(vid)) continue;
      idSet.add(vid);
      ids.push(vid);
    }
  }

  // details 取得（50件ずつ）
  const items = [];
  for (let i=0; i<ids.length; i+=50){
    const chunk = ids.slice(i, i+50);
    const det = await fetchVideoDetails(chunk);
    items.push(...det);
  }

  // published_ago_sec を付与
  const outItems = items
    .map(it => {
      let published_ago_sec = null;
      if (it.published_ms != null){
        const diff = Math.max(0, Math.floor((now - it.published_ms) / 1000));
        published_ago_sec = diff;
      }
      return {
        video_id: it.video_id,
        url: it.url,
        title: it.title,
        channel_title: it.channel_title,
        views: it.views,
        published_ago_sec,
        topic: it.topic,
        thumbnail_url: it.thumbnail_url || null,
      };
    })
    // viewsが取れないものは後ろへ
    .sort((a,b)=> (b.views ?? -1) - (a.views ?? -1))
    .slice(0, max);

  const jst = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
    hour12: false
  }).format(new Date());

  const payload = {
    updated_at: `${jst.replaceAll("/", "-").replace(" ", " ")} JST`,
    source: "youtube-data-api",
    region: "JP",
    items: outItems
  };

  const outPath = path.join(process.cwd(), "latest.json");
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf-8");
  console.log(`wrote ${outPath} items=${outItems.length}`);

  if (selftest){
    if (!Array.isArray(outItems) || outItems.length === 0) die("selftest failed: no items");
    const sample = outItems[0];
    console.log("selftest ok. sample:", {
      video_id: sample.video_id,
      views: sample.views,
      topic: sample.topic,
      thumbnail_url: sample.thumbnail_url,
    });
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
