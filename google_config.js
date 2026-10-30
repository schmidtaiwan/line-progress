/* Google Cloud OAuth 用戶端（網頁應用程式）
 *
 * 多專案：每個專案一個資料夾
 *   {projectsRoot}/{專案名稱}/line_data.json
 *   {projectsRoot}/{專案名稱}/photos/
 *   {projectsRoot}/{專案名稱}/history/
 *   {projectsRoot}/projects_index.json  ← 專案清單
 *
 * 舊版單資料夾（VIVO R01 相容）：
 *   legacyFolderPath + legacyFileName 仍可讀取，首次儲存會寫入新專案資料夾
 */
window.GOOGLE_CONFIG = {
  clientId: "90391506221-41kb4us4hsuq7go94udf3o17hr2f9uoh.apps.googleusercontent.com",

  // 所有專案的父資料夾（相對於「我的雲端硬碟」）
  projectsRoot: "架線進度專案",

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
