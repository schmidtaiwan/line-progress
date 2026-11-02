/* Google Identity + Drive API → JSON sync
 * 使用 drive 範圍（私人用），可用檔名搜尋，手機／電腦才能對到同一份檔。
 */
(function (global) {
  const cfg = global.GOOGLE_CONFIG || {};
  // drive.file 在部分手機瀏覽器／舊 token 容易 SCOPE 不足；私人用改 drive
  const SCOPES = "https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.email";
  const state = {
    account: null,
    token: "",
    ready: false,
    lastCloudAt: "",
    busy: false,
    fileId: "",
    viewers: 0,
    viewerList: []
  };
  let tokenClient = null;
  let uploadTimer = null;
  let cachedFolderId = "";
  let presenceTimer = null;
  let presenceBusy = false;
  let onViewersChange = null;
  const PRESENCE_TTL_MS = 45000;
  const PRESENCE_INTERVAL_MS = 12000;
  const PRESENCE_PREFIX = "vivo_r01_view_";
  /** 目前作用中專案（決定雲端資料夾） */
  let activeProject = null;
  /** 切換專案加速：記住各專案資料夾／檔案 ID，避免每次重查 Drive */
  const folderIdByProject = Object.create(null);
  const fileIdByProject = Object.create(null);
  const childFolderListCache = Object.create(null);
  const CHILD_LIST_TTL_MS = 60000;

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

  /** 清除目前專案的 folder／file 快取（誤連到別案檔時強制重解析） */
  function clearActiveFileCache() {
    const key = projCacheKey(activeProject);
    if (key) {
      delete folderIdByProject[key];
      delete fileIdByProject[key];
    }
    cachedFolderId = "";
    state.fileId = "";
    try { saveStoredFileId(""); } catch (e) {}
  }

  function clearAllProjectCaches() {
    clearFolderCache();
    Object.keys(folderIdByProject).forEach(function (k) { delete folderIdByProject[k]; });
    Object.keys(fileIdByProject).forEach(function (k) { delete fileIdByProject[k]; });
    Object.keys(childFolderListCache).forEach(function (k) { delete childFolderListCache[k]; });
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
      legacyFileName: proj.legacyFileName || ""
    };
    const key = projCacheKey(activeProject);
    // 切換時沿用記憶體快取，不要清掉 localStorage 的 fileId（否則每次都重搜 2～3 秒）
    cachedFolderId = (key && folderIdByProject[key]) || "";
    state.fileId = (key && fileIdByProject[key]) || "";
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
      createdAt: (p && p.createdAt) || ""
    };
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

  /** 只讀 projects_index，不依資料夾重建（刪案用，避免刪前又把資料夾同步回來） */
  function readProjectsIndexRaw() {
    return ensureInit()
      .then(function () {
        if (!state.account) return login({ prompt: "consent" });
      })
      .then(function () {
        return withScopeRetry(function () {
          return ensureProjectsRootId().then(function (rootId) {
            return fetchJsonInFolder(rootId, "projects_index.json").then(function (data) {
              const list = (data && Array.isArray(data.projects))
                ? data.projects.map(normalizeProjectRecord)
                : [];
              return { rootId: rootId, data: data || null, list: list };
            });
          });
        });
      });
  }

  function loadProjectsIndex() {
    return ensureInit()
      .then(function () {
        if (!state.account) return login({ prompt: "consent" });
      })
      .then(function () {
        return withScopeRetry(function () {
          return ensureProjectsRootId().then(function (rootId) {
            return fetchJsonInFolder(rootId, "projects_index.json").then(function (data) {
              const buildId = String(cfg.forceIndexBuildId || "").trim();
              const forced = forceIndexHints();
              const needForce = !!(buildId && forced.length && (!data || data.forceBuildId !== buildId));
              let hint = (data && Array.isArray(data.projects)) ? data.projects.map(normalizeProjectRecord) : [];
              if (needForce) {
                // 只把設定當「名稱／id 提示」對齊現有資料夾；不再把已刪專案幽靈加回
                const mergedHints = {};
                hint.concat(forced).forEach(function (p) {
                  const k = normFolderKey(p.name);
                  if (!k) return;
                  mergedHints[k] = Object.assign({}, mergedHints[k] || {}, p);
                });
                hint = Object.keys(mergedHints).map(function (k) { return normalizeProjectRecord(mergedHints[k]); });
                return syncProjectsIndexFromDrive(rootId, hint, { forceBuildId: buildId, seedMissing: false });
              }
              return syncProjectsIndexFromDrive(rootId, hint, { forceBuildId: buildId }).then(function (fromFolders) {
                if (fromFolders && fromFolders.length) return fromFolders;
                return migrateIntoSharedRootIfNeeded(rootId, hint).then(function (migrated) {
                  return syncProjectsIndexFromDrive(rootId, migrated || hint, { forceBuildId: buildId }).then(function (again) {
                    if (again && again.length) return again;
                    const list = defaultProjectsList().map(normalizeProjectRecord);
                    return putJsonInFolder(rootId, "projects_index.json", {
                      savedAt: new Date().toISOString(),
                      forceBuildId: buildId || undefined,
                      projects: list
                    }).then(function () { return list; });
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
        return withScopeRetry(function () {
          return ensureProjectsRootId().then(function (rootId) {
            const payload = {
              savedAt: new Date().toISOString(),
              projects: list
            };
            // 必須帶上 forceBuildId，否則下次載入會再跑強制清單把已刪專案加回
            if (buildId) payload.forceBuildId = buildId;
            return putJsonInFolder(rootId, "projects_index.json", payload).then(function () { return list; });
          });
        });
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

  /** 刪除專案在共用根下的資料夾（含 line_data／photos／history） */
  function deleteProjectFolder(proj) {
    const name = String((proj && proj.name) || "").trim();
    if (!name) return Promise.resolve();
    const folderName = sanitizeProjectFolderName(name);
    return ensureProjectsRootId().then(function (rootId) {
      return findChildFolder(rootId, folderName).then(function (folderId) {
        if (!folderId) return;
        const key = projCacheKey(proj);
        if (key) {
          delete folderIdByProject[key];
          delete fileIdByProject[key];
        }
        if (activeProject && projCacheKey(activeProject) === key) {
          cachedFolderId = "";
          state.fileId = "";
        }
        return withScopeRetry(function () {
          return driveFetch(
            "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(folderId) + "?supportsAllDrives=true",
            { method: "DELETE" }
          ).then(function (res) {
            if (res.status === 404 || res.ok) return;
            // 無法永久刪除時改丟進垃圾桶（資料夾內檔案一併處理）
            return driveFetch(
              "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(folderId) + "?supportsAllDrives=true",
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
      });
    }).then(function () {
      try {
        const root = sharedProjectsRootId() || "";
        if (root) delete childFolderListCache[root];
        delete childFolderListCache["root"];
      } catch (e) {}
    });
  }

  function deleteProject(projectId) {
    const id = String(projectId || "");
    if (!id) return Promise.reject(new Error("缺少專案 ID"));
    // 用 raw 讀取，避免 loadProjectsIndex 先依資料夾把專案同步回來
    return readProjectsIndexRaw().then(function (raw) {
      let list = (raw && raw.list) || [];
      let hit = list.find(function (p) { return p && p.id === id; });
      // index 過期時，仍允許用目前作用中專案刪資料夾
      if (!hit && activeProject && String(activeProject.id) === id) {
        hit = normalizeProjectRecord(activeProject);
      }
      if (!hit) throw new Error("找不到要刪除的專案");
      const next = list.filter(function (p) {
        if (!p) return false;
        if (p.id === id) return false;
        // 同名也一併從清單拿掉，避免 id 不一致又殘留
        if (normFolderKey(p.name) === normFolderKey(hit.name)) return false;
        return true;
      });
      // 先刪雲端資料夾，再更新清單（失敗則整筆中止，避免清單沒了資料夾還在）
      return deleteProjectFolder(hit).then(function () {
        return saveProjectsIndex(next).then(function () { return next; });
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
        callback: function () {}
      });
      state.ready = true;
    });
  }

  function requestToken(prompt, hintEmail) {
    return ensureInit().then(function () {
      return new Promise(function (resolve, reject) {
        tokenClient.callback = function (resp) {
          if (resp.error) {
            reject(new Error(resp.error_description || resp.error));
            return;
          }
          state.token = resp.access_token;
          resolve(resp.access_token);
        };
        const req = { prompt: prompt || "" };
        // 已登入時帶 hint，避免「從雲端載入」又跳出選帳戶
        if (hintEmail) req.hint = hintEmail;
        tokenClient.requestAccessToken(req);
      });
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
   * 預設只補授權，不強制選帳戶（給首次登入或內部呼叫）
   */
  function login(opts) {
    opts = opts || {};
    const switchAccount = !!opts.switchAccount;
    const prevEmail = accountEmail();
    state.token = "";
    if (switchAccount) {
      clearAllProjectCaches();
      activeProject = null;
    }
    const prompt = switchAccount
      ? "select_account consent"
      : (opts.prompt != null ? opts.prompt : "consent");
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

  function isScopeError(text) {
    return /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions|insufficient authentication scopes|insufficientFilePermissions|寫入專案清單失敗 403|建立專案清單失敗 403|建立資料夾失敗 403/i.test(text || "");
  }

  function withScopeRetry(fn) {
    return fn().catch(function (err) {
      const msg = String(err && err.message || err);
      // 403：多半是舊 token 只有 drive.file，對既有資料夾無法寫入 → 強制重新同意完整 drive
      if (!isScopeError(msg) && !/\b403\b/.test(msg)) throw err;
      state.token = "";
      return requestToken("consent", accountHint()).then(function () {
        return fetchUserEmail(state.token);
      }).then(function () {
        return fn();
      });
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
        if (!state.account) return login({ prompt: "consent" });
      })
      .then(function () {
        return withScopeRetry(function () {
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
                // 共用根模式略過舊路徑搜尋（省一次往返）
                if (isSharedProjectsRoot()) return null;
                return findLegacyData();
              });
            });
          });
        });
      })
      .finally(function () { state.busy = false; });
  }

  function uploadJson(payload) {
    state.busy = true;
    const body = JSON.stringify(payload);
    return ensureInit()
      .then(function () {
        if (!state.account) return login();
      })
      .then(function () {
        return withScopeRetry(function () {
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
              state.lastCloudAt = new Date().toISOString();
              return res.json().catch(function () { return {}; });
            });
          });
        });
      })
      .finally(function () { state.busy = false; });
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

  function ensurePhotosFolderId() {
    return ensureFolderId().then(function (parentId) {
      const name = photosFolderName();
      return findChildFolder(parentId === "root" ? "root" : parentId, name).then(function (id) {
        if (id) return id;
        return createChildFolder(parentId === "root" ? "root" : parentId, name);
      });
    });
  }

  function sanitizeFileName(name) {
    const raw = String(name || "photo.jpg").replace(/[\\/:*?"<>|]/g, "_").trim();
    return raw || "photo.jpg";
  }

  /** 上傳圖片到 LineProcess/photos，回傳 { id, name, mimeType, uploadedAt } */
  function uploadPhoto(file, label) {
    if (!file) return Promise.reject(new Error("未選擇檔案"));
    const mime = file.type || "image/jpeg";
    if (mime && mime.indexOf("image/") !== 0 && mime !== "application/octet-stream") {
      return Promise.reject(new Error("請選擇圖片檔"));
    }
    const base = sanitizeFileName(file.name || "photo.jpg");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const prefix = label ? String(label).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40) + "_" : "";
    const name = prefix + stamp + "_" + base;
    return ensureInit()
      .then(function () {
        if (!state.account) return login();
      })
      .then(function () {
        return withScopeRetry(function () {
          return ensurePhotosFolderId().then(function (folderId) {
            const meta = {
              name: name,
              mimeType: mime.indexOf("image/") === 0 ? mime : "image/jpeg",
              parents: [folderId]
            };
            const boundary = "----linephoto" + String(Date.now()) + Math.random().toString(16).slice(2);
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
                if (!res.ok) return res.text().then(function (t) { throw new Error("上傳照片失敗 " + res.status + " " + t); });
                return res.json();
              }).then(function (f) {
                return {
                  id: f.id,
                  name: f.name || name,
                  mimeType: f.mimeType || meta.mimeType,
                  uploadedAt: new Date().toISOString(),
                  webViewLink: f.webViewLink || ("https://drive.google.com/file/d/" + f.id + "/view")
                };
              });
            });
          });
        });
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
      return "Google 雲端　｜　已登入 " + who + share + view +
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
        if (!state.account) return login({ prompt: "consent" });
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
    logout: logout,
    accountEmail: accountEmail,
    isSharedProjectsRoot: isSharedProjectsRoot,
    downloadJson: downloadJson,
    findLegacyData: findLegacyData,
    clearActiveFileCache: clearActiveFileCache,
    uploadJson: uploadJson,
    scheduleUpload: scheduleUpload,
    uploadPhoto: uploadPhoto,
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
    createProject: createProject,
    deleteProject: deleteProject,
    duplicateProject: duplicateProject,
    uniqueProjectName: uniqueProjectName,
    sanitizeProjectFolderName: sanitizeProjectFolderName
  };

  global.LineGoogle = api;
  global.LineOneDrive = api;
})(window);
