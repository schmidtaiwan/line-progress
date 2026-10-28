/* Google Identity + Drive API → JSON sync（介面與 LineOneDrive 對齊）
 * 使用 drive.file：不呼叫 files.list（會 403），改以 localStorage 記住 fileId。
 */
(function (global) {
  const cfg = global.GOOGLE_CONFIG || {};
  const SCOPES = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email";
  const state = {
    account: null,
    token: "",
    ready: false,
    lastCloudAt: "",
    busy: false,
    fileId: ""
  };
  let tokenClient = null;
  let uploadTimer = null;

  function fileName() {
    return cfg.fileName || "vivo_r01_line_data.json";
  }

  function storageKey() {
    const email = (state.account && (state.account.email || state.account.username)) || "default";
    return "line_google_drive_file_id_" + email + "_" + fileName();
  }

  function loadStoredFileId() {
    try {
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
          reject(new Error("Google 登入庫載入逾時（請用 http/https 開啟，勿雙擊 HTML）"));
          return;
        }
        setTimeout(tick, 100);
      })();
    });
  }

  function initMsal() {
    return ensureInit();
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

  function login() {
    // consent：強制重選權限，避免舊 token 沒有 Drive scope
    return requestToken("consent").then(function (tok) {
      return fetchUserEmail(tok);
    });
  }

  function logout() {
    if (state.token && global.google && google.accounts && google.accounts.oauth2) {
      google.accounts.oauth2.revoke(state.token, function () {});
    }
    state.token = "";
    state.account = null;
    state.fileId = "";
    return Promise.resolve();
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

  function createFile() {
    const meta = { name: fileName(), mimeType: "application/json" };
    return driveFetch("https://www.googleapis.com/drive/v3/files?fields=id,name", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(meta)
    }).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { throw new Error("建立雲端檔失敗 " + res.status + " " + t); });
      return res.json();
    }).then(function (f) {
      saveStoredFileId(f.id);
      return f.id;
    });
  }

  function ensureFileId() {
    loadStoredFileId();
    if (state.fileId) return Promise.resolve(state.fileId);
    return createFile();
  }

  function downloadJson() {
    state.busy = true;
    return ensureInit()
      .then(function () {
        if (!state.account) return login();
      })
      .then(function () {
        loadStoredFileId();
        if (!state.fileId) return null;
        return driveFetch("https://www.googleapis.com/drive/v3/files/" + state.fileId + "?alt=media")
          .then(function (res) {
            if (res.status === 404) {
              saveStoredFileId("");
              return null;
            }
            if (!res.ok) return res.text().then(function (t) { throw new Error("下載失敗 " + res.status + " " + t); });
            return res.text().then(function (text) {
              if (!text || !String(text).trim()) return null;
              return JSON.parse(text);
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
      .then(function () { return ensureFileId(); })
      .then(function (id) {
        return driveFetch("https://www.googleapis.com/upload/drive/v3/files/" + id + "?uploadType=media", {
          method: "PATCH",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: body
        });
      })
      .then(function (res) {
        if (res.status === 404) {
          saveStoredFileId("");
          return createFile().then(function (id) {
            return driveFetch("https://www.googleapis.com/upload/drive/v3/files/" + id + "?uploadType=media", {
              method: "PATCH",
              headers: { "Content-Type": "application/json; charset=utf-8" },
              body: body
            });
          });
        }
        return res;
      })
      .then(function (res) {
        if (!res.ok) return res.text().then(function (t) { throw new Error("上傳失敗 " + res.status + " " + t); });
        state.lastCloudAt = new Date().toISOString();
        return res.json().catch(function () { return {}; });
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

  function statusText() {
    if (!(cfg.clientId || "").trim() || String(cfg.clientId).indexOf("PLEASE_") === 0) {
      return "Google：尚未設定 clientId（見 google_config.js）";
    }
    if (state.account) {
      const who = state.account.email || state.account.username || "已登入";
      return "Google 雲端　｜　已登入 " + who +
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
    statusText: statusText
  };

  global.LineGoogle = api;
  global.LineOneDrive = api;
})(window);
