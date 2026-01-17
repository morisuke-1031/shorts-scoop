# scripts/make_rank_video.py
# - 720x1280 縦
# - latest.json 上からTOP3
# - 背景動画 + BGM 合成
# - 表示：TOP(色付き) → タイトル(20字目安で改行, 最大2行) → チャンネル/再生数
# - デザイン：縁取り(border)＋影(shadow)で統一（軽い）
# - 安定化：latest.json が空/途中でも落ちない（リトライ＋バックアップ読み）

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Dict, List, Tuple


JST = timezone(timedelta(hours=9))


def die(msg: str, code: int = 1) -> None:
    print(msg, flush=True)
    raise SystemExit(code)


def which_ffmpeg() -> str:
    exe = shutil.which("ffmpeg")
    if not exe:
        die("ffmpeg が見つかりません。ffmpeg をインストールして PATH に通してください。")
    return exe


def run(cmd: List[str]) -> None:
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    out = p.stdout or b""
    try:
        s = out.decode("utf-8")
    except UnicodeDecodeError:
        s = out.decode("cp932", errors="replace")

    if p.returncode != 0:
        print(s)
        die(f"ffmpeg failed (code={p.returncode})")


def pick_font_default() -> str:
    win = os.environ.get("WINDIR")
    if win:
        candidates = [
            Path(win) / "Fonts" / "meiryob.ttc",
            Path(win) / "Fonts" / "meiryo.ttc",
            Path(win) / "Fonts" / "msgothic.ttc",
            Path(win) / "Fonts" / "YuGothB.ttc",
            Path(win) / "Fonts" / "YuGothM.ttc",
        ]
        for c in candidates:
            if c.exists():
                return str(c)

    linux_candidates = [
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc",
        "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
    ]
    for c in linux_candidates:
        if Path(c).exists():
            return c

    return ""


def ffmpeg_escape_text(s: str) -> str:
    s = s.replace("\\", "\\\\")
    s = s.replace("'", "\\'")
    s = s.replace(":", "\\:")
    s = s.replace("%", "\\%")
    s = s.replace("\r\n", "\n").replace("\r", "\n")
    return s


def ffmpeg_quote_fontfile(p: str) -> str:
    v = p.replace("\\", "\\\\").replace(":", "\\:")
    return "'" + v.replace("'", "\\'") + "'"


def normalize_spaces(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def truncate(s: str, max_chars: int) -> str:
    s = normalize_spaces(s)
    if len(s) <= max_chars:
        return s
    return s[: max_chars - 1] + "…"


# ---- 安定化：JSON読み（空/途中を避ける） ----
def read_text_stable(path: Path, *, retries: int = 6, sleep_sec: float = 0.25) -> str:
    """
    - 0バイトや取得途中の可能性があるので、少し待って複数回読む
    - 2回連続で同じサイズ & 同じ先頭（簡易）になったら安定とみなす
    """
    last_sig = None
    last_txt = ""
    for i in range(retries):
        try:
            if not path.exists():
                time.sleep(sleep_sec)
                continue

            st = path.stat()
            if st.st_size <= 0:
                time.sleep(sleep_sec)
                continue

            txt = path.read_text(encoding="utf-8", errors="strict")
            sig = (st.st_size, txt[:64])

            if last_sig == sig:
                return txt  # 安定
            last_sig = sig
            last_txt = txt

            time.sleep(sleep_sec)
        except UnicodeDecodeError:
            # 文字コード崩れは稀だが一応待つ
            time.sleep(sleep_sec)
        except Exception:
            time.sleep(sleep_sec)

    # 最後に読めたものがあれば返す（空は返さない）
    if last_txt.strip():
        return last_txt
    raise ValueError("latest.json が空、または読み取りに失敗しました（生成/取得中の可能性）")


def load_json_resilient(latest_json: Path) -> Dict[str, Any]:
    """
    JSONDecodeError対策：
    1) latest.json を安定読み
    2) 失敗したら .bak / .tmp などをフォールバック
    """
    candidates = [
        latest_json,
        latest_json.with_suffix(latest_json.suffix + ".bak"),
        latest_json.with_suffix(".bak"),
        latest_json.with_name(latest_json.name + ".bak"),
        latest_json.with_name(latest_json.stem + ".tmp"),
        latest_json.with_name(latest_json.name + ".tmp"),
    ]

    errors: List[str] = []
    for p in candidates:
        if not p.exists():
            continue
        try:
            txt = read_text_stable(p)
            return json.loads(txt)
        except Exception as e:
            errors.append(f"{p.name}: {e}")

    # ここまでダメなら原因は「最新が空/途中」
    msg = "latest.json の読み取りに失敗しました。\n" + "\n".join(errors[-5:])
    raise ValueError(msg)


# ---- ラップ（不自然な分割を避ける） ----
_SPLIT_HINT = re.compile(r"([ 　/|｜・、。,\.\-\–—_#\(\)\[\]【】「」『』])")


def smart_wrap(s: str, width: int, max_lines: int = 2) -> List[str]:
    """
    20文字目安で折り返すが、できるだけ「区切り文字（空白/記号）」で折る。
    それでも無理なら文字数で切る。
    """
    s = normalize_spaces(s)
    if not s:
        return [""]

    # 区切り記号を保持したままトークン化
    parts = [p for p in _SPLIT_HINT.split(s) if p != ""]
    lines: List[str] = []
    cur = ""

    def push_line(x: str) -> None:
        nonlocal cur
        if x.strip():
            lines.append(x.strip())
        cur = ""

    for token in parts:
        # 先頭に区切りだけが来ないよう調整
        if cur == "" and _SPLIT_HINT.fullmatch(token or ""):
            continue

        if len(cur) + len(token) <= width:
            cur += token
            continue

        # これ以上入らない → 行確定
        if cur.strip():
            push_line(cur)
        else:
            # token自体が長すぎる（区切りなし長文）→強制分割
            push_line(token[:width])
            rest = token[width:]
            if rest:
                cur = rest

        if len(lines) >= max_lines:
            break

    if len(lines) < max_lines and cur.strip():
        push_line(cur)

    # 超過は … で締める
    if len(lines) > max_lines:
        lines = lines[:max_lines]

    joined_len = sum(len(x) for x in lines)
    if joined_len < len(s) and lines:
        last = lines[-1]
        lines[-1] = (last[:-1] + "…") if len(last) >= 1 else "…"

    # max_linesを満たさない場合でもOK
    return lines[:max_lines]


def drawtext_text(s: str) -> str:
    s = s.replace("\r\n", "\n").replace("\r", "\n")
    parts = s.split("\n")
    parts = [ffmpeg_escape_text(p) for p in parts]
    return "\\n".join(parts)


def fmt_views(v: Any) -> str:
    try:
        n = int(v)
    except Exception:
        return str(v)
    return f"{n:,}回"


def load_top3(latest_json: Path) -> Tuple[str, List[Dict[str, Any]]]:
    data = load_json_resilient(latest_json)
    updated_at = str(data.get("updated_at") or "").strip()
    items = data.get("items")
    if not isinstance(items, list) or len(items) < 3:
        die("latest.json の items が不足しています（3件以上必要）")
    top3 = items[:3]
    for i, it in enumerate(top3, 1):
        if not isinstance(it, dict):
            die(f"items[{i}] が dict ではありません")
        for k in ("title", "channel_title", "views"):
            if k not in it:
                die(f"items[{i}] に '{k}' がありません")
    return updated_at, top3


def jst_today_yyyymmdd() -> str:
    return datetime.now(JST).strftime("%Y/%m/%d")


def build_filter(*, w: int, h: int, seconds: int, fontfile: str, header: str, blocks: List[Dict[str, Any]], cta: str) -> str:
    if len(blocks) != 3:
        die("internal: blocks must be length 3")

    cta_start = max(1, seconds - 3)
    main_end = cta_start - 0.05

    fs_header = 30
    fs_rank = 42
    fs_title = 36
    fs_meta = 30
    fs_footer = 26
    fs_cta = 44

    y_header = 105

    # 1ブロック内を「rank → title → meta」でギュッと固める
    y1_rank, y1_title, y1_meta = 240, 300, 360
    y2_rank, y2_title, y2_meta = 500, 560, 620
    y3_rank, y3_title, y3_meta = 800, 860, 920

    # CTAを中央寄りに
    y_cta = 600

    enable_main = f"between(t,0,{main_end})"
    enable_cta = f"between(t,{cta_start},{seconds})"

    rank_colors = {
        1: "FFD54A",  # gold
        2: "D7D7D7",  # silver
        3: "FFFFFF",  # white
    }

    def dt(
        text: str,
        x: str,
        y: int,
        fs: int,
        enable: str,
        *,
        color_hex: str = "FFFFFF",
        borderw: int = 4,
        border_a: float = 0.90,
        shadow_a: float = 0.45,
        shadowx: int = 2,
        shadowy: int = 2,
    ) -> str:
        t = drawtext_text(text)
        font_part = f"fontfile={ffmpeg_quote_fontfile(fontfile)}:" if fontfile else ""
        return (
            f"drawtext={font_part}text='{t}':"
            f"x={x}:y={y}:fontsize={fs}:fontcolor={color_hex}:"
            f"borderw={borderw}:bordercolor=black@{border_a}:"
            f"shadowcolor=black@{shadow_a}:shadowx={shadowx}:shadowy={shadowy}:"
            f"enable='{enable}'"
        )

    filters: List[str] = []
    filters.append(f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}")
    filters.append("eq=brightness=-0.02:contrast=1.10:saturation=1.02")

    filters.append(
        dt(
            header,
            "(w-text_w)/2",
            y_header,
            fs_header,
            enable_main,
            color_hex="FFFFFF",
            borderw=5,
            border_a=0.92,
            shadow_a=0.50,
            shadowx=2,
            shadowy=2,
        )
    )

    positions = [
        (y1_rank, y1_title, y1_meta),
        (y2_rank, y2_title, y2_meta),
        (y3_rank, y3_title, y3_meta),
    ]
    for idx, (y_rank, y_title, y_meta) in enumerate(positions):
        b = blocks[idx]
        rank_no = idx + 1

        is_top1 = bool(b.get("is_top1"))
        rank_borderw = 6 if is_top1 else 5
        title_borderw = 5 if is_top1 else 4

        filters.append(
            dt(
                str(b["rank"]),
                "(w-text_w)/2",
                y_rank,
                fs_rank,
                enable_main,
                color_hex=rank_colors.get(rank_no, "FFFFFF"),
                borderw=rank_borderw,
                border_a=0.92,
                shadow_a=0.55 if is_top1 else 0.45,
                shadowx=3 if is_top1 else 2,
                shadowy=3 if is_top1 else 2,
            )
        )

        filters.append(
            dt(
                str(b["title"]),
                "(w-text_w)/2",
                y_title,
                fs_title,
                enable_main,
                color_hex="FFFFFF",
                borderw=title_borderw,
                border_a=0.90,
                shadow_a=0.45,
                shadowx=2,
                shadowy=2,
            )
        )

        filters.append(
            dt(
                str(b["meta"]),
                "(w-text_w)/2",
                y_meta,
                fs_meta,
                enable_main,
                color_hex="FFFFFF",
                borderw=4,
                border_a=0.88,
                shadow_a=0.40,
                shadowx=2,
                shadowy=2,
            )
        )

    filters.append(
        dt(
            "shorts-ranking.com",
            "(w-text_w)/2",
            h - 120,
            fs_footer,
            enable_main,
            color_hex="FFFFFF",
            borderw=3,
            border_a=0.70,
            shadow_a=0.30,
            shadowx=1,
            shadowy=1,
        )
    )

    filters.append(
        dt(
            cta,
            "(w-text_w)/2",
            y_cta,
            fs_cta,
            enable_cta,
            color_hex="FFFFFF",
            borderw=6,
            border_a=0.92,
            shadow_a=0.55,
            shadowx=3,
            shadowy=3,
        )
    )

    return ",".join(filters)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--latest_json", required=True)
    ap.add_argument("--bg", required=True)
    ap.add_argument("--bgm", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--seconds", type=int, default=15)
    ap.add_argument("--w", type=int, default=720)
    ap.add_argument("--h", type=int, default=1280)
    ap.add_argument("--bgm_volume", type=float, default=0.22)
    ap.add_argument("--date", default="", help="空ならJST今日（例: 2026/01/17）")
    ap.add_argument("--font", default="", help="空なら自動検出")
    ap.add_argument("--title_width", type=int, default=20, help="タイトル1行の最大文字数（強制改行）")
    ap.add_argument("--title_lines", type=int, default=2, help="タイトル最大行数")
    ap.add_argument("--channel_width", type=int, default=18, help="チャンネル名の最大文字数")
    args = ap.parse_args()

    ffmpeg = which_ffmpeg()

    latest_json = Path(args.latest_json)
    bg = Path(args.bg)
    bgm = Path(args.bgm)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    for p in (latest_json, bg, bgm):
        if not p.exists():
            die(f"ファイルが見つかりません: {p}")

    updated_at, top3 = load_top3(latest_json)

    date_str = args.date.strip() or jst_today_yyyymmdd()
    header = f"{date_str} ショート動画再生数ランキング"
    cta = "概要欄からランキングをチェック！"
    fontfile = args.font.strip() or pick_font_default()

    blocks: List[Dict[str, Any]] = []
    for i, it in enumerate(top3, 1):
        title_raw = str(it.get("title", ""))
        # 20文字目安で、区切り記号優先のスマートラップ（不自然な分断を避ける）
        title_lines = smart_wrap(title_raw, width=args.title_width, max_lines=args.title_lines)
        title_block = "\n".join(title_lines)

        views = fmt_views(it.get("views"))
        ch = truncate(str(it.get("channel_title", "")), args.channel_width)
        meta_line = f"{ch}  /  {views}"

        blocks.append(
            {
                "rank": f"TOP{i}",
                "title": title_block,
                "meta": meta_line,
                "is_top1": (i == 1),
            }
        )

    vf = build_filter(
        w=args.w,
        h=args.h,
        seconds=args.seconds,
        fontfile=fontfile,
        header=header,
        blocks=blocks,
        cta=cta,
    )

    cmd = [
        ffmpeg,
        "-y",
        "-stream_loop", "-1",
        "-i", str(bg),
        "-stream_loop", "-1",
        "-i", str(bgm),
        "-t", str(args.seconds),
        "-vf", vf,
        "-r", "30",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-profile:v", "high",
        "-level", "4.0",
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-af", f"volume={args.bgm_volume}",
        "-c:a", "aac",
        "-b:a", "128k",
        str(out),
    ]

    print("=== INFO ===")
    print(f"latest.json updated_at: {updated_at}")
    print("TOP3:")
    for b in blocks:
        t = str(b["title"]).replace("\n", " / ")
        print(f"  {b['rank']}  {t}  |  {b['meta']}")
    print(f"fontfile: {fontfile or '(auto)'}")
    print("============")

    run(cmd)
    print(f"OK: wrote {out}")


if __name__ == "__main__":
    main()
