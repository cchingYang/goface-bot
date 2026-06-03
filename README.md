# goface-bot

Slack Bot，讓同事用自然語言觸發官網內容任務，自動開 GitHub PR。

## 支援任務

| 同事說的話 | Bot 動作 |
|-----------|--------|
| 幫我改 [網址] 的「原文」改成「新文字」 | 找 .html → 替換 → 開 PR |
| 幫我新增一篇關於 [主題] 的文章 | 生成 HTML → 建新檔案 → 開 PR |
| 幫我看看 [網址] 的 SEO | 分析頁面 → 回覆建議（不開 PR） |
| 其他 | 回覆使用說明 |

## 專案結構

```
goface-bot/
├── app/api/slack/events/
│   └── route.ts          # 主邏輯，接收 Slack 事件，分派任務
├── lib/
│   ├── parser.ts         # OpenAI 解析自然語言 → taskType
│   ├── github.ts         # 修改現有 .html 檔，開 PR
│   ├── create-article.ts # 生成新文章 HTML，開 PR
│   ├── review-seo.ts     # 抓頁面內容，分析 SEO
│   ├── slack.ts          # 回覆 Slack thread
│   └── verify.ts         # 驗證請求來自 Slack
├── .env.example
└── package.json
```

## 環境變數

參考 `.env.example`，複製為 `.env.local` 填入。

重要：`GITHUB_CONTENT_BASE_PATH` 要填 HTML 檔在 repo 的資料夾名稱。

## 部署

```bash
npm install
vercel deploy --prod
```

部署後把網址給主管填入 Slack App Event Subscriptions：
https://your-app.vercel.app/api/slack/events
