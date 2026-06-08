import { google } from 'googleapis'
import { Octokit } from '@octokit/rest'
import OpenAI from 'openai'

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN })
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const REPO_OWNER = process.env.GITHUB_REPO_OWNER!
const REPO_NAME = process.env.GITHUB_REPO_NAME!
const BASE_BRANCH = process.env.GITHUB_BASE_BRANCH || 'main'

function getOAuthClient() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
  )
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN })
  return auth
}

// 從 Drive 資料夾取得 Google Doc ID 和圖片清單
async function getDriveFolderContents(folderId: string) {
  const auth = getOAuthClient()
  const drive = google.drive({ version: 'v3', auth })

  const { data } = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType)',
  })

  const files = data.files || []
  const doc = files.find(f => f.mimeType === 'application/vnd.google-apps.document')
  const images = files.filter(f => f.mimeType?.startsWith('image/'))

  if (!doc) throw new Error('資料夾內找不到 Google Doc')
  return { docId: doc.id!, images }
}

// 讀取 Google Doc 內容（匯出為純文字）
async function getDocContent(docId: string): Promise<string> {
  const auth = getOAuthClient()
  const drive = google.drive({ version: 'v3', auth })

  const { data } = await drive.files.export(
    { fileId: docId, mimeType: 'text/plain' },
    { responseType: 'text' }
  ) as { data: string }

  return data
}

// 下載圖片 buffer
async function downloadImage(fileId: string): Promise<Buffer> {
  const auth = getOAuthClient()
  const drive = google.drive({ version: 'v3', auth })

  const { data } = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  )

  return Buffer.from(data as ArrayBuffer)
}

// 取得目前最新 blog 編號
async function getNextBlogNumber(): Promise<number> {
  const { data } = await octokit.repos.getContent({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    path: 'src/blog/zh-TW',
    ref: BASE_BRANCH,
  })

  if (!Array.isArray(data)) throw new Error('無法讀取 blog 目錄')

  const numbers = data
    .map(f => f.name.match(/^b(\d+)\.html$/))
    .filter(Boolean)
    .map(m => parseInt(m![1]))

  return Math.max(...numbers) + 1
}

// 用 GPT-4o 把 Doc 內容轉成 blog HTML
async function generateBlogHTML(params: {
  docContent: string
  blogNumber: number
  imageCount: number
  date: string
}): Promise<string> {
  const { docContent, blogNumber, imageCount, date } = params
  const bId = `b${blogNumber}`

  const imageTagsExample = Array.from({ length: imageCount }, (_, i) => {
    const n = i + 1
    if (n === 1) return `（第一張圖放在 h1 上方，固定格式）`
    return `圖片 ${n}：<picture><source srcset="/images/pages/${bId}_image_${n}.webp" type="image/webp"><img alt="[描述]" src="/images/pages/${bId}_image_${n}.jpg"></picture>`
  }).join('\n')

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 4000,
    messages: [
      {
        role: 'system',
        content: `你是 goface.me 的部落格文章 HTML 生成助手。
根據提供的文章內容，生成符合以下模板格式的完整 HTML。

模板結構（請嚴格參考）：
- head：title、meta keywords、meta description、og tags、FAQ JSON-LD schema
- body：header include、h1、目錄 card、h2/h3 章節、圖片穿插、FAQ Q&A、CTA 按鈕、footer include
- 語系佔位符：\${{ _lang_ }}\$、\${{blog.pass}}\$、\${{blog.checkin}}\$、\${{blog.technical}}\$ 等照抄
- include 路徑：@@include('../../../src/head.html') 等照抄
- 圖片命名：${bId}_image_1.jpg、${bId}_image_2.jpg...
- og:url：https://www.goface.me/zh-TW/blog/zh-TW/${bId}.html
- 日期：${date}
- 圖片數量：${imageCount} 張，第一張放 h1 上方，其餘穿插在適合的段落之間
- 延伸閱讀：放在最後一個 h2 章節末尾，連結到 b81.html

只回傳完整 HTML，不要加說明文字。`
      },
      {
        role: 'user',
        content: `以下是文章內容，請生成 HTML：\n\n${docContent}`,
      },
    ],
  })

  return response.choices[0]?.message?.content || ''
}

export async function createBlogPost(params: {
  driveFolderUrl: string
  slackUser: string
}): Promise<{ prUrl: string; prNumber: number; blogNumber: number }> {
  const { driveFolderUrl, slackUser } = params

  // 從 URL 取出 folder ID
  const folderIdMatch = driveFolderUrl.match(/folders\/([a-zA-Z0-9_-]+)/)
  if (!folderIdMatch) throw new Error('無效的 Google Drive 資料夾網址')
  const folderId = folderIdMatch[1]

  // 讀取資料夾內容
  const { docId, images } = await getDriveFolderContents(folderId)

  // 讀取 Doc 內容
  const docContent = await getDocContent(docId)

  // 決定文章編號
  const blogNumber = await getNextBlogNumber()
  const bId = `b${blogNumber}`
  const date = new Date().toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '/')

  // 生成 HTML
  const html = await generateBlogHTML({
    docContent,
    blogNumber,
    imageCount: images.length,
    date,
  })

  if (!html) throw new Error('HTML 生成失敗')

  // 建立 branch
  const timestamp = Date.now()
  const branchName = `blog/add-${bId}-${timestamp}`

  const { data: refData } = await octokit.git.getRef({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    ref: `heads/${BASE_BRANCH}`,
  })

  await octokit.git.createRef({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    ref: `refs/heads/${branchName}`,
    sha: refData.object.sha,
  })

  // 上傳圖片到 src/assets/images/_pages/
  const uploadedImages: string[] = []
  for (let i = 0; i < images.length; i++) {
    const image = images[i]
    const ext = image.name!.split('.').pop()?.toLowerCase() || 'jpg'
    const imagePath = `src/assets/images/_pages/${bId}_image_${i + 1}.${ext}`

    const buffer = await downloadImage(image.id!)

    await octokit.repos.createOrUpdateFileContents({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: imagePath,
      message: `blog: add images for ${bId}`,
      content: buffer.toString('base64'),
      branch: branchName,
    })

    uploadedImages.push(imagePath)
  }

  // 上傳 HTML
  const htmlPath = `src/blog/zh-TW/${bId}.html`
  await octokit.repos.createOrUpdateFileContents({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    path: htmlPath,
    message: `blog: add ${bId}`,
    content: Buffer.from(html).toString('base64'),
    branch: branchName,
  })

  // 開 PR
  const { data: pr } = await octokit.pulls.create({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    title: `[Blog] 新增文章 ${bId}`,
    body: `## 新增部落格文章

**文章編號**：${bId}
**來源**：${driveFolderUrl}

**新增檔案**
- \`${htmlPath}\`
${uploadedImages.map(p => `- \`${p}\``).join('\n')}

**備註**
- 圖片將由 GitHub Actions 自動轉 webp 並壓縮
- dist 將由 GitHub Actions 自動產出

---
*此 PR 由 goface-bot 自動建立，由 @${slackUser} 發起*`,
    head: branchName,
    base: BASE_BRANCH,
  })

  return { prUrl: pr.html_url, prNumber: pr.number, blogNumber }
}
