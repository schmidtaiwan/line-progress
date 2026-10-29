/**
 * 匯出四工作表 XLSX（對齊原檔紅框 sheets）
 * 依賴全域 XLSX（xlsx.full.min.js）與頁面 DATA / 輔助函式。
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
    return ws;
  }

  function exportFourSheets(DATA, filename) {
    if (typeof XLSX === "undefined") throw new Error("缺少 XLSX 函式庫");
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, buildTrack(DATA), TRACK);
    XLSX.utils.book_append_sheet(wb, buildWeekly(DATA), WEEKLY);
    XLSX.utils.book_append_sheet(wb, buildOutlook(DATA), OUTLOOK);
    XLSX.utils.book_append_sheet(wb, buildOverview(DATA), OVERVIEW);
    XLSX.writeFile(wb, filename || ("Jason追蹤表_" + Date.now() + ".xlsx"));
  }

  global.exportLineFourSheets = exportFourSheets;
})(window);
