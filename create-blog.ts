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
  const images = files
    .filter(f => f.mimeType?.startsWith('image/'))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true }))

  if (!doc) throw new Error('資料夾內找不到 Google Doc')
  return { docId: doc.id!, images }
}

// 從 Docs API 取得文字和超連結
// hyperlinks：每個段落若含「延伸閱讀」關鍵字，收集該段落內所有帶連結的 textRun
async function getDocContent(docId: string): Promise<{
  text: string
  furtherReading: { text: string; url: string } | null
}> {
  const auth = getOAuthClient()
  const docs = google.docs({ version: 'v1', auth })

  const { data } = await docs.documents.get({ documentId: docId })

  const textParts: string[] = []
  let furtherReading: { text: string; url: string } | null = null

  for (const block of data.body?.content || []) {
    // 處理 table
    if (block.table) {
      for (const row of block.table.tableRows || []) {
        for (const cell of row.tableCells || []) {
          for (const cellBlock of cell.content || []) {
            if (cellBlock.paragraph) {
              const paraText = (cellBlock.paragraph.elements || [])
                .map((e: any) => e.textRun?.content || '').join('')
              textParts.push(paraText)
            }
          }
        }
      }
      continue
    }

    if (!block.paragraph) continue

    const elements: any[] = block.paragraph.elements || []
    const paraText = elements.map((e: any) => e.textRun?.content || '').join('')
    textParts.push(paraText)

    // 若段落含「延伸閱讀」，找第一個有 url 的 textRun
    if (paraText.includes('延伸閱讀') && !furtherReading) {
      for (const el of elements) {
        const url = el.textRun?.textStyle?.link?.url
        const text = el.textRun?.content?.trim()
        if (url && text) {
          furtherReading = { text, url }
          break
        }
      }
    }
  }

  return { text: textParts.join(''), furtherReading }
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

// hashtag → ct-* 對應表
const TAG_MAP: Record<string, { ct: string; blog: string }> = {
  '出勤服務': { ct: 'ct-checkin',     blog: 'blog.checkin' },
  '門禁服務': { ct: 'ct-pass',        blog: 'blog.pass' },
  '場域安全': { ct: 'ct-application', blog: 'blog.application' },
  '顧客管理': { ct: 'ct-customer',    blog: 'blog.customer' },
  '技術研究': { ct: 'ct-technical',   blog: 'blog.technical' },
  '案例分享': { ct: 'ct-case',        blog: 'blog.case' },
  '其他':     { ct: 'ct-other',       blog: 'blog.other' },
}

// 從 Doc 內容解析 # 或 ＃ 標籤
function parseHashtags(docContent: string): Array<{ ct: string; blog: string }> {
  const matches = docContent.match(/[#＃]([^\s#＃\n]+)/g) || []
  const result: Array<{ ct: string; blog: string }> = []
  for (const tag of matches) {
    const label = tag.replace(/^[#＃]/, '').trim()
    if (TAG_MAP[label]) result.push(TAG_MAP[label])
  }
  return result
}

// 用 GPT-4o 從 Doc 抽取結構化欄位（不用 regex，避免全形/半形問題）
async function parseDocMeta(docContent: string): Promise<{ metaTitle?: string; metaDescription?: string; h1?: string; imageAlts: string[] }> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 800,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `從文章內容中找出以下欄位，回傳 JSON：\n- metaTitle：Meta Title 欄位的文字\n- metaDescription：Meta Description 欄位的文字\n- h1：文章主標題（H1）\n- imageAlts：所有圖片 alt 描述的陣列（依出現順序）\n\n欄位名稱可能是全形或半形冒號，大小寫不拘。找不到就回傳 null 或空陣列。\n只回傳 JSON，格式：{"metaTitle":"...","metaDescription":"...","h1":"...","imageAlts":["...","..."]}`
      },
      { role: 'user', content: docContent },
    ],
  })
  const raw = response.choices[0]?.message?.content || '{}'
  const parsed = JSON.parse(raw)
  return {
    metaTitle: parsed.metaTitle || undefined,
    metaDescription: parsed.metaDescription || undefined,
    h1: parsed.h1 || undefined,
    imageAlts: Array.isArray(parsed.imageAlts) ? parsed.imageAlts : [],
  }
}


// 用 GPT-4o 生成 blog.html 用的 post-item HTML 片段
async function generatePostItem(params: {
  bId: string
  docContent: string
  date: string
  title: string
  imageAlt: string
  tags: Array<{ ct: string; blog: string }>
}): Promise<string> {
  const { bId, date, title, imageAlt, tags } = params

  const ctClasses = tags.map(t => t.ct).join(' ')
  const blogTags = tags.map(t => `\${{${t.blog}}}\$`).join('、')

  return `<div class="post-item border ${ctClasses}">
                        <div class="post-item-wrap">
                            <div class="post-image embed-responsive embed-responsive-4by3">
                                <a href="${bId}.html" class="embed-responsive-item">
                                    <img alt="${imageAlt}" src="/images/pages/${bId}_image_1.jpg">
                                </a>
                            </div>
                            <div class="post-item-description bg-gray-10">
                                <span class="post-meta-date">${date}</span>
                                <div class="text-grey-60 d-flex align-items-center"><span
                                        class="icon-sell mr-1"></span>${blogTags}
                                </div>
                                <h2 class="text-truncate text-truncate--2"><a href="${bId}.html">${title}</a></h2>
                            </div>
                        </div>
                    </div>`
}

// 用 GPT-4o 取得文章標題與第一張圖 alt
async function extractTitleAndAlt(docContent: string): Promise<{ title: string; imageAlt: string }> {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 200,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `從文章內容中取得以下資訊，回傳 JSON：
- title：文章的主標題（h1）
- imageAlt：第一張圖片的 alt 描述（繁體中文，描述圖片場景，約 20-30 字）

只回傳 JSON，格式：{"title":"...","imageAlt":"..."}`
      },
      { role: 'user', content: docContent },
    ],
  })
  const raw = response.choices[0]?.message?.content || '{}'
  return JSON.parse(raw)
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
  metaTitle?: string
  metaDescription?: string
  imageAlts?: string[]
  furtherReadingUrl?: string
  furtherReadingText?: string
}): Promise<string> {
  const { docContent, blogNumber, imageCount, date, templateHtml, metaTitle, metaDescription, imageAlts, furtherReadingUrl, furtherReadingText } = params
  const bId = `b${blogNumber}`

  // 延伸閱讀：有才放，沒有就略過
  const furtherReadingInstruction = (furtherReadingUrl && furtherReadingText)
    ? `- 延伸閱讀連結：href="${furtherReadingUrl}"，連結文字使用：${furtherReadingText}`
    : `- 此篇文章沒有延伸閱讀，請完全省略延伸閱讀區塊`

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    max_tokens: 16000,
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
- 第一張圖放在 h1 上方，其餘圖片穿插在適合的段落之間
- og:url 改為：https://www.goface.me/zh-TW/blog/zh-TW/${bId}.html
- 日期改為：${date}
${furtherReadingInstruction}
- FAQ JSON-LD schema 根據新文章的 FAQ 內容重新生成
${metaTitle ? `- title 和 og:title 使用：${metaTitle}` : ''}
${metaDescription ? `- meta description 和 og:description 使用：${metaDescription}` : ''}
${imageAlts && imageAlts.length > 0 ? `- 圖片 alt 依序使用：${imageAlts.map((a, i) => `圖${i + 1}: ${a}`).join('、')}` : ''}

只回傳完整 HTML，不要加任何說明文字或 markdown 標記。`
      },
      {
        role: 'user',
        content: `# 參考模板\n\n${templateHtml}\n\n# 新文章內容\n\n${docContent}`,
      },
    ],
  })

  const raw = response.choices[0]?.message?.content || ''
  // GPT-4o 有時會包 markdown code block，strip 掉
  return raw.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim()
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

  // 讀取 Doc 內容（含延伸閱讀超連結）
  const { text: docContent, furtherReading } = await getDocContent(docId)

  // 決定文章編號
  const blogNumber = await getNextBlogNumber()
  const bId = `b${blogNumber}`
  const date = new Date().toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '/')

  // 解析 hashtag 分類
  const tags = parseHashtags(docContent)
  if (tags.length === 0) throw new Error('Google Doc 內找不到分類標籤（如 ＃出勤服務），請確認文件最開頭有加上標籤')

  // 從 Doc 直接 parse 結構化欄位
  const docMeta = await parseDocMeta(docContent)
  const title = docMeta.h1 || docMeta.metaTitle || bId
  const imageAlt = docMeta.imageAlts[0] || ''

  // 找延伸閱讀超連結（doc 中含「延伸閱讀」字樣的 hyperlink）
  const furtherReadingUrl = furtherReading?.url
  const furtherReadingText = furtherReading?.text

  // 讀取上一篇 blog 作為模板
  const templateHtml = await getLatestBlogTemplate(blogNumber)

  // 生成 HTML
  const html = await generateBlogHTML({
    docContent,
    blogNumber,
    imageCount: images.length,
    date,
    templateHtml,
    metaTitle: docMeta.metaTitle,
    metaDescription: docMeta.metaDescription,
    imageAlts: docMeta.imageAlts,
    furtherReadingUrl,
    furtherReadingText,
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
  const postItem = await generatePostItem({ bId, docContent, date, title, imageAlt, tags })
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
