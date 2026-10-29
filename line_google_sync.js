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

  function fileName() {
    return cfg.fileName || "vivo_r01_line_data.json";
  }

  function folderPathParts() {
    const raw = (cfg.folderPath || cfg.folderName || "").trim();
    if (!raw) return [];
    return raw.replace(/^\/+|\/+$/g, "").split("/").map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function storageKey() {
    const email = (state.account && (state.account.email || state.account.username)) || "default";
    const folderKey = (cfg.folderId || folderPathParts().join("/") || "root");
    return "line_google_drive_file_id_" + email + "_" + folderKey + "_" + fileName();
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

  function requestToken(prompt) {
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
        tokenClient.requestAccessToken({ prompt: prompt || "" });
      });
    });
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

  function login(opts) {
    state.token = "";
    cachedFolderId = "";
    saveStoredFileId("");
    // select_account：可換帳號；consent：首次／換帳時補授權
    const prompt = (opts && opts.prompt) || "select_account consent";
    return requestToken(prompt).then(function (tok) {
      return fetchUserEmail(tok).then(function (acc) {
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
      state.fileId = "";
      cachedFolderId = "";
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
    return requestToken("").then(function (tok) {
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

  function findChildFolder(parentId, name) {
    const safe = name.replace(/'/g, "\\'");
    const q = encodeURIComponent(
      "mimeType='application/vnd.google-apps.folder' and name='" + safe +
      "' and '" + parentId + "' in parents and trashed=false"
    );
    return driveFetch(
      "https://www.googleapis.com/drive/v3/files?q=" + q +
      "&fields=files(id,name)&pageSize=1&spaces=drive"
    ).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { throw new Error("搜尋資料夾失敗 " + res.status + " " + t); });
      return res.json();
    }).then(function (data) {
      return (data.files && data.files[0] && data.files[0].id) || "";
    });
  }

  function createChildFolder(parentId, name) {
    const meta = {
      name: name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId]
    };
    return driveFetch("https://www.googleapis.com/drive/v3/files?fields=id,name", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(meta)
    }).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { throw new Error("建立資料夾失敗 " + res.status + " " + t); });
      return res.json();
    }).then(function (f) { return f.id; });
  }

  function ensureFolderId() {
    const fixed = (cfg.folderId || "").trim();
    if (fixed) {
      cachedFolderId = fixed;
      return Promise.resolve(fixed);
    }
    if (cachedFolderId) return Promise.resolve(cachedFolderId);
    const parts = folderPathParts();
    if (!parts.length) {
      cachedFolderId = "root";
      return Promise.resolve("root");
    }
    let chain = Promise.resolve("root");
    parts.forEach(function (part) {
      chain = chain.then(function (parentId) {
        return findChildFolder(parentId, part).then(function (id) {
          if (id) return id;
          return createChildFolder(parentId, part);
        });
      });
    });
    return chain.then(function (id) {
      cachedFolderId = id;
      return id;
    });
  }

  function driveListByQuery(q) {
    return driveFetch(
      "https://www.googleapis.com/drive/v3/files?q=" + encodeURIComponent(q) +
      "&fields=files(id,name,modifiedTime,parents)&pageSize=20&spaces=drive&orderBy=modifiedTime desc"
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

  /** 先找指定資料夾，沒有再找整個雲端硬碟（根目錄舊檔也能找到） */
  function findFileByName() {
    return findFilesInFolder().then(function (files) {
      if (files.length) {
        saveStoredFileId(files[0].id);
        return files[0].id;
      }
      return findFilesAnywhere().then(function (all) {
        if (all.length) {
          saveStoredFileId(all[0].id);
          return all[0].id;
        }
        return "";
      });
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
    return /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions|insufficient authentication scopes/i.test(text || "");
  }

  function withScopeRetry(fn) {
    return fn().catch(function (err) {
      const msg = String(err && err.message || err);
      if (!isScopeError(msg)) throw err;
      state.token = "";
      return requestToken("consent").then(function () {
        return fetchUserEmail(state.token);
      }).then(function () {
        return fn();
      });
    });
  }

  function downloadJson() {
    state.busy = true;
    return ensureInit()
      .then(function () {
        if (!state.account) return login();
      })
      .then(function () {
        return withScopeRetry(function () {
          // 下載不新建空檔；先資料夾、再全碟，略過無內容的檔
          return findFilesInFolder().then(function (inFolder) {
            return downloadFirstNonEmpty(inFolder).then(function (data) {
              if (data) return data;
              return findFilesAnywhere().then(function (anywhere) {
                // 略過已在資料夾試過的 id
                const tried = {};
                inFolder.forEach(function (f) { tried[f.id] = true; });
                const rest = anywhere.filter(function (f) { return !tried[f.id]; });
                return downloadFirstNonEmpty(rest.length ? rest : anywhere);
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
      return "Google 雲端　｜　已登入 " + who + view +
        (state.lastCloudAt ? "　｜　上次雲端 " + state.lastCloudAt.replace("T", " ").slice(0, 19) : "");
    }
    return "Google 雲端　｜　未登入（登入後才載入資料）";
  }

  const api = {
    state: state,
    initMsal: initMsal,
    ensureInit: ensureInit,
    login: login,
    logout: logout,
    downloadJson: downloadJson,
    uploadJson: uploadJson,
    scheduleUpload: scheduleUpload,
    uploadPhoto: uploadPhoto,
    deleteDriveFile: deleteDriveFile,
    photoViewUrl: photoViewUrl,
    startPresence: startPresence,
    stopPresence: stopPresence,
    presenceTick: presenceTick,
    statusText: statusText
  };

  global.LineGoogle = api;
  global.LineOneDrive = api;
})(window);
