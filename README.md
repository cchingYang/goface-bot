# goface-bot

Slack Bot，讓行銷/設計同事用自然語言操作 goface.me 官網，自動修改 src 並開 GitHub PR。PR 開啟後由 GitHub Actions 自動產出 dist、sitemap、markdown，工程師 review 後 merge 即完成部署。

## 支援任務

| 同事說的話 | Bot 動作 |
|-----------|--------|
| 幫我改 [網址] 的「原文」改成「新文字」 | 找 src 檔 → 替換文字 → 開 PR |
| 幫我發布這篇文章 [Google Drive 資料夾網址] | 從 Drive 讀取 Doc + 圖片 → 生成 HTML → 開 PR |
| 幫我看看 [網址] 的 SEO | 分析頁面 → 回覆建議（不開 PR） |

PR 開啟後，**GitHub Actions**（goface.me repo）自動執行：
- `build-dist.yml`：`gulp build:ci`（HTML 編譯、CSS/JS、sitemap、markdown）→ commit dist 回 PR branch
- `build-images.yml`：圖片轉 webp + 壓縮 → commit 回 PR branch

---

## 技術架構

| 技術 | 用途 |
|------|------|
| **Vercel** | 雲端部署，提供公開 HTTPS endpoint 接收 Slack 事件 |
| **Slack Events API** | 接收 `app_mention`、驗證簽名、回覆 thread |
| **OpenAI GPT-4o** | 解析自然語言 → taskType；生成部落格 HTML |
| **GitHub API (Octokit)** | 建立 branch、讀寫檔案、開 PR |
| **Google Docs API** | 讀取文件結構（段落、清單、超連結、表格）|
| **Google Drive API** | 列出資料夾內容、下載圖片 |
| **GitHub Actions** | PR 開啟後自動 build dist + 處理圖片 |

---

## 專案結構

```
goface-bot/
├── api/slack/
│   └── events.ts          # Vercel Serverless Function，接收 Slack 事件，分派任務
├── parser.ts               # GPT-4o 解析自然語言 → taskType + 參數
├── update-file.ts          # 任務：修改現有頁面文字 → 開 PR
├── create-blog.ts          # 任務：從 Google Drive 建立新部落格文章 → 開 PR
├── review-seo.ts           # 任務：SEO 分析（不開 PR）
├── slack.ts                # 回覆 Slack thread
├── verify.ts               # 驗證 Slack 請求簽名
├── vercel.json             # Vercel 設定
├── test-update-file.ts     # 本機測試：修改文字
├── test-create-blog.ts     # 本機測試：建立部落格（含兩個測試案例）
├── get-refresh-token.ts    # 工具：取得 Google OAuth refresh token
├── .env.example            # 環境變數範本
└── Slack App 設定說明.md
```

---

## 環境變數

複製 `.env.example` 為 `.env`：

| 變數 | 說明 |
|------|------|
| `SLACK_BOT_TOKEN` | Slack Bot User OAuth Token |
| `SLACK_SIGNING_SECRET` | Slack App Signing Secret |
| `GITHUB_TOKEN` | GitHub Fine-grained PAT（需 contents: write） |
| `GITHUB_REPO_OWNER` | repo 擁有者，e.g. `astracloud` |
| `GITHUB_REPO_NAME` | repo 名稱，e.g. `goface.me` |
| `GITHUB_BASE_BRANCH` | 預設 `main` |
| `GITHUB_CONTENT_BASE_PATH` | src 資料夾，e.g. `src` |
| `OPENAI_API_KEY` | OpenAI API Key |
| `GOOGLE_CLIENT_ID` | Google OAuth 2.0 Client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 Client Secret |
| `GOOGLE_REFRESH_TOKEN` | Google OAuth refresh token（見下方說明） |

### 取得 Google OAuth Refresh Token

Google Docs/Drive API 使用 OAuth 2.0（以個人 Gmail 帳號授權），首次設定需執行：

```bash
npx ts-node get-refresh-token.ts
```

依指示完成授權後，將終端機印出的 refresh token 填入 `.env` 的 `GOOGLE_REFRESH_TOKEN`，並同步更新至 Vercel 環境變數。

> **換人時**：只需重新執行上述步驟，用新帳號授權並更換 refresh token 即可。

---

## 本機測試

```bash
npm install

# 測試：修改現有頁面文字
npx ts-node test-update-file.ts

# 測試：建立部落格文章
npx ts-node test-create-blog.ts 1   # 案例 1：一般文章（無表格）
npx ts-node test-create-blog.ts 2   # 案例 2：含表格文章
```

---

## 部落格文章建立流程（create_blog）

### Google Drive 資料夾格式

每篇文章一個 Drive 資料夾，內容：
- **Google Doc**（一份）：文章主體
- **圖片**（若干）：命名依序排列（`pic1.jpg`、`pic2.jpg`...），決定插圖順序

### Google Doc 格式規範

| 欄位 | 說明 |
|------|------|
| `#標籤` 或 `＃標籤` | 文章分類，放最前面（支援全形／半形 `#`）。可用：`#出勤服務`、`#門禁服務`、`#場域安全`、`#顧客管理`、`#技術研究`、`#案例分享`、`#其他` |
| `Meta Title：` | SEO 標題 |
| `Meta Description：` | SEO 描述 |
| `H1` | 文章主標題 |
| `alt=` | 圖片 alt 描述（依圖片順序） |
| `CTA｜[按鈕文字](url)` | CTA 按鈕區塊，前一行為描述文字（輸出為 `<h4>`）|
| 有序清單（1. 2. 3.） | 輸出為 `<ol>` |
| 無序清單（• ） | 輸出為 `<ul>` |
| 延伸閱讀（文字附超連結） | 輸出為延伸閱讀連結；無則省略 |
| 其他超連結文字 | 輸出為 `<a target="_blank" rel="noopener">` |
| **粗體** | 輸出為 `<strong>` |

### 執行步驟

1. bot 讀取 Drive 資料夾 → 找到 Google Doc 和圖片（依檔名數字順序排列）
2. **Google Docs API** 解析文件結構（段落、清單類型、超連結 URL、粗體、表格）
3. **GPT-4o** 解析 Meta 欄位、hashtag 分類、圖片 alt
4. **GPT-4o** 以前一篇文章為模板，忠實將 Doc 內容填入 HTML 結構
5. 建立新 branch → 上傳圖片至 `src/assets/images/_pages/` → 上傳 HTML → 更新 `blog.html` post-item → 開 PR
6. **GitHub Actions** 自動轉 webp、壓縮圖片、build dist

---

## 修改文字流程（update_file）

同事提供網址 + 原文 + 新文字，bot 找對應 src 檔替換並開 PR：

- **blog 頁面**（`/zh-TW/blog/zh-TW/b80.html`）→ 修改 `src/blog/zh-TW/b80.html`
- **一般頁面**（`/zh-TW/checkin.html`）→ 修改 `src/lang/zh-TW/checkin.json`

---

## 部署

1. 將此 repo 連結到 Vercel
2. 在 Vercel > Settings > Environment Variables 填入所有環境變數
3. 依照 `Slack App 設定說明.md` 完成 Slack App 設定，將 Vercel endpoint 填入 Slack Event Subscriptions URL

---

## 新增任務

新增一個 bot 任務需要三步：

1. **`parser.ts`** — 在 `TaskType` 加入新類型，在 system prompt 補上判斷規則
2. **新功能檔案** — 建立 `.ts` 實作邏輯（參考 `update-file.ts` 或 `create-blog.ts`）
3. **`api/slack/events.ts`** — import 新功能，在 `switch` 新增對應 `case`
