/* Google Cloud OAuth 用戶端（網頁應用程式）
 *
 * 多專案：全部寫入共用根資料夾（projectsRootId）
 *   {共用根}/架線進度_專案索引（Google 試算表）← 專案清單 SoT
 *   {共用根}/{專案名稱}/{專案}_架線進度（Google 試算表）← 進度 SoT
 *   {共用根}/{專案名稱}/photos/
 *   {共用根}/{專案名稱}/history/   ← JSON 快照備份（非主讀取）
 *   專案清單 SoT＝架線進度_專案索引（試算表）；不再寫 projects_index.json
 *   各專案進度 SoT＝{專案}_架線進度（試算表）；line_data.json 可選備份
 *
 * 目前共用根＝「網頁專案使用」
 *   https://drive.google.com/drive/folders/1kXxR9OFtjchcNzl-3mDEPcOeZAitAtAd
 *
 * GCP 需啟用：Google Drive API、Google Sheets API
 */
window.GOOGLE_CONFIG = {
  clientId: "90391506221-41kb4us4hsuq7go94udf3o17hr2f9uoh.apps.googleusercontent.com",

  // 顯示／路徑用名稱（實際位置以 projectsRootId 為準）
  projectsRoot: "網頁專案使用",

  // 多帳號共用根資料夾 ID（所有儲存都進這裡）
  projectsRootId: "1kXxR9OFtjchcNzl-3mDEPcOeZAitAtAd",

  // 舊版個人根（遷移來源；不再寫入）
  legacyProjectsRoot: "架線進度專案",

  // 資料儲存模式：sheets＝試算表為唯一進度／清單來源
  storageMode: "sheets",

  // 專案清單只留 Sheets（不寫／寫成後可清掉 projects_index.json）
  indexSheetsOnly: true,
  trashIndexJsonAfterSheetsWrite: true,

  // 共用根下的專案索引試算表
  indexSpreadsheetName: "架線進度_專案索引",
  indexSheetName: "projects",

  // 專案試算表工作表名（對齊 export_line_xlsx）
  sheetMeta: "_meta",
  sheetTrack: "架線項目清單管控",
  sheetWeekly: "架線周報",
  sheetOutlook: "OUTLOOK周報預覽",
  sheetOverview: "架線階段進度總覽",
  sheetPhotos: "_photos",

  // 一次性：空 Sheets 索引時從舊 JSON／資料夾還原一次
  // 20261102-sheets3：索引改 Sheets-only，不再雙寫 JSON
  forceIndexBuildId: "20261102-sheets3",
  forceIndexProjects: [
    { id: "p-dip-auto", name: "DIP自動換線", arch: "unified" },
    { id: "p-r01-mep", name: "R01機電工程", arch: "unified" },
    { id: "p-r01-pre", name: "R01機電前置工程", arch: "unified" },
    { id: "vivo-r01", name: "VIVO R01", arch: "unified", legacyFallback: true }
  ],

  // 各專案進度：可選仍寫 line_data.json 備份（與索引 JSON 無關）
  fileName: "line_data.json",
  writeJsonBackup: true,

  // 舊版 VIVO R01 路徑（相容讀取）
  legacyFolderPath: "R01_V4架線進度",
  legacyFileName: "vivo_r01_line_data.json",

  // 項目照片／歷史（在各專案資料夾底下）
  photosFolder: "photos",
  historyFolder: "history",
  historyMax: 10
};
