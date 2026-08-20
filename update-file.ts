import { Octokit } from '@octokit/rest'
import { emojify } from 'node-emoji'

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function decodeHtmlEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
}

function stripTags(line: string): string {
  return decodeHtmlEntities(line.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

// 用於「找行」的比對：把空白全部移除後再比對，避免 tag 內尾部空白造成不一致
function collapseSpaces(s: string): string {
  return s.replace(/\s/g, '')
}

// 若插入的新內容是純文字（無 HTML tag），且目標行是 <p> 開頭，自動包上 <p></p>
function wrapIfNeeded(newContent: string, targetLine: string): string {
  if (/<[^>]+>/.test(newContent)) return newContent
  if (/^\s*<p[\s>]/i.test(targetLine)) {
    const indent = targetLine.match(/^(\s*)/)?.[1] ?? ''
    return `${indent}<p>${newContent}</p>`
  }
  return newContent
}

// 純文字比對，或剝除 HTML 標籤後比對（空白全移除後比對，避免 tag 邊界空白問題）
function contentContains(content: string, text: string): boolean {
  if (content.includes(text)) return true
  const needle = collapseSpaces(text)
  return content.split('\n').some(line => collapseSpaces(stripTags(line)).includes(needle))
}

// 使用者常用「Meta Title：」「Meta Description：」標註要改哪個欄位，
// 但這個標籤本身不會出現在頁面原始碼裡，需剝除後才能比對
const META_LABEL_RE = /^\s*Meta\s*(Title|Description)\s*[:：]\s*/i

function extractMetaField(text: string): { field: 'title' | 'description'; text: string } | null {
  const m = text.match(META_LABEL_RE)
  if (!m) return null
  const field = m[1].toLowerCase() === 'title' ? 'title' : 'description'
  return { field, text: text.slice(m[0].length) }
}

// title/description 在建立文章時會同時填入 <title>/og:title 或 description/og:description，
// 兩處內容相同，所以修改時兩處都要一起更新，避免 SEO 標籤互相不一致。
// 文字與右引號中間允許有空白/換行（\s*）：舊文章曾出現 content="文字\n"> 這種夾帶換行的寫法，
// 取代時一併吃掉，順便清成單行乾淨格式
function metaTagPatterns(field: 'title' | 'description', oldText: string): RegExp[] {
  const escaped = escapeRegExp(oldText)
  if (field === 'title') {
    return [
      new RegExp(`(<title>)${escaped}\\s*(</title>)`),
      new RegExp(`(<meta\\s+property="og:title"\\s+content=")${escaped}\\s*("\\s*/?>)`),
    ]
  }
  return [
    new RegExp(`(<meta\\s+name="description"\\s+content=")${escaped}\\s*("\\s*/?>)`),
    new RegExp(`(<meta\\s+property="og:description"\\s+content=")${escaped}\\s*("\\s*/?>)`),
  ]
}

// 沒有標籤（或標籤寫在引號外面，parser 沒抓進 original）時的備援判斷：
// 只要 original 剛好等於目前整個 <title>/<meta description> 的內容，就視為在改該欄位，
// 避免落回一般文字取代（只替換第一個出現位置，導致 og:title/og:description 沒同步更新）
function detectMetaFieldFromContent(content: string, original: string): 'title' | 'description' | null {
  const escaped = escapeRegExp(original)
  if (new RegExp(`<title>${escaped}\\s*</title>`).test(content)) return 'title'
  if (new RegExp(`<meta\\s+name="description"\\s+content="${escaped}\\s*"\\s*/?>`).test(content)) return 'description'
  return null
}

function applyMetaFieldChange(content: string, field: 'title' | 'description', oldText: string, newText: string): { content: string; matched: boolean } {
  const safeNewText = newText.replace(/\$/g, '$$$$')
  let result = content
  let matched = false
  for (const pattern of metaTagPatterns(field, oldText)) {
    if (pattern.test(result)) {
      result = result.replace(pattern, `$1${safeNewText}$2`)
      matched = true
    }
  }
  return { content: result, matched }
}

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
})

const REPO_OWNER = process.env.GITHUB_REPO_OWNER!
const REPO_NAME = process.env.GITHUB_REPO_NAME!
const BASE_BRANCH = process.env.GITHUB_BASE_BRANCH || 'main'

// src 路徑：去語系前綴
// e.g. /zh-TW/blog/zh-TW/b80.html → src/blog/zh-TW/b80.html
function urlToSrcPath(url: string): string {
  const BASE_PATH = process.env.GITHUB_CONTENT_BASE_PATH || 'src'
  const pathname = new URL(url).pathname
    .replace(/^\/(zh-TW|en-US|ja-JP)\//, '/')
    .replace(/^\//, '')
  return `${BASE_PATH}/${pathname}`
}

async function fetchFile(path: string): Promise<{ content: string; sha: string } | null> {
  try {
    const { data } = await octokit.repos.getContent({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path,
      ref: BASE_BRANCH,
    })
    if (Array.isArray(data) || data.type !== 'file') return null
    return {
      content: Buffer.from(data.content, 'base64').toString('utf-8'),
      sha: data.sha,
    }
  } catch (err: any) {
    if (err.status === 404) return null
    throw err
  }
}

// 從 URL 找出 src 裡有原文的檔案
// blog 頁面：文字直接在 src/blog/zh-TW/bXX.html
// 一般頁面：文字在 src/lang/zh-TW/pageName.json
async function findSrcFile(url: string, original: string): Promise<{ path: string; content: string; sha: string } | null> {
  const BASE_PATH = process.env.GITHUB_CONTENT_BASE_PATH || 'src'
  const urlObj = new URL(url)
  const pathname = urlObj.pathname

  // 先試 src html（去掉語系前綴）
  const srcHtmlPath = `${BASE_PATH}${pathname.replace(/^\/(zh-TW|en-US|ja-JP)\//, '/')}`
  const srcHtmlFile = await fetchFile(srcHtmlPath)
  if (srcHtmlFile && contentContains(srcHtmlFile.content, original)) {
    return { path: srcHtmlPath, ...srcHtmlFile }
  }

  // 找不到就去 lang json 找
  const langMatch = pathname.match(/^\/(zh-TW|en-US|ja-JP)\//)
  const lang = langMatch?.[1]
  if (!lang) return null

  const pageName = pathname.split('/').pop()?.replace('.html', '')
  if (!pageName) return null

  const langJsonPath = `${BASE_PATH}/lang/${lang}/${pageName}.json`
  const langJsonFile = await fetchFile(langJsonPath)
  if (langJsonFile && contentContains(langJsonFile.content, original)) {
    return { path: langJsonPath, ...langJsonFile }
  }

  return null
}

export interface Change {
  url: string
  original: string
  replacement: string
  metaField?: 'title' | 'description'
  // 由 parser.ts 依使用者用的動詞（加上/插入 vs 改成）明確指定，不要用字串頭尾去猜，
  // 否則「新文字整段包住原文」的單純改寫會被誤判成插入
  action?: 'insertBefore' | 'insertAfter'
}

export async function createSEOPullRequest(params: {
  changes: Change[]
  slackUser: string
}): Promise<{ prUrl: string; prNumber: number }> {
  const { slackUser } = params
  // Slack Events API 會把 & 編碼成 &amp;，先全部 decode 還原；
  // 使用者輸入的 emoji shortcode（如 :point_right:）如果 Slack 沒有自動轉換成 unicode，
  // 也要在這裡轉換，避免 shortcode 原文字串直接被寫進頁面
  const changes = params.changes.map(c => ({
    ...c,
    original: emojify(decodeHtmlEntities(c.original)),
    replacement: emojify(decodeHtmlEntities(c.replacement)),
  }))

  // 剝除「Meta Title：」「Meta Description：」標籤前綴，標記 metaField，
  // 讓比對邏輯改用 <title>/<meta> 標籤定向比對，而不是整份原始碼的文字搜尋
  const changesWithMeta: Change[] = changes.map(c => {
    const originalMeta = extractMetaField(c.original)
    if (!originalMeta) return c
    const replacementMeta = extractMetaField(c.replacement)
    return {
      ...c,
      metaField: originalMeta.field,
      original: originalMeta.text,
      replacement: replacementMeta ? replacementMeta.text : c.replacement,
    }
  })

  // 依 URL 分組
  const byUrl = new Map<string, Change[]>()
  for (const change of changesWithMeta) {
    if (!byUrl.has(change.url)) byUrl.set(change.url, [])
    byUrl.get(change.url)!.push(change)
  }

  // 建立 branch
  const timestamp = Date.now()
  const fileNames = [...byUrl.keys()]
    .map(u => new URL(u).pathname.split('/').pop()?.replace('.html', ''))
    .join('-')
  const branchName = `seo/update-${fileNames}-${timestamp}`

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

  const prBodySections: string[] = []
  const modifiedPaths: string[] = []

  // 依每個 URL 處理所有修改
  for (const [url, urlChanges] of byUrl) {

    // 找 src 檔案
    let srcFile: { path: string; content: string; sha: string } | null = null
    for (const { original } of urlChanges) {
      const found = await findSrcFile(url, original)
      if (found) { srcFile = found; break }
    }
    if (!srcFile) throw new Error(`在 src 中找不到對應檔案：${url}`)

    // 套用所有替換
    let srcContent = srcFile.content

    // 明確標記 Meta Title/Description（extractMetaField 剝出來的 metaField）的修改一律優先處理，
    // 且只鎖定 <title>/<meta> 標籤範圍替換。
    // 原因：同一段文字常常同時被當作可見段落與 meta 內容（SEO 慣例），若先跑一般文字取代，
    // 會用 split/join 把「所有」出現這段文字的地方都換掉（包括 meta 標籤），
    // 導致後面才處理的 meta 修改因原文已經被換掉而找不到、誤判為失敗。
    // 分組只看「明確標記」，不能用 detectMetaFieldFromContent 自動判斷來分組——
    // 若段落文字剛好與 meta 內容一模一樣，會連沒標記的段落修改也一起誤判成 meta 修改，
    // 導致段落本身永遠沒被換到。自動判斷留給下面第二輪、用當時最新的內容評估即可。
    const metaChanges = urlChanges.filter(c => c.metaField)
    const otherChanges = urlChanges.filter(c => !c.metaField)

    for (const { original, replacement, metaField } of metaChanges) {
      const { content: updated, matched } = applyMetaFieldChange(srcContent, metaField!, original, replacement)
      if (!matched) {
        const fieldLabel = metaField === 'title' ? 'Meta Title' : 'Meta Description'
        throw new Error(`找不到 ${fieldLabel} 原文「${original}」，請確認文字與頁面 <title>/<meta> 標籤內容完全一致。`)
      }
      srcContent = updated
    }

    for (const { original, replacement, action } of otherChanges) {
      // 沒有明確標記的修改，仍用內容自動判斷是否其實是在改 meta 欄位（見 detectMetaFieldFromContent）。
      // 用「目前」的 srcContent 判斷：若上面那輪已經把 meta 標籤換成新文字，這裡就不會再誤判，
      // 能正確落回一般文字取代，改到可見段落
      const autoMetaField = detectMetaFieldFromContent(srcContent, original)
      if (autoMetaField) {
        const { content: updated, matched } = applyMetaFieldChange(srcContent, autoMetaField, original, replacement)
        if (!matched) {
          const fieldLabel = autoMetaField === 'title' ? 'Meta Title' : 'Meta Description'
          throw new Error(`找不到 ${fieldLabel} 原文「${original}」，請確認文字與頁面 <title>/<meta> 標籤內容完全一致。`)
        }
        srcContent = updated
        continue
      }

      // 插入方向由 parser.ts 依使用者的動詞明確指定（action），不要單靠 replacement 是否以
      // original 開頭/結尾去猜——單純改寫句子時，新文字也可能剛好整段包住原文。
      // 同時仍檢查字串形狀是否吻合，避免 action 標錯或內容不符預期格式時誤觸插入邏輯
      const isInsertAfter = action === 'insertAfter' && replacement.startsWith(original)
      const isInsertBefore = action === 'insertBefore' && replacement.endsWith(original)

      if (srcContent.includes(original)) {
        if (isInsertAfter || isInsertBefore) {
          // 找到包含 original 的整行，在整行前後插入，避免新 block 元素嵌入原標籤內
          const lines = srcContent.split('\n')
          const lineIndex = lines.findIndex(line => line.includes(original))
          if (lineIndex !== -1) {
            const rawContent = replacement.slice(isInsertAfter ? original.length : 0, isInsertAfter ? undefined : -original.length).trimStart()
            const newContent = wrapIfNeeded(rawContent, lines[lineIndex])
            lines[lineIndex] = isInsertAfter
              ? lines[lineIndex] + '\n' + newContent
              : newContent + '\n' + lines[lineIndex]
            srcContent = lines.join('\n')
            continue
          }
        }
        // 換掉所有出現位置：同一段文字常同時出現在目錄錨點與內文標題（或其他重複引用處），
        // 只換第一個會讓目錄跟內文標題不同步
        srcContent = srcContent.split(original).join(replacement)
        continue
      }
      // 找不到純文字時，逐行剝除 HTML 標籤後比對，找到包含該文字的整行就整行前後插入或替換
      const lines = srcContent.split('\n')
      const needle = collapseSpaces(original)
      const lineIndex = lines.findIndex(line => collapseSpaces(stripTags(line)).includes(needle))
      if (lineIndex !== -1) {
        if (isInsertAfter) {
          const newContent = wrapIfNeeded(replacement.slice(original.length).trimStart(), lines[lineIndex])
          lines[lineIndex] = lines[lineIndex] + '\n' + newContent
        } else if (isInsertBefore) {
          const newContent = wrapIfNeeded(replacement.slice(0, -original.length).trimEnd(), lines[lineIndex])
          lines[lineIndex] = newContent + '\n' + lines[lineIndex]
        } else {
          lines[lineIndex] = replacement
        }
        srcContent = lines.join('\n')
        continue
      }
      throw new Error(`找不到原文「${original}」，請確認文字與頁面內容完全一致。`)
    }

    // Commit src
    await octokit.repos.createOrUpdateFileContents({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: srcFile.path,
      message: `seo: update content in ${srcFile.path.split('/').pop()}`,
      content: Buffer.from(srcContent).toString('base64'),
      sha: srcFile.sha,
      branch: branchName,
    })

    modifiedPaths.push(srcFile.path)

    const changeLines = urlChanges.map(({ original, replacement }) =>
      `> 原文：${original}\n> 改文：${replacement}`
    ).join('\n\n')
    prBodySections.push(`**${url}**\n${changeLines}`)
  }

  // 開 PR
  const { data: pr } = await octokit.pulls.create({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    title: `[SEO] 內容優化 ${[...byUrl.keys()].map(u => new URL(u).pathname.split('/').pop()).join(', ')}`,
    body: `## SEO 內容更新

**修改檔案**
${modifiedPaths.map(p => `- \`${p}\``).join('\n')}

**修改內容**

${prBodySections.join('\n\n---\n\n')}

---
*此 PR 由 goface-bot 自動建立，由 @${slackUser} 發起*
*dist 檔案將由 GitHub Actions 自動產出*`,
    head: branchName,
    base: BASE_BRANCH,
  })

  return { prUrl: pr.html_url, prNumber: pr.number }
}
