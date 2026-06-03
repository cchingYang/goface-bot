import OpenAI from 'openai'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

/**
 * 抓取網頁內容，用 OpenAI 分析 SEO 並回覆建議
 * 不開 PR，只回覆到 Slack
 */
export async function reviewPageSEO(url: string): Promise<string> {
  // 1. 抓取頁面內容
  let pageContent = ''
  try {
    const res = await fetch(url)
    const html = await res.text()

    // 簡單擷取 title、meta description、h1、前幾段文字
    const titleMatch = html.match(/<title>(.*?)<\/title>/i)
    const descMatch = html.match(/name="description"[^>]*content="([^"]+)"/i)
    const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/i)
    const h2Matches = [...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/gi)].map(m => m[1])

    pageContent = `
Title: ${titleMatch?.[1] || '找不到'}
Meta Description: ${descMatch?.[1] || '找不到'}
H1: ${h1Match?.[1] || '找不到'}
H2 列表: ${h2Matches.slice(0, 5).join(' / ') || '找不到'}
    `.trim()
  } catch {
    pageContent = '無法抓取頁面內容，請確認網址是否正確且公開可存取。'
  }

  // 2. 呼叫 OpenAI 分析
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 800,
    messages: [
      {
        role: 'system',
        content: '你是一位專業 SEO 顧問，專精於繁體中文市場。請給出具體、可執行的優化建議。',
      },
      {
        role: 'user',
        content: `請審查以下頁面的 SEO 狀況：

網址：${url}

頁面資訊：
${pageContent}

請提供：
*🔍 現況分析*
（Title、Meta Description、標題結構的問題點）

*✏️ 具體修改建議*
（直接給出建議的文字，可以直接使用）

*📊 優先順序*
（哪個最重要，先改哪個）`,
      },
    ],
  })

  return response.choices[0]?.message?.content || '無法生成分析，請稍後再試。'
}
