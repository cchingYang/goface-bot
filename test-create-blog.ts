import * as dotenv from 'dotenv'
dotenv.config()

const { createBlogPost } = require('./create-blog')

// 測試用的 Google Drive 資料夾網址請設定在 .env（.env 已被 gitignore，不會進版控）：
// TEST_DRIVE_FOLDER_URL_1=一般文章（無表格）
// TEST_DRIVE_FOLDER_URL_2=含表格文章
const TEST_CASES = [
  {
    name: '一般文章（無表格）',
    driveFolderUrl: process.env.TEST_DRIVE_FOLDER_URL_1,
  },
  {
    name: '含表格文章',
    driveFolderUrl: process.env.TEST_DRIVE_FOLDER_URL_2,
  },
]

async function run() {
  const index = parseInt(process.argv[2] ?? '1') - 1
  const testCase = TEST_CASES[index]

  if (!testCase?.driveFolderUrl) {
    console.log('用法：npx ts-node test-create-blog.ts [1|2]')
    console.log('  1 = 一般文章（無表格）')
    console.log('  2 = 含表格文章')
    console.log('請先在 .env 設定 TEST_DRIVE_FOLDER_URL_1 / TEST_DRIVE_FOLDER_URL_2')
    process.exit(1)
  }

  console.log(`🚀 測試案例 ${index + 1}：${testCase.name}`)
  console.log(`📁 ${testCase.driveFolderUrl}\n`)

  try {
    const { prUrl, prNumber, blogNumber } = await createBlogPost({
      driveFolderUrl: testCase.driveFolderUrl,
      slackUser: 'ching-test',
    })
    console.log(`✅ 文章 b${blogNumber} 建立成功！`)
    console.log(`📎 PR #${prNumber}: ${prUrl}`)
  } catch (err: any) {
    console.error(`❌ 錯誤：${err.message}`)
    console.error(err)
  }
}

run()
