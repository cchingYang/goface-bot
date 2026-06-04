import OpenAI from 'openai'

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

export type TaskType = 'update_file' | 'review_only' | 'unknown'

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

taskType 只有三種：
1. "update_file" — 修改現有頁面的某段文字，支援一次修改多個網址、每個網址多段文字
   需要：changes 陣列，每筆包含 url（網址）、original（原文）、replacement（改文）

2. "review_only" — 審查某頁面的 SEO，只要分析建議，不改檔案
   需要：reviewUrl（要審查的網址）

3. "unknown" — 無法判斷，或不屬於以上任務

判斷規則：
- 有提到「改」「修改」「替換」「更新」某段文字 → update_file
- 有提到「審查」「分析」「建議」「看看」「哪裡可以改」→ review_only
- 其他 → unknown

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

輸入：幫我看看 https://goface.me/blog/b29.html 的 SEO 哪裡可以改
輸出：{"taskType":"review_only","reviewUrl":"https://goface.me/blog/b29.html"}

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
