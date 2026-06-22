import { Octokit } from '@octokit/rest'

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
}

export async function createSEOPullRequest(params: {
  changes: Change[]
  slackUser: string
}): Promise<{ prUrl: string; prNumber: number }> {
  const { slackUser } = params
  // Slack Events API 會把 & 編碼成 &amp;，先全部 decode 還原
  const changes = params.changes.map(c => ({
    ...c,
    original: decodeHtmlEntities(c.original),
    replacement: decodeHtmlEntities(c.replacement),
  }))

  // 依 URL 分組
  const byUrl = new Map<string, Change[]>()
  for (const change of changes) {
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
    for (const { original, replacement } of urlChanges) {
      // 判斷插入方向：replacement 以 original 開頭 → 下方插入；以 original 結尾 → 上方插入；否則是純替換
      const isInsertAfter = replacement.startsWith(original)
      const isInsertBefore = !isInsertAfter && replacement.endsWith(original)

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
        srcContent = srcContent.replace(original, replacement)
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
