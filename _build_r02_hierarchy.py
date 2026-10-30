# -*- coding: utf-8 -*-
"""晶睿TY2 R02 電力/CDA/排氣 PDF → 層級專案 nodes (L1/L2/L3)."""
import json
from datetime import datetime, date
from pathlib import Path

YEAR = 2026

def d(md):
    if not md:
        return ""
    m, day = md.split("/")
    return f"{YEAR}/{int(m):02d}/{int(day):02d}"

def parse_d(s):
    if not s:
        return None
    y, m, day = s.split("/")
    return date(int(y), int(m), int(day))

def days_between(start, finish):
    a, b = parse_d(start), parse_d(finish)
    if not a or not b:
        return 0
    return max(0, (b - a).days + 1)

def nid(*parts):
    return "n_" + "_".join(str(p) for p in parts)

# L1 project (PDF 紅框)
L1_NAME = "晶睿科技股份有限公司TY2廠2樓-R02產線電力、CDA及排氣工程"

# L2 (橘) → L3 (綠)：name, pct, start, finish, note
PHASES = [
    ("前置作業", [
        ("得標通知及訂單開立(By業主)", 1.0, "10/19", "10/21", "By業主"),
        ("採購發包作業", 1.0, "10/20", "10/22", ""),
        ("保險作業", 1.0, "10/19", "10/21", ""),
        ("配電盤設備送審", 0.6, "10/22", "10/28", ""),
        ("施工材料備料", 0.2, "10/21", "11/19", ""),
        ("人員及機具準備", 0.3, "10/21", "11/9", ""),
        ("人員進場教育訓練及工作證", 0.5, "10/21", "12/14", ""),
    ]),
    ("設備製造", [
        ("配電盤(送審簽認後35天到場)", 0.0, "10/29", "12/2", ""),
        ("照明燈具(業主提供既有延用)", 0.0, "11/16", "11/20", "業主提供既有延用"),
    ]),
    ("R10區域（電力／空壓）", [
        ("業主既有移出清空完成(By業主)", 1.0, "10/22", "10/24", "By業主"),
        ("臨時防護", 1.0, "10/24", "10/24", ""),
        ("電力照明插座配設", 0.22, "10/24", "11/15", ""),
        ("空壓配設", 0.0, "11/16", "11/18", ""),
    ]),
    ("R11/R12區域（電力／空壓）", [
        ("業主R11停線R12淨空(By業主)", 0.0, "10/30", "10/30", "By業主；R11需停線及R12工區淨空"),
        ("臨時防護", 0.0, "10/31", "10/31", ""),
        ("電力照明插座配設", 0.0, "11/1", "11/15", ""),
        ("空壓配設", 0.0, "11/16", "11/18", ""),
    ]),
    ("R02前半段（電力／空壓／排氣）", [
        ("業主既有移出清空完成(By業主)", 0.0, "11/14", "11/14", "By業主需淨空"),
        ("臨時防護", 0.0, "11/15", "11/15", ""),
        ("電力照明插座配設", 0.0, "11/19", "11/28", ""),
        ("空壓配設", 0.0, "11/29", "12/1", ""),
        ("排氣配設", 0.0, "11/14", "11/28", ""),
    ]),
    ("R02後半段（電力／空壓）", [
        ("業主既有移出清空完成(By業主)", 0.0, "11/28", "11/28", "By業主需淨空"),
        ("臨時防護", 0.0, "11/29", "11/29", ""),
        ("電力照明插座配設", 0.0, "11/28", "12/12", ""),
        ("空壓配設", 0.0, "12/13", "12/15", ""),
    ]),
    ("竣工驗收", [
        ("收尾及竣工", 0.0, "12/10", "12/15", ""),
        ("缺失改善及驗收", 0.0, "12/14", "12/16", ""),
    ]),
]

nodes = []
id1 = "n1"
nodes.append({
    "id": id1, "parentId": "", "level": 1, "name": L1_NAME,
    "days": 0, "pct": 0, "start": "", "finish": "", "note": "PDF 紅框＝第1層"
})

for pi, (phase, tasks) in enumerate(PHASES, start=1):
    id2 = f"n2_{pi}"
    nodes.append({
        "id": id2, "parentId": id1, "level": 2, "name": phase,
        "days": 0, "pct": 0, "start": "", "finish": "", "note": "PDF 橘框＝第2層"
    })
    for ti, (name, pct, s, f, note) in enumerate(tasks, start=1):
        start, finish = d(s), d(f)
        nodes.append({
            "id": f"n3_{pi}_{ti}", "parentId": id2, "level": 3, "name": name,
            "days": days_between(start, finish),
            "pct": float(pct),
            "start": start, "finish": finish,
            "note": note or "PDF 綠框＝第3層"
        })

# rollup L2 / L1
by_id = {n["id"]: n for n in nodes}
children = {}
for n in nodes:
    children.setdefault(n["parentId"], []).append(n)

def rollup(parent):
    kids = children.get(parent["id"], [])
    if not kids:
        return
    for k in kids:
        if k["level"] < 3:
            rollup(k)
    parent["pct"] = sum(k["pct"] for k in kids) / len(kids)
    starts = sorted([k["start"] for k in kids if k["start"]])
    finishes = sorted([k["finish"] for k in kids if k["finish"]])
    if starts:
        parent["start"] = starts[0]
    if finishes:
        parent["finish"] = finishes[-1]
    parent["days"] = days_between(parent["start"], parent["finish"]) if parent["start"] and parent["finish"] else sum(k["days"] for k in kids)

rollup(by_id[id1])

payload = {
    "arch": "hierarchy",
    "source": "進度表 晶睿TY2 2樓-R02產線電力、CDA及排氣工程20261026R 2.pdf",
    "title": "R02水電工程｜層級進度",
    "subtitle": "週次：2026/10/26　｜　晶睿TY2-2樓-R02產線電力／CDA／排氣　｜　層級架構（紅／橘／綠）　｜　整體約{:.0f}%".format(by_id[id1]["pct"] * 100),
    "projectName": "R02水電工程",
    "savedAt": datetime.now().isoformat(timespec="seconds"),
    "built": datetime.now().strftime("%Y/%m/%d %H:%M"),
    "note": "※ 由施工進度表 PDF 匯入層級架構。紅＝第1層專案、橘＝第2層階段、綠＝第3層工作項。",
    "equipment": [],
    "milestones": [],
    "stages": [],
    "segOrder": [],
    "nodes": nodes,
}

out_dir = Path(__file__).resolve().parent / "seeds"
out_dir.mkdir(exist_ok=True)
out = out_dir / "R02水電工程_hierarchy.json"
out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
print("nodes", len(nodes), "L1 pct", round(by_id[id1]["pct"] * 100, 1), "->", out)
