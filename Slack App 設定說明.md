# goface-bot — Slack App 設定說明

---

## 步驟一｜建立 Slack App

1. 開啟 https://api.slack.com/apps
2. 點右上角 **「Create New App」**
3. 選擇 **「From scratch」**
4. 填入：
   - App Name：`goface-bot`
   - Pick a workspace：選擇公司的 workspace
5. 點 **「Create App」**

---

## 步驟二｜設定 Bot 權限

1. 左側選單點 **「OAuth & Permissions」**
2. 往下找到 **「Bot Token Scopes」**
3. 點 **「Add an OAuth Scope」**，依序加入以下 3 個：
   - `app_mentions:read`
   - `chat:write`
   - `channels:history`

---

## 步驟三｜安裝 App 到 Workspace

1. 左側選單點 **「Install App」**
2. 點 **「Install to Workspace」**
3. 點 **「允許」**
4. 安裝完成後，頁面會出現一組 **Bot User OAuth Token**
   - 格式為 `xoxb-...` 開頭
   - 複製後填入 Vercel > Settings > Environment Variables > `SLACK_BOT_TOKEN`

---

## 步驟四｜取得 Signing Secret

1. 左側選單點 **「Basic Information」**
2. 找到 **「App Credentials」** 區塊
3. 點 **「Signing Secret」** 旁邊的 Show
4. 複製後填入 Vercel > Settings > Environment Variables > `SLACK_SIGNING_SECRET`

---

## 步驟五｜開啟 Event Subscriptions

1. 左側選單點 **「Event Subscriptions」**
2. 右上角 toggle 打開 **「Enable Events」**
3. 在 **Request URL** 填入：
   ```
   https://goface-bot.vercel.app/api/slack/events
   ```
4. 等出現 ✅ **Verified** 字樣
5. 往下找 **「Subscribe to bot events」**
6. 點 **「Add Bot User Event」**，加入：
   - `app_mention`
7. 點右下角 **「Save Changes」**

---

## 步驟六｜將 Bot 加入指定頻道

1. 打開以下指定頻道：https://astracloud.slack.com/archives/C040Q9F6D37
2. 點頻道名稱（上方）→ **「整合」** → **「加入 App」**
3. 搜尋 `goface-bot`，加入
