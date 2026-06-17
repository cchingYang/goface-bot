import OpenAI from 'openai'

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

export type TaskType = 'update_file' | 'review_only' | 'create_blog' | 'unknown'

export interface FileChange {
  url: string
  original: string
  replacement: string
}

export interface ParsedRequest {
  taskType: TaskType
  // update_file 用（支援多組修改）
  changes?: FileChange[]
  // review_only 用
  reviewUrl?: string
  // create_blog 用
  driveFolderUrl?: string
}

export async function parseSlackMessage(text: string): Promise<ParsedRequest> {
  const clean = text.replace(/<@[A-Z0-9]+>/g, '').trim()

  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 1500,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `你是 goface-bot 的訊息解析助手。判斷用戶想做什麼，回傳 JSON。

taskType 只有四種：
1. "update_file" — 修改現有頁面的某段文字，支援一次修改多個網址、每個網址多段文字
   需要：changes 陣列，每筆包含 url（網址）、original（原文）、replacement（改文）

2. "review_only" — 審查某頁面的 SEO，只要分析建議，不改檔案
   需要：reviewUrl（要審查的網址）

3. "create_blog" — 從 Google Drive 資料夾建立新部落格文章
   需要：driveFolderUrl（Google Drive 資料夾網址）

4. "unknown" — 無法判斷，或不屬於以上任務

判斷規則：
- 有提到「改」「修改」「替換」「更新」某段文字 → update_file
- 有提到「刪除」「移除」「拿掉」「去掉」某段文字 → update_file（replacement 設為空字串 ""）
- 有提到「上方加」「下方加」「前面加」「後面加」「加上」「插入」「新增一行」「結尾加」「最後加」「文章最後」「文末」→ update_file（見下方插入規則）
- 有提到「審查」「分析」「建議」「看看」「哪裡可以改」→ review_only
- 有提到「新增」「發布」「上傳」「建立」文章，並附上 Google Drive 網址 → create_blog
- 其他 → unknown

插入規則（統一用 update_file，透過 original/replacement 實作插入）：

定位錨點規則：
- 用戶指定「某段文字」→ original 直接用該文字
- 用戶說「CTA 按鈕上方」→ original = <a id="business_inquire"，replacement = [新內容段落]\n                                        <a id="business_inquire"
- 用戶說「CTA 按鈕下方」→ original = </a>\n                                        <h5 class="font-weight-400 mt-4">為您的企業量身打造高效門禁方案</h5>，replacement = </a>\n                                        [新內容段落]\n                                        <h5 class="font-weight-400 mt-4">為您的企業量身打造高效門禁方案</h5>
- 用戶說「文章結尾」「最後」「文末」→ original = <!-- end: content -->

插入方向規則（非 CTA 錨點）：
- 上方/前面插入：replacement = [新內容段落]\n[original]
- 下方/後面插入：replacement = [original]\n[新內容段落]
- 文章結尾插入（original 為 <!-- end: content -->）：replacement = [新內容段落]\n                                <!-- end: content -->

新內容格式規則：
- 純文字 → <p class="h5 font-weight-400 mt-3">[文字]</p>
- 有超連結 → <p class="h5 font-weight-400 mt-3">[前綴文字]<a href="[網址]" target="_blank" rel="noreferrer noopener">[連結文字]</a></p>
- 延伸閱讀格式 → <p class="h5 font-weight-400 mt-3 mb-4">延伸閱讀：<a href="[網址]" target="_blank" rel="noreferrer noopener">[連結文字]</a></p>

只回傳 JSON，不要其他文字。

範例一（單一修改）：
輸入：幫我改 https://goface.me/blog/b29.html 的「門禁廠商推薦」改成「想找高品質」
輸出：{"taskType":"update_file","changes":[{"url":"https://goface.me/blog/b29.html","original":"門禁廠商推薦","replacement":"想找高品質"}]}

範例二（同一頁面多段修改）：
輸入：幫我改 https://goface.me/blog/b31.html 的「2026門禁」改成「2027門禁」，「一、何謂門禁」改成「一、你知道門禁」
輸出：{"taskType":"update_file","changes":[{"url":"https://goface.me/blog/b31.html","original":"2026門禁","replacement":"2027門禁"},{"url":"https://goface.me/blog/b31.html","original":"一、何謂門禁","replacement":"一、你知道門禁"}]}

範例三（多個網址）：
輸入：幫我改 https://goface.me/blog/b31.html 的「A」改成「B」，https://goface.me/blog/b71.html 的「C」改成「D」
輸出：{"taskType":"update_file","changes":[{"url":"https://goface.me/blog/b31.html","original":"A","replacement":"B"},{"url":"https://goface.me/blog/b71.html","original":"C","replacement":"D"}]}

範例四（新增部落格）：
輸入：幫我新增這篇文章 https://drive.google.com/drive/folders/xxx
輸出：{"taskType":"create_blog","driveFolderUrl":"https://drive.google.com/drive/folders/xxx"}

範例五（SEO 審查）：
輸入：幫我看看 https://goface.me/blog/b29.html 的 SEO 哪裡可以改
輸出：{"taskType":"review_only","reviewUrl":"https://goface.me/blog/b29.html"}

範例六（在 CTA 上方插入延伸閱讀）：
輸入：在 https://www.goface.me/zh-TW/blog/zh-TW/b80.html 的 CTA 按鈕上方加上延伸閱讀「為什麼 AI 人臉辨識是考勤的未來？GoFace徹底解決代打卡與傳統刷卡機耗損問題」並使用超連結至 https://www.goface.me/zh-TW/blog/zh-TW/b81.html
輸出：{"taskType":"update_file","changes":[{"url":"https://www.goface.me/zh-TW/blog/zh-TW/b80.html","original":"<a id=\"business_inquire\"","replacement":"<p class=\"h5 font-weight-400 mt-3 mb-4\">延伸閱讀：<a href=\"https://www.goface.me/zh-TW/blog/zh-TW/b81.html\" target=\"_blank\" rel=\"noreferrer noopener\">為什麼 AI 人臉辨識是考勤的未來？GoFace徹底解決代打卡與傳統刷卡機耗損問題</a></p>\n                                        <a id=\"business_inquire\""}]}

範例六-b（在 CTA 按鈕下方插入純文字）：
輸入：在 https://www.goface.me/zh-TW/blog/zh-TW/b80.html 的 CTA 按鈕下方加上「我是機器人」
輸出：{"taskType":"update_file","changes":[{"url":"https://www.goface.me/zh-TW/blog/zh-TW/b80.html","original":"</a>\n                                        <h5 class=\"font-weight-400 mt-4\">為您的企業量身打造高效門禁方案</h5>","replacement":"</a>\n                                        <p class=\"h5 font-weight-400 mt-3\">我是機器人</p>\n                                        <h5 class=\"font-weight-400 mt-4\">為您的企業量身打造高效門禁方案</h5>"}]}

範例七（在某段文字上方插入純文字）：
輸入：在 https://www.goface.me/zh-TW/blog/zh-TW/b80.html 的「GoFace (盛星科技) 致力於成為」上方加上「立即了解更多 GoFace 方案」
輸出：{"taskType":"update_file","changes":[{"url":"https://www.goface.me/zh-TW/blog/zh-TW/b80.html","original":"GoFace (盛星科技) 致力於成為","replacement":"<p class=\"h5 font-weight-400 mt-3\">立即了解更多 GoFace 方案</p>\nGoFace (盛星科技) 致力於成為"}]}

範例八（在某段文字下方插入延伸閱讀連結）：
輸入：在 https://www.goface.me/zh-TW/blog/zh-TW/b79.html 的「雲端化與 AI 化是不可逆的趨勢」下方加上延伸閱讀「GoFace 完整方案介紹」連結到 https://www.goface.me/zh-TW/solution.html
輸出：{"taskType":"update_file","changes":[{"url":"https://www.goface.me/zh-TW/blog/zh-TW/b79.html","original":"雲端化與 AI 化是不可逆的趨勢","replacement":"雲端化與 AI 化是不可逆的趨勢\n<p class=\"h5 font-weight-400 mt-3 mb-4\">延伸閱讀：<a href=\"https://www.goface.me/zh-TW/solution.html\" target=\"_blank\" rel=\"noreferrer noopener\">GoFace 完整方案介紹</a></p>"}]}

範例九（在文章結尾插入）：
輸入：在 https://www.goface.me/zh-TW/blog/zh-TW/b80.html 的文章結尾加上「想進一步了解 GoFace 如何協助您的企業？立即預約免費顧問諮詢！」
輸出：{"taskType":"update_file","changes":[{"url":"https://www.goface.me/zh-TW/blog/zh-TW/b80.html","original":"<!-- end: content -->","replacement":"<p class=\"h5 font-weight-400 mt-3\">想進一步了解 GoFace 如何協助您的企業？立即預約免費顧問諮詢！</p>\n                                <!-- end: content -->"}]}

範例十（刪除某段文字）：
輸入：刪除 https://www.goface.me/zh-TW/blog/zh-TW/b80.html 的「我是機器人愛吃蘋果蘋果。」
輸出：{"taskType":"update_file","changes":[{"url":"https://www.goface.me/zh-TW/blog/zh-TW/b80.html","original":"我是機器人愛吃蘋果蘋果。","replacement":""}]}

範例十一（多段刪除）：
輸入：刪除 https://www.goface.me/zh-TW/blog/zh-TW/b80.html 的「文字A」和「文字B」
輸出：{"taskType":"update_file","changes":[{"url":"https://www.goface.me/zh-TW/blog/zh-TW/b80.html","original":"文字A","replacement":""},{"url":"https://www.goface.me/zh-TW/blog/zh-TW/b80.html","original":"文字B","replacement":""}]}

輸入：你好
輸出：{"taskType":"unknown"}`
      },
      {
        role: 'user',
        content: clean,
      },
    ],
  })

  const raw = response.choices[0]?.message?.content || '{}'
  const parsed = JSON.parse(raw)
  return parsed as ParsedRequest
}
