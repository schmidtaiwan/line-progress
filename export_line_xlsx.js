/**
 * 匯出四工作表 XLSX（對齊原檔紅框 sheets）
 * 依賴全域 XLSX（xlsx-js-style，可寫入底色／字色）
 */
(function (global) {
  "use strict";

  var TRACK = "架線項目清單管控";
  var WEEKLY = "架線周報";
  var OUTLOOK = "OUTLOOK周報預覽";
  var OVERVIEW = "架線階段進度總覽";
  var STAGE_ICONS = ["📋 ", "🔧 ", "🧪 ", "🔗 ", "🚀 "];
  var SEG_LABEL = {
    "板階段": "A. 板階段（架線前準備）",
    "組裝段": "B. 組裝段（架線前準備）",
    "測試段": "C. 測試段（架線前準備）"
  };

  // 高反差配色：深底淺字 或 淺底深字
  var C = {
    titleBg: "16324A", titleFg: "FFFFFF",
    subBg: "1F4E79", subFg: "F8FAFC",
    headBg: "0F2740", headFg: "FFFFFF",
    eqHeadBg: "1A5276", eqHeadFg: "FFFFFF",
    eqBodyBg: "D6EAF8", eqBodyFg: "0B2C4A",
    zebraBg: "EEF5FB",
    whiteBg: "FFFFFF", ink: "1C2430", muted: "334155",
    thin: "94A3B8",
    stageHead: [
      { bg: "C0392B", fg: "FFFFFF" }, // 準備：橘紅
      { bg: "B7950B", fg: "FFFFFF" }, // 架機：琥珀
      { bg: "1A5276", fg: "FFFFFF" }, // 單機：藍
      { bg: "196F3D", fg: "FFFFFF" }, // 整線：綠
      { bg: "6C3483", fg: "FFFFFF" }  // 上線：紫
    ],
    stageBody: [
      { bg: "FADBD8", fg: "641E16" },
      { bg: "FCF3CF", fg: "7D6608" },
      { bg: "D4E6F1", fg: "1B4F72" },
      { bg: "D5F5E3", fg: "145A32" },
      { bg: "E8DAEF", fg: "4A235A" }
    ],
    urgHigh: { bg: "922B21", fg: "FFFFFF" },
    urgMid: { bg: "B9770E", fg: "FFFFFF" },
    urgLow: { bg: "1E8449", fg: "FFFFFF" },
    stDelay: { bg: "922B21", fg: "FFFFFF" },
    stRun: { bg: "1A5276", fg: "FFFFFF" },
    stDone: { bg: "145A32", fg: "FFFFFF" },
    stIdle: { bg: "5D6D7E", fg: "FFFFFF" },
    segBoard: { bg: "1F6F9A", fg: "FFFFFF" },
    segAssy: { bg: "1C8A5A", fg: "FFFFFF" },
    segTest: { bg: "C0392B", fg: "FFFFFF" },
    secBg: "0E4D6C", secFg: "FFFFFF",
    topBg: "7B241C", topFg: "FFFFFF"
  };

  function rgb(hex) { return String(hex || "").replace(/^#/, "").toUpperCase(); }

  function cellStyle(fg, bg, opts) {
    opts = opts || {};
    var s = {
      font: {
        name: "Microsoft JhengHei",
        sz: opts.sz || 11,
        bold: !!opts.bold,
        color: { rgb: rgb(fg) }
      },
      fill: { patternType: "solid", fgColor: { rgb: rgb(bg) } },
      alignment: {
        horizontal: opts.h || "center",
        vertical: "center",
        wrapText: !!opts.wrap
      }
    };
    if (opts.border !== false) {
      var b = { style: "thin", color: { rgb: C.thin } };
      s.border = { top: b, bottom: b, left: b, right: b };
    }
    return s;
  }

  function ensureCell(ws, r, c) {
    var addr = XLSX.utils.encode_cell({ r: r, c: c });
    if (!ws[addr]) ws[addr] = { t: "s", v: "" };
    return ws[addr];
  }

  function paintCell(ws, r, c, style) {
    var cell = ensureCell(ws, r, c);
    cell.s = style;
    return cell;
  }

  function paintRange(ws, r0, c0, r1, c1, style) {
    for (var r = r0; r <= r1; r++) {
      for (var c = c0; c <= c1; c++) paintCell(ws, r, c, style);
    }
  }

  function sheetRange(ws) {
    var ref = ws["!ref"] || "A1";
    return XLSX.utils.decode_range(ref);
  }

  function urgStyle(v) {
    var s = String(v || "");
    if (s.indexOf("高") >= 0) return cellStyle(C.urgHigh.fg, C.urgHigh.bg, { bold: true });
    if (s.indexOf("低") >= 0) return cellStyle(C.urgLow.fg, C.urgLow.bg, { bold: true });
    return cellStyle(C.urgMid.fg, C.urgMid.bg, { bold: true });
  }

  function statusStyle(v) {
    var s = String(v || "");
    if (s.indexOf("延誤") >= 0) return cellStyle(C.stDelay.fg, C.stDelay.bg, { bold: true });
    if (s.indexOf("進行") >= 0) return cellStyle(C.stRun.fg, C.stRun.bg, { bold: true });
    if (s.indexOf("完成") >= 0) return cellStyle(C.stDone.fg, C.stDone.bg, { bold: true });
    return cellStyle(C.stIdle.fg, C.stIdle.bg, { bold: true });
  }

  function segStyle(v) {
    var s = String(v || "");
    if (s.indexOf("板") >= 0) return cellStyle(C.segBoard.fg, C.segBoard.bg, { bold: true });
    if (s.indexOf("組裝") >= 0) return cellStyle(C.segAssy.fg, C.segAssy.bg, { bold: true });
    if (s.indexOf("測試") >= 0) return cellStyle(C.segTest.fg, C.segTest.bg, { bold: true });
    return cellStyle(C.eqBodyFg, C.eqBodyBg, { bold: true });
  }

  function paintTrackSheet(ws, nStages) {
    var range = sheetRange(ws);
    var maxC = Math.max(range.e.c, 6 + nStages * 5);
    paintRange(ws, 0, 0, 0, maxC, cellStyle(C.titleFg, C.titleBg, { bold: true, sz: 14, h: "left", wrap: true }));
    paintRange(ws, 1, 0, 1, maxC, cellStyle(C.subFg, C.subBg, { bold: true, sz: 10, h: "left", wrap: true }));
    paintRange(ws, 2, 0, 2, 6, cellStyle(C.eqHeadFg, C.eqHeadBg, { bold: true, sz: 12 }));
    paintRange(ws, 3, 0, 3, 6, cellStyle(C.headFg, C.headBg, { bold: true, sz: 10, wrap: true }));
    for (var si = 0; si < nStages; si++) {
      var c0 = 7 + si * 5;
      var head = C.stageHead[si % C.stageHead.length];
      var body = C.stageBody[si % C.stageBody.length];
      paintRange(ws, 2, c0, 2, c0 + 4, cellStyle(head.fg, head.bg, { bold: true, sz: 12 }));
      paintRange(ws, 3, c0, 3, c0 + 4, cellStyle(head.fg, head.bg, { bold: true, sz: 10, wrap: true }));
      for (var r = 4; r <= range.e.r; r++) {
        for (var c = c0; c <= c0 + 4; c++) {
          var raw = ensureCell(ws, r, c).v;
          if (c === c0 + 2) paintCell(ws, r, c, urgStyle(raw));
          else if (c === c0 + 4) paintCell(ws, r, c, statusStyle(raw));
          else paintCell(ws, r, c, cellStyle(body.fg, body.bg, { h: c === c0 ? "left" : "center" }));
        }
      }
    }
    for (var rr = 4; rr <= range.e.r; rr++) {
      for (var cc = 0; cc <= 6; cc++) {
        var vv = ensureCell(ws, rr, cc).v;
        if (cc === 1 && vv) paintCell(ws, rr, cc, segStyle(vv));
        else paintCell(ws, rr, cc, cellStyle(C.eqBodyFg, C.eqBodyBg, { h: cc === 2 ? "left" : "center", bold: cc <= 2 }));
      }
    }
    ws["!rows"] = ws["!rows"] || [];
    ws["!rows"][0] = { hpt: 28 };
    ws["!rows"][2] = { hpt: 24 };
    ws["!rows"][3] = { hpt: 32 };
  }

  function paintSimpleTable(ws, headerRows, opts) {
    opts = opts || {};
    var range = sheetRange(ws);
    paintRange(ws, 0, 0, 0, range.e.c, cellStyle(C.titleFg, C.titleBg, { bold: true, sz: 14, h: "left", wrap: true }));
    if (range.e.r >= 1) {
      paintRange(ws, 1, 0, 1, range.e.c, cellStyle(C.subFg, C.subBg, { bold: true, sz: 10, h: "left", wrap: true }));
    }
    (headerRows || []).forEach(function (hr) {
      paintRange(ws, hr, 0, hr, range.e.c, cellStyle(C.headFg, C.headBg, { bold: true, sz: 11, wrap: true }));
    });
    for (var r = 0; r <= range.e.r; r++) {
      if ((headerRows || []).indexOf(r) >= 0 || r <= 1) continue;
      var first = String(ensureCell(ws, r, 0).v || "");
      if (!first) continue;
      if (/^[①②③]|各階段|設備完成|甘特|報表|專案|林廠長|🏭/.test(first) || opts.sectionTest && opts.sectionTest(first)) {
        paintRange(ws, r, 0, r, range.e.c, cellStyle(C.secFg, C.secBg, { bold: true, h: "left" }));
        continue;
      }
      if (/^TOP/.test(first)) {
        paintRange(ws, r, 0, r, range.e.c, cellStyle(C.topFg, C.topBg, { bold: true }));
        continue;
      }
      var bg = (r % 2 === 0) ? C.zebraBg : C.whiteBg;
      for (var c = 0; c <= range.e.c; c++) {
        var v = ensureCell(ws, r, c).v;
        var txt = String(v == null ? "" : v);
        if (c === 1 && /板階段|組裝段|測試段/.test(txt)) paintCell(ws, r, c, segStyle(txt));
        else if (/高|中|低/.test(txt) && txt.length <= 4) paintCell(ws, r, c, urgStyle(txt));
        else if (/延誤|進行|完成|未開始/.test(txt)) paintCell(ws, r, c, statusStyle(txt));
        else paintCell(ws, r, c, cellStyle(C.ink, bg, { h: c === 0 || c === 2 || c === 3 ? "left" : "center" }));
      }
    }
  }

  function stageNames(DATA) {
    return (DATA.stages || []).map(function (s) { return s.name; });
  }

  function stageMarks(DATA) {
    return (DATA.stages || []).map(function (s, i) {
      return (STAGE_ICONS[i] || "") + s.name;
    });
  }

  function asRatio(v) {
    var f = Number(v);
    if (!isFinite(f)) return 0;
    if (f > 1) return Math.max(0, Math.min(1, f / 100));
    return Math.max(0, Math.min(1, f));
  }

  function pctStr(v) {
    return (asRatio(v) * 100).toFixed(1).replace(/\.0$/, "") + "%";
  }

  function avgItems(items) {
    items = items || [];
    if (!items.length) return 0;
    var sum = 0;
    items.forEach(function (it) { sum += asRatio(it.pct); });
    return sum / items.length;
  }

  function fmtDue(v) {
    if (!v) return "";
    return String(v).trim().replace(/-/g, "/").slice(0, 10);
  }

  function parseIdx(v) {
    if (v == null || v === "" || v === "-") return v == null ? "" : v;
    var f = Number(v);
    if (isFinite(f) && String(v).trim() !== "") return f;
    return String(v);
  }

  function eqBlock(eq) {
    var max = 1;
    (eq.stages || []).forEach(function (st) {
      max = Math.max(max, (st.items || []).length);
    });
    return Math.max(10, max);
  }

  function orderedEquipment(DATA) {
    var order = DATA.segOrder || [];
    var list = (DATA.equipment || []).slice();
    list.sort(function (a, b) {
      var ia = order.indexOf(a.seg);
      var ib = order.indexOf(b.seg);
      if (ia < 0) ia = 999;
      if (ib < 0) ib = 999;
      if (ia !== ib) return ia - ib;
      return String(a.idx || "").localeCompare(String(b.idx || ""), "zh-Hant", { numeric: true });
    });
    return list;
  }

  function buildTrack(DATA) {
    var names = stageNames(DATA);
    var marks = stageMarks(DATA);
    var aoa = [];
    aoa.push(["TW1_VIVO_R01 五階段工作項目清單管控（矩陣：左設備 × 右五階段）"]);
    aoa.push(["製程段分色｜五階段分色＋圖示｜急迫性：高／中／低｜狀態：未開始／進行中／延誤中／已完成｜匯出 " + new Date().toLocaleString()]);
    var row3 = ["🏭 ◀ 設備", "", "", "", "", "", ""];
    marks.forEach(function (m) {
      row3.push(m, "", "", "", "");
    });
    aoa.push(row3);
    var row4 = ["🔢 項次", "📂 製程段", "🖥️ 設備名稱", "📦 數量", "👤 AMBU PM", "👤 Owner", "#️⃣ 細項序"];
    names.forEach(function () {
      row4.push("📝 待完成事項(細項)", "📊 完成百分比", "🔥 急迫性", "📅 預計完成時間", "🚦 目前狀態");
    });
    aoa.push(row4);

    var merges = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 31 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: 31 } },
      { s: { r: 2, c: 0 }, e: { r: 2, c: 6 } }
    ];
    marks.forEach(function (_m, si) {
      var c0 = 7 + si * 5;
      merges.push({ s: { r: 2, c: c0 }, e: { r: 2, c: c0 + 4 } });
    });

    orderedEquipment(DATA).forEach(function (eq) {
      var block = eqBlock(eq);
      var startR = aoa.length;
      for (var offset = 0; offset < block; offset++) {
        var row = new Array(7 + names.length * 5).fill("");
        if (offset === 0) {
          row[0] = parseIdx(eq.idx);
          row[1] = eq.seg || "";
          row[2] = eq.name || "";
          row[3] = parseIdx(eq.qty);
          row[4] = eq.pm || "-";
          row[5] = eq.owner || "-";
        }
        row[6] = offset + 1;
        (eq.stages || []).forEach(function (st, si) {
          var it = (st.items || [])[offset];
          var c0 = 7 + si * 5;
          if (!it) return;
          row[c0] = it.item || "";
          row[c0 + 1] = asRatio(it.pct);
          row[c0 + 2] = it.urg || "中";
          row[c0 + 3] = fmtDue(it.due);
          row[c0 + 4] = it.status || "未開始";
        });
        aoa.push(row);
      }
      if (block > 1) {
        [0, 1, 2, 3, 4, 5].forEach(function (c) {
          merges.push({ s: { r: startR, c: c }, e: { r: startR + block - 1, c: c } });
        });
      }
    });

    var ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!merges"] = merges;
    ws["!cols"] = [
      { wch: 6 }, { wch: 10 }, { wch: 22 }, { wch: 6 }, { wch: 10 }, { wch: 12 }, { wch: 6 }
    ].concat(names.flatMap(function () {
      return [{ wch: 22 }, { wch: 10 }, { wch: 8 }, { wch: 12 }, { wch: 10 }];
    }));
    paintTrackSheet(ws, names.length || 5);
    return ws;
  }

  function buildWeekly(DATA) {
    var eqList = orderedEquipment(DATA);
    var segs = DATA.segOrder || [];
    var title = DATA.title || "TW1_VIVO_R01 架線前準備｜進度周報";
    var sub = DATA.subtitle || "";
    var aoa = [];
    aoa.push([title]);
    aoa.push([sub]);
    aoa.push([]);
    aoa.push(["① 板階段／組裝段／測試段｜架線前準備進度"]);
    aoa.push(["製程段", "設備數", "架線前準備完成率", "預計完成時間", "急迫性高(未完成)", "說明"]);
    segs.forEach(function (seg) {
      var eqs = eqList.filter(function (eq) { return eq.seg === seg; });
      var items = eqs.flatMap(function (eq) { return (eq.stages[0] && eq.stages[0].items) || []; });
      var high = items.filter(function (it) { return it.urg === "高" && it.status !== "已完成"; }).length;
      var mile = ((DATA.milestones || []).find(function (m) { return m.seg === seg; }) || {}).dates || [];
      aoa.push([seg, eqs.length, pctStr(avgItems(items)), fmtDue(mile[0]), high, "架線前準備階段周進度"]);
    });
    aoa.push([]);
    aoa.push(["② 全部設備｜架線前準備進度％"]);
    aoa.push(["項次", "製程段", "設備名稱", "架線前準備完成率", "預計完成時間", "急迫性高項數", "目前瓶頸狀態"]);
    eqList.forEach(function (eq) {
      var items = (eq.stages[0] && eq.stages[0].items) || [];
      var r = avgItems(items);
      var high = items.filter(function (it) { return it.urg === "高" && it.status !== "已完成"; }).length;
      var status = "○ 未開始";
      if (items.some(function (it) { return it.status === "延誤中"; })) status = "⚠ 有延誤";
      else if (items.some(function (it) { return it.status === "進行中"; })) status = "▶ 進行中";
      else if (r >= 0.999) status = "✔ 已完成";
      aoa.push([parseIdx(eq.idx), eq.seg, eq.name, pctStr(r), fmtDue((eq.stages[0] && eq.stages[0].due) || (items[0] && items[0].due)), high, status]);
    });
    aoa.push([]);
    aoa.push(["③ 急迫性「高」｜待處理前三項（架線前準備／未完成）"]);
    aoa.push(["排名", "製程段", "設備名稱", "待完成事項", "急迫性", "完成率", "目前狀態", "負責人", "預計完成"]);
    var tops = [];
    segs.forEach(function (seg) {
      eqList.filter(function (eq) { return eq.seg === seg; }).forEach(function (eq) {
        ((eq.stages[0] && eq.stages[0].items) || []).forEach(function (it) {
          if (it.urg === "高" && it.status !== "已完成") {
            tops.push({ seg: seg, name: eq.name, item: it.item, pct: it.pct, status: it.status, owner: eq.owner, due: it.due });
          }
        });
      });
    });
    // 每段各取第一筆高急迫，最多 3
    var picked = [];
    segs.forEach(function (seg) {
      var hit = tops.find(function (t) { return t.seg === seg; });
      if (hit) picked.push(hit);
    });
    while (picked.length < 3 && tops[picked.length]) picked.push(tops[picked.length]);
    picked.slice(0, 3).forEach(function (t, i) {
      aoa.push(["TOP " + (i + 1), t.seg, t.name, t.item, "🔥 高", pctStr(t.pct), t.status, t.owner || "-", fmtDue(t.due)]);
    });
    aoa.push([]);
    aoa.push([DATA.note || "※ 急迫性可在清單管控調整；TOP3 依各製程段高急迫未完成項彙整。"]);

    var ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!merges"] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 7 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: 7 } }
    ];
    ws["!cols"] = [{ wch: 8 }, { wch: 10 }, { wch: 28 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
    paintSimpleTable(ws, [4, 10, 40], {
      sectionTest: function (t) { return /①|②|③|全部設備|急迫性/.test(t); }
    });
    return ws;
  }

  function buildOutlook(DATA) {
    var eqList = orderedEquipment(DATA);
    var segs = DATA.segOrder || [];
    var names = stageNames(DATA);
    var today = new Date();
    var dateStr = today.getFullYear() + "/" + String(today.getMonth() + 1).padStart(2, "0") + "/" + String(today.getDate()).padStart(2, "0");
    var left = [];
    left.push(["左側文字｜右側甘特簡表｜匯出自 Jason追蹤表"]);
    left.push([]);
    left.push(["林廠長您好，本周周報重點如下："]);
    left.push([]);
    left.push(["【報表日期】" + dateStr]);
    left.push(["【專案】TW1_VIVO_R01｜架線前準備進度周報"]);
    left.push([]);

    segs.forEach(function (seg) {
      left.push(["🏭 " + (SEG_LABEL[seg] || seg)]);
      left.push([]);
      var eqs = eqList.filter(function (eq) { return eq.seg === seg; });
      eqs.forEach(function (eq, i) {
        var items = (eq.stages[0] && eq.stages[0].items) || [];
        var highs = items.filter(function (it) { return it.urg === "高" && it.status !== "已完成"; });
        left.push([(i + 1) + ". 🔧 " + eq.name + "（" + (eq.owner || "-") + "）"]);
        left.push(["   • 📊 總進度：" + pctStr(avgItems(items))]);
        left.push(["   • 急迫性（高）項目："]);
        if (!highs.length) left.push(["     - （無）"]);
        highs.forEach(function (it) {
          left.push(["     - " + (it.item || "") + "｜狀態：" + (it.status || "") + "｜預計完成：" + (fmtDue(it.due) || "-")]);
        });
        left.push(["   • 預計完成時間：" + (fmtDue((eq.stages[0] && eq.stages[0].due) || (items[0] && items[0].due)) || "-")]);
        left.push([]);
      });
      left.push([]);
    });

    var right = [];
    right.push(["甘特圖（架線／五階段時程）"]);
    right.push(["項目/工項", "負責人", "預估工期(天)", "預計開始日", "預計結束日", "目前進度", "狀態確認"]);
    segs.forEach(function (seg) {
      right.push([seg, "", "", "", "", "", ""]);
      var eqs = eqList.filter(function (eq) { return eq.seg === seg; });
      var owner = (eqs[0] && eqs[0].owner) || "-";
      var mile = ((DATA.milestones || []).find(function (m) { return m.seg === seg; }) || {}).dates || [];
      names.forEach(function (nm, si) {
        var items = eqs.flatMap(function (eq) { return (eq.stages[si] && eq.stages[si].items) || []; });
        var r = avgItems(items);
        var status = items.some(function (it) { return it.status === "延誤中"; }) ? "延誤中"
          : items.some(function (it) { return it.status === "進行中"; }) ? "進行中"
          : r >= 0.999 ? "已完成" : "未開始";
        right.push([(si + 1) + ". " + nm, owner, "", "", fmtDue(mile[si]), pctStr(r), status]);
      });
      eqs.forEach(function (eq) {
        var items = (eq.stages[0] && eq.stages[0].items) || [];
        var r = avgItems(items);
        var status = items.some(function (it) { return it.status === "延誤中"; }) ? "延誤中"
          : items.some(function (it) { return it.status === "進行中"; }) ? "進行中"
          : r >= 0.999 ? "已完成" : "未開始";
        right.push(["　└ " + eq.name, eq.owner || "-", "", "", fmtDue((eq.stages[0] && eq.stages[0].due) || (items[0] && items[0].due)), pctStr(r), status]);
      });
    });

    var maxR = Math.max(left.length, right.length);
    var aoa = [];
    for (var r = 0; r < maxR; r++) {
      var L = left[r] || [""];
      var R = right[r] || [];
      aoa.push([L[0] || "", "", "", "", "", ""].concat(R));
    }
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [{ wch: 56 }, { wch: 2 }, { wch: 2 }, { wch: 2 }, { wch: 2 }, { wch: 2 }, { wch: 28 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 }];
    paintSimpleTable(ws, [4], {
      sectionTest: function (t) {
        return /🏭|甘特|項目\/工項|板階段|組裝段|測試段|報表日期|專案|林廠長/.test(t) && t.indexOf("└") < 0;
      }
    });
    // 右側甘特標題列
    var rng = sheetRange(ws);
    for (var r = 0; r <= rng.e.r; r++) {
      var g = String(ensureCell(ws, r, 6).v || "");
      if (g === "甘特圖（架線／五階段時程）" || g === "項目/工項") {
        paintRange(ws, r, 6, r, Math.max(rng.e.c, 12), cellStyle(C.headFg, C.headBg, { bold: true, h: "left" }));
      } else if (/^(板階段|組裝段|測試段)$/.test(g)) {
        paintRange(ws, r, 6, r, Math.max(rng.e.c, 12), segStyle(g));
      } else if (g) {
        var bg = (r % 2 === 0) ? C.zebraBg : C.whiteBg;
        for (var c = 6; c <= Math.max(rng.e.c, 12); c++) {
          var vv = String(ensureCell(ws, r, c).v || "");
          if (/延誤|進行|完成|未開始/.test(vv)) paintCell(ws, r, c, statusStyle(vv));
          else paintCell(ws, r, c, cellStyle(C.ink, bg, { h: c === 6 ? "left" : "center" }));
        }
      }
    }
    return ws;
  }

  function buildOverview(DATA) {
    var eqList = orderedEquipment(DATA);
    var names = stageNames(DATA);
    var marks = stageMarks(DATA);
    var segs = DATA.segOrder || [];
    var aoa = [];
    aoa.push(["五階段進度總覽（矩陣版）"]);
    aoa.push(["含各階段預計完成時間｜左側設備 × 右側五階段完成率（匯出時已計算）"]);
    aoa.push([]);
    aoa.push(["📅 各階段預計完成時間"]);
    aoa.push(["製程段"].concat(marks));
    segs.forEach(function (seg) {
      var mile = ((DATA.milestones || []).find(function (m) { return m.seg === seg; }) || {}).dates || [];
      aoa.push([seg].concat(names.map(function (_n, i) { return fmtDue(mile[i]); })));
    });
    aoa.push([]);
    aoa.push(["📊 設備完成率與完成時間"]);
    var head1 = ["🏭 設備", "", ""];
    marks.forEach(function (m) { head1.push(m, ""); });
    head1.push("📈 整體", "");
    aoa.push(head1);
    var head2 = ["項次", "製程段", "設備名稱"];
    names.forEach(function () { head2.push("完成率", "📅完成時間"); });
    head2.push("完成率", "延誤數");
    aoa.push(head2);

    eqList.forEach(function (eq) {
      var row = [parseIdx(eq.idx), eq.seg, eq.name];
      var allItems = [];
      var delays = 0;
      (eq.stages || []).forEach(function (st, si) {
        var items = st.items || [];
        allItems = allItems.concat(items);
        delays += items.filter(function (it) { return it.status === "延誤中"; }).length;
        var mile = ((DATA.milestones || []).find(function (m) { return m.seg === eq.seg; }) || {}).dates || [];
        row.push(pctStr(avgItems(items)), fmtDue(st.due || mile[si] || (items[0] && items[0].due)));
      });
      row.push(pctStr(avgItems(allItems)), delays);
      aoa.push(row);
    });

    var ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!merges"] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 12 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: 12 } }
    ];
    ws["!cols"] = [{ wch: 8 }, { wch: 10 }, { wch: 28 }].concat(names.flatMap(function () {
      return [{ wch: 10 }, { wch: 12 }];
    })).concat([{ wch: 10 }, { wch: 8 }]);
    paintSimpleTable(ws, [4, 10, 11], {
      sectionTest: function (t) { return /各階段預計|設備完成率/.test(t); }
    });
    // 階段標題列著色
    var or = sheetRange(ws);
    for (var oc = 3; oc <= or.e.c - 2; oc++) {
      var si = Math.floor((oc - 3) / 2);
      var head = C.stageHead[si % C.stageHead.length];
      if (or.e.r >= 10) paintCell(ws, 10, oc, cellStyle(head.fg, head.bg, { bold: true }));
      if (or.e.r >= 11) paintCell(ws, 11, oc, cellStyle(head.fg, head.bg, { bold: true, sz: 10 }));
    }
    return ws;
  }

  function exportFourSheets(DATA, filename) {
    if (typeof XLSX === "undefined") throw new Error("缺少 XLSX 函式庫（xlsx-js-style）");
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, buildTrack(DATA), TRACK);
    XLSX.utils.book_append_sheet(wb, buildWeekly(DATA), WEEKLY);
    XLSX.utils.book_append_sheet(wb, buildOutlook(DATA), OUTLOOK);
    XLSX.utils.book_append_sheet(wb, buildOverview(DATA), OVERVIEW);
    XLSX.writeFile(wb, filename || ("Jason追蹤表_" + Date.now() + ".xlsx"));
  }

  function cellStr(v) {
    if (v == null || v === "") return "";
    if (v instanceof Date) {
      var y = v.getFullYear();
      var m = String(v.getMonth() + 1).padStart(2, "0");
      var d = String(v.getDate()).padStart(2, "0");
      return y + "/" + m + "/" + d;
    }
    if (typeof v === "number" && v > 20000 && v < 80000) {
      // Excel serial date
      try {
        var parsed = XLSX.SSF.parse_date_code(v);
        if (parsed) {
          return parsed.y + "/" + String(parsed.m).padStart(2, "0") + "/" + String(parsed.d).padStart(2, "0");
        }
      } catch (e) {}
    }
    return String(v).trim();
  }

  function findTrackSheet(wb) {
    if (wb.Sheets[TRACK]) return wb.Sheets[TRACK];
    var hit = (wb.SheetNames || []).find(function (n) { return n.indexOf("項目清單") >= 0; });
    return hit ? wb.Sheets[hit] : null;
  }

  function findOverviewSheet(wb) {
    if (wb.Sheets[OVERVIEW]) return wb.Sheets[OVERVIEW];
    var hit = (wb.SheetNames || []).find(function (n) { return n.indexOf("進度總覽") >= 0; });
    return hit ? wb.Sheets[hit] : null;
  }

  function photoMapFromPrev(prevEqList) {
    var map = {};
    (prevEqList || []).forEach(function (eq) {
      (eq.stages || []).forEach(function (st, si) {
        (st.items || []).forEach(function (it) {
          if (!it || !Array.isArray(it.photos) || !it.photos.length) return;
          map[(eq.seg || "") + "|" + (eq.name || "") + "|" + si + "|" + (it.item || "")] = it.photos;
        });
      });
    });
    return map;
  }

  /** 解析「架線項目清單管控」矩陣 → equipment[] */
  function parseTrackSheet(ws, stageCount, prevEquipment) {
    var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });
    if (!aoa.length) throw new Error("清單工作表是空的");
    var headerRow = -1;
    for (var r = 0; r < Math.min(10, aoa.length); r++) {
      var a = cellStr(aoa[r][0]);
      if (a.indexOf("項次") >= 0 || a.indexOf("🔢") >= 0) {
        headerRow = r;
        break;
      }
    }
    if (headerRow < 0) throw new Error("找不到清單表頭列（項次）");
    var nStages = stageCount || 5;
    var photos = photoMapFromPrev(prevEquipment);
    var equipment = [];
    var cur = null;

    for (var i = headerRow + 1; i < aoa.length; i++) {
      var row = aoa[i] || [];
      var name = cellStr(row[2]);
      var seg = cellStr(row[1]);
      var idx = row[0];
      var hasItem = false;
      for (var si0 = 0; si0 < nStages; si0++) {
        if (cellStr(row[7 + si0 * 5])) { hasItem = true; break; }
      }
      if (name) {
        cur = {
          idx: cellStr(idx) || String(equipment.length + 1),
          seg: seg || (cur && cur.seg) || "",
          name: name,
          qty: cellStr(row[3]) || "-",
          pm: cellStr(row[4]) || "-",
          owner: cellStr(row[5]) || "-",
          stages: []
        };
        for (var s = 0; s < nStages; s++) {
          cur.stages.push({ due: "", items: [] });
        }
        equipment.push(cur);
      }
      if (!cur) continue;
      if (!hasItem && !name) continue;

      for (var si = 0; si < nStages; si++) {
        var c0 = 7 + si * 5;
        var itemName = cellStr(row[c0]);
        if (!itemName) continue;
        var pct = asRatio(row[c0 + 1]);
        var urg = cellStr(row[c0 + 2]) || "中";
        if (urg.indexOf("高") >= 0) urg = "高";
        else if (urg.indexOf("低") >= 0) urg = "低";
        else urg = "中";
        var due = fmtDue(cellStr(row[c0 + 3]));
        var status = cellStr(row[c0 + 4]) || "未開始";
        if (status.indexOf("延誤") >= 0) status = "延誤中";
        else if (status.indexOf("進行") >= 0) status = "進行中";
        else if (status.indexOf("完成") >= 0) status = "已完成";
        else status = "未開始";
        var key = (cur.seg || "") + "|" + (cur.name || "") + "|" + si + "|" + itemName;
        var it = {
          item: itemName,
          pct: pct,
          urg: urg,
          start: "",
          due: due,
          actual: "",
          status: status,
          note: "",
          photos: photos[key] ? photos[key].slice() : []
        };
        cur.stages[si].items.push(it);
        if (due && !cur.stages[si].due) cur.stages[si].due = due;
      }
    }

    if (!equipment.length) throw new Error("清單中沒有讀到任何設備");
    return equipment;
  }

  /** 從總覽表讀各製程段五階段預計完成時間 */
  function parseMilestones(ws, segOrder, stageCount) {
    if (!ws) return null;
    var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });
    var out = [];
    var nStages = stageCount || 5;
    for (var r = 0; r < aoa.length; r++) {
      var seg = cellStr(aoa[r][0]);
      if ((segOrder || []).indexOf(seg) < 0) continue;
      var dates = [];
      for (var c = 1; c <= nStages; c++) dates.push(fmtDue(cellStr(aoa[r][c])));
      if (dates.some(Boolean)) out.push({ seg: seg, dates: dates });
    }
    return out.length ? out : null;
  }

  /**
   * 讀取匯出格式（或原檔紅框四表）XLSX，回傳 { equipment, milestones }
   * @param {ArrayBuffer} buffer
   * @param {object} opts { stageCount, segOrder, prevEquipment }
   */
  function importFourSheets(buffer, opts) {
    if (typeof XLSX === "undefined") throw new Error("缺少 XLSX 函式庫");
    opts = opts || {};
    var wb = XLSX.read(buffer, { type: "array", cellDates: true });
    var track = findTrackSheet(wb);
    if (!track) throw new Error("找不到「架線項目清單管控」工作表");
    var equipment = parseTrackSheet(track, opts.stageCount || 5, opts.prevEquipment || []);
    var milestones = parseMilestones(findOverviewSheet(wb), opts.segOrder || [], opts.stageCount || 5);
    return { equipment: equipment, milestones: milestones, sheetNames: wb.SheetNames };
  }

  global.exportLineFourSheets = exportFourSheets;
  global.importLineFourSheets = importFourSheets;
})(window);
