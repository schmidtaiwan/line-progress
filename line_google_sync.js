/* Google Identity + Drive／Sheets API → 進度同步
 * storageMode=sheets：一專案一本試算表為 SoT；照片／history 仍用 Drive。
 * drive 範圍（私人用）+ spreadsheets；可用檔名搜尋，手機／電腦對同一份。
 */
(function (global) {
  const cfg = global.GOOGLE_CONFIG || {};
  // drive.file 在部分手機瀏覽器／舊 token 容易 SCOPE 不足；私人用改 drive
  const SCOPES = "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email";
  const state = {
    account: null,
    token: "",
    ready: false,
    lastCloudAt: "",
    busy: false,
    fileId: "",
    spreadsheetId: "",
    viewers: 0,
    viewerList: []
  };
  let tokenClient = null;
  /** 目前進行中的 token 請求（給 error_callback／取消／逾時結束 Promise） */
  let pendingToken = null;
  let uploadTimer = null;
  let cachedFolderId = "";
  let presenceTimer = null;
  let presenceBusy = false;
  let onViewersChange = null;
  /** 本頁面只強制 consent 一次，避免「未驗證應用」警告一直跳 */
  let scopeConsentAsked = false;
  let scopeRetryInFlight = null;
  const PRESENCE_TTL_MS = 45000;
  const PRESENCE_INTERVAL_MS = 12000;
  const PRESENCE_PREFIX = "vivo_r01_view_";
  /** 目前作用中專案（決定雲端資料夾） */
  let activeProject = null;
  /** 切換專案加速：記住各專案資料夾／檔案 ID，避免每次重查 Drive */
  const folderIdByProject = Object.create(null);
  const fileIdByProject = Object.create(null);
  const spreadsheetIdByProject = Object.create(null);
  let cachedIndexSpreadsheetId = "";
  const childFolderListCache = Object.create(null);
  const CHILD_LIST_TTL_MS = 60000;

  function isSheetsMode() {
    return String(cfg.storageMode || "sheets").toLowerCase() !== "json";
  }

  function projCacheKey(proj) {
    if (!proj) return "";
    return String(proj.id || proj.name || "").trim();
  }

  function fileName() {
    return (cfg.fileName || "line_data.json").trim() || "line_data.json";
  }

  function splitPath(raw) {
    return String(raw || "").replace(/^\/+|\/+$/g, "").split("/").map(function (s) {
      return s.trim();
    }).filter(Boolean);
  }

  function projectsRootParts() {
    return splitPath(cfg.projectsRoot || "架線進度專案");
  }

  /** 多帳號共用根資料夾 ID（有值則所有登入帳號讀寫同一份） */
  function sharedProjectsRootId() {
    return String(cfg.projectsRootId || cfg.sharedFolderId || "").trim();
  }

  function isSharedProjectsRoot() {
    return !!sharedProjectsRootId();
  }

  function sanitizeProjectFolderName(name) {
    return String(name || "新專案")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "新專案";
  }

  function folderPathParts() {
    if (activeProject && activeProject.folderPath) {
      return splitPath(activeProject.folderPath);
    }
    const raw = (cfg.folderPath || cfg.folderName || "").trim();
    if (!raw) return projectsRootParts().concat(["VIVO R01"]);
    return splitPath(raw);
  }

  function storageKey() {
    const email = (state.account && (state.account.email || state.account.username)) || "default";
    const folderKey = (cfg.folderId || folderPathParts().join("/") || "root");
    return "line_google_drive_file_id_" + email + "_" + folderKey + "_" + fileName();
  }

  function clearFolderCache() {
    cachedFolderId = "";
    state.fileId = "";
  }

  /** 清除目前專案的 folder／file／試算表 快取（誤連到別案檔時強制重解析） */
  function clearActiveFileCache() {
    const key = projCacheKey(activeProject);
    if (key) {
      delete folderIdByProject[key];
      delete fileIdByProject[key];
      delete spreadsheetIdByProject[key];
    }
    cachedFolderId = "";
    state.fileId = "";
    state.spreadsheetId = "";
    try { saveStoredFileId(""); } catch (e) {}
  }

  function clearAllProjectCaches() {
    clearFolderCache();
    Object.keys(folderIdByProject).forEach(function (k) { delete folderIdByProject[k]; });
    Object.keys(fileIdByProject).forEach(function (k) { delete fileIdByProject[k]; });
    Object.keys(spreadsheetIdByProject).forEach(function (k) { delete spreadsheetIdByProject[k]; });
    Object.keys(childFolderListCache).forEach(function (k) { delete childFolderListCache[k]; });
    cachedIndexSpreadsheetId = "";
    state.spreadsheetId = "";
    try { saveStoredFileId(""); } catch (e) {}
  }

  function rememberActiveFolderId(id) {
    cachedFolderId = id || "";
    const key = projCacheKey(activeProject);
    if (key && id) folderIdByProject[key] = id;
  }

  function rememberActiveFileId(id) {
    state.fileId = id || "";
    const key = projCacheKey(activeProject);
    if (key && id) fileIdByProject[key] = id;
  }

  function getActiveProject() {
    return activeProject;
  }

  function setActiveProject(proj) {
    if (!proj || !proj.name) return activeProject;
    activeProject = {
      id: String(proj.id || proj.name),
      name: String(proj.name),
      folderPath: String(proj.folderPath || (projectsRootParts().concat([sanitizeProjectFolderName(proj.name)]).join("/"))),
      legacyFallback: !!proj.legacyFallback,
      legacyFolderPath: proj.legacyFolderPath || "",
      legacyFileName: proj.legacyFileName || "",
      spreadsheetId: String(proj.spreadsheetId || "").trim(),
      folderId: String(proj.folderId || "").trim(),
      arch: proj.arch || "unified"
    };
    const key = projCacheKey(activeProject);
    // 切換時沿用記憶體快取，不要清掉 localStorage 的 fileId（否則每次都重搜 2～3 秒）
    cachedFolderId = (key && folderIdByProject[key]) || activeProject.folderId || "";
    state.fileId = (key && fileIdByProject[key]) || "";
    state.spreadsheetId = (key && spreadsheetIdByProject[key]) || activeProject.spreadsheetId || "";
    if (state.spreadsheetId && key) spreadsheetIdByProject[key] = state.spreadsheetId;
    if (!state.fileId) loadStoredFileId();
    if (state.fileId && key) fileIdByProject[key] = state.fileId;
    return activeProject;
  }

  function ensureProjectsRootId() {
    const fixed = sharedProjectsRootId();
    if (fixed) return Promise.resolve(fixed);
    const parts = projectsRootParts();
    if (!parts.length) return Promise.resolve("root");
    let chain = Promise.resolve("root");
    parts.forEach(function (part) {
      chain = chain.then(function (parentId) {
        return findChildFolder(parentId, part).then(function (id) {
          if (id) return id;
          return createChildFolder(parentId, part);
        });
      });
    });
    return chain;
  }

  function legacyPersonalRootName() {
    return String(cfg.legacyProjectsRoot || "架線進度專案").trim() || "架線進度專案";
  }

  function normalizeProjectRecord(p) {
    const name = String((p && p.name) || "未命名");
    const folderName = sanitizeProjectFolderName(name);
    return {
      id: String((p && (p.id || p.name)) || folderName),
      name: name,
      folderPath: projectsRootParts().concat([folderName]).join("/"),
      arch: (p && (p.arch === "hierarchy" || p.arch === "equipment" || p.arch === "unified"))
        ? p.arch
        : "unified",
      legacyFallback: !!(p && p.legacyFallback),
      legacyFolderPath: (p && p.legacyFolderPath) || "",
      legacyFileName: (p && p.legacyFileName) || "",
      createdAt: (p && p.createdAt) || "",
      spreadsheetId: String((p && p.spreadsheetId) || "").trim(),
      folderId: String((p && p.folderId) || "").trim()
    };
  }

  function indexSpreadsheetName() {
    return String(cfg.indexSpreadsheetName || "架線進度_專案索引").trim() || "架線進度_專案索引";
  }

  function indexSheetName() {
    return String(cfg.indexSheetName || "projects").trim() || "projects";
  }

  function projectSpreadsheetTitle(proj) {
    const n = sanitizeProjectFolderName((proj && proj.name) || "專案");
    return n + "_架線進度";
  }

  function rememberSpreadsheetId(id) {
    state.spreadsheetId = id || "";
    const key = projCacheKey(activeProject);
    if (key) {
      if (id) spreadsheetIdByProject[key] = id;
      else delete spreadsheetIdByProject[key];
    }
    if (activeProject) activeProject.spreadsheetId = id || "";
  }

  function withTimeout(promise, ms, label) {
    const limit = ms || 15000;
    let timer = null;
    const guarded = Promise.resolve(promise);
    const timeout = new Promise(function (_resolve, reject) {
      timer = setTimeout(function () {
        reject(new Error((label || "操作") + "逾時（" + Math.round(limit / 1000) + "s）"));
      }, limit);
    });
    return Promise.race([guarded, timeout]).then(
      function (v) { clearTimeout(timer); return v; },
      function (e) { clearTimeout(timer); throw e; }
    );
  }

  function sheetsFetch(url, options) {
    options = options || {};
    const timeoutMs = options.timeoutMs != null ? options.timeoutMs : 20000;
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    let timer = null;
    if (ctrl) {
      timer = setTimeout(function () {
        try { ctrl.abort(); } catch (e) {}
      }, timeoutMs);
    }
    const headers = Object.assign({}, options.headers || {}, {
      Authorization: "Bearer " + state.token
    });
    const opts = Object.assign({}, options, { headers: headers });
    delete opts.timeoutMs;
    if (ctrl) opts.signal = ctrl.signal;
    return fetch(url, opts).then(
      function (res) {
        if (timer) clearTimeout(timer);
        return res;
      },
      function (err) {
        if (timer) clearTimeout(timer);
        if (err && err.name === "AbortError") {
          throw new Error("Sheets API 逾時（" + Math.round(timeoutMs / 1000) + "s）");
        }
        throw err;
      }
    );
  }

  function quoteSheetRange(sheetName, a1) {
    const safe = String(sheetName || "").replace(/'/g, "''");
    return "'" + safe + "'!" + (a1 || "A1");
  }

  function sheetsGetValues(spreadsheetId, sheetName) {
    const range = encodeURIComponent(quoteSheetRange(sheetName, "A1:ZZ2000"));
    return sheetsFetch(
      "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(spreadsheetId) +
      "/values/" + range
    ).then(function (res) {
      if (res.status === 404) return [];
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error("讀取試算表失敗 " + res.status + " " + t);
        });
      }
      return res.json().then(function (data) { return data.values || []; });
    });
  }

  function sheetsBatchUpdateValues(spreadsheetId, aoaByName) {
    const data = [];
    Object.keys(aoaByName || {}).forEach(function (name) {
      const values = aoaByName[name] || [];
      data.push({
        range: quoteSheetRange(name, "A1"),
        majorDimension: "ROWS",
        values: values
      });
    });
    if (!data.length) return Promise.resolve({});
    // 先清再寫，避免殘留舊列
    const clearData = data.map(function (d) {
      return { range: d.range.replace(/!A1$/, "!A1:ZZ2000") };
    });
    return sheetsFetch(
      "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(spreadsheetId) +
      "/values:batchClear",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ranges: clearData.map(function (c) { return c.range; }) })
      }
    ).then(function (res) {
      if (!res.ok && res.status !== 400) {
        return res.text().then(function (t) {
          throw new Error("清除試算表失敗 " + res.status + " " + t);
        });
      }
      return sheetsFetch(
        "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(spreadsheetId) +
        "/values:batchUpdate",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ valueInputOption: "RAW", data: data })
        }
      );
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error("寫入試算表失敗 " + res.status + " " + t);
        });
      }
      return res.json().catch(function () { return {}; });
    });
  }

  /** 同一試算表的分頁建立串行，避免並行 rename/addSheet 撞名 */
  const sheetTabsLocks = Object.create(null);

  function sheetTitleKey(name) {
    return String(name || "").trim().toLowerCase();
  }

  function ensureSheetTabs(spreadsheetId, wantedNames) {
    const sid = String(spreadsheetId || "");
    if (!sid) return Promise.reject(new Error("缺少 spreadsheetId"));
    const prev = sheetTabsLocks[sid] || Promise.resolve();
    const run = prev.catch(function () {}).then(function () {
      return sheetsFetch(
        "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(sid) +
        "?fields=sheets.properties"
      ).then(function (res) {
        if (!res.ok) {
          return res.text().then(function (t) {
            throw new Error("讀取試算表分頁失敗 " + res.status + " " + t);
          });
        }
        return res.json();
      }).then(function (meta) {
        const byKey = Object.create(null);
        ((meta && meta.sheets) || []).forEach(function (s) {
          const n = s.properties && s.properties.title;
          if (!n) return;
          byKey[sheetTitleKey(n)] = {
            title: n,
            sheetId: s.properties.sheetId
          };
        });
        const requests = [];
        const wanted = (wantedNames || []).map(function (n) { return String(n || "").trim(); }).filter(Boolean);
        const pendingKeys = Object.create(null);

        function hasTitle(name) {
          const k = sheetTitleKey(name);
          return !!(byKey[k] || pendingKeys[k]);
        }
        function markPending(name) {
          pendingKeys[sheetTitleKey(name)] = true;
        }

        // 預設 Sheet1／工作表1 → 改名成第一個尚不存在的目標名
        const defaultEntry = Object.keys(byKey).map(function (k) { return byKey[k]; }).find(function (e) {
          return /^工作表\d+$/i.test(e.title) || /^Sheet\d+$/i.test(e.title);
        });
        if (defaultEntry && wanted.length && !hasTitle(wanted[0])) {
          requests.push({
            updateSheetProperties: {
              properties: { sheetId: defaultEntry.sheetId, title: wanted[0] },
              fields: "title"
            }
          });
          markPending(wanted[0]);
          delete byKey[sheetTitleKey(defaultEntry.title)];
          byKey[sheetTitleKey(wanted[0])] = { title: wanted[0], sheetId: defaultEntry.sheetId };
        }

        wanted.forEach(function (name) {
          if (hasTitle(name)) return;
          requests.push({ addSheet: { properties: { title: name } } });
          markPending(name);
        });

        if (!requests.length) return sid;
        return sheetsFetch(
          "https://sheets.googleapis.com/v4/spreadsheets/" + encodeURIComponent(sid) +
          ":batchUpdate",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ requests: requests })
          }
        ).then(function (res) {
          if (res.ok) return sid;
          return res.text().then(function (t) {
            // 已有同名分頁＝可視為成功（競態／重試）
            if (res.status === 400 && /已有工作表使用|already exists|duplicate/i.test(t)) {
              return sid;
            }
            throw new Error("建立工作表分頁失敗 " + res.status + " " + t);
          });
        });
      });
    });
    sheetTabsLocks[sid] = run.then(function () {}, function () {});
    return run;
  }

  function findSpreadsheetInFolder(folderId, title) {
    const safe = String(title || "").replace(/'/g, "\\'");
    let q = "mimeType='application/vnd.google-apps.spreadsheet' and name='" + safe + "' and trashed=false";
    if (folderId && folderId !== "root") q += " and '" + folderId + "' in parents";
    return driveListByQuery(q).then(function (files) {
      return (files[0] && files[0].id) || "";
    });
  }

  function createSpreadsheetInFolder(folderId, title) {
    const meta = {
      name: title,
      mimeType: "application/vnd.google-apps.spreadsheet"
    };
    if (folderId) meta.parents = [folderId];
    return driveFetch("https://www.googleapis.com/drive/v3/files?fields=id,name&supportsAllDrives=true", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(meta)
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error("建立試算表失敗 " + res.status + " " + t);
        });
      }
      return res.json();
    }).then(function (f) { return f.id; });
  }

  function ensureIndexSpreadsheetId() {
    if (cachedIndexSpreadsheetId) return Promise.resolve(cachedIndexSpreadsheetId);
    if (cfg.indexSpreadsheetId) {
      cachedIndexSpreadsheetId = String(cfg.indexSpreadsheetId).trim();
      return Promise.resolve(cachedIndexSpreadsheetId);
    }
    return ensureProjectsRootId().then(function (rootId) {
      return findSpreadsheetInFolder(rootId, indexSpreadsheetName()).then(function (id) {
        if (id) {
          cachedIndexSpreadsheetId = id;
          return ensureSheetTabs(id, [indexSheetName()]).catch(function (e) {
            console.warn("索引試算表分頁準備失敗", e);
            return id;
          }).then(function () { return id; });
        }
        return createSpreadsheetInFolder(rootId, indexSpreadsheetName()).then(function (nid) {
          cachedIndexSpreadsheetId = nid;
          return ensureSheetTabs(nid, [indexSheetName()]).catch(function (e) {
            console.warn("索引試算表分頁準備失敗", e);
            return nid;
          }).then(function () { return nid; });
        });
      });
    });
  }

  function readIndexFromSheets() {
    return ensureIndexSpreadsheetId().then(function (sid) {
      return ensureSheetTabs(sid, [indexSheetName()]).then(function () {
        return sheetsGetValues(sid, indexSheetName()).then(function (aoa) {
          const codec = global.LineSheetsCodec;
          if (!codec) return { projects: [], forceBuildId: "", spreadsheetId: sid };
          const parsed = codec.indexAoaToProjects(aoa);
          return {
            projects: (parsed.projects || []).map(normalizeProjectRecord),
            forceBuildId: parsed.forceBuildId || "",
            spreadsheetId: sid
          };
        });
      });
    });
  }

  function writeIndexToSheets(projects) {
    const list = Array.isArray(projects) ? projects.map(normalizeProjectRecord) : [];
    const buildId = String(cfg.forceIndexBuildId || "").trim();
    const codec = global.LineSheetsCodec;
    if (!codec) return Promise.reject(new Error("缺少 LineSheetsCodec"));
    return ensureIndexSpreadsheetId().then(function (sid) {
      return ensureSheetTabs(sid, [indexSheetName()]).then(function () {
        const aoa = codec.projectsToIndexAoa(list, buildId);
        const map = {};
        map[indexSheetName()] = aoa;
        return sheetsBatchUpdateValues(sid, map).then(function () { return list; });
      });
    });
  }

  function projectSheetTabNames() {
    const codec = global.LineSheetsCodec;
    const n = (codec && codec.sheetNames()) || {};
    return [n.meta, n.track, n.weekly, n.outlook, n.overview, n.photos].filter(Boolean);
  }

  function findExistingProjectSpreadsheetId(proj) {
    const p = proj || activeProject;
    if (!p) return Promise.resolve("");
    const key = projCacheKey(p);
    const known = (p.spreadsheetId || (key && spreadsheetIdByProject[key]) || state.spreadsheetId || "").trim();
    const title = projectSpreadsheetTitle(p);
    if (known) {
      rememberSpreadsheetId(known);
      return Promise.resolve(known);
    }
    return ensureFolderId().then(function (folderId) {
      if (p) p.folderId = folderId;
      return findSpreadsheetInFolder(folderId, title).then(function (id) {
        if (id) rememberSpreadsheetId(id);
        if (id && p) p.spreadsheetId = id;
        return id || "";
      });
    });
  }

  function ensureProjectSpreadsheetId(proj) {
    const p = proj || activeProject;
    if (!p) return Promise.reject(new Error("尚未選擇專案"));
    const title = projectSpreadsheetTitle(p);

    function afterId(id) {
      rememberSpreadsheetId(id);
      if (p) p.spreadsheetId = id;
      return ensureSheetTabs(id, projectSheetTabNames()).then(function () { return id; });
    }

    return findExistingProjectSpreadsheetId(p).then(function (existing) {
      if (existing) return afterId(existing);
      return ensureFolderId().then(function (folderId) {
        if (p) p.folderId = folderId;
        return createSpreadsheetInFolder(folderId, title).then(afterId);
      });
    });
  }

  function readPayloadFromSheets(spreadsheetId) {
    const codec = global.LineSheetsCodec;
    if (!codec) return Promise.reject(new Error("缺少 LineSheetsCodec"));
    const names = codec.sheetNames();
    // 先讀 _meta；有完整 payload 就夠用（加速總覽／切案）
    return sheetsGetValues(spreadsheetId, names.meta).then(function (metaAoa) {
      if (!metaAoa || metaAoa.length <= 1) return null;
      const parsed = codec.parseMetaAoa(metaAoa);
      if (parsed && parsed.payload && (
        (Array.isArray(parsed.payload.equipment) && parsed.payload.equipment.length) ||
        (Array.isArray(parsed.payload.nodes) && parsed.payload.nodes.length) ||
        parsed.payload.title
      )) {
        return parsed.payload;
      }
      // meta 不完整時再讀清單表覆寫 equipment
      return sheetsGetValues(spreadsheetId, names.track).then(function (trackAoa) {
        const aoaByName = {};
        aoaByName[names.meta] = metaAoa;
        aoaByName[names.track] = trackAoa || [];
        return codec.sheetAoaMapToPayload(aoaByName, {});
      });
    });
  }

  const sheetsMigrateBusy = Object.create(null);

  /** 背景把 JSON 寫入試算表（不阻塞載入） */
  function scheduleSheetsMigrateFromLegacy(payload) {
    if (!isSheetsMode() || !payload || !activeProject) return;
    const key = projCacheKey(activeProject);
    if (!key || sheetsMigrateBusy[key]) return;
    sheetsMigrateBusy[key] = true;
    const proj = activeProject;
    const body = payload;
    // 背景遷移：不要 withScopeRetry／consent，避免邊用邊跳授權窗
    Promise.resolve()
      .then(function () {
        if (!state.token) return;
        return ensureProjectSpreadsheetId(proj).then(function (sid) {
          return writePayloadToSheets(sid, body).then(function () {
            rememberSpreadsheetId(sid);
            if (proj) proj.spreadsheetId = sid;
            return persistSpreadsheetIdToIndex(proj);
          });
        });
      })
      .catch(function (e) { console.warn("背景 Sheets 遷移失敗", e); })
      .then(function () { delete sheetsMigrateBusy[key]; });
  }

  function writePayloadToSheets(spreadsheetId, payload) {
    const codec = global.LineSheetsCodec;
    if (!codec) return Promise.reject(new Error("缺少 LineSheetsCodec"));
    // 人讀表需要 XLSX codec
    if (!global.LineXlsxCodec) {
      console.warn("LineXlsxCodec 未載入，僅寫入 _meta／_photos");
    }
    const aoaMap = codec.payloadToSheetAoaMap(payload);
    return ensureSheetTabs(spreadsheetId, Object.keys(aoaMap)).then(function () {
      return sheetsBatchUpdateValues(spreadsheetId, aoaMap);
    });
  }

  function downloadJsonLegacy() {
    const key = projCacheKey(activeProject);
    const cachedId = state.fileId || (key && fileIdByProject[key]) || "";
    const tryCached = cachedId
      ? fetchJsonIfInActiveFolder(cachedId).then(function (data) {
          if (data) {
            saveStoredFileId(cachedId);
            return data;
          }
          return null;
        }).catch(function () { return null; })
      : Promise.resolve(null);
    return tryCached.then(function (cachedData) {
      if (cachedData) return cachedData;
      return findFilesInFolder().then(function (inFolder) {
        return downloadFirstNonEmpty(inFolder).then(function (data) {
          if (data) return data;
          if (isSharedProjectsRoot()) return null;
          return findLegacyData();
        });
      });
    });
  }

  function uploadJsonLegacy(payload) {
    const body = JSON.stringify(payload);
    return ensureFileId().then(function (id) {
      return driveFetch("https://www.googleapis.com/upload/drive/v3/files/" + id + "?uploadType=media", {
        method: "PATCH",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: body
      }).then(function (res) {
        if (res.status === 404) {
          saveStoredFileId("");
          return createFile().then(function (nid) {
            return driveFetch("https://www.googleapis.com/upload/drive/v3/files/" + nid + "?uploadType=media", {
              method: "PATCH",
              headers: { "Content-Type": "application/json; charset=utf-8" },
              body: body
            });
          });
        }
        return res;
      }).then(function (res) {
        if (!res.ok) return res.text().then(function (t) { throw new Error("上傳失敗 " + res.status + " " + t); });
        return res.json().catch(function () { return {}; });
      });
    });
  }

  function persistSpreadsheetIdToIndex(proj) {
    if (!proj || !proj.spreadsheetId) return Promise.resolve();
    return readIndexFromSheets().then(function (idx) {
      let list = idx.projects || [];
      let found = false;
      list = list.map(function (p) {
        if (p.id === proj.id || normFolderKey(p.name) === normFolderKey(proj.name)) {
          found = true;
          return normalizeProjectRecord(Object.assign({}, p, {
            spreadsheetId: proj.spreadsheetId,
            folderId: proj.folderId || p.folderId
          }));
        }
        return p;
      });
      if (!found) list.push(normalizeProjectRecord(proj));
      return writeIndexToSheets(list);
    }).catch(function (e) {
      console.warn("索引寫回 spreadsheetId 失敗", e);
    });
  }

  /** 專案資料夾相對共用根／projectsRoot 的路徑片段（通常只有專案名稱） */
  function projectFolderWalkParts() {
    const parts = folderPathParts();
    const rootParts = projectsRootParts();
    const legacyRoot = splitPath(legacyPersonalRootName());
    let walk = parts.slice();
    function stripPrefix(prefix) {
      let i = 0;
      while (i < prefix.length && i < walk.length && walk[i] === prefix[i]) i += 1;
      if (i > 0) walk = walk.slice(i);
    }
    stripPrefix(rootParts);
    stripPrefix(legacyRoot);
    if (!walk.length && activeProject && activeProject.name) {
      walk = [sanitizeProjectFolderName(activeProject.name)];
    }
    return walk;
  }

  function findPersonalProjectsRootId() {
    const name = legacyPersonalRootName();
    return findChildFolder("root", name).then(function (id) {
      if (id) return id;
      const safe = name.replace(/'/g, "\\'");
      return driveListByQuery(
        "mimeType='application/vnd.google-apps.folder' and name='" + safe + "' and trashed=false"
      ).then(function (files) {
        return (files[0] && files[0].id) || "";
      });
    });
  }

  /** 資料夾名比對鍵：去空白／不分大小寫（避免「DIP 自動換線」vs「DIP自動換線」重覆建立） */
  function normFolderKey(name) {
    return String(name || "").replace(/\s+/g, "").toLowerCase();
  }

  function ensureNamedChildFolder(parentId, name) {
    return findChildFolder(parentId, name).then(function (id) {
      if (id) return id;
      return createChildFolder(parentId, sanitizeProjectFolderName(name));
    });
  }

  /** 把單一專案的 line_data.json 從舊根複製到共用根（同名資料夾不新建） */
  function copyProjectJsonToShared(sharedRootId, oldRootId, proj) {
    const name = String((proj && proj.name) || "").trim();
    if (!name) return Promise.resolve(null);
    const folderName = sanitizeProjectFolderName(name);
    const oldParts = splitPath((proj && proj.folderPath) || "");
    const oldFolderName = oldParts.length ? oldParts[oldParts.length - 1] : folderName;
    return findChildFolder(oldRootId, oldFolderName).then(function (oldId) {
      if (!oldId && oldFolderName !== folderName) return findChildFolder(oldRootId, folderName);
      return oldId;
    }).then(function (oldProjId) {
      if (!oldProjId) return null;
      return fetchJsonInFolder(oldProjId, fileName()).then(function (payload) {
        if (!payload) return null;
        return ensureNamedChildFolder(sharedRootId, folderName).then(function (newProjId) {
          return putJsonInFolder(newProjId, fileName(), payload).then(function () {
            return normalizeProjectRecord(Object.assign({}, proj, { name: folderName }));
          });
        });
      });
    });
  }

  /**
   * 僅在共用根「完全沒有專案資料夾」時，才從個人「架線進度專案」遷移。
   * 已有資料夾時以 Drive 實體為準，不再複製、不再新建。
   */
  function migrateIntoSharedRootIfNeeded(sharedRootId, sharedList) {
    if (!isSharedProjectsRoot()) return Promise.resolve(sharedList || []);
    return listChildFolders(sharedRootId).then(function (folders) {
      const projectFolders = (folders || []).filter(function (f) {
        return !!normFolderKey(f.name);
      });
      if (projectFolders.length) return sharedList || [];
      return findPersonalProjectsRootId().then(function (oldRoot) {
        if (!oldRoot || oldRoot === sharedRootId) return sharedList || [];
        return fetchJsonInFolder(oldRoot, "projects_index.json").then(function (data) {
          const oldList = (data && Array.isArray(data.projects)) ? data.projects : [];
          if (!oldList.length) return sharedList || [];
          let chain = Promise.resolve([]);
          oldList.forEach(function (p) {
            chain = chain.then(function (acc) {
              return copyProjectJsonToShared(sharedRootId, oldRoot, p).then(function (rec) {
                if (rec) acc.push(rec);
                else acc.push(normalizeProjectRecord(p));
                return acc;
              }).catch(function () {
                acc.push(normalizeProjectRecord(p));
                return acc;
              });
            });
          });
          return chain.then(function (copied) {
            const seen = {};
            const next = copied.filter(function (p) {
              const k = normFolderKey(p.name);
              if (!k || seen[k]) return false;
              seen[k] = true;
              return true;
            });
            return putJsonInFolder(sharedRootId, "projects_index.json", {
              savedAt: new Date().toISOString(),
              migratedFrom: legacyPersonalRootName(),
              projects: next
            }).then(function () { return next; });
          });
        });
      });
    }).catch(function () {
      return sharedList || [];
    });
  }

  function defaultProjectsList() {
    const legacyPath = (cfg.legacyFolderPath || "R01_V4架線進度").trim();
    const folderName = sanitizeProjectFolderName("VIVO R01");
    const newPath = projectsRootParts().concat([folderName]).join("/");
    return [{
      id: "vivo-r01",
      name: "VIVO R01",
      folderPath: newPath,
      legacyFallback: true,
      legacyFolderPath: legacyPath,
      legacyFileName: (cfg.legacyFileName || "vivo_r01_line_data.json").trim(),
      createdAt: new Date().toISOString()
    }];
  }

  function parentIdOrRoot(folderId) {
    return (!folderId || folderId === "root") ? "root" : folderId;
  }

  function parentQueryClause(folderId) {
    return " and '" + parentIdOrRoot(folderId) + "' in parents";
  }

  function fetchJsonInFolder(folderId, name) {
    const safe = String(name || "").replace(/'/g, "\\'");
    const q = "name='" + safe + "' and trashed=false" + parentQueryClause(folderId);
    return driveListByQuery(q).then(function (files) {
      if (!files.length) return null;
      // 多份同名：一律取最新（modifiedTime desc）；舊的進垃圾桶
      // ※ 不可再「專案數最多」——刪案後較小的新清單會被舊的四案清單蓋回
      if (files.length > 1) {
        const keep = files[0];
        const trashOthers = files.slice(1).map(function (f) { return trashDriveFile(f.id); });
        return Promise.all(trashOthers).then(function () {
          return fetchJsonById(keep.id);
        });
      }
      return fetchJsonById(files[0].id);
    });
  }

  function trashDriveFile(fileId) {
    if (!fileId) return Promise.resolve();
    return driveFetch(
      "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) + "?supportsAllDrives=true",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trashed: true })
      }
    ).then(function () { return null; }).catch(function () { return null; });
  }

  function createJsonInFolder(folderId, name, body) {
    const meta = {
      name: name,
      mimeType: "application/json",
      parents: [parentIdOrRoot(folderId)]
    };
    const boundary = "line_proj_" + Date.now().toString(36);
    const multipart =
      "--" + boundary + "\r\n" +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      JSON.stringify(meta) + "\r\n" +
      "--" + boundary + "\r\n" +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      body + "\r\n" +
      "--" + boundary + "--";
    return driveFetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name",
      {
        method: "POST",
        headers: { "Content-Type": "multipart/related; boundary=" + boundary },
        body: multipart
      }
    ).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error("建立專案清單失敗 " + res.status + " " + t);
        });
      }
      return res.json();
    });
  }

  function putJsonInFolder(folderId, name, payload) {
    const body = JSON.stringify(payload);
    const safe = String(name || "").replace(/'/g, "\\'");
    const q = "name='" + safe + "' and trashed=false" + parentQueryClause(folderId);
    return driveListByQuery(q).then(function (files) {
      if (!files.length) return createJsonInFolder(folderId, name, body);
      // 同名多份：保留最新一份，其餘進垃圾桶，絕不新建
      const keep = files[0];
      const trashOthers = files.slice(1).map(function (f) { return trashDriveFile(f.id); });
      return Promise.all(trashOthers).then(function () {
        return driveFetch(
          "https://www.googleapis.com/upload/drive/v3/files/" + encodeURIComponent(keep.id) +
          "?uploadType=media&supportsAllDrives=true",
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json; charset=utf-8" },
            body: body
          }
        ).then(function (res) {
          if (res.ok) return keep;
          return res.text().then(function (t) {
            if (res.status === 403 || res.status === 404) {
              // 不可寫時改寫到既有其他檔；都失敗才新建一次
              return trashDriveFile(keep.id).then(function () {
                return driveListByQuery(q).then(function (left) {
                  if (left.length) {
                    return putJsonInFolder(folderId, name, payload);
                  }
                  return createJsonInFolder(folderId, name, body);
                });
              });
            }
            throw new Error("寫入專案清單失敗 " + res.status + " " + t);
          });
        });
      });
    });
  }

  function forceIndexHints() {
    const raw = cfg.forceIndexProjects;
    if (!Array.isArray(raw) || !raw.length) return [];
    return raw.map(normalizeProjectRecord);
  }

  /** 以共用根底下「實體資料夾」重建專案清單，並清掉同名重複資料夾 */
  function syncProjectsIndexFromDrive(rootId, hintList, opts) {
    opts = opts || {};
    const hints = {};
    (hintList || []).forEach(function (p) {
      const k = normFolderKey(p && p.name);
      if (k) hints[k] = p;
    });
    return listChildFolders(rootId).then(function (folders) {
      const groups = {};
      (folders || []).forEach(function (f) {
        const k = normFolderKey(f.name);
        if (!k) return;
        (groups[k] = groups[k] || []).push(f);
      });
      const keys = Object.keys(groups);
      let chain = Promise.resolve([]);
      keys.forEach(function (k) {
        chain = chain.then(function (acc) {
          return consolidateFolderGroup(groups[k]).then(function (best) {
            if (!best) return acc;
            return fetchJsonInFolder(best.id, fileName()).then(function (payload) {
              const hint = hints[k] || {};
              let arch = "unified";
              if (payload && payload.arch) arch = payload.arch;
              else if (hint.arch) arch = hint.arch;
              else if (payload && Array.isArray(payload.equipment) && payload.equipment.length
                && Array.isArray(payload.stages) && payload.stages.length) arch = "equipment";
              else if (payload && Array.isArray(payload.nodes) && payload.nodes.length) arch = "hierarchy";
              // 強制重建時優先用指定顯示名稱（與雲端資料夾一致）
              const displayName = String((hint.name) || best.name || k).trim() || k;
              acc.push(normalizeProjectRecord({
                id: hint.id || ("p-" + String(best.id).slice(0, 10)),
                name: displayName,
                arch: arch,
                legacyFallback: !!hint.legacyFallback,
                legacyFolderPath: hint.legacyFolderPath || "",
                legacyFileName: hint.legacyFileName || "",
                createdAt: hint.createdAt || ""
              }));
              return acc;
            });
          });
        });
      });
      return chain.then(function (list) {
        // 預設：只認實體資料夾。缺資料夾的 hint 不再幽靈寫回（否則刪案重整又出現）
        if (opts.seedMissing) {
          Object.keys(hints).forEach(function (k) {
            if (list.some(function (p) { return normFolderKey(p.name) === k; })) return;
            list.push(normalizeProjectRecord(hints[k]));
          });
        }
        list.sort(function (a, b) {
          return String(a.name || "").localeCompare(String(b.name || ""), "zh-Hant");
        });
        // Sheets-only：掃描結果交呼叫端寫入試算表，這裡不再寫 projects_index.json
        if (isSheetsMode() && cfg.indexSheetsOnly !== false) {
          return list;
        }
        const payload = {
          savedAt: new Date().toISOString(),
          syncedFromFolders: true,
          projects: list
        };
        const buildId = String(opts.forceBuildId || cfg.forceIndexBuildId || "").trim();
        if (buildId) payload.forceBuildId = buildId;
        return putJsonInFolder(rootId, "projects_index.json", payload).then(function () { return list; });
      });
    });
  }

  /** 只讀專案清單，不依資料夾重建（刪案用） */
  function readProjectsIndexRaw() {
    return ensureInit()
      .then(function () {
        if (!state.account) return login();
      })
      .then(function () {
        return ensureProjectsRootId().then(function (rootId) {
          function fromJson() {
            return fetchJsonInFolder(rootId, "projects_index.json").then(function (data) {
              const list = (data && Array.isArray(data.projects))
                ? data.projects.map(normalizeProjectRecord)
                : [];
              return { rootId: rootId, data: data || null, list: list };
            });
          }
          if (!isSheetsMode()) return fromJson();
          // Sheets 403／未開 API 時改讀 JSON，避免刪案整段失敗
          return readIndexFromSheets().then(function (idx) {
            const list = (idx.projects || []).filter(function (p) { return p && p.name; });
            if (list.length) {
              return {
                rootId: rootId,
                data: { forceBuildId: idx.forceBuildId, projects: list },
                list: list
              };
            }
            return fromJson();
          }).catch(function (e) {
            console.warn("讀 Sheets 索引失敗，改讀 JSON", e);
            return fromJson();
          });
        });
      });
  }

  /** 合併多來源專案清單（後寫入覆蓋同 id／同名） */
  function mergeProjectLists() {
    const byKey = Object.create(null);
    const out = [];
    function addAll(arr) {
      (arr || []).forEach(function (raw) {
        const p = normalizeProjectRecord(raw);
        if (!p || !p.name) return;
        const k = normFolderKey(p.name) || p.id;
        if (byKey[k]) {
          const prev = byKey[k];
          byKey[k] = normalizeProjectRecord(Object.assign({}, prev, p, {
            spreadsheetId: p.spreadsheetId || prev.spreadsheetId,
            folderId: p.folderId || prev.folderId,
            legacyFallback: p.legacyFallback || prev.legacyFallback
          }));
          const idx = out.indexOf(prev);
          if (idx >= 0) out[idx] = byKey[k];
        } else {
          byKey[k] = p;
          out.push(p);
        }
      });
    }
    for (let i = 0; i < arguments.length; i++) addAll(arguments[i]);
    return out;
  }

  /** 從 JSON／資料夾／設定提示組出專案清單（不寫空清單蓋掉舊 JSON） */
  function recoverProjectsList(rootId, buildId) {
    const forced = forceIndexHints();
    return fetchJsonInFolder(rootId, "projects_index.json").then(function (data) {
      const fromJson = (data && Array.isArray(data.projects))
        ? data.projects.map(normalizeProjectRecord).filter(function (p) { return p && p.name; })
        : [];
      // 只掃描資料夾，不要在這裡 putJson（避免空結果蓋掉舊 index）
      return listChildFolders(rootId, { bypassCache: true }).then(function (folders) {
        const fromFolders = [];
        const groups = {};
        (folders || []).forEach(function (f) {
          const k = normFolderKey(f.name);
          if (!k) return;
          (groups[k] = groups[k] || []).push(f);
        });
        const keys = Object.keys(groups);
        let chain = Promise.resolve();
        keys.forEach(function (k) {
          chain = chain.then(function () {
            return consolidateFolderGroup(groups[k]).then(function (best) {
              if (!best) return;
              const hint = forced.find(function (h) {
                return normFolderKey(h.name) === k;
              }) || {};
              fromFolders.push(normalizeProjectRecord({
                id: hint.id || ("p-" + String(best.id).slice(0, 10)),
                name: String(hint.name || best.name || k).trim() || k,
                arch: hint.arch || "unified",
                folderId: best.id,
                legacyFallback: !!hint.legacyFallback,
                legacyFolderPath: hint.legacyFolderPath || "",
                legacyFileName: hint.legacyFileName || "",
                createdAt: hint.createdAt || ""
              }));
            });
          });
        });
        return chain.then(function () {
          let list = mergeProjectLists(fromJson, fromFolders, forced);
          if (!list.length) {
            return migrateIntoSharedRootIfNeeded(rootId, forced).then(function () {
              return listChildFolders(rootId, { bypassCache: true }).then(function (folders2) {
                (folders2 || []).forEach(function (f) {
                  const name = String(f.name || "").trim();
                  if (!name) return;
                  list.push(normalizeProjectRecord({
                    id: "p-" + String(f.id).slice(0, 10),
                    name: name,
                    folderId: f.id,
                    arch: "unified"
                  }));
                });
                list = mergeProjectLists(list, forced);
                if (!list.length) list = defaultProjectsList().map(normalizeProjectRecord);
                return list;
              });
            });
          }
          return list;
        });
      });
    });
  }

  function trashIndexJsonInRoot(rootId) {
    const safe = "projects_index.json".replace(/'/g, "\\'");
    const q = "name='" + safe + "' and trashed=false" + parentQueryClause(rootId);
    return driveListByQuery(q).then(function (files) {
      if (!files.length) return;
      return Promise.all(files.map(function (f) { return trashDriveFile(f.id); }));
    }).catch(function (e) {
      console.warn("清除舊 projects_index.json 失敗", e);
    });
  }

  function persistIndexList(list, buildId) {
    const projects = (list || []).map(normalizeProjectRecord).filter(function (p) { return p && p.name; });
    const sheetsOnly = isSheetsMode() && cfg.indexSheetsOnly !== false;
    return ensureProjectsRootId().then(function (rootId) {
      if (!isSheetsMode()) {
        return putJsonInFolder(rootId, "projects_index.json", {
          savedAt: new Date().toISOString(),
          forceBuildId: buildId || undefined,
          projects: projects
        }).then(function () { return projects; });
      }
      // ★ 索引只寫 Sheets；成功後可清掉舊 projects_index.json
      return writeIndexToSheets(projects).then(function () {
        if (sheetsOnly && cfg.trashIndexJsonAfterSheetsWrite !== false) {
          return trashIndexJsonInRoot(rootId).then(function () { return projects; });
        }
        return projects;
      }).catch(function (err) {
        const msg = String((err && err.message) || err || "");
        if (/403|Sheets API has not been used|accessNotConfigured/i.test(msg)) {
          throw new Error(
            "寫入專案索引試算表失敗（請在 GCP 啟用 Google Sheets API，並重新登入授權）。" +
            (msg ? "\n" + msg : "")
          );
        }
        throw err;
      });
    });
  }

  function migrateIndexJsonToSheets(rootId, buildId) {
    return recoverProjectsList(rootId, buildId).then(function (list) {
      return persistIndexList(list, buildId);
    });
  }

  function loadProjectsIndex() {
    return ensureInit()
      .then(function () {
        if (!state.account) return login();
      })
      .then(function () {
        return withScopeRetry(function () {
          return ensureProjectsRootId().then(function (rootId) {
            const buildId = String(cfg.forceIndexBuildId || "").trim();

            if (isSheetsMode()) {
              return readIndexFromSheets().then(function (idx) {
                let list = (idx.projects || []).filter(function (p) { return p && p.name; });
                const buildMismatch = !!(buildId && idx.forceBuildId !== buildId);
                // 空清單或強制版次變更 → 從舊 JSON／資料夾／設定提示還原
                if (!list.length || buildMismatch) {
                  return recoverProjectsList(rootId, buildId).then(function (recovered) {
                    const merged = mergeProjectLists(list, recovered);
                    return persistIndexList(merged, buildId);
                  });
                }
                return list;
              }).catch(function (err) {
                console.warn("讀 Sheets 專案索引失敗，改從 JSON／資料夾還原", err);
                return migrateIndexJsonToSheets(rootId, buildId);
              });
            }

            return fetchJsonInFolder(rootId, "projects_index.json").then(function (data) {
              let list = (data && Array.isArray(data.projects))
                ? data.projects.map(normalizeProjectRecord).filter(function (p) { return p && p.name; })
                : [];
              const hasIndex = list.length > 0;

              if (hasIndex) {
                if (buildId && data.forceBuildId !== buildId) {
                  return putJsonInFolder(rootId, "projects_index.json", {
                    savedAt: new Date().toISOString(),
                    forceBuildId: buildId,
                    projects: list
                  }).then(function () { return list; });
                }
                return list;
              }

              const forced = forceIndexHints();
              return syncProjectsIndexFromDrive(rootId, forced, {
                forceBuildId: buildId,
                seedMissing: false
              }).then(function (fromFolders) {
                if (fromFolders && fromFolders.length) return fromFolders;
                return migrateIntoSharedRootIfNeeded(rootId, forced).then(function (migrated) {
                  return syncProjectsIndexFromDrive(rootId, migrated || forced, {
                    forceBuildId: buildId,
                    seedMissing: false
                  }).then(function (again) {
                    if (again && again.length) return again;
                    const fallback = defaultProjectsList().map(normalizeProjectRecord);
                    return putJsonInFolder(rootId, "projects_index.json", {
                      savedAt: new Date().toISOString(),
                      forceBuildId: buildId || undefined,
                      projects: fallback
                    }).then(function () { return fallback; });
                  });
                });
              });
            });
          });
        });
      });
  }

  function saveProjectsIndex(projects) {
    const list = Array.isArray(projects) ? projects : [];
    const buildId = String(cfg.forceIndexBuildId || "").trim();
    return ensureInit()
      .then(function () {
        if (!state.account) return login();
      })
      .then(function () {
        // 一律走 persistIndexList：先／保 JSON，Sheets 失敗不擋刪案／排序
        return persistIndexList(list, buildId);
      });
  }

  function createProject(name, opts) {
    opts = opts || {};
    const label = String(name || "").trim();
    if (!label) return Promise.reject(new Error("請輸入專案名稱"));
    const arch = opts.arch || "unified";
    const folderName = sanitizeProjectFolderName(label);
    const folderPath = projectsRootParts().concat([folderName]).join("/");
    const proj = {
      id: "p-" + Date.now().toString(36),
      name: label,
      folderPath: folderPath,
      arch: arch,
      legacyFallback: false,
      createdAt: new Date().toISOString()
    };
    return loadProjectsIndex().then(function (list) {
      if (list.some(function (p) { return p.name === label; })) {
        throw new Error("專案名稱已存在");
      }
      list.push(proj);
      return saveProjectsIndex(list).then(function () {
        // 先切到新專案並確保資料夾存在
        setActiveProject(proj);
        return ensureFolderId().then(function () { return proj; });
      });
    });
  }

  function trashOrDeleteDriveId(fileId) {
    if (!fileId) return Promise.resolve();
    return withScopeRetry(function () {
      return driveFetch(
        "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) + "?supportsAllDrives=true",
        { method: "DELETE" }
      ).then(function (res) {
        if (res.status === 404 || res.ok) return;
        return driveFetch(
          "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) + "?supportsAllDrives=true",
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ trashed: true })
          }
        ).then(function (r2) {
          if (r2.status === 404 || r2.ok) return;
          return r2.text().then(function (t) {
            throw new Error("刪除雲端資料夾失敗 " + r2.status + " " + t);
          });
        });
      });
    });
  }

  /** 刪除專案在共用根下的資料夾（同名／去空白同名全部刪） */
  function deleteProjectFolder(proj) {
    const name = String((proj && proj.name) || "").trim();
    if (!name) return Promise.resolve();
    const want = normFolderKey(name);
    const key = projCacheKey(proj);
    if (key) {
      delete folderIdByProject[key];
      delete fileIdByProject[key];
    }
    if (activeProject && projCacheKey(activeProject) === key) {
      cachedFolderId = "";
      state.fileId = "";
    }
    return ensureProjectsRootId().then(function (rootId) {
      return listChildFolders(rootId, { bypassCache: true }).then(function (folders) {
        const matches = (folders || []).filter(function (f) {
          return normFolderKey(f.name) === want;
        });
        let chain = Promise.resolve();
        matches.forEach(function (f) {
          chain = chain.then(function () { return trashOrDeleteDriveId(f.id); });
        });
        return chain;
      });
    }).then(function () {
      try {
        const root = sharedProjectsRootId() || "";
        if (root) delete childFolderListCache[root];
        delete childFolderListCache["root"];
      } catch (e) {}
    });
  }

  function deleteProject(projectId, opts) {
    opts = opts || {};
    const id = String(projectId || "");
    if (!id) return Promise.reject(new Error("缺少專案 ID"));
    // 用 raw 讀取，避免 loadProjectsIndex 先依資料夾把專案同步回來
    return readProjectsIndexRaw().then(function (raw) {
      let list = (raw && raw.list) || [];
      // UI 傳入的目前清單可補 raw 漏讀（Sheets 空／403）
      if (Array.isArray(opts.knownList) && opts.knownList.length) {
        list = mergeProjectLists(list, opts.knownList);
      }
      let hit = list.find(function (p) { return p && p.id === id; });
      // index 過期時，仍允許用目前作用中專案刪資料夾
      if (!hit && activeProject && String(activeProject.id) === id) {
        hit = normalizeProjectRecord(activeProject);
      }
      if (!hit && opts.fallbackProject) {
        hit = normalizeProjectRecord(opts.fallbackProject);
      }
      if (!hit) throw new Error("找不到要刪除的專案");
      const next = list.filter(function (p) {
        if (!p) return false;
        if (p.id === id) return false;
        // 同名也一併從清單拿掉，避免 id 不一致又殘留
        if (normFolderKey(p.name) === normFolderKey(hit.name)) return false;
        return true;
      });
      // ★ 先寫入較短清單（JSON 為準；Sheets 失敗不擋），再刪資料夾／試算表
      return saveProjectsIndex(next).then(function () {
        const trashSheet = hit.spreadsheetId
          ? trashOrDeleteDriveId(hit.spreadsheetId).catch(function (e) {
              console.warn("刪除專案試算表失敗", e);
            })
          : Promise.resolve();
        return trashSheet.then(function () {
          return deleteProjectFolder(hit).then(function () {
            return next;
          }).catch(function (err) {
            console.warn("專案資料夾刪除失敗（清單已更新）", err);
            // 共用根無權刪別人資料夾時仍算刪案成功（清單已拿掉）
            return next;
          });
        });
      });
    });
  }

  function uniqueProjectName(base, list) {
    const names = {};
    (list || []).forEach(function (p) { names[String(p.name || "")] = true; });
    let label = String(base || "專案副本").trim() || "專案副本";
    if (!names[label]) return label;
    let i = 2;
    while (names[label + " (" + i + ")"]) i += 1;
    return label + " (" + i + ")";
  }

  /** 複製專案：新建名稱＋資料夾，可選寫入 payload */
  function duplicateProject(sourceProj, newName, payload) {
    const src = sourceProj || {};
    const arch = (payload && payload.arch) || src.arch || "unified";
    return loadProjectsIndex().then(function (list) {
      const label = uniqueProjectName(newName || ((src.name || "專案") + " 副本"), list);
      return createProject(label, { arch: arch }).then(function (proj) {
        if (!payload) return proj;
        const body = Object.assign({}, payload, {
          projectId: proj.id,
          projectName: proj.name,
          savedAt: new Date().toISOString()
        });
        if (body.title) {
          body.title = String(body.title).replace(String(src.name || ""), proj.name);
        }
        setActiveProject(proj);
        return uploadJson(body).then(function () { return proj; });
      });
    });
  }

  function findLegacyData() {
    if (!activeProject || !activeProject.legacyFallback) return Promise.resolve(null);
    const legacyName = (activeProject.legacyFileName || cfg.legacyFileName || "vivo_r01_line_data.json").replace(/'/g, "\\'");
    const legacyParts = splitPath(activeProject.legacyFolderPath || cfg.legacyFolderPath || "");
    if (!legacyParts.length) {
      return driveListByQuery("name='" + legacyName + "' and trashed=false").then(function (files) {
        if (!files.length) return null;
        return fetchJsonById(files[0].id);
      });
    }
    let chain = Promise.resolve("root");
    legacyParts.forEach(function (part) {
      chain = chain.then(function (parentId) {
        return findChildFolder(parentId, part).then(function (id) { return id || ""; });
      });
    });
    return chain.then(function (folderId) {
      if (!folderId) return null;
      let q = "name='" + legacyName + "' and trashed=false and '" + folderId + "' in parents";
      return driveListByQuery(q).then(function (files) {
        if (!files.length) return null;
        return fetchJsonById(files[0].id);
      });
    });
  }

  function loadStoredFileId() {
    try {
      const fixed = (cfg.fileId || "").trim();
      if (fixed) {
        state.fileId = fixed;
        return;
      }
      state.fileId = localStorage.getItem(storageKey()) || "";
    } catch (e) {
      state.fileId = "";
    }
  }

  function saveStoredFileId(id) {
    state.fileId = id || "";
    const key = projCacheKey(activeProject);
    if (key) {
      if (id) fileIdByProject[key] = id;
      else delete fileIdByProject[key];
    }
    try {
      if (id) localStorage.setItem(storageKey(), id);
      else localStorage.removeItem(storageKey());
    } catch (e) {}
  }

  function waitForGis(timeoutMs) {
    const limit = timeoutMs || 15000;
    const start = Date.now();
    return new Promise(function (resolve, reject) {
      (function tick() {
        if (global.google && google.accounts && google.accounts.oauth2) {
          resolve();
          return;
        }
        if (Date.now() - start > limit) {
          reject(new Error("Google 登入庫載入逾時（請用 http/https 開啟）"));
          return;
        }
        setTimeout(tick, 100);
      })();
    });
  }

  function initMsal() { return ensureInit(); }

  function settlePendingToken(fn) {
    const pending = pendingToken;
    pendingToken = null;
    if (!pending || pending.settled) return;
    pending.settled = true;
    if (pending.timer) clearTimeout(pending.timer);
    fn(pending);
  }

  function cancelPendingLogin(message) {
    settlePendingToken(function (pending) {
      pending.reject(new Error(message || "已取消登入"));
    });
  }

  function ensureInit() {
    const id = (cfg.clientId || "").trim();
    if (!id || id.indexOf("PLEASE_") === 0) {
      return Promise.reject(new Error("請先在 google_config.js 填入 Google 用戶端 ID"));
    }
    if (state.ready && tokenClient) return Promise.resolve();
    return waitForGis().then(function () {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: id,
        scope: SCOPES,
        callback: function (resp) {
          settlePendingToken(function (pending) {
            if (resp && resp.error) {
              pending.reject(new Error(resp.error_description || resp.error));
              return;
            }
            state.token = (resp && resp.access_token) || "";
            pending.resolve(state.token);
          });
        },
        error_callback: function (err) {
          settlePendingToken(function (pending) {
            const typ = (err && err.type) || "";
            let msg = "Google 登入失敗，請再試一次";
            if (typ === "popup_failed_to_open") {
              msg = "無法開啟 Google 登入視窗（可能被瀏覽器封鎖）。請允許此網站的彈出式視窗後再按登入";
            } else if (typ === "popup_closed") {
              msg = "已關閉 Google 登入視窗，請再按「登入 Google」";
            } else if (err && (err.message || err.type)) {
              msg = "Google 登入失敗：" + (err.message || err.type);
            }
            pending.reject(new Error(msg));
          });
        }
      });
      state.ready = true;
    });
  }

  /** 必須在使用者點擊的同步呼叫堆疊內執行 requestAccessToken，否則瀏覽器會封鎖彈窗 */
  function requestTokenSync(prompt, hintEmail, timeoutMs) {
    if (!tokenClient || !state.ready) {
      return Promise.reject(new Error("Google 登入尚未就緒，請再按一次「登入 Google」"));
    }
    return new Promise(function (resolve, reject) {
      if (pendingToken && !pendingToken.settled) {
        settlePendingToken(function (pending) {
          pending.reject(new Error("已取消前一次登入，請再試一次"));
        });
      }
      const waitMs = Math.max(12000, Number(timeoutMs) || 90000);
      const pending = {
        settled: false,
        timer: null,
        resolve: resolve,
        reject: reject
      };
      pending.timer = setTimeout(function () {
        if (pending.settled) return;
        pending.settled = true;
        if (pendingToken === pending) pendingToken = null;
        reject(new Error("登入逾時。若沒看到 Google 視窗，請允許彈出式視窗後再試"));
      }, waitMs);
      pendingToken = pending;
      const req = { prompt: prompt || "" };
      // 已登入時帶 hint，避免「從雲端載入」又跳出選帳戶
      if (hintEmail) req.hint = hintEmail;
      try {
        tokenClient.requestAccessToken(req);
      } catch (e) {
        if (pending.settled) return;
        pending.settled = true;
        clearTimeout(pending.timer);
        if (pendingToken === pending) pendingToken = null;
        reject(e);
      }
    });
  }

  function requestToken(prompt, hintEmail, timeoutMs) {
    // 已就緒：同步開啟彈窗（保留 click user gesture）
    if (state.ready && tokenClient) {
      return requestTokenSync(prompt, hintEmail, timeoutMs);
    }
    // 尚未就緒：先載入 GIS，請使用者再點一次（await 後再開彈窗會被擋）
    return ensureInit().then(function () {
      return Promise.reject(new Error("Google 元件剛就緒，請再按一次「登入 Google」以開啟視窗"));
    });
  }

  function accountHint() {
    return (state.account && (state.account.email || state.account.username)) || "";
  }

  /** 目前登入帳號（小寫 email），未登入回空字串 */
  function accountEmail() {
    return String(accountHint() || "").trim().toLowerCase();
  }

  function fetchUserEmail(token) {
    return fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: "Bearer " + token }
    }).then(function (r) {
      if (!r.ok) return { email: "Google 使用者", name: "" };
      return r.json();
    }).then(function (u) {
      state.account = { email: u.email || "Google 使用者", name: u.name || "", username: u.email || "" };
      loadStoredFileId();
      return state.account;
    });
  }

  /**
   * opts.switchAccount = true → 重新登入／換帳（會跳出選帳戶）
   * 預設不強制 consent（有 token 就靜默續用）；缺 scope 時才由 withScopeRetry 要一次
   */
  function login(opts) {
    opts = opts || {};
    const switchAccount = !!opts.switchAccount;
    const prevEmail = accountEmail();
    state.token = "";
    if (switchAccount) {
      clearAllProjectCaches();
      activeProject = null;
      scopeConsentAsked = false;
    }
    // 不要預設 consent：會一直跳出「這個應用程式未經 Google 驗證」
    let prompt = "";
    if (switchAccount) prompt = "select_account";
    else if (opts.prompt != null) prompt = opts.prompt;
    const hint = switchAccount ? "" : (opts.hint || accountHint());
    return requestToken(prompt, hint).then(function (tok) {
      return fetchUserEmail(tok).then(function (acc) {
        const nextEmail = accountEmail();
        // 換帳後清掉舊帳的資料夾／檔案快取，強制走新帳號的「我的雲端硬碟」
        if (switchAccount || (prevEmail && nextEmail && prevEmail !== nextEmail)) {
          clearAllProjectCaches();
          activeProject = null;
        }
        startPresence();
        return acc;
      });
    });
  }

  function logout() {
    return stopPresence(true).catch(function () {}).then(function () {
      if (state.token && global.google && google.accounts && google.accounts.oauth2) {
        google.accounts.oauth2.revoke(state.token, function () {});
      }
      state.token = "";
      state.account = null;
      clearAllProjectCaches();
      activeProject = null;
      state.viewers = 0;
      state.viewerList = [];
      notifyViewers();
    });
  }

  function viewSessionId() {
    const key = "line_google_view_session_id";
    try {
      let id = localStorage.getItem(key);
      if (!id) {
        id = "s" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
        localStorage.setItem(key, id);
      }
      return id;
    } catch (e) {
      return "s" + String(Date.now());
    }
  }

  function deviceLabel() {
    const ua = navigator.userAgent || "";
    if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return "手機";
    return "電腦";
  }

  function presencePropKey() {
    return "v_" + viewSessionId().replace(/[^a-zA-Z0-9_]/g, "").slice(0, 40);
  }

  function notifyViewers() {
    if (typeof onViewersChange === "function") {
      try { onViewersChange(state.viewers, state.viewerList); } catch (e) {}
    }
  }

  function listLegacyPresenceFiles() {
    return ensureFolderId().then(function (folderId) {
      let q = "name contains '" + PRESENCE_PREFIX + "' and trashed=false";
      if (folderId && folderId !== "root") q += " and '" + folderId + "' in parents";
      else q += " and 'root' in parents";
      return driveFetch(
        "https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent(q) +
        "&fields=files(id,name)&pageSize=100&spaces=drive"
      ).then(function (res) {
        if (!res.ok) return { files: [] };
        return res.json();
      }).then(function (data) {
        return (data && data.files) || [];
      });
    });
  }

  function purgeLegacyPresenceFiles() {
    return listLegacyPresenceFiles().then(function (files) {
      return Promise.all((files || []).map(function (f) {
        return driveFetch("https://www.googleapis.com/drive/v3/files/" + f.id, { method: "DELETE" }).catch(function () {});
      }));
    }).catch(function () {});
  }

  function readAppProperties(fileId) {
    return driveFetch("https://www.googleapis.com/drive/v3/files/" + fileId + "?fields=appProperties")
      .then(function (res) {
        if (!res.ok) return {};
        return res.json();
      }).then(function (data) {
        return (data && data.appProperties) || {};
      });
  }

  function patchAppProperties(fileId, props) {
    return driveFetch("https://www.googleapis.com/drive/v3/files/" + fileId, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appProperties: props })
    }).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { throw new Error("更新連線狀態失敗 " + res.status + " " + t); });
      return res.json().catch(function () { return {}; });
    });
  }

  function applyViewerMap(props) {
    const cutoff = Date.now() - PRESENCE_TTL_MS;
    const live = [];
    Object.keys(props || {}).forEach(function (k) {
      if (k.indexOf("v_") !== 0) return;
      const parts = String(props[k] || "").split("|");
      const ts = Number(parts[1] || 0);
      if (!ts || ts < cutoff) return;
      live.push({
        sessionId: k.slice(2),
        device: parts[0] || "",
        modifiedTime: new Date(ts).toISOString()
      });
    });
    state.viewers = live.length;
    state.viewerList = live;
    if (state.account && state.viewers < 1) state.viewers = 1;
    notifyViewers();
  }

  function presenceTick() {
    if (!state.account || presenceBusy) return Promise.resolve(state.viewers);
    presenceBusy = true;
    return findFileByName().then(function (id) {
      if (!id) {
        state.viewers = 1;
        state.viewerList = [];
        notifyViewers();
        return state.viewers;
      }
      const key = presencePropKey();
      const value = deviceLabel() + "|" + Date.now();
      return readAppProperties(id).then(function (props) {
        const patch = {};
        patch[key] = value;
        const cutoff = Date.now() - PRESENCE_TTL_MS;
        Object.keys(props).forEach(function (k) {
          if (k.indexOf("v_") !== 0 || k === key) return;
          const ts = Number(String(props[k] || "").split("|")[1] || 0);
          if (!ts || ts < cutoff) patch[k] = null;
        });
        return patchAppProperties(id, patch).then(function () {
          props[key] = value;
          Object.keys(patch).forEach(function (k) {
            if (patch[k] === null) delete props[k];
          });
          applyViewerMap(props);
          return state.viewers;
        });
      });
    }).catch(function (e) {
      console.warn(e);
      return state.viewers;
    }).finally(function () { presenceBusy = false; });
  }

  function startPresence(cb) {
    if (typeof cb === "function") onViewersChange = cb;
    if (!state.account) return state.viewers;
    if (presenceTimer) clearInterval(presenceTimer);
    purgeLegacyPresenceFiles();
    presenceTick();
    presenceTimer = setInterval(function () { presenceTick(); }, PRESENCE_INTERVAL_MS);
    return state.viewers;
  }

  function stopPresence(removeFile) {
    if (presenceTimer) {
      clearInterval(presenceTimer);
      presenceTimer = null;
    }
    const finish = function () {
      state.viewers = 0;
      state.viewerList = [];
      notifyViewers();
    };
    if (!removeFile || !state.token) {
      finish();
      return Promise.resolve();
    }
    const key = presencePropKey();
    return findFileByName().then(function (id) {
      if (!id) return;
      const patch = {};
      patch[key] = null;
      return patchAppProperties(id, patch);
    }).catch(function () {}).then(finish);
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && state.account) presenceTick();
    });
  }
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", function () {
      if (state.account) stopPresence(true);
    });
  }

  function getToken() {
    if (state.token) return Promise.resolve(state.token);
    const hint = accountHint();
    return requestToken("", hint).then(function (tok) {
      if (state.account) return tok;
      return fetchUserEmail(tok).then(function () { return tok; });
    });
  }

  function driveFetch(url, options) {
    return getToken().then(function (tok) {
      const opts = options || {};
      const headers = Object.assign({ Authorization: "Bearer " + tok }, opts.headers || {});
      return fetch(url, Object.assign({}, opts, { headers: headers }));
    });
  }

  function listChildFolders(parentId, opts) {
    opts = opts || {};
    const pid = parentIdOrRoot(parentId);
    const cached = childFolderListCache[pid];
    if (!opts.bypassCache && cached && (Date.now() - cached.at) < CHILD_LIST_TTL_MS) {
      return Promise.resolve(cached.folders.slice());
    }
    const q = encodeURIComponent(
      "mimeType='application/vnd.google-apps.folder' and '" + pid +
      "' in parents and trashed=false"
    );
    return driveFetch(
      "https://www.googleapis.com/drive/v3/files?q=" + q +
      "&fields=files(id,name,modifiedTime,createdTime)&pageSize=100&spaces=drive" +
      "&supportsAllDrives=true&includeItemsFromAllDrives=true&orderBy=createdTime"
    ).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { throw new Error("列出資料夾失敗 " + res.status + " " + t); });
      return res.json();
    }).then(function (data) {
      const folders = (data && data.files) || [];
      childFolderListCache[pid] = { at: Date.now(), folders: folders.slice() };
      return folders;
    });
  }

  /** 同名多個資料夾：保留有 line_data.json 的（或最舊的），其餘進垃圾桶 */
  function consolidateFolderGroup(folders) {
    const list = folders || [];
    if (!list.length) return Promise.resolve(null);
    if (list.length === 1) return Promise.resolve(list[0]);
    let chain = Promise.resolve([]);
    list.forEach(function (f) {
      chain = chain.then(function (acc) {
        const safe = fileName().replace(/'/g, "\\'");
        const q = "name='" + safe + "' and trashed=false and '" + f.id + "' in parents";
        return driveListByQuery(q).then(function (files) {
          acc.push({
            folder: f,
            hasData: !!(files && files.length),
            dataModified: (files && files[0] && files[0].modifiedTime) || "",
            createdTime: f.createdTime || ""
          });
          return acc;
        });
      });
    });
    return chain.then(function (infos) {
      infos.sort(function (a, b) {
        if (a.hasData !== b.hasData) return a.hasData ? -1 : 1;
        const dm = String(b.dataModified || "").localeCompare(String(a.dataModified || ""));
        if (dm) return dm;
        return String(a.createdTime || "").localeCompare(String(b.createdTime || ""));
      });
      const keep = infos[0].folder;
      return Promise.all(infos.slice(1).map(function (i) {
        return trashDriveFile(i.folder.id);
      })).then(function () {
        // 清掉清單快取，下次重列
        try { delete childFolderListCache[parentIdOrRoot((keep && keep.parents && keep.parents[0]) || "")]; } catch (e) {}
        Object.keys(childFolderListCache).forEach(function (k) { delete childFolderListCache[k]; });
        return keep;
      });
    });
  }

  function findChildFolder(parentId, name) {
    const want = normFolderKey(name);
    if (!want) return Promise.resolve("");
    const label = String(name || "").trim();
    const safe = label.replace(/'/g, "\\'");
    const pid = parentIdOrRoot(parentId);
    // 快速路徑：精確檔名查詢（切換專案時通常一發命中）
    const q = encodeURIComponent(
      "mimeType='application/vnd.google-apps.folder' and name='" + safe +
      "' and '" + pid + "' in parents and trashed=false"
    );
    return driveFetch(
      "https://www.googleapis.com/drive/v3/files?q=" + q +
      "&fields=files(id,name,createdTime)&pageSize=5&spaces=drive" +
      "&supportsAllDrives=true&includeItemsFromAllDrives=true&orderBy=createdTime"
    ).then(function (res) {
      if (!res.ok) return null;
      return res.json();
    }).then(function (data) {
      const exact = (data && data.files) || [];
      if (exact.length === 1) return exact[0].id;
      if (exact.length > 1) return exact[0].id; // 切換時不跑 consolidate，避免多輪 API
      // 模糊：去空白比對（快取清單）
      return listChildFolders(pid).then(function (folders) {
        const hits = (folders || []).filter(function (f) {
          return normFolderKey(f.name) === want;
        });
        if (!hits.length) return "";
        return hits[0].id;
      });
    });
  }

  function createChildFolder(parentId, name) {
    const label = sanitizeProjectFolderName(name);
    // 建立前再查一次，防止競態重複
    return findChildFolder(parentId, label).then(function (existing) {
      if (existing) return { id: existing, name: label };
      const meta = {
        name: label,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId]
      };
      return driveFetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,name", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(meta)
      }).then(function (res) {
        if (!res.ok) return res.text().then(function (t) { throw new Error("建立資料夾失敗 " + res.status + " " + t); });
        return res.json();
      }).then(function (f) {
        try { delete childFolderListCache[parentIdOrRoot(parentId)]; } catch (e) {}
        return f;
      });
    }).then(function (f) { return f.id; });
  }

  function ensureFolderId() {
    const fixed = (cfg.folderId || "").trim();
    if (fixed) {
      rememberActiveFolderId(fixed);
      return Promise.resolve(fixed);
    }
    const key = projCacheKey(activeProject);
    if (!cachedFolderId && key && folderIdByProject[key]) {
      cachedFolderId = folderIdByProject[key];
    }
    if (cachedFolderId) return Promise.resolve(cachedFolderId);

    // 共用根：從 projectsRootId 往下找專案名稱；否則從「我的雲端硬碟」走完整路徑
    const sharedRoot = sharedProjectsRootId();
    const walkParts = sharedRoot ? projectFolderWalkParts() : folderPathParts();
    if (!walkParts.length) {
      if (sharedRoot) {
        rememberActiveFolderId(sharedRoot);
        return Promise.resolve(sharedRoot);
      }
      rememberActiveFolderId("root");
      return Promise.resolve("root");
    }
    let chain = sharedRoot ? Promise.resolve(sharedRoot) : Promise.resolve("root");
    walkParts.forEach(function (part) {
      chain = chain.then(function (parentId) {
        return ensureNamedChildFolder(parentId, part);
      });
    });
    return chain.then(function (id) {
      rememberActiveFolderId(id);
      return id;
    });
  }

  function driveListByQuery(q) {
    return driveFetch(
      "https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent(q) +
      "&fields=files(id,name,modifiedTime,parents)&pageSize=50&spaces=drive&orderBy=modifiedTime desc" +
      "&supportsAllDrives=true&includeItemsFromAllDrives=true"
    ).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { throw new Error("搜尋雲端檔失敗 " + res.status + " " + t); });
      return res.json();
    }).then(function (data) {
      return (data.files && data.files.length) ? data.files : [];
    });
  }

  function findFilesInFolder() {
    const name = fileName().replace(/'/g, "\\'");
    return ensureFolderId().then(function (folderId) {
      let q = "name='" + name + "' and trashed=false";
      if (folderId && folderId !== "root") q += " and '" + folderId + "' in parents";
      else if (folderId === "root") q += " and 'root' in parents";
      return driveListByQuery(q);
    });
  }

  function findFilesAnywhere() {
    const name = fileName().replace(/'/g, "\\'");
    return driveListByQuery("name='" + name + "' and trashed=false");
  }

  /** 只在目前專案資料夾找（多專案避免抓到別案的同名檔） */
  function findFileByName() {
    return findFilesInFolder().then(function (files) {
      if (files.length) {
        saveStoredFileId(files[0].id);
        return files[0].id;
      }
      return "";
    });
  }

  function createFile() {
    return ensureFolderId().then(function (folderId) {
      const meta = { name: fileName(), mimeType: "application/json" };
      if (folderId) meta.parents = [folderId];
      return driveFetch("https://www.googleapis.com/drive/v3/files?fields=id,name", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(meta)
      });
    }).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { throw new Error("建立雲端檔失敗 " + res.status + " " + t); });
      return res.json();
    }).then(function (f) {
      saveStoredFileId(f.id);
      return f.id;
    });
  }

  function ensureFileId() {
    // 上傳用：先找（含全碟 fallback），沒有才在指定資料夾新建
    return findFileByName().then(function (id) {
      if (id) return id;
      const fixed = (cfg.fileId || "").trim();
      if (fixed) {
        saveStoredFileId(fixed);
        return fixed;
      }
      return createFile();
    });
  }

  function fetchJsonById(id) {
    return driveFetch("https://www.googleapis.com/drive/v3/files/" + id + "?alt=media")
      .then(function (res) {
        if (res.status === 404) return null;
        if (!res.ok) {
          return res.text().then(function (t) {
            throw new Error("下載失敗 " + res.status + " " + t);
          });
        }
        return res.text().then(function (text) {
          if (!text || !String(text).trim()) return null;
          try {
            return JSON.parse(text);
          } catch (e) {
            return null;
          }
        });
      });
  }

  function listFileRevisions(fileId) {
    if (!fileId) return Promise.resolve([]);
    return driveFetch(
      "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) +
      "/revisions?fields=revisions(id,modifiedTime)&pageSize=40&supportsAllDrives=true"
    ).then(function (res) {
      if (!res.ok) return [];
      return res.json().then(function (data) {
        const revs = (data && data.revisions) || [];
        return revs.slice().reverse(); // 新→舊
      });
    }).catch(function () { return []; });
  }

  function fetchJsonRevision(fileId, revId) {
    if (!fileId || !revId) return Promise.resolve(null);
    return driveFetch(
      "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) +
      "/revisions/" + encodeURIComponent(revId) + "?alt=media&supportsAllDrives=true"
    ).then(function (res) {
      if (!res.ok) return null;
      return res.text().then(function (text) {
        if (!text || !String(text).trim()) return null;
        try { return JSON.parse(text); } catch (e) { return null; }
      });
    }).catch(function () { return null; });
  }

  function listJsonFilesInFolder(folderId) {
    if (!folderId) return Promise.resolve([]);
    const q = "'" + folderId + "' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'";
    return driveFetch(
      "https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent(q) +
      "&fields=files(id,name,modifiedTime)&pageSize=50&spaces=drive&supportsAllDrives=true&includeItemsFromAllDrives=true&orderBy=modifiedTime desc"
    ).then(function (res) {
      if (!res.ok) return [];
      return res.json().then(function (data) {
        return ((data && data.files) || []).filter(function (f) {
          return /\.json$/i.test(f.name || "");
        });
      });
    }).catch(function () { return []; });
  }

  /**
   * 在共用根下掃描各專案 line_data／history／Drive 版次，找出符合 accept(data, meta) 的 JSON。
   * 用於跨案誤植後把 DIP 等資料從別案版次回救。
   */
  function findRecoverablePayload(acceptFn, opts) {
    opts = opts || {};
    const maxRevsPerFile = Math.max(1, Number(opts.maxRevisions) || 8);
    if (typeof acceptFn !== "function") return Promise.resolve(null);
    return withScopeRetry(function () {
      return ensureProjectsRootId().then(function (rootId) {
        return listChildFolders(rootId, { bypassCache: true }).then(function (folders) {
          let chain = Promise.resolve(null);
          (folders || []).forEach(function (folder) {
            chain = chain.then(function (hit) {
              if (hit) return hit;
              if (!folder || !folder.id) return null;
              const folderName = folder.name || "";
              return listJsonFilesInFolder(folder.id).then(function (files) {
                const main = (files || []).find(function (f) {
                  return String(f.name || "").toLowerCase() === String(fileName()).toLowerCase();
                });
                const histFolderPromise = listChildFolders(folder.id).then(function (subs) {
                  const hname = historyFolderName();
                  const hf = (subs || []).find(function (s) {
                    return String(s.name || "") === hname;
                  });
                  return hf ? listJsonFilesInFolder(hf.id) : [];
                }).catch(function () { return []; });

                return histFolderPromise.then(function (histFiles) {
                  const candidates = [];
                  if (main && main.id) {
                    candidates.push({
                      kind: "line",
                      folderName: folderName,
                      fileId: main.id,
                      modifiedTime: main.modifiedTime || ""
                    });
                  }
                  (histFiles || []).forEach(function (f) {
                    candidates.push({
                      kind: "history",
                      folderName: folderName,
                      fileId: f.id,
                      modifiedTime: f.modifiedTime || "",
                      name: f.name || ""
                    });
                  });

                  let inner = Promise.resolve(null);
                  candidates.forEach(function (cand) {
                    inner = inner.then(function (found) {
                      if (found) return found;
                      return fetchJsonById(cand.fileId).then(function (data) {
                        if (data && acceptFn(data, cand)) {
                          return { data: data, meta: cand };
                        }
                        return null;
                      });
                    });
                  });

                  // line_data 版次（錯置被覆蓋前常還留在 revision）
                  if (main && main.id) {
                    inner = inner.then(function (found) {
                      if (found) return found;
                      return listFileRevisions(main.id).then(function (revs) {
                        let rchain = Promise.resolve(null);
                        (revs || []).slice(0, maxRevsPerFile).forEach(function (rev) {
                          rchain = rchain.then(function (found2) {
                            if (found2) return found2;
                            return fetchJsonRevision(main.id, rev.id).then(function (data) {
                              if (!data) return null;
                              const meta = {
                                kind: "revision",
                                folderName: folderName,
                                fileId: main.id,
                                revId: rev.id,
                                modifiedTime: rev.modifiedTime || ""
                              };
                              if (acceptFn(data, meta)) return { data: data, meta: meta };
                              return null;
                            });
                          });
                        });
                        return rchain;
                      });
                    });
                  }
                  return inner;
                });
              });
            });
          });
          return chain;
        });
      });
    });
  }

  /** 依序嘗試多個候選檔，略過空檔（避免誤建的空 JSON） */
  function downloadFirstNonEmpty(files) {
    let chain = Promise.resolve(null);
    (files || []).forEach(function (f) {
      chain = chain.then(function (hit) {
        if (hit) return hit;
        return fetchJsonById(f.id).then(function (data) {
          if (data) {
            saveStoredFileId(f.id);
            return data;
          }
          return null;
        });
      });
    });
    return chain;
  }

  /** 僅 OAuth scope 不足才重授權；Sheets API 未開／一般 403 不要當 scope（否則一直跳未驗證警告） */
  function isScopeError(text) {
    return /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes|Request had insufficient authentication scopes|accessNotConfigured.*scope|invalid_scope/i.test(text || "");
  }

  function withScopeRetry(fn) {
    return fn().catch(function (err) {
      const msg = String(err && err.message || err);
      if (!isScopeError(msg)) throw err;
      // 本頁只問一次 consent，避免未驗證應用警告循環
      if (scopeConsentAsked) throw err;
      if (scopeRetryInFlight) {
        return scopeRetryInFlight.then(function () { return fn(); });
      }
      scopeConsentAsked = true;
      state.token = "";
      scopeRetryInFlight = requestToken("consent", accountHint())
        .then(function () { return fetchUserEmail(state.token); })
        .finally(function () { scopeRetryInFlight = null; });
      return scopeRetryInFlight.then(function () { return fn(); });
    });
  }

  /** 快取 fileId 必須屬於目前專案資料夾，避免 DIP 讀到 VIVO 的檔 */
  function fetchJsonIfInActiveFolder(fileId) {
    if (!fileId) return Promise.resolve(null);
    return ensureFolderId().then(function (folderId) {
      return driveFetch(
        "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) +
        "?fields=id,name,parents&supportsAllDrives=true"
      ).then(function (res) {
        if (!res.ok) return null;
        return res.json();
      }).then(function (meta) {
        if (!meta || !meta.id) return null;
        const parents = meta.parents || [];
        if (folderId && folderId !== "root" && parents.indexOf(folderId) < 0) {
          saveStoredFileId("");
          return null;
        }
        return fetchJsonById(fileId);
      }).catch(function () {
        saveStoredFileId("");
        return null;
      });
    });
  }

  function downloadJson() {
    state.busy = true;
    return ensureInit()
      .then(function () {
        // 未登入才登入；不要用 switchAccount，避免載入時又跳選帳戶
        if (!state.account) return login();
      })
      .then(function () {
        return withScopeRetry(function () {
          if (!isSheetsMode()) return downloadJsonLegacy();

          // ★ 讀取優先 JSON（快）；Sheets 遷移改背景，避免總覽卡住數分鐘
          return downloadJsonLegacy().then(function (legacy) {
            if (legacy) {
              state.lastCloudAt = legacy.savedAt || new Date().toISOString();
              scheduleSheetsMigrateFromLegacy(legacy);
              return legacy;
            }
            return findExistingProjectSpreadsheetId(activeProject).then(function (sid) {
              if (!sid) {
                if (isSharedProjectsRoot()) return null;
                return findLegacyData();
              }
              return withTimeout(readPayloadFromSheets(sid), 20000, "讀取試算表")
                .then(function (fromSheets) {
                  if (fromSheets) {
                    state.lastCloudAt = fromSheets.savedAt || new Date().toISOString();
                    return fromSheets;
                  }
                  return null;
                })
                .catch(function (e) {
                  console.warn(e);
                  return null;
                });
            });
          });
        });
      })
      .finally(function () { state.busy = false; });
  }

  function uploadJson(payload) {
    state.busy = true;
    return ensureInit()
      .then(function () {
        if (!state.account) return login();
      })
      .then(function () {
        return withScopeRetry(function () {
          if (!isSheetsMode()) {
            return uploadJsonLegacy(payload).then(function (r) {
              state.lastCloudAt = new Date().toISOString();
              return r;
            });
          }
          return ensureProjectSpreadsheetId(activeProject).then(function (sid) {
            return writePayloadToSheets(sid, payload).then(function () {
              rememberSpreadsheetId(sid);
              state.lastCloudAt = new Date().toISOString();
              const backup = cfg.writeJsonBackup !== false
                ? uploadJsonLegacy(payload).catch(function (e) {
                    console.warn("JSON 備份寫入失敗", e);
                  })
                : Promise.resolve();
              return persistSpreadsheetIdToIndex(activeProject).then(function () {
                return backup.then(function () { return { spreadsheetId: sid }; });
              });
            });
          });
        });
      })
      .finally(function () { state.busy = false; });
  }

  function getSpreadsheetId() {
    const key = projCacheKey(activeProject);
    return (
      state.spreadsheetId ||
      (activeProject && activeProject.spreadsheetId) ||
      (key && spreadsheetIdByProject[key]) ||
      ""
    );
  }

  function spreadsheetEditUrl(id) {
    const sid = id || getSpreadsheetId();
    if (!sid) return "";
    return "https://docs.google.com/spreadsheets/d/" + encodeURIComponent(sid) + "/edit";
  }

  function spreadsheetEmbedUrl(id) {
    const sid = id || getSpreadsheetId();
    if (!sid) return "";
    return "https://docs.google.com/spreadsheets/d/" + encodeURIComponent(sid) + "/edit?usp=sharing&rm=minimal";
  }

  function scheduleUpload(payload, delayMs) {
    clearTimeout(uploadTimer);
    uploadTimer = setTimeout(function () {
      if (!state.account) return;
      uploadJson(payload).catch(function (e) {
        console.warn(e);
        if (typeof global.toast === "function") global.toast("雲端同步失敗：" + (e.message || e));
      });
    }, delayMs == null ? 1200 : delayMs);
  }

  function photosFolderName() {
    return (cfg.photosFolder || "photos").trim() || "photos";
  }

  function filesFolderName() {
    return (cfg.filesFolder || "files").trim() || "files";
  }

  function ensureNamedChildFolder(folderName) {
    return ensureFolderId().then(function (parentId) {
      const name = String(folderName || "files").trim() || "files";
      return findChildFolder(parentId === "root" ? "root" : parentId, name).then(function (id) {
        if (id) return id;
        return createChildFolder(parentId === "root" ? "root" : parentId, name);
      });
    });
  }

  function ensurePhotosFolderId() {
    return ensureNamedChildFolder(photosFolderName());
  }

  function ensureFilesFolderId() {
    return ensureNamedChildFolder(filesFolderName());
  }

  function sanitizeFileName(name) {
    const raw = String(name || "file.bin").replace(/[\\/:*?"<>|]/g, "_").trim();
    return raw || "file.bin";
  }

  function guessMimeType(file, fallback) {
    const mime = (file && file.type) || "";
    if (mime) return mime;
    const n = String((file && file.name) || "").toLowerCase();
    if (/\.png$/i.test(n)) return "image/png";
    if (/\.jpe?g$/i.test(n)) return "image/jpeg";
    if (/\.gif$/i.test(n)) return "image/gif";
    if (/\.webp$/i.test(n)) return "image/webp";
    if (/\.txt$/i.test(n)) return "text/plain";
    if (/\.csv$/i.test(n)) return "text/csv";
    if (/\.pdf$/i.test(n)) return "application/pdf";
    if (/\.docx?$/i.test(n)) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (/\.pptx?$/i.test(n)) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    if (/\.xlsx?$/i.test(n)) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    return fallback || "application/octet-stream";
  }

  /** 上傳任意檔到專案資料夾下指定子資料夾，回傳 { id, name, mimeType, uploadedAt, webViewLink, kind } */
  function uploadDriveBlob(file, label, opts) {
    opts = opts || {};
    if (!file) return Promise.reject(new Error("未選擇檔案"));
    const folderPromise = opts.folder === "photos" ? ensurePhotosFolderId() : ensureFilesFolderId();
    const mime = guessMimeType(file, opts.fallbackMime || "application/octet-stream");
    const base = sanitizeFileName(file.name || (opts.defaultName || "file.bin"));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const prefix = label ? String(label).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40) + "_" : "";
    const name = prefix + stamp + "_" + base;
    const errLabel = opts.errLabel || "上傳檔案";
    return ensureInit()
      .then(function () {
        if (!state.account) return login();
      })
      .then(function () {
        return withScopeRetry(function () {
          return folderPromise.then(function (folderId) {
            const meta = {
              name: name,
              mimeType: mime,
              parents: [folderId]
            };
            const boundary = "----linefile" + String(Date.now()) + Math.random().toString(16).slice(2);
            return file.arrayBuffer().then(function (buf) {
              const metaPart =
                "--" + boundary + "\r\n" +
                "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
                JSON.stringify(meta) + "\r\n";
              const binHead =
                "--" + boundary + "\r\n" +
                "Content-Type: " + meta.mimeType + "\r\n\r\n";
              const tail = "\r\n--" + boundary + "--";
              const head = new TextEncoder().encode(metaPart + binHead);
              const end = new TextEncoder().encode(tail);
              const body = new Uint8Array(head.length + buf.byteLength + end.length);
              body.set(head, 0);
              body.set(new Uint8Array(buf), head.length);
              body.set(end, head.length + buf.byteLength);
              return driveFetch(
                "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,webViewLink",
                {
                  method: "POST",
                  headers: { "Content-Type": "multipart/related; boundary=" + boundary },
                  body: body
                }
              ).then(function (res) {
                if (!res.ok) return res.text().then(function (t) { throw new Error(errLabel + "失敗 " + res.status + " " + t); });
                return res.json();
              }).then(function (f) {
                return {
                  id: f.id,
                  name: f.name || name,
                  mimeType: f.mimeType || meta.mimeType,
                  uploadedAt: new Date().toISOString(),
                  webViewLink: f.webViewLink || ("https://drive.google.com/file/d/" + f.id + "/view"),
                  kind: opts.kind || "file",
                  originalName: file.name || base
                };
              });
            });
          });
        });
      });
  }

  /** 上傳圖片到專案 photos 資料夾 */
  function uploadPhoto(file, label) {
    if (!file) return Promise.reject(new Error("未選擇檔案"));
    const mime = guessMimeType(file, "image/jpeg");
    if (mime.indexOf("image/") !== 0 && mime !== "application/octet-stream") {
      return Promise.reject(new Error("請選擇圖片檔"));
    }
    return uploadDriveBlob(file, label, {
      folder: "photos",
      kind: "photo",
      fallbackMime: "image/jpeg",
      defaultName: "photo.jpg",
      errLabel: "上傳照片"
    });
  }

  /** 上傳一般檔案（TXT／Word／PPT／Excel／其它）到專案 files 資料夾 */
  function uploadFile(file, label) {
    return uploadDriveBlob(file, label, {
      folder: "files",
      kind: "file",
      fallbackMime: "application/octet-stream",
      defaultName: "file.bin",
      errLabel: "上傳檔案"
    });
  }

  function deleteDriveFile(fileId) {
    if (!fileId) return Promise.resolve();
    return withScopeRetry(function () {
      return driveFetch("https://www.googleapis.com/drive/v3/files/" + fileId, { method: "DELETE" })
        .then(function (res) {
          if (res.status === 404 || res.ok) return;
          return res.text().then(function (t) { throw new Error("刪除雲端照片失敗 " + res.status + " " + t); });
        });
    });
  }

  function photoViewUrl(fileId) {
    return "https://drive.google.com/file/d/" + fileId + "/view";
  }

  /** 下載雲端檔為 Blob（供網頁內預覽） */
  function downloadFileBlob(fileId) {
    if (!fileId) return Promise.reject(new Error("缺少檔案 ID"));
    return withScopeRetry(function () {
      return driveFetch("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) + "?alt=media")
        .then(function (res) {
          if (!res.ok) return res.text().then(function (t) { throw new Error("下載照片失敗 " + res.status + " " + t); });
          return res.blob();
        });
    });
  }

  function statusText() {
    if (!(cfg.clientId || "").trim() || String(cfg.clientId).indexOf("PLEASE_") === 0) {
      return "Google：尚未設定 clientId（見 google_config.js）";
    }
    if (state.account) {
      const who = state.account.email || state.account.username || "已登入";
      const view =
        state.viewers > 0
          ? "　｜　連線查看 " + state.viewers + " 個"
          : "";
      const rootLabel = (cfg.projectsRoot || "共用資料夾").trim() || "共用資料夾";
      const share = isSharedProjectsRoot() ? ("　｜　儲存於「" + rootLabel + "」") : "";
      const mode = isSheetsMode() ? "　｜　Sheets 儲存" : "";
      return "Google 雲端　｜　已登入 " + who + share + mode + view +
        (state.lastCloudAt ? "　｜　上次雲端 " + state.lastCloudAt.replace("T", " ").slice(0, 19) : "");
    }
    return "Google 雲端　｜　未登入（登入後才載入資料）";
  }

  function historyFolderName() {
    return (cfg.historyFolder || "history").trim() || "history";
  }

  function historyMax() {
    const n = Number(cfg.historyMax);
    return Number.isFinite(n) && n > 0 ? Math.min(50, Math.floor(n)) : 10;
  }

  function ensureHistoryFolderId() {
    return ensureFolderId().then(function (parentId) {
      const name = historyFolderName();
      return findChildFolder(parentId === "root" ? "root" : parentId, name).then(function (id) {
        if (id) return id;
        return createChildFolder(parentId === "root" ? "root" : parentId, name);
      });
    });
  }

  function listHistoryFiles() {
    return withScopeRetry(function () {
      return ensureHistoryFolderId().then(function (folderId) {
        const q = "'" + folderId + "' in parents and trashed=false";
        return driveFetch(
          "https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent(q) +
          "&fields=files(id,name,modifiedTime,size)&pageSize=50&spaces=drive&orderBy=modifiedTime desc"
        ).then(function (res) {
          if (!res.ok) return res.text().then(function (t) { throw new Error("讀取歷史清單失敗 " + res.status + " " + t); });
          return res.json();
        }).then(function (data) {
          return (data.files || []).filter(function (f) {
            return /\.json$/i.test(f.name || "");
          });
        });
      });
    });
  }

  function trashDriveFile(fileId) {
    if (!fileId) return Promise.resolve();
    return driveFetch("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true })
    }).then(function (res) {
      if (!res.ok && res.status !== 404) {
        return res.text().then(function (t) { throw new Error("刪除歷史失敗 " + res.status + " " + t); });
      }
    });
  }

  function pruneHistoryFiles(maxKeep) {
    const keep = maxKeep || historyMax();
    return listHistoryFiles().then(function (files) {
      const extra = files.slice(keep);
      let chain = Promise.resolve();
      extra.forEach(function (f) {
        chain = chain.then(function () { return trashDriveFile(f.id); });
      });
      return chain.then(function () { return files.slice(0, keep); });
    });
  }

  function saveHistoryJson(payload, label) {
    const stamp = (function () {
      const d = new Date();
      const p = function (n) { return String(n).padStart(2, "0"); };
      return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "_" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    })();
    const name = "vivo_r01_hist_" + stamp + ".json";
    const bodyObj = Object.assign({}, payload || {}, {
      historySavedAt: new Date().toISOString(),
      historyLabel: label || ("歷史 " + stamp)
    });
    const body = JSON.stringify(bodyObj);
    state.busy = true;
    return ensureInit()
      .then(function () {
        if (!state.account) return login();
      })
      .then(function () {
        return withScopeRetry(function () {
          return ensureHistoryFolderId().then(function (folderId) {
            const meta = { name: name, mimeType: "application/json", parents: [folderId] };
            return driveFetch("https://www.googleapis.com/drive/v3/files?fields=id,name,modifiedTime", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(meta)
            }).then(function (res) {
              if (!res.ok) return res.text().then(function (t) { throw new Error("建立歷史檔失敗 " + res.status + " " + t); });
              return res.json();
            }).then(function (f) {
              return driveFetch("https://www.googleapis.com/upload/drive/v3/files/" + f.id + "?uploadType=media", {
                method: "PATCH",
                headers: { "Content-Type": "application/json; charset=utf-8" },
                body: body
              }).then(function (res) {
                if (!res.ok) return res.text().then(function (t) { throw new Error("上傳歷史失敗 " + res.status + " " + t); });
                return f;
              });
            }).then(function (f) {
              return pruneHistoryFiles(historyMax()).then(function () { return f; });
            });
          });
        });
      })
      .finally(function () { state.busy = false; });
  }

  function loadHistoryJson(fileId) {
    if (!fileId) return Promise.reject(new Error("缺少歷史檔 ID"));
    state.busy = true;
    return ensureInit()
      .then(function () {
        if (!state.account) return login();
      })
      .then(function () {
        return withScopeRetry(function () {
          return fetchJsonById(fileId).then(function (data) {
            if (!data) throw new Error("歷史檔是空的或無法解析");
            return data;
          });
        });
      })
      .finally(function () { state.busy = false; });
  }

  const api = {
    state: state,
    initMsal: initMsal,
    ensureInit: ensureInit,
    login: login,
    cancelPendingLogin: cancelPendingLogin,
    logout: logout,
    accountEmail: accountEmail,
    isSharedProjectsRoot: isSharedProjectsRoot,
    isSheetsMode: isSheetsMode,
    downloadJson: downloadJson,
    findLegacyData: findLegacyData,
    clearActiveFileCache: clearActiveFileCache,
    uploadJson: uploadJson,
    scheduleUpload: scheduleUpload,
    uploadPhoto: uploadPhoto,
    uploadFile: uploadFile,
    deleteDriveFile: deleteDriveFile,
    photoViewUrl: photoViewUrl,
    downloadFileBlob: downloadFileBlob,
    startPresence: startPresence,
    stopPresence: stopPresence,
    presenceTick: presenceTick,
    statusText: statusText,
    listHistoryFiles: listHistoryFiles,
    saveHistoryJson: saveHistoryJson,
    loadHistoryJson: loadHistoryJson,
    findRecoverablePayload: findRecoverablePayload,
    historyMax: historyMax,
    getActiveProject: getActiveProject,
    setActiveProject: setActiveProject,
    loadProjectsIndex: loadProjectsIndex,
    saveProjectsIndex: saveProjectsIndex,
    rebuildProjectsIndex: function () {
      cachedIndexSpreadsheetId = "";
      const buildId = String(cfg.forceIndexBuildId || "").trim();
      return ensureInit()
        .then(function () {
          if (!state.account) return login();
        })
        .then(function () {
          return withScopeRetry(function () {
            return ensureProjectsRootId().then(function (rootId) {
              return migrateIndexJsonToSheets(rootId, buildId);
            });
          });
        });
    },
    createProject: createProject,
    deleteProject: deleteProject,
    duplicateProject: duplicateProject,
    uniqueProjectName: uniqueProjectName,
    sanitizeProjectFolderName: sanitizeProjectFolderName,
    getSpreadsheetId: getSpreadsheetId,
    spreadsheetEditUrl: spreadsheetEditUrl,
    spreadsheetEmbedUrl: spreadsheetEmbedUrl,
    ensureProjectSpreadsheetId: function () {
      return ensureInit().then(function () {
        if (!state.account) return login();
      }).then(function () {
        return withScopeRetry(function () {
          return ensureProjectSpreadsheetId(activeProject);
        });
      });
    }
  };

  global.LineGoogle = api;
  global.LineOneDrive = api;
})(window);
