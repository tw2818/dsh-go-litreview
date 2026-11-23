// 三个文献源：Sci-Hub、PubMed、OpenAlex。
//
// 都走 MCP（和模型用的是同一批服务器），OpenAlex 另有一条直连 REST 的兜底，
// 因为它的 MCP 服务器在限流时会一直重试、不返回结果。

/** OpenAlex 的 API key，从凭据库来。空字符串就是没配。 */
let openalexKey = ''

export function setOpenalexKey(value) {
  if (typeof value === 'string') openalexKey = value
}

/** MCP 进程的位置。跟 profile 的 cordis.patch.yml 里配的一致。 */
export const SERVERS = {
  scihub: {
    command: '/usr/local/bin/python3',
    args: ['/root/.dsh/mcp/sci-hub-mcp-server/sci_hub_server.py'],
    cwd: '/root/.dsh/mcp/sci-hub-mcp-server',
    timeoutMs: 90_000,
  },
  pubmed: {
    command: '/opt/node/bin/node',
    args: ['/usr/local/lib/node_modules/@cyanheads/pubmed-mcp-server/dist/index.js'],
    timeoutMs: 45_000,
  },
  openalex: {
    command: '/opt/python/bin/openalex-mcp',
    args: [],
    // 限流时这个 MCP 会一直重试不返回，所以给它一个短超时，让 REST 兜底顶上。
    timeoutMs: 12_000,
  },
}

export const SOURCE_OPTIONS = ['Sci-Hub', 'PubMed', 'OpenAlex', '全部']

const SOURCE_BY_LABEL = {
  'Sci-Hub': 'scihub',
  PubMed: 'pubmed',
  OpenAlex: 'openalex',
  全部: 'all',
}

export function sourceIdFromLabel(label) {
  return SOURCE_BY_LABEL[label] ?? 'all'
}

export function isDoi(query) {
  return /^10\.\d{4,9}\/\S+$/i.test(String(query ?? '').trim())
}

/* ── 解析工具 ───────────────────────────────────────────── */

/** 从一段文本里抠出若干个 JSON 对象（Sci-Hub 的 MCP 会这么吐）。 */
export function parseJsonObjects(text) {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return []
  try {
    const value = JSON.parse(trimmed)
    if (Array.isArray(value)) return value
    if (value && typeof value === 'object') return [value]
  } catch {
    // 不是一整段 JSON，改用括号配对一段段抠。
  }
  const found = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      if (depth === 0) start = i
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0 && start >= 0) {
        try {
          found.push(JSON.parse(trimmed.slice(start, i + 1)))
        } catch {
          // 这段不是合法 JSON，跳过。
        }
        start = -1
      }
    }
  }
  return found
}

/** PubMed 的 MCP 返回 Markdown，按 "#### 标题" 切块。 */
export function parsePubmedMarkdown(text) {
  const blocks = String(text ?? '').split(/\n(?=####\s)/g)
  const papers = []
  for (const block of blocks) {
    const head = block.split('\n').find((line) => line.startsWith('#### '))
    if (!head) continue
    const field = (name) => {
      const match = block.match(new RegExp(`\\*\\*${name}:\\*\\*\\s*(.+)`))
      return match ? match[1].trim() : ''
    }
    const published = field('Published')
    papers.push({
      title: head.slice(5).trim(),
      pmid: field('PMID'),
      doi: field('DOI'),
      pmcid: field('PMCID'),
      authors: field('Authors'),
      venue: field('Source'),
      year: (published.match(/\d{4}/) ?? [''])[0],
    })
  }
  return papers
}

/**
 * OpenAlex 的作品 JSON → 统一字段。
 * MCP 返回的是 { query, total_results, works: [...] }，
 * REST 返回的是 { results: [...] }，两种都认。
 */
export function parseOpenalexWorks(text) {
  const parsed = parseJsonObjects(text)
  const root = parsed[0]
  const works = Array.isArray(root?.works)
    ? root.works
    : Array.isArray(root?.results)
      ? root.results
      : (Array.isArray(root) ? root : parsed)
  return works
    .filter((work) => work && typeof work === 'object' && (work.title || work.display_name || work.doi))
    .map((work) => {
      const authorships = Array.isArray(work.authorships) ? work.authorships : []
      const authors = work.first_author
        ? String(work.first_author)
        : authorships
            .slice(0, 3)
            .map((entry) => entry?.author?.display_name)
            .filter(Boolean)
            .join(', ')
      const venue =
        work.source_name ??
        work.primary_location?.source?.display_name ??
        work.locations?.[0]?.source?.display_name ??
        ''
      return {
        title: work.title ?? work.display_name ?? '',
        doi: String(work.doi ?? '').replace(/^https?:\/\/doi\.org\//i, ''),
        authors: authors ?? '',
        venue: venue ?? '',
        year: work.publication_year ?? work.year ?? '',
        cited: work.cited_by_count ?? 0,
        openAccess: work.open_access ?? false,
      }
    })
}

/* ── CrossRef 补标题 ────────────────────────────────────── */

const crossrefCache = new Map()

/** Sci-Hub 只给 DOI，用 CrossRef 补标题/作者/年份/期刊（失败就算了）。 */
export async function crossrefMeta(doi) {
  const key = String(doi ?? '').trim().toLowerCase()
  if (!key) return {}
  if (crossrefCache.has(key)) return crossrefCache.get(key)
  const promise = (async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await fetch(`https://api.crossref.org/works/${encodeURIComponent(key)}`, {
        signal: controller.signal,
        headers: { 'User-Agent': 'dsh-go-litreview/0.1 (dsh-go)' },
      })
      if (!response.ok) return {}
      const body = await response.json()
      const message = body?.message ?? {}
      const title = Array.isArray(message.title) ? message.title[0] : ''
      const authors = Array.isArray(message.author)
        ? message.author
            .slice(0, 3)
            .map((author) => [author?.given, author?.family].filter(Boolean).join(' '))
            .filter(Boolean)
            .join(', ')
        : ''
      const venue = Array.isArray(message['container-title']) ? message['container-title'][0] : ''
      const year = message?.issued?.['date-parts']?.[0]?.[0] ?? ''
      return { title: title ?? '', authors: authors ?? '', venue: venue ?? '', year: year ?? '' }
    } catch {
      return {}
    } finally {
      clearTimeout(timer)
    }
  })()
  crossrefCache.set(key, promise)
  return promise
}

/* ── 三个源的搜索 ───────────────────────────────────────── */

export async function searchScihub(client, query, limit) {
  const text = isDoi(query)
    ? await client.call('search_scihub_by_doi', { doi: String(query).trim() }, { timeoutMs: 60_000 })
    : await client.call('search_scihub_by_keyword', { keyword: query, num_results: limit }, { timeoutMs: 90_000 })
  const raw = parseJsonObjects(text).filter((item) => item && item.status === 'success')
  const papers = await Promise.all(
    raw.slice(0, limit).map(async (item) => {
      const meta = await crossrefMeta(item.doi)
      return {
        doi: item.doi ?? '',
        title: meta.title || item.doi || '（无标题）',
        authors: meta.authors || '',
        venue: meta.venue || '',
        year: meta.year || '',
        pdfUrl: item.pdf_url ?? '',
        mirror: item.mirror ?? '',
        source: 'scihub',
      }
    }),
  )
  return papers
}

export async function searchPubmed(client, query, limit) {
  const text = await client.call(
    'pubmed_search_articles',
    { query, maxResults: limit, summaryCount: limit },
    { timeoutMs: 45_000 },
  )
  return parsePubmedMarkdown(text).slice(0, limit).map((paper) => ({
    ...paper,
    pdfUrl: '',
    source: 'pubmed',
  }))
}

export async function searchOpenalex(client, query, limit) {
  try {
    const text = await client.call(
      'openalex_search_works',
      { query, per_page: limit },
      { timeoutMs: 20_000 },
    )
    const papers = parseOpenalexWorks(text).slice(0, limit)
    if (papers.length > 0) {
      return papers.map((paper) => ({ ...paper, pdfUrl: '', source: 'openalex' }))
    }
  } catch {
    // MCP 那边限流时会一直重试，往下走 REST 兜底。
  }
  const rest = await openalexRest(query, limit)
  if (rest.error) {
    const error = new Error(rest.error)
    error.friendly = true
    throw error
  }
  return rest.papers
}

/** 直连 OpenAlex REST：快，限流时直接拿到 429 的说明。 */
async function openalexRest(query, limit) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const keyPart = openalexKey ? `&api_key=${encodeURIComponent(openalexKey)}` : ''
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${limit}${keyPart}`
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'dsh-go-litreview/0.1 (dsh-go)' },
    })
    if (response.status === 429) {
      return { papers: [], error: 'OpenAlex 免费额度用完了（本机共享出口 IP），过一阵子再试。' }
    }
    if (!response.ok) {
      return { papers: [], error: `OpenAlex 报错：HTTP ${response.status}` }
    }
    const body = await response.json()
    const papers = (Array.isArray(body?.results) ? body.results : []).map((work) => ({
      title: work?.display_name ?? '',
      doi: String(work?.doi ?? '').replace(/^https?:\/\/doi\.org\//i, ''),
      authors: (Array.isArray(work?.authorships) ? work.authorships : [])
        .slice(0, 3)
        .map((entry) => entry?.author?.display_name)
        .filter(Boolean)
        .join(', '),
      venue: work?.primary_location?.source?.display_name ?? '',
      year: work?.publication_year ?? '',
      cited: work?.cited_by_count ?? 0,
      pdfUrl: '',
      source: 'openalex',
    }))
    return { papers, error: '' }
  } catch (error) {
    return { papers: [], error: `OpenAlex 连不上：${error?.message ?? error}` }
  } finally {
    clearTimeout(timer)
  }
}

/** 统一成面板里的一行。 */
export function toRow(paper) {
  const bits = []
  if (paper.authors) bits.push(paper.authors)
  if (paper.year) bits.push(String(paper.year))
  if (paper.venue) bits.push(paper.venue)
  if (paper.source === 'pubmed' && paper.pmid) bits.push(`PMID ${paper.pmid}`)
  if (paper.source === 'openalex' && paper.cited) bits.push(`被引 ${paper.cited}`)
  if (paper.source === 'scihub' && paper.mirror) bits.push('有 PDF')
  const title = String(paper.title ?? '').trim() || paper.doi || '（无标题）'
  return {
    title: title.slice(0, 220),
    subtitle: bits.join(' · ').slice(0, 160),
    trailing: paper.source === 'scihub' ? 'Sci-Hub' : paper.source === 'pubmed' ? 'PubMed' : 'OpenAlex',
    icon: paper.source === 'scihub' ? 'download' : 'article',
    action: {
      id: 'pick',
      args: {
        doi: paper.doi ?? '',
        pmid: paper.pmid ?? '',
        title: title.slice(0, 200),
        source: paper.source ?? '',
      },
    },
  }
}
