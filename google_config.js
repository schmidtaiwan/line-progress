/* Google Cloud OAuth 用戶端（網頁應用程式）
 *
 * 多專案：全部寫入共用根資料夾（projectsRootId）
 *   {共用根}/projects_index.json
 *   {共用根}/{專案名稱}/line_data.json
 *   {共用根}/{專案名稱}/photos/
 *   {共用根}/{專案名稱}/history/
 *
 * 目前共用根＝「網頁專案使用」
 *   https://drive.google.com/drive/folders/1kXxR9OFtjchcNzl-3mDEPcOeZAitAtAd
 *
 * 首次載入若共用根尚無清單，會自動從舊資料夾「架線進度專案」遷移專案 JSON。
 */
window.GOOGLE_CONFIG = {
  clientId: "90391506221-41kb4us4hsuq7go94udf3o17hr2f9uoh.apps.googleusercontent.com",

  // 顯示／路徑用名稱（實際位置以 projectsRootId 為準）
  projectsRoot: "網頁專案使用",

  // 多帳號共用根資料夾 ID（所有儲存都進這裡）
  projectsRootId: "1kXxR9OFtjchcNzl-3mDEPcOeZAitAtAd",

  // 舊版個人根（遷移來源；不再寫入）
  legacyProjectsRoot: "架線進度專案",

  // 一次性：依雲端資料夾重寫 projects_index（寫入後帶 forceBuildId，同 ID 不重跑）
  // 20261102-del1：修正刪案後因缺 forceBuildId／幽靈 hint 又把專案加回
  forceIndexBuildId: "20261102-del1",
  forceIndexProjects: [
    { id: "p-dip-auto", name: "DIP自動換線", arch: "unified" },
    { id: "p-r01-mep", name: "R01機電工程", arch: "unified" },
    { id: "p-r01-pre", name: "R01機電前置工程", arch: "unified" },
    { id: "vivo-r01", name: "VIVO R01", arch: "unified", legacyFallback: true }
  ],

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
