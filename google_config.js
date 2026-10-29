/* Google Cloud OAuth 用戶端（網頁應用程式）
 *
 * folderPath：雲端硬碟路徑（相對於「我的雲端硬碟」根目錄）
 *   例： "架線進度"           → 根目錄下的「架線進度」資料夾
 *       "專案/架線進度/資料"   → 多層資料夾（不存在會自動建立）
 *   留空 "" = 存在根目錄
 *
 * folderId：若已知資料夾 ID 可直接填（優先於 folderPath）
 *   開資料夾 → 網址 .../folders/xxxxxxxx 的那一段
 */
window.GOOGLE_CONFIG = {
  clientId: "865222319751-1jbqneceh84tf5b0mst6g7b2re88q1cu.apps.googleusercontent.com",

  // ↓ 指定上傳資料夾（對應你雲端硬碟已有的 LineProcess）
  folderPath: "LineProcess",

  // 或改用資料夾 ID（有填則忽略 folderPath）
  folderId: "",

  fileName: "vivo_r01_line_data.json",

  // 項目照片放在 folderPath 底下的此資料夾（不存在會自動建立）
  photosFolder: "photos"
};
