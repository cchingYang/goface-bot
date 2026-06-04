import type { VercelRequest, VercelResponse } from '@vercel/node'
import type { IncomingMessage } from 'http'

function getRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}
import { parseSlackMessage } from '../../parser'
import { createSEOPullRequest } from '../../update-file'
import { reviewPageSEO } from '../../review-seo'
import { replyToSlack } from '../../slack'
import { verifySlackSignature } from '../../verify'

// Vercel 預設會 parse body，關掉讓我們自己處理 raw body（Slack 簽名驗證需要）
export const config = { api: { bodyParser: false } }

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).end()

  const rawBody = await getRawBody(req)
  const signature = (req.headers['x-slack-signature'] as string) || ''
  const timestamp = (req.headers['x-slack-request-timestamp'] as string) || ''

  const isValid = await verifySlackSignature(rawBody, signature, timestamp)
  if (!isValid) return res.status(401).json({ error: 'Invalid signature' })

  const body = JSON.parse(rawBody)

  if (body.type === 'url_verification') {
    return res.status(200).json({ challenge: body.challenge })
  }

  const event = body.event
  if (!event || event.type !== 'app_mention') {
    return res.status(200).json({ ok: true })
  }

  // 先處理完再回 200（serverless function 回應後即終止，不能用背景任務）
  await processInBackground(event)
  return res.status(200).json({ ok: true })
}

async function processInBackground(event: any) {
  const message: string = event.text || ''
  const channel: string = event.channel
  const ts: string = event.ts
  const slackUser: string = event.user || 'unknown'

  try {
    await replyToSlack(channel, ts, '⏳ 處理中，請稍候...')

    const parsed = await parseSlackMessage(message)

    switch (parsed.taskType) {

      case 'update_file': {
        if (!parsed.url || !parsed.original || !parsed.replacement) {
          await replyToSlack(channel, ts,
            '⚠️ 修改檔案需要提供：\n• 網址\n• 原始文字\n• 修改後的文字\n\n例：幫我改 https://goface.me/blog/b29.html 的「原文」改成「新文字」')
          return
        }
        const { prUrl, prNumber } = await createSEOPullRequest({
          url: parsed.url,
          original: parsed.original,
          replacement: parsed.replacement,
          slackUser,
        })
        await replyToSlack(channel, ts,
          `✅ 修改完成，PR 已建立！\n\n*PR #${prNumber}*\n${prUrl}\n\n請 <@U0819C25K51> review 後 merge。`)
        break
      }

      case 'review_only': {
        if (!parsed.reviewUrl) {
          await replyToSlack(channel, ts,
            '⚠️ 請提供要審查的網址。\n\n例：幫我看看 https://goface.me/blog/b29.html 的 SEO')
          return
        }
        const analysis = await reviewPageSEO(parsed.reviewUrl)
        await replyToSlack(channel, ts,
          `*🔍 SEO 審查報告*\n${parsed.reviewUrl}\n\n${analysis}`)
        break
      }

      case 'unknown':
      default: {
        await replyToSlack(channel, ts,
          `你好！我是 goface-bot 👋\n\n我目前支援以下任務：\n\n*✏️ 修改現有頁面內容*\n幫我改 [網址] 的「原文」改成「新文字」\n\n*🔍 SEO 審查*\n幫我看看 [網址] 的 SEO 哪裡可以改\n\n其他需求請找相關同事處理 🙏`)
        break
      }
    }
  } catch (error: any) {
    console.error('goface-bot error:', error)
    await replyToSlack(channel, ts,
      `❌ 發生錯誤：${error.message || '請稍後再試或聯繫管理員。'}`)
  }
}
