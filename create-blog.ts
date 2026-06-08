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

// 從 GitHub 讀取檔案（含 sha）
async function fetchGithubFile(path: string): Promise<{ content: string; sha: string }> {
  const { data } = await octokit.repos.getContent({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    path,
    ref: BASE_BRANCH,
  })
  if (Array.isArray(data) || data.type !== 'file') throw new Error(`找不到檔案：${path}`)
  return { content: Buffer.from(data.content, 'base64').toString('utf-8'), sha: data.sha }
}

// 用 GPT-4o 生成 blog.html 用的 post-item HTML 片段
async function generatePostItem(params: {
  bId: string
  docContent: string
  date: string
}): Promise<string> {
  const { bId, docContent, date } = params

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 500,
    messages: [
      {
        role: 'system',
        content: `你是 goface.me 部落格列表的 HTML 生成助手。
根據文章內容，生成一個 post-item 的 HTML 片段，格式嚴格參考以下範例：

<div class="post-item border ct-pass ct-checkin ct-technical">
    <div class="post-item-wrap">
        <div class="post-image embed-responsive embed-responsive-4by3">
            <a href="b81.html" class="embed-responsive-item">
                <img alt="AI臉部辨識考勤系統在現代辦公室平板電腦上進行人臉辨識與活體偵測打卡" src="/images/pages/b81_image_1.jpg">
            </a>
        </div>
        <div class="post-item-description bg-gray-10">
            <span class="post-meta-date">2026/06/04</span>
            <div class="text-grey-60 d-flex align-items-center"><span class="icon-sell mr-1"></span>\${{blog.pass}}\$、\${{blog.checkin}}\$、\${{blog.technical}}\$
            </div>
            <h2 class="text-truncate text-truncate--2"><a href="b81.html">為什麼 AI 人臉辨識是考勤的未來？GoFace徹底解決代打卡與傳統刷卡機耗損問題</a></h2>
        </div>
    </div>
</div>

規則：
- href 和 img src 改為新文章的 ${bId}
- img alt 根據文章內容描述第一張圖
- date 改為 ${date}
- ct-* class 從以下選項中選擇符合文章內容的：ct-pass、ct-checkin、ct-technical、ct-application、ct-customer、ct-case
- \${{blog.XXX}}\$ 標籤與 ct-* class 對應，有幾個 ct-* 就列幾個 blog 標籤
- h2 標題從文章 h1 標題取得
- 只回傳 HTML 片段，不要其他說明`
      },
      {
        role: 'user',
        content: `文章編號：${bId}\n日期：${date}\n\n文章內容：\n${docContent}`,
      },
    ],
  })

  return response.choices[0]?.message?.content?.trim() || ''
}

// 從 GitHub 讀取最新一篇 blog HTML 作為模板
async function getLatestBlogTemplate(currentBlogNumber: number): Promise<string> {
  const prevBId = `b${currentBlogNumber - 1}`
  const { data } = await octokit.repos.getContent({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    path: `src/blog/zh-TW/${prevBId}.html`,
    ref: BASE_BRANCH,
  })
  if (Array.isArray(data) || data.type !== 'file') throw new Error(`找不到模板 ${prevBId}.html`)
  return Buffer.from(data.content, 'base64').toString('utf-8')
}

// 用 GPT-4o 把 Doc 內容轉成 blog HTML
async function generateBlogHTML(params: {
  docContent: string
  blogNumber: number
  imageCount: number
  date: string
  templateHtml: string
}): Promise<string> {
  const { docContent, blogNumber, imageCount, date, templateHtml } = params
  const bId = `b${blogNumber}`
  const prevBId = `b${blogNumber - 1}`

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 4000,
    messages: [
      {
        role: 'system',
        content: `你是 goface.me 的部落格文章 HTML 生成助手。
根據提供的「參考模板」與「新文章內容」，生成一篇全新的完整 HTML。

規則：
- 嚴格沿用模板的所有 HTML 結構、class 名稱、include 路徑、語系佔位符
- 語系佔位符（如 \${{ _lang_ }}\$、\${{blog.pass}}\$ 等）照抄不要更動
- include 路徑（如 @@include('../../../src/head.html')）照抄不要更動
- 圖片命名改為新編號：${bId}_image_1.jpg、${bId}_image_2.jpg...（共 ${imageCount} 張）
- 第一張圖放在 h1 上方
- 其餘圖片穿插在適合的段落之間
- og:url 改為：https://www.goface.me/zh-TW/blog/zh-TW/${bId}.html
- 日期改為：${date}
- 延伸閱讀連結改為指向 ${prevBId}.html
- title、meta、og、h1、h2、h3、內文、FAQ 全部換成新文章的內容
- FAQ JSON-LD schema 也要根據新文章的 FAQ 內容重新生成

只回傳完整 HTML，不要加任何說明文字或 markdown 標記。`
      },
      {
        role: 'user',
        content: `# 參考模板\n\n${templateHtml}\n\n# 新文章內容\n\n${docContent}`,
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

  // 讀取上一篇 blog 作為模板
  const templateHtml = await getLatestBlogTemplate(blogNumber)

  // 生成 HTML
  const html = await generateBlogHTML({
    docContent,
    blogNumber,
    imageCount: images.length,
    date,
    templateHtml,
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

  // 生成 post-item 並插入 blog.html
  const postItem = await generatePostItem({ bId, docContent, date })
  if (!postItem) throw new Error('post-item 生成失敗')

  const blogListPath = 'src/blog/zh-TW/blog.html'
  const blogListFile = await fetchGithubFile(blogListPath)
  const insertMarker = '<!-- Post item-->'
  if (!blogListFile.content.includes(insertMarker)) throw new Error('找不到 blog.html 插入點')

  const updatedBlogList = blogListFile.content.replace(
    insertMarker,
    `${insertMarker}\n                    ${postItem}`
  )

  await octokit.repos.createOrUpdateFileContents({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    path: blogListPath,
    message: `blog: add ${bId} to blog list`,
    content: Buffer.from(updatedBlogList).toString('base64'),
    sha: blogListFile.sha,
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

**新增／修改檔案**
- \`${htmlPath}\`
- \`${blogListPath}\`（已新增 post-item）
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
