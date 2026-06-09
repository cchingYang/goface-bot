import * as dotenv from 'dotenv'
dotenv.config()

const { createBlogPost } = require('./create-blog')

async function run() {
  console.log('🚀 開始測試建立部落格文章...')
  try {
    const { prUrl, prNumber, blogNumber } = await createBlogPost({
      driveFolderUrl: 'https://drive.google.com/drive/folders/19oghX7Gyr73e4jcvyKAXefggHZKJlE05',
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
