部署到 GitHub Pages
==================
1. 在 Google Cloud 填好 google_config.js 的 clientId
2. OAuth「已授權的 JavaScript 來源」加上：
   https://你的帳號.github.io
   https://你的帳號.github.io/儲存庫名
3. 新建 GitHub 儲存庫，把本資料夾內容推上去
4. Settings → Pages → Deploy from branch → main / root（或 /docs）
5. 開啟 Pages 網址，按「登入 Google」→「上傳雲端」

勿把含真實進度的 JSON 提交進 Git。資料只存在 Google 雲端硬碟。
