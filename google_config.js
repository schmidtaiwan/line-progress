/* Google Cloud OAuth 用戶端（網頁應用程式）
 *
 * 1. https://console.cloud.google.com/ → 建立專案
 * 2. 啟用「Google Drive API」
 * 3. 憑證 → 建立 OAuth 用戶端 ID → 應用程式類型「網頁應用程式」
 * 4. 已授權的 JavaScript 來源加：
 *      http://localhost:8765
 *      https://你的帳號.github.io
 *      （若 repo 專案站：https://你的帳號.github.io/儲存庫名）
 * 5. 把用戶端 ID 貼到下面 clientId
 */
window.GOOGLE_CONFIG = {
  clientId: "865222319751-1jbqneceh84tf5b0mst6g7b2re88q1cu.apps.googleusercontent.com",
  // 會建立／讀寫在你 Google 雲端硬碟根目錄（由本 App 建立的檔）
  fileName: "vivo_r01_line_data.json"
};
