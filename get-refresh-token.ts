import * as fs from 'fs'
import * as readline from 'readline'
import { google } from 'googleapis'

// 讀取下載的 OAuth JSON
const credPath = process.argv[2]
if (!credPath) {
  console.error('用法：npx ts-node get-refresh-token.ts <path-to-client-secret.json>')
  process.exit(1)
}

const creds = JSON.parse(fs.readFileSync(credPath, 'utf-8'))
const { client_id, client_secret, redirect_uris } = creds.installed

const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0])

const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/documents.readonly',
]

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent',
})

console.log('\n請在瀏覽器開啟以下網址並授權：\n')
console.log(authUrl)
console.log()

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
rl.question('授權完成後，貼上網址列的 code 參數值：', async (code) => {
  rl.close()
  try {
    const { tokens } = await oauth2Client.getToken(code)
    console.log('\n✅ 成功！請把以下三個值加到 .env 和 Vercel 環境變數：\n')
    console.log(`GOOGLE_CLIENT_ID=${client_id}`)
    console.log(`GOOGLE_CLIENT_SECRET=${client_secret}`)
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`)
  } catch (err: any) {
    console.error('❌ 錯誤：', err.message)
  }
})
