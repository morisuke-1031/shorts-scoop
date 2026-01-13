// scripts/build_latest_dummy.js
// Node.jsだけで動くダミー生成。YouTube API接続前の検証用。
// 目的: Actionsが "latest.json を更新してコミット" できることを確認する。

const fs = require("fs");
const path = require("path");

function pad(n){ return String(n).padStart(2, "0"); }
function jstNow(){
  // GitHub ActionsはUTCが多いので、固定でJST +9hに寄せる
  const d = new Date(Date.now() + 9*60*60*1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} JST`;
}
function randInt(min, max){
  return Math.floor(Math.random()*(max-min+1))+min;
}

const outPath = path.join(process.cwd(), "latest.json");

const topics = ["雑学","ライフハック","筋トレ","英語","料理","恋愛","副業"];
const base = [
  { title: "【保存推奨】1分で分かる○○（テンポ命）", ch: "毎日ショート研究所" },
  { title: "これ知らないと損する…○○の裏技", ch: "ライフハック短編集" },
  { title: "3日で変わる！○○トレ（初心者向け）", ch: "筋トレショーツ" },
  { title: "英語が一瞬で出る○○フレーズ", ch: "英語ショート部" },
  { title: "料理が爆速になる○○だけ", ch: "ズボラ飯Shorts" }
];

const items = base.map((b, i) => {
  const views = randInt(200000, 1800000);
  const ago = randInt(60*30, 60*60*24); // 30分〜24時間
  const topic = topics[randInt(0, topics.length-1)];
  const vid = `dummy${String(i+1).padStart(3,"0")}`;
  return {
    video_id: vid,
    url: `https://www.youtube.com/shorts/${vid}`,
    title: b.title,
    channel_title: b.ch,
    views,
    published_ago_sec: ago,
    topic
  };
}).sort((a,b)=> b.views - a.views);

const payload = {
  updated_at: jstNow(),
  source: "dummy",
  region: "JP",
  items
};

fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf-8");
console.log("Wrote:", outPath);
