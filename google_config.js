/* Google Cloud OAuth 用戶端（網頁應用程式）
 *
 * 多專案：每個專案一個資料夾
 *   {projectsRoot}/{專案名稱}/line_data.json
 *   {projectsRoot}/{專案名稱}/photos/
 *   {projectsRoot}/{專案名稱}/history/
 *   {projectsRoot}/projects_index.json  ← 專案清單
 *
 * 多帳號同讀同一份資料（建議做法）：
 * 1. 選定「主帳號」（資料最完整的那一個，例如 jason660803@…）
 * 2. 開啟該帳 Drive →「架線進度專案」資料夾
 * 3. 網址列複製資料夾 ID：
 *    https://drive.google.com/drive/folders/【這一段就是 ID】
 * 4. 對該資料夾「共用」給其他帳號，權限選「編輯者」
 * 5. 把 ID 填入下方 projectsRootId（有填就走共用；空白＝各帳各自一份）
 *
 * 舊版單資料夾（VIVO R01 相容）：
 *   legacyFolderPath + legacyFileName 仍可讀取，首次儲存會寫入新專案資料夾
 */
window.GOOGLE_CONFIG = {
  clientId: "90391506221-41kb4us4hsuq7go94udf3o17hr2f9uoh.apps.googleusercontent.com",

  // 所有專案的父資料夾名稱（未設 projectsRootId 時，相對於「我的雲端硬碟」）
  projectsRoot: "架線進度專案",

  // 多帳號共用：填主帳號「架線進度專案」的資料夾 ID（空白＝各帳獨立）
  // 例："1AbCDefGhIjKLmnOPQrsTUVwxYZ"
  projectsRootId: "",

  // 專案內統一檔名
  fileName: "line_data.json",

  // 舊版 VIVO R01 路徑（相容讀取）
  legacyFolderPath: "R01_V4架線進度",
  legacyFileName: "vivo_r01_line_data.json",

  // 項目照片／歷史（在各專案資料夾底下）
  photosFolder: "photos",
  historyFolder: "history",
  historyMax: 10
};
