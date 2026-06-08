# goface-bot

Slack Bot，讓行銷/設計同事用自然語言修改 goface.me 官網內容，自動修改 src 並開 GitHub PR。PR 開啟後由 GitHub Actions 自動產出 dist、sitemap、markdown，只需工程師 review PR 後 merge 即完成。

## 技術架構

| 技術 | 用途 |
|------|------|
| **Vercel** | 雲端部署，提供公開 HTTPS endpoint 接收 Slack 事件 |
| **OpenAI GPT-4o** | 解析同事輸入的自然語言，判斷任務類型並抽取參數 |
| **GitHub API** | 找到對應 src 檔、替換內容、自動開 PR |
| **GitHub Actions** | PR 開啟後自動執行 `gulp build:ci`，產出 dist、sitemap、markdown 並 commit 回 PR branch |
| **Slack API** | 接收 app_mention 事件、驗證請求來源、回覆處理結果至 thread |

## 支援任務

| 同事說的話 | Bot 動作 |
|-----------|--------|
| 幫我改 [網址] 的「原文」改成「新文字」 | 找 src 檔案 → 替換文字 → 開 PR → GitHub Actions 自動 build dist + sitemap + markdown |
| 幫我看看 [網址] 的 SEO | 分析頁面 → 回覆建議（不開 PR） |
| 其他 | 回覆使用說明 |

## 專案結構

```
goface-bot/
├── api/slack/
│   └── events.ts     # Vercel Serverless Function，接收 Slack 事件，分派任務
├── parser.ts          # OpenAI 解析自然語言 → taskType
├── update-file.ts     # 找 src 檔案、替換文字、開 PR（dist 由 GitHub Actions 產出）
├── review-seo.ts      # 抓頁面內容，分析 SEO
├── slack.ts           # 回覆 Slack thread
├── verify.ts          # 驗證請求來自 Slack
├── vercel.json        # Vercel 設定
├── .env.example       # 環境變數範本
└── Slack App 設定說明.md
```

## 環境變數

複製 `.env.example` 為 `.env`，填入以下內容：

| 變數 | 說明 |
|------|------|
| `SLACK_BOT_TOKEN` | Slack Bot User OAuth Token（參考 Slack App 設定說明.md） |
| `SLACK_SIGNING_SECRET` | Slack App Signing Secret（參考 Slack App 設定說明.md） |
| `GITHUB_TOKEN` | GitHub Fine-grained PAT |
| `GITHUB_REPO_OWNER` | repo 擁有者，e.g. `astracloud` |
| `GITHUB_REPO_NAME` | repo 名稱，e.g. `goface.me` |
| `GITHUB_BASE_BRANCH` | 預設 `main` |
| `GITHUB_CONTENT_BASE_PATH` | src 資料夾名稱，e.g. `src` |
| `OPENAI_API_KEY` | OpenAI API Key（公司提供） |

## 檔案更新邏輯

同事傳入網址後，bot 只修改 src 檔案並開 PR，dist 由 GitHub Actions 自動產出：

- **blog 頁面**（`/zh-TW/blog/zh-TW/b80.html`）
  - bot 修改：`src/blog/zh-TW/b80.html`

- **一般頁面**（`/zh-TW/checkin.html`）
  - bot 修改：`src/lang/zh-TW/checkin.json`（文字存在 lang json）

PR 開啟後，**GitHub Actions**（goface.me repo）自動執行 `gulp build:ci`：
- HTML 編譯（`include` + `lang`）
- CSS/JS 產出
- `dist/sitemap.xml` 更新
- markdown 產出
- 將 dist commit 回 PR branch，merge 即完成部署

## 部署

1. 將此 repo 連結到 Vercel
2. 在 Vercel > Settings > Environment Variables 填入所有環境變數
3. 依照 `Slack App 設定說明.md` 完成 Slack App 設定

## 本機測試

```bash
npm install
npx ts-node test-update-file.ts
```

## 新增任務說明

新增一個 bot 任務需要以下步驟：

1. **`parser.ts`** — 在 `TaskType` 加入新類型，並在 system prompt 補上判斷規則與範例
2. **新增功能檔案** — 建立對應的 `.ts` 檔實作邏輯（參考 `update-file.ts`）
3. **`api/slack/events.ts`** — import 新功能，在 `switch` 裡新增對應的 `case`

---

## 未來待開發

- **新增部落格文章**：串接 Google Doc 後，讓同事直接從 Google Doc 匯入內容自動建立 HTML 並開 PR
