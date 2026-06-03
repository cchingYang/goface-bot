import { Octokit } from '@octokit/rest'

const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN,
})

const REPO_OWNER = process.env.GITHUB_REPO_OWNER!
const REPO_NAME = process.env.GITHUB_REPO_NAME!
const BASE_BRANCH = process.env.GITHUB_BASE_BRANCH || 'main'

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// dist 路徑：URL pathname 直接對應
// e.g. /zh-TW/checkin.html → dist/zh-TW/checkin.html
function urlToDistPath(url: string): string {
  const pathname = new URL(url).pathname.replace(/^\//, '')
  return `dist/${pathname}`
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
// blog 頁面：文字直接在 src/blog/zh-TW/b80.html
// 一般頁面：文字在 src/lang/zh-TW/checkin.json
async function findSrcFile(url: string, original: string): Promise<{ path: string; content: string; sha: string } | null> {
  const BASE_PATH = process.env.GITHUB_CONTENT_BASE_PATH || 'src'
  const urlObj = new URL(url)
  const pathname = urlObj.pathname

  // 先試 src html（去掉語系前綴）
  const srcHtmlPath = `${BASE_PATH}${pathname.replace(/^\/(zh-TW|en-US|ja-JP)\//, '/')}`
  const srcHtmlFile = await fetchFile(srcHtmlPath)
  if (srcHtmlFile?.content.includes(original)) {
    return { path: srcHtmlPath, ...srcHtmlFile }
  }

  // 找不到就去 lang json 找
  const langMatch = pathname.match(/^\/(zh-TW|en-US|ja-JP)\//)
  const lang = langMatch?.[1]
  if (!lang) return null

  // 取得頁面名稱（去掉副檔名）
  const pageName = pathname.split('/').pop()?.replace('.html', '')
  if (!pageName) return null

  const langJsonPath = `${BASE_PATH}/lang/${lang}/${pageName}.json`
  const langJsonFile = await fetchFile(langJsonPath)
  if (langJsonFile?.content.includes(original)) {
    return { path: langJsonPath, ...langJsonFile }
  }

  return null
}

export async function createSEOPullRequest(params: {
  url: string
  original: string
  replacement: string
  slackUser: string
}): Promise<{ prUrl: string; prNumber: number }> {
  const { url, original, replacement, slackUser } = params
  const distPath = urlToDistPath(url)

  // 1. 找 src 檔案（html 或 lang json）
  const srcFile = await findSrcFile(url, original)
  if (!srcFile) {
    throw new Error(`在 src 中找不到原文，請確認貼上的文字與檔案完全一致（包含空格與標點）。`)
  }

  // 2. 取得 dist 檔案
  const distFile = await fetchFile(distPath)
  if (!distFile) {
    throw new Error(`找不到 dist 檔案：${distPath}`)
  }
  if (!distFile.content.includes(original)) {
    throw new Error(
      `在 \`${distPath}\` 中找不到原文，src 與 dist 可能不同步，請先在本機執行 gulp dev 後再試。`
    )
  }

  // 3. 建立新 branch
  const timestamp = Date.now()
  const fileName = distPath.split('/').pop()?.replace('.html', '') || 'file'
  const branchName = `seo/update-${fileName}-${timestamp}`

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

  // 4. Commit src（html 或 lang json）
  await octokit.repos.createOrUpdateFileContents({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    path: srcFile.path,
    message: `seo: update content in ${srcFile.path.split('/').pop()}`,
    content: Buffer.from(srcFile.content.replace(original, replacement)).toString('base64'),
    sha: srcFile.sha,
    branch: branchName,
  })

  // 5. Commit dist
  await octokit.repos.createOrUpdateFileContents({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    path: distPath,
    message: `seo: update dist for ${fileName}.html`,
    content: Buffer.from(distFile.content.replace(original, replacement)).toString('base64'),
    sha: distFile.sha,
    branch: branchName,
  })

  // 6. 更新 sitemap lastmod
  const sitemapFile = await fetchFile('dist/sitemap.xml')
  if (sitemapFile) {
    const pageUrl = new URL(url)
    const newLastmod = new Date().toISOString()
    // 先試完整 URL，找不到再試 trailing slash（index.html 的 sitemap 有時用 /）
    const candidateUrls = [
      `${pageUrl.origin}${pageUrl.pathname}`,
      `${pageUrl.origin}${pageUrl.pathname.replace(/\/index\.html$/, '/')}`,
    ]
    let updatedSitemap = sitemapFile.content
    for (const locUrl of candidateUrls) {
      const replaced = sitemapFile.content.replace(
        new RegExp(`(<loc>${escapeRegex(locUrl)}</loc>\\s*<lastmod>)[^<]*(</lastmod>)`, 's'),
        `$1${newLastmod}$2`
      )
      if (replaced !== sitemapFile.content) {
        updatedSitemap = replaced
        break
      }
    }
    if (updatedSitemap !== sitemapFile.content) {
      await octokit.repos.createOrUpdateFileContents({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        path: 'dist/sitemap.xml',
        message: `seo: update sitemap lastmod for ${fileName}.html`,
        content: Buffer.from(updatedSitemap).toString('base64'),
        sha: sitemapFile.sha,
        branch: branchName,
      })
    }
  }

  // 7. 開 PR
  const { data: pr } = await octokit.pulls.create({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    title: `[SEO] ${fileName}.html 內容優化`,
    body: `## SEO 內容更新

**來源頁面**
${url}

**修改檔案**
- \`${srcFile.path}\`
- \`${distPath}\`

**修改內容**

> 原文
${original}

> 改文
${replacement}

---
*此 PR 由 goface-bot 自動建立，由 @${slackUser} 發起*`,
    head: branchName,
    base: BASE_BRANCH,
  })

  return {
    prUrl: pr.html_url,
    prNumber: pr.number,
  }
}
