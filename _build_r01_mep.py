# -*- coding: utf-8 -*-
"""Convert 晶睿TY2 R02 電力/CDA/排氣 PDF schedule → line_data.json for R01水電工程."""
import json
from datetime import datetime
from pathlib import Path

YEAR = 2026

def d(md):
    """10/19 → 2026/10/19"""
    m, day = md.split("/")
    return f"{YEAR}/{int(m):02d}/{int(day):02d}"

def status_of(pct):
    if pct >= 1:
        return "已完成"
    if pct > 0:
        return "進行中"
    return "未開始"

def item(name, pct, start, finish, urg="中", note=""):
    p = float(pct)
    return {
        "item": name,
        "pct": p,
        "urg": urg,
        "start": d(start) if start else "",
        "due": d(finish) if finish else "",
        "actual": d(finish) if p >= 1 and finish else "",
        "status": status_of(p),
        "note": note,
    }

def blank_stage(due=""):
    return {"due": due, "items": []}

def make_eq(idx, seg, name, items, qty="1", pm="泰創", owner="", stage_dues=None, note_owner=""):
    """items go into stage0 (前置準備); other stages get due only for Gantt."""
    dues = stage_dues or ["", "", "", "", ""]
    while len(dues) < 5:
        dues.append("")
    # overall due = last item due
    last_due = ""
    for it in items:
        if it.get("due"):
            last_due = it["due"]
    stages = []
    for si in range(5):
        st = blank_stage(dues[si] or (last_due if si == 0 else ""))
        if si == 0:
            st["items"] = items
            if items:
                st["due"] = items[-1].get("due") or st["due"]
        stages.append(st)
    return {
        "idx": str(idx),
        "seg": seg,
        "name": name,
        "qty": qty,
        "pm": pm,
        "owner": owner or note_owner or "泰創工程",
        "startRow": 0,
        "stageOn": [True, True, True, True, True],
        "stages": stages,
    }

# --- WBS from PDF ---
equipment = []
n = 1

# 前置作業
prep_tasks = [
    ("得標通知及訂單開立(By業主)", 1.0, "10/19", "10/21", "高", "By業主"),
    ("採購發包作業", 1.0, "10/20", "10/22", "高", ""),
    ("保險作業", 1.0, "10/19", "10/21", "中", ""),
    ("配電盤設備送審", 0.6, "10/22", "10/28", "高", ""),
    ("施工材料備料", 0.2, "10/21", "11/19", "中", ""),
    ("人員及機具準備", 0.3, "10/21", "11/9", "中", ""),
    ("人員進場教育訓練及工作證", 0.5, "10/21", "12/14", "中", ""),
]
for name, pct, s, f, urg, own in prep_tasks:
    equipment.append(make_eq(n, "前置作業", name, [item(name, pct, s, f, urg)], owner=own or "泰創工程"))
    n += 1

# 設備製造
equipment.append(make_eq(
    n, "設備製造", "配電盤(送審簽認後35天到場)",
    [item("配電盤製造／到場", 0.0, "10/29", "12/2", "高")],
    owner="泰創工程",
))
n += 1
equipment.append(make_eq(
    n, "設備製造", "照明燈具(業主提供既有延用)",
    [item("照明燈具準備／延用", 0.0, "11/16", "11/20", "中", "業主提供既有延用")],
    owner="業主",
))
n += 1

# 區域安裝
equipment.append(make_eq(
    n, "區域安裝", "R10區域（電力／空壓）",
    [
        item("業主既有移出清空完成(By業主)", 1.0, "10/22", "10/24", "高", "By業主"),
        item("臨時防護", 1.0, "10/24", "10/24", "中"),
        item("電力照明插座配設", 0.22, "10/24", "11/15", "高"),
        item("空壓配設", 0.0, "11/16", "11/18", "中"),
    ],
    owner="泰創工程",
))
n += 1

equipment.append(make_eq(
    n, "區域安裝", "R11/R12區域（電力／空壓）",
    [
        item("業主R11停線R12淨空(By業主)", 0.0, "10/30", "10/30", "高", "By業主；R11需停線及R12工區淨空"),
        item("臨時防護", 0.0, "10/31", "10/31", "中"),
        item("電力照明插座配設", 0.0, "11/1", "11/15", "高"),
        item("空壓配設", 0.0, "11/16", "11/18", "中"),
    ],
    owner="泰創工程",
))
n += 1

equipment.append(make_eq(
    n, "區域安裝", "R02前半段（電力／空壓／排氣）",
    [
        item("業主既有移出清空完成(By業主)", 0.0, "11/14", "11/14", "高", "By業主需淨空"),
        item("臨時防護", 0.0, "11/15", "11/15", "中"),
        item("電力照明插座配設", 0.0, "11/19", "11/28", "高"),
        item("空壓配設", 0.0, "11/29", "12/1", "中"),
        item("排氣配設", 0.0, "11/14", "11/28", "高"),
    ],
    owner="泰創工程",
))
n += 1

equipment.append(make_eq(
    n, "區域安裝", "R02後半段（電力／空壓）",
    [
        item("業主既有移出清空完成(By業主)", 0.0, "11/28", "11/28", "高", "By業主需淨空"),
        item("臨時防護", 0.0, "11/29", "11/29", "中"),
        item("電力照明插座配設", 0.0, "11/28", "12/12", "高"),
        item("空壓配設", 0.0, "12/13", "12/15", "中"),
    ],
    owner="泰創工程",
))
n += 1

# 竣工驗收
equipment.append(make_eq(
    n, "竣工驗收", "收尾及竣工",
    [item("收尾及竣工", 0.0, "12/10", "12/15", "高")],
))
n += 1
equipment.append(make_eq(
    n, "竣工驗收", "缺失改善及驗收",
    [item("缺失改善及驗收", 0.0, "12/14", "12/16", "高")],
))

stages = [
    {"key": "prep", "name": "前置準備", "mark": "前置"},
    {"key": "mfg", "name": "設備製造", "mark": "製造"},
    {"key": "install", "name": "現場安裝", "mark": "安裝"},
    {"key": "finish", "name": "收尾", "mark": "收尾"},
    {"key": "accept", "name": "驗收", "mark": "驗收"},
]
seg_order = ["前置作業", "設備製造", "區域安裝", "竣工驗收"]

# milestones: start/finish of each seg across stages (approx from PDF)
milestones = [
    {"seg": "前置作業", "starts": ["2026/10/19", "2026/10/22", "", "", ""], "dates": ["2026/12/14", "2026/10/28", "", "", ""]},
    {"seg": "設備製造", "starts": ["2026/10/29", "2026/10/29", "", "", ""], "dates": ["2026/12/02", "2026/12/02", "", "", ""]},
    {"seg": "區域安裝", "starts": ["2026/10/22", "", "2026/10/22", "", ""], "dates": ["2026/12/15", "", "2026/12/15", "", ""]},
    {"seg": "竣工驗收", "starts": ["", "", "", "2026/12/10", "2026/12/14"], "dates": ["", "", "", "2026/12/15", "2026/12/16"]},
]

payload = {
    "source": "進度表 晶睿TY2 2樓-R02產線電力、CDA及排氣工程20261026R 2.pdf",
    "title": "R01水電工程｜架線進度",
    "subtitle": "週次：2026/10/26　｜　晶睿TY2-2樓-R02產線電力／CDA／排氣　｜　泰創工程　｜　整體約23%",
    "projectName": "R01水電工程",
    "savedAt": datetime.now().isoformat(timespec="seconds"),
    "built": datetime.now().strftime("%Y/%m/%d %H:%M"),
    "note": "※ 由施工進度表 PDF 匯入（2026/10/26）。細項完成率依進度表％；By業主項目請與業主進度同步更新。",
    "stages": stages,
    "segOrder": seg_order,
    "milestones": milestones,
    "equipment": equipment,
}

out_dir = Path(__file__).resolve().parent / "seeds"
out_dir.mkdir(exist_ok=True)
out = out_dir / "R01水電工程_line_data.json"
out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
# also copy to Downloads for easy pick
dl = Path(r"C:\Users\JASON.HUANG\Downloads") / "R01水電工程_line_data.json"
dl.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
print("eq", len(equipment), "->", out)
print("items", sum(len(e["stages"][0]["items"]) for e in equipment))
print("dl", dl)
