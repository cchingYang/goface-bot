import * as dotenv from 'dotenv'
dotenv.config()

const { createSEOPullRequest } = require('./update-file')

const testCases = [
  {
    url: 'https://www.goface.me/zh-TW/checkin.html',
    original: 'AI 打卡｜人臉辨識出勤更精準、更快速',
    replacement: 'HR 打卡｜人臉辨識出勤更精準、更快速',
  },
  {
    url: 'https://www.goface.me/zh-TW/blog/zh-TW/b80.html',
    original: '2026 企業雲端門禁考勤系統選購指南：提升管理效率的 5 大關鍵',
    replacement: '2027 企業雲端門禁考勤系統選購指南：提升管理效率的 7 大關鍵',
  },
]

async function run() {
  for (const tc of testCases) {
    console.log(`\n📄 測試：${tc.url}`)
    try {
      const { prUrl, prNumber } = await createSEOPullRequest({ ...tc, slackUser: 'ching-test' })
      console.log(`✅ PR #${prNumber}: ${prUrl}`)
    } catch (err: any) {
      console.error(`❌ 錯誤：${err.message}`)
    }
  }
}

run()
