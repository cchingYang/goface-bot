import * as dotenv from 'dotenv'
dotenv.config()

const { createBlogPost } = require('./create-blog')

const TEST_CASES = [
  {
    name: '一般文章（無表格）',
    driveFolderUrl: 'https://drive.google.com/drive/folders/19oghX7Gyr73e4jcvyKAXefggHZKJlE05',
  },
  {
    name: '含表格文章（台鉅生技）',
    driveFolderUrl: 'https://drive.google.com/drive/folders/1g0GA8uVHitu0m1vblZ2v6nyZEYf3WKUB',
  },
]

async function run() {
  const index = parseInt(process.argv[2] ?? '1') - 1
  const testCase = TEST_CASES[index]

  if (!testCase) {
    console.log('用法：npx ts-node test-create-blog.ts [1|2]')
    console.log('  1 = 一般文章（無表格）')
    console.log('  2 = 含表格文章（台鉅生技）')
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
