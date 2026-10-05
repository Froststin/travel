"""產生「旅遊｜投資」雙分頁圖文選單的兩張圖（2500×1686）。

只有綁定投資日報的人會看到這組選單；其他人仍是原本的 gas/richmenu-v2.png。
執行：python tools/make_invest_menu.py（需要 Pillow，字型用 macOS 內建的蘋方與 Apple Color Emoji）
改了圖要把 gas/Invest.gs 的 INVEST_MENU_VERSION 加 1，檔名跟著換。
"""

import glob
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W, H, TAB_H = 2500, 1686, 250
VERSION = sys.argv[1] if len(sys.argv) > 1 else "1"
OUT = Path(__file__).resolve().parent.parent / "gas"

PINGFANG = (glob.glob("/System/Library/AssetsV2/com_apple_MobileAsset_Font*/*/AssetData/PingFang.ttc")
            + glob.glob("/System/Library/Fonts/**/PingFang.ttc", recursive=True))[0]
EMOJI = "/System/Library/Fonts/Apple Color Emoji.ttc"


def font(size, weight="Semibold"):
    index = {"Regular": 2, "Medium": 6, "Semibold": 10, "Light": 14}[weight]  # PingFang TC
    return ImageFont.truetype(PINGFANG, size, index=index)


def emoji(char, size):
    """Apple Color Emoji 只有固定幾種點陣大小：先用 160 畫，再縮放到需要的大小。"""
    f = ImageFont.truetype(EMOJI, 160)
    tile = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
    ImageDraw.Draw(tile).text((100, 100), char, font=f, embedded_color=True, anchor="mm")
    return tile.resize((size, size), Image.LANCZOS)


def draw_cell(img, box, colors, icon, title, subtitle):
    x0, y0, x1, y1 = box
    d = ImageDraw.Draw(img)
    d.rectangle(box, fill=colors["cell"])
    d.rectangle(box, outline=colors["line"], width=6)
    cx, h = (x0 + x1) // 2, y1 - y0
    size = 250
    pic = emoji(icon, size)
    img.paste(pic, (cx - size // 2, y0 + int(h * 0.11)), pic)
    title_font = font(112 if len(title) <= 4 else 96)
    d.text((cx, y0 + int(h * 0.62)), title, font=title_font, fill="#FFFFFF", anchor="mm")
    d.text((cx, y0 + int(h * 0.82)), subtitle, font=font(50, "Regular"), fill=colors["sub"], anchor="mm")


def draw_tabs(img, active, palettes):
    d = ImageDraw.Draw(img)
    for i, (key, label) in enumerate([("travel", "🧭  旅遊"), ("invest", "📈  投資")]):
        x0, x1 = i * W // 2, (i + 1) * W // 2
        on = key == active
        pal = palettes[key]
        d.rectangle((x0, 0, x1, TAB_H), fill=pal["tab_on"] if on else pal["tab_off"])
        icon, text = label.split("  ")
        pic = emoji(icon, 120)
        f = font(100 if on else 88, "Semibold" if on else "Regular")
        tw = d.textlength(text, font=f)
        start = (x0 + x1) // 2 - int(tw + 150) // 2
        if not on:
            pic.putalpha(pic.getchannel("A").point(lambda a: int(a * 0.55)))
        img.paste(pic, (start, TAB_H // 2 - 62), pic)
        d.text((start + 150, TAB_H // 2 - 6), text, font=f, fill="#FFFFFF" if on else "#B8C4C9", anchor="lm")
        if on:
            d.rectangle((x0 + 60, TAB_H - 16, x1 - 60, TAB_H), fill="#FFD54A")


PALETTES = {
    "travel": {"tab_on": "#17877B", "tab_off": "#0B4F49", "cells": ["#127268", "#17877B"], "line": "#0E5F57", "sub": "#CDEBE6"},
    "invest": {"tab_on": "#2A5C99", "tab_off": "#16324F", "cells": ["#1F4675", "#2A5C99"], "line": "#173A5E", "sub": "#CFE0F5"},
}

TRAVEL = [  # 上排 3 格、下排 4 格（跟原本的旅遊選單一樣）
    [("📆", "今天", "今天的行程"), ("🗓️", "明天", "明天的行程"), ("🧳", "所有旅程", "旅程列表")],
    [("📒", "旅遊日誌", "查看今天的紀錄"), ("🌐", "開啟網站", "編輯完整行程"), ("📤", "匯出備份", "PDF 與網站連結"), ("💡", "使用說明", "可以怎麼問")],
]
INVEST = [  # 上下各 3 格
    [("📂", "持股損益", "每檔收益率"), ("📝", "交易紀錄", "已實現損益"), ("📈", "報酬率", "每日損益")],
    [("🎯", "準確率", "模型勝率"), ("📊", "今日選股", "台股推薦"), ("🪙", "虛擬貨幣", "幣種推薦")],
]


def make(name, rows):
    pal = PALETTES[name]
    img = Image.new("RGB", (W, H), pal["line"])
    draw_tabs(img, name, PALETTES)
    row_h = (H - TAB_H) // len(rows)
    for r, cells in enumerate(rows):
        for c, (icon, title, subtitle) in enumerate(cells):
            x0, x1 = round(c * W / len(cells)), round((c + 1) * W / len(cells))
            colors = {"cell": pal["cells"][(r + c) % 2], "line": pal["line"], "sub": pal["sub"]}
            draw_cell(img, (x0, TAB_H + r * row_h, x1, TAB_H + (r + 1) * row_h), colors, icon, title, subtitle)
    path = OUT / f"investmenu-{name}-v{VERSION}.png"
    img.save(path, optimize=True)
    print(path.name, f"{path.stat().st_size / 1024:.0f} KB")


make("travel", TRAVEL)
make("invest", INVEST)
