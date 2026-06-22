import * as dotenv from 'dotenv'
dotenv.config()

const { createSEOPullRequest } = require('./update-file')

const testCases = [
  {
    changes: [
      {
        url: 'https://www.goface.me/zh-TW/blog/zh-TW/b80.html',
        original: '雲端門禁考勤系統（Cloud-Based Access Control & Attendance System）是一種基於 SaaS架構的解決方案。',
        replacement: '隨著數位轉型普及，現代雲端考勤系統已成為企業不可或缺的管理工具。雲端門禁考勤系統（Cloud-Based Access Control & Attendance System）是一種基於 SaaS架構的解決方案。',
      },
    ],
  },
]

async function run() {
  for (const tc of testCases) {
    console.log(`\n📄 測試：${tc.changes.map(c => c.url).join(', ')}`)
    try {
      const { prUrl, prNumber } = await createSEOPullRequest({ ...tc, slackUser: 'ching-test' })
      console.log(`✅ PR #${prNumber}: ${prUrl}`)
    } catch (err: any) {
      console.error(`❌ 錯誤：${err.message}`)
    }
  }
}

run()
