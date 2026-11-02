/**
 * Sheets ↔ 架線進度 payload 轉換（配合 LineXlsxCodec / Google Sheets values）
 */
(function (global) {
  "use strict";

  var META_KEYS = [
    "payload",
    "id", "projectId", "projectName", "title", "subtitle", "source", "built",
    "note", "arch", "segOrder", "stages", "milestones", "weekly", "nodes",
    "savedAt", "schema"
  ];

  function cfg() {
    return global.GOOGLE_CONFIG || {};
  }

  function sheetNames() {
    var c = cfg();
    var x = global.LineXlsxCodec || {};
    return {
      meta: c.sheetMeta || "_meta",
      track: c.sheetTrack || x.TRACK || "架線項目清單管控",
      weekly: c.sheetWeekly || x.WEEKLY || "架線周報",
      outlook: c.sheetOutlook || x.OUTLOOK || "OUTLOOK周報預覽",
      overview: c.sheetOverview || x.OVERVIEW || "架線階段進度總覽",
      photos: c.sheetPhotos || "_photos"
    };
  }

  var PAYLOAD_CHUNK = 45000;

  function safeJson(v) {
    try { return JSON.stringify(v); } catch (e) { return "null"; }
  }

  function parseJson(s, fallback) {
    if (s == null || s === "") return fallback;
    try { return JSON.parse(String(s)); } catch (e) { return fallback; }
  }

  function chunkString(s, size) {
    var str = String(s || "");
    var out = [];
    var n = size || PAYLOAD_CHUNK;
    for (var i = 0; i < str.length; i += n) out.push(str.slice(i, i + n));
    if (!out.length) out.push("");
    return out;
  }

  function buildMetaAoa(payload) {
    var p = payload || {};
    var rows = [["key", "value"]];
    rows.push(["schema", "line-progress-sheets-v1"]);
    rows.push(["savedAt", p.savedAt || new Date().toISOString()]);
    var chunks = chunkString(safeJson(p), PAYLOAD_CHUNK);
    rows.push(["payloadChunks", String(chunks.length)]);
    chunks.forEach(function (c, i) {
      rows.push(["payload_" + i, c]);
    });
    // 小專案相容：也寫單格（超過上限時 Sheets 會截斷，讀取以 chunks 為準）
    if (chunks.length === 1) rows.push(["payload", chunks[0]]);
    rows.push(["projectId", p.projectId || p.id || ""]);
    rows.push(["projectName", p.projectName || ""]);
    rows.push(["title", p.title || ""]);
    rows.push(["subtitle", p.subtitle || ""]);
    rows.push(["arch", p.arch || "unified"]);
    rows.push(["note", p.note || ""]);
    rows.push(["source", p.source || ""]);
    rows.push(["built", p.built || ""]);
    rows.push(["segOrder", safeJson(p.segOrder || [])]);
    rows.push(["stages", safeJson(p.stages || [])]);
    rows.push(["milestones", safeJson(p.milestones || [])]);
    rows.push(["weekly", safeJson(p.weekly || null)]);
    var nodeChunks = chunkString(safeJson(p.nodes || []), PAYLOAD_CHUNK);
    rows.push(["nodesChunks", String(nodeChunks.length)]);
    nodeChunks.forEach(function (c, i) {
      rows.push(["nodes_" + i, c]);
    });
    return rows;
  }

  function joinChunks(map, prefix, countKey) {
    var n = Number(map[countKey] || 0);
    if (n > 0) {
      var s = "";
      for (var i = 0; i < n; i++) s += map[prefix + i] || "";
      return s;
    }
    return map[prefix.replace(/_$/, "")] || map.payload || "";
  }

  function parseMetaAoa(aoa) {
    var map = {};
    (aoa || []).forEach(function (row, i) {
      if (!i) return;
      var k = String((row && row[0]) || "").trim();
      if (!k) return;
      map[k] = row[1];
    });
    var payloadRaw = joinChunks(map, "payload_", "payloadChunks");
    if (!payloadRaw && map.payload) payloadRaw = map.payload;
    var payload = parseJson(payloadRaw, null);
    if (!payload || typeof payload !== "object") {
      var nodesRaw = joinChunks(map, "nodes_", "nodesChunks");
      payload = {
        title: map.title || "",
        subtitle: map.subtitle || "",
        note: map.note || "",
        source: map.source || "",
        built: map.built || "",
        arch: map.arch || "unified",
        projectId: map.projectId || "",
        projectName: map.projectName || "",
        segOrder: parseJson(map.segOrder, []),
        stages: parseJson(map.stages, []),
        milestones: parseJson(map.milestones, []),
        weekly: parseJson(map.weekly, null),
        nodes: parseJson(nodesRaw || map.nodes, []),
        equipment: [],
        savedAt: map.savedAt || ""
      };
    }
    return { map: map, payload: payload };
  }

  function buildPhotosAoa(payload) {
    var rows = [["seg", "equipment", "stageIndex", "item", "photosJson"]];
    ((payload && payload.equipment) || []).forEach(function (eq) {
      (eq.stages || []).forEach(function (st, si) {
        (st.items || []).forEach(function (it) {
          if (!it || !Array.isArray(it.photos) || !it.photos.length) return;
          rows.push([
            eq.seg || "",
            eq.name || "",
            si,
            it.item || "",
            safeJson(it.photos)
          ]);
        });
      });
    });
    return rows;
  }

  function parsePhotosAoa(aoa) {
    var map = {};
    (aoa || []).forEach(function (row, i) {
      if (!i) return;
      var seg = String((row && row[0]) || "");
      var name = String((row && row[1]) || "");
      var si = Number(row[2]);
      var item = String((row && row[3]) || "");
      var photos = parseJson(row[4], []);
      if (!item || !Array.isArray(photos) || !photos.length) return;
      map[seg + "|" + name + "|" + si + "|" + item] = photos;
    });
    return map;
  }

  function applyPhotosMap(equipment, photoMap) {
    (equipment || []).forEach(function (eq) {
      (eq.stages || []).forEach(function (st, si) {
        (st.items || []).forEach(function (it) {
          var key = (eq.seg || "") + "|" + (eq.name || "") + "|" + si + "|" + (it.item || "");
          if (photoMap[key]) it.photos = photoMap[key].slice();
        });
      });
    });
  }

  /** payload → 各工作表 AOA（供 Sheets batch 寫入） */
  function payloadToSheetAoaMap(payload) {
    var names = sheetNames();
    var codec = global.LineXlsxCodec;
    if (!codec) throw new Error("缺少 LineXlsxCodec（export_line_xlsx.js）");
    var map = {};
    map[names.meta] = buildMetaAoa(payload);
    map[names.photos] = buildPhotosAoa(payload);
    try {
      map[names.track] = codec.buildTrackAoa(payload);
      map[names.weekly] = codec.buildWeeklyAoa(payload);
      map[names.outlook] = codec.buildOutlookAoa(payload);
      map[names.overview] = codec.buildOverviewAoa(payload);
    } catch (e) {
      // 無設備的 hierarchy 專案：人讀表可空，仍保留 _meta
      map[names.track] = map[names.track] || [["（無設備清單）"]];
      map[names.weekly] = map[names.weekly] || [[payload.title || ""], [payload.subtitle || ""]];
      map[names.outlook] = map[names.outlook] || [[payload.title || ""]];
      map[names.overview] = map[names.overview] || [["製程段"].concat(((payload.stages || []).map(function (s) { return s.name; })))];
    }
    return map;
  }

  /**
   * 各工作表 AOA → payload
   * 以 _meta.payload 為底，清單表有設備時覆寫 equipment（讓 Sheets 手改可回寫）
   */
  function sheetAoaMapToPayload(aoaByName, opts) {
    opts = opts || {};
    var names = sheetNames();
    var codec = global.LineXlsxCodec;
    var metaParsed = parseMetaAoa(aoaByName[names.meta] || []);
    var payload = metaParsed.payload || {};
    var photoMap = parsePhotosAoa(aoaByName[names.photos] || []);
    var stageCount = (payload.stages && payload.stages.length) || opts.stageCount || 5;
    var prevEq = payload.equipment || opts.prevEquipment || [];

    if (codec && aoaByName[names.track] && aoaByName[names.track].length > 1) {
      try {
        var eq = codec.parseTrackFromAoa(aoaByName[names.track], stageCount, prevEq);
        if (eq && eq.length) {
          applyPhotosMap(eq, photoMap);
          // 若 photos 表沒有、但舊 payload 有，parseTrack 已用 prevEq 帶入
          payload.equipment = eq;
        }
      } catch (e) {
        // 保留 meta 內 equipment
        if (!payload.equipment) payload.equipment = [];
        applyPhotosMap(payload.equipment, photoMap);
      }
    } else if (payload.equipment) {
      applyPhotosMap(payload.equipment, photoMap);
    }

    if (codec && aoaByName[names.overview]) {
      var miles = codec.parseMilestonesFromAoa(
        aoaByName[names.overview],
        payload.segOrder || [],
        stageCount
      );
      if (miles && miles.length) payload.milestones = miles;
    }

    payload.savedAt = metaParsed.map.savedAt || payload.savedAt || new Date().toISOString();
    return payload;
  }

  /** 索引試算表 AOA */
  function projectsToIndexAoa(projects, forceBuildId) {
    var rows = [["order", "id", "name", "arch", "spreadsheetId", "folderId", "legacyFallback", "createdAt", "forceBuildId"]];
    (projects || []).forEach(function (p, i) {
      rows.push([
        i + 1,
        p.id || "",
        p.name || "",
        p.arch || "unified",
        p.spreadsheetId || "",
        p.folderId || "",
        p.legacyFallback ? "1" : "",
        p.createdAt || "",
        i === 0 ? (forceBuildId || "") : ""
      ]);
    });
    if (!(projects || []).length) {
      rows.push(["", "", "", "", "", "", "", "", forceBuildId || ""]);
    }
    return rows;
  }

  function indexAoaToProjects(aoa) {
    var list = [];
    var forceBuildId = "";
    (aoa || []).forEach(function (row, i) {
      if (!i) return;
      var id = String((row && row[1]) || "").trim();
      var name = String((row && row[2]) || "").trim();
      var fb = String((row && row[8]) || "").trim();
      if (fb) forceBuildId = fb;
      if (!id && !name) return;
      list.push({
        id: id || name,
        name: name || id,
        arch: String((row && row[3]) || "unified").trim() || "unified",
        spreadsheetId: String((row && row[4]) || "").trim(),
        folderId: String((row && row[5]) || "").trim(),
        legacyFallback: String((row && row[6]) || "") === "1" || String((row && row[6]) || "").toLowerCase() === "true",
        createdAt: String((row && row[7]) || "").trim()
      });
    });
    list.sort(function (a, b) {
      // 保持列順序（order 欄）
      return 0;
    });
    return { projects: list, forceBuildId: forceBuildId };
  }

  global.LineSheetsCodec = {
    META_KEYS: META_KEYS,
    sheetNames: sheetNames,
    buildMetaAoa: buildMetaAoa,
    parseMetaAoa: parseMetaAoa,
    buildPhotosAoa: buildPhotosAoa,
    parsePhotosAoa: parsePhotosAoa,
    payloadToSheetAoaMap: payloadToSheetAoaMap,
    sheetAoaMapToPayload: sheetAoaMapToPayload,
    projectsToIndexAoa: projectsToIndexAoa,
    indexAoaToProjects: indexAoaToProjects
  };
})(window);
