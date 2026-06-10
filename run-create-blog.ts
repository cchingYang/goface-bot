import * as dotenv from 'dotenv'
dotenv.config()

import { createBlogPost } from './create-blog'
import { replyToSlack } from './slack'

async function main() {
  const driveFolderUrl = process.env.DRIVE_FOLDER_URL
  const slackUser = process.env.SLACK_USER || 'unknown'
  const channel = process.env.SLACK_CHANNEL
  const ts = process.env.SLACK_TS

  if (!driveFolderUrl || !channel || !ts) {
    console.error('缺少必要環境變數：DRIVE_FOLDER_URL, SLACK_CHANNEL, SLACK_TS')
    process.exit(1)
  }

  try {
    const { prUrl, prNumber, blogNumber } = await createBlogPost({ driveFolderUrl, slackUser })
    await replyToSlack(channel, ts,
      `✅ 文章 b${blogNumber} 已建立，PR 已開啟！\n\n*PR #${prNumber}*\n${prUrl}\n\n請 <@U0819C25K51> review 後 merge。`)
  } catch (error: any) {
    console.error('create-blog error:', error)
    await replyToSlack(channel, ts,
      `❌ 發生錯誤：${error.message || '請稍後再試或聯繫管理員。'}`)
    process.exit(1)
  }
}

main()
