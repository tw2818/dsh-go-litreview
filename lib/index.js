// 文献检索 —— dsh-go 原生插件。
//
// 把三个文献源合成一个原生面板：
//   · Sci-Hub   —— 命中即有 PDF（走本机装好的 Sci-Hub MCP）
//   · PubMed    —— 标题、作者、PMID（走 PubMed MCP）
//   · OpenAlex  —— 引用数、开放获取线索（走 OpenAlex MCP，限流时走 REST 兜底）
//
// 面板只做两件事：给出结果、把结果变成一句能发出去的话。
// 真正读全文、下载 PDF、总结，还是交给模型——它手里有同一批 MCP 工具。

import { McpClient } from './mcp.js'
import {
  SERVERS,
  SOURCE_OPTIONS,
  searchOpenalex,
  searchPubmed,
  searchScihub,
  setOpenalexKey,
  sourceIdFromLabel,
  toRow,
} from './sources.js'

export const name = 'dsh-go-litreview'

const DOWNLOAD_DIR = '/sdcard/Download/DSH-Go'
const RESULT_LIMIT = 10
const SCIHUB_LIMIT = 6

/** MCP 客户端按需拉起，用完留着复用。 */
const clients = new Map()

function client(id) {
  if (!clients.has(id)) {
    const config = SERVERS[id]
    clients.set(id, new McpClient({ ...config, label: id }))
  }
  return clients.get(id)
}

const state = {
  query: '',
  source: '全部',
  doiDraft: '',
  results: [],
  status: '填关键词或 DOI，点「搜索」。',
  statusTone: 'info',
  hint: '命中后点某一条，会把检索指令放进输入框，由模型去取全文。',
  downloadNote: '按 DOI 直取 PDF，存到手机存储 DSH-Go 目录。',
}

let pushPanel = null
let pushStrip = null

function t(caps, cn, en) {
  return String(caps?.locale ?? '').startsWith('en') ? en : cn
}

/* ── 从 App 送来的动作载荷里取值 ─────────────────────────── */

const META_KEYS = new Set(['action', 'id', 'surface', 'locale', 'field', 'type', 'pkg', 'stream', 'userGesture'])

function scalarsOf(value, depth = 0) {
  if (depth > 3) return []
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return [value]
  if (Array.isArray(value)) return value.flatMap((item) => scalarsOf(item, depth + 1))
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value)
    .filter(([key]) => !META_KEYS.has(key))
    .flatMap(([, item]) => scalarsOf(item, depth + 1))
}

/** 用户刚改的那个值（输入框、来源切换都走它）。 */
function changedValue(event) {
  const value = event?.value
  if (typeof value === 'string') return value
  if (value === null || typeof value !== 'object') return undefined
  if (typeof value.field === 'string' && 'value' in value) return value.value
  for (const key of ['value', 'text', 'query', 'doi']) {
    if (typeof value[key] === 'string') return value[key]
  }
  const scalars = scalarsOf(value)
  if (scalars.length === 1) return scalars[0]
  return undefined
}

/** 面板动作的 args。App 给的可能是 args 本体，也可能再包一层。 */
function readArgs(event) {
  const value = event?.value
  if (value && typeof value === 'object') {
    if (value.args && typeof value.args === 'object') return value.args
    return value
  }
  return {}
}

/* ── 面板数据 ───────────────────────────────────────────── */

function panelData() {
  return {
    query: state.query,
    source: state.source,
    doiDraft: state.doiDraft,
    status: state.status,
    statusTone: state.statusTone,
    results: state.results,
    resultCount: state.results.length,
    hint: state.hint,
    downloadNote: state.downloadNote,
  }
}

function push() {
  try {
    pushPanel?.(panelData())
  } catch {
    // 面板还没订阅。
  }
  try {
    pushStrip?.(stripText())
  } catch {
    // 同上。
  }
}

function stripText() {
  const count = state.results.length
  if (count > 0) return `文献：${count} 条命中`
  return '文献：Sci-Hub·PubMed·OpenAlex'
}

function setStatus(text, tone = 'info') {
  state.status = text
  state.statusTone = tone
  push()
}

function friendlyError(error) {
  const message = String(error?.message ?? error ?? '')
  if (!message) return '出错了'
  if (/Rate limit|429|额度/i.test(message)) return '今日免费额度用完了，过一阵子再试'
  if (/超时|等太久/i.test(message)) return '等太久了，超时了'
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|连不上/i.test(message)) return '连不上服务器'
  return message.slice(0, 60)
}

/* ── 搜索 ───────────────────────────────────────────────── */

async function runSearch() {
  const query = state.query.trim()
  if (!query) {
    setStatus('先填检索词或 DOI。', 'warn')
    return
  }
  const sourceId = sourceIdFromLabel(state.source)
  const started = Date.now()
  setStatus(`搜索中…（${state.source}）`, 'info')
  state.hint = ''

  const jobs = []
  if (sourceId === 'all' || sourceId === 'scihub') {
    jobs.push({ id: 'scihub', label: 'Sci-Hub', run: () => searchScihub(client('scihub'), query, SCIHUB_LIMIT) })
  }
  if (sourceId === 'all' || sourceId === 'pubmed') {
    jobs.push({ id: 'pubmed', label: 'PubMed', run: () => searchPubmed(client('pubmed'), query, RESULT_LIMIT) })
  }
  if (sourceId === 'all' || sourceId === 'openalex') {
    jobs.push({ id: 'openalex', label: 'OpenAlex', run: () => searchOpenalex(client('openalex'), query, RESULT_LIMIT) })
  }

  // 各源各自跑，谁先回来谁先出结果，不用等最慢的那个。
  const papers = []
  const notes = []
  const order = { scihub: 0, pubmed: 1, openalex: 2 }
  await Promise.all(
    jobs.map(async (job) => {
      try {
        const found = await job.run()
        papers.push(...found.map((paper) => ({ ...paper, source: paper.source ?? job.id })))
        papers.sort((a, b) => (order[a.source] ?? 9) - (order[b.source] ?? 9))
        state.results = papers.map(toRow)
        setStatus(`已找到 ${papers.length} 条（${job.label}）…`, 'info')
      } catch (error) {
        notes.push(`${job.label}：${friendlyError(error)}`)
        state.hint = notes.join('；')
        push()
      }
    }),
  )

  state.results = papers.map(toRow)
  const seconds = Math.max(1, Math.round((Date.now() - started) / 1000))
  if (papers.length === 0) {
    setStatus('没找到。换个关键词或直接填 DOI 再试。', 'warn')
  } else {
    setStatus(`找到 ${papers.length} 条 · ${seconds} 秒`, 'good')
  }
  state.hint = notes.length
    ? notes.join('；')
    : '点一条结果，检索指令会放进输入框；全文和 PDF 由模型去取。'
  push()
}

/* ── 直取 PDF ───────────────────────────────────────────── */

async function downloadPdf(doi, caps) {
  const clean = doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
  state.downloadNote = `正在取 ${clean}…`
  push()
  try {
    const text = await client('scihub').call('search_scihub_by_doi', { doi: clean }, { timeoutMs: 60_000 })
    const found = JSON.parse(text)
    if (!found || found.status !== 'success' || !found.pdf_url) {
      state.downloadNote = `Sci-Hub 没找到 ${clean}。`
      push()
      return
    }
    const fileName = `${clean.replace(/[^\w.-]+/g, '_')}.pdf`
    const target = `${DOWNLOAD_DIR}/${fileName}`
    const result = await client('scihub').call(
      'download_scihub_pdf',
      { pdf_url: found.pdf_url, output_path: target },
      { timeoutMs: 120_000 },
    )
    if (/successfully/i.test(result)) {
      state.downloadNote = `已存到 ${target}`
    } else {
      state.downloadNote = `下载没成功：${result.slice(0, 60)}`
    }
  } catch (error) {
    state.downloadNote = `下载失败：${friendlyError(error)}`
  }
  push()
  void caps
}

/* ── 插件入口 ───────────────────────────────────────────── */

export function apply(ctx) {
  // OpenAlex 的 key 放在 DSH 凭据库里，解析出来喂给 MCP 进程。
  // 单独一个 inject：凭据服务不来，也不该把面板拖住。
  ctx.inject(['credentials'], (ctx) => {
    void (async () => {
      try {
        const resolved = await ctx.credentials?.resolve?.('OPENALEX_API_KEY')
        const value = resolved?.value
        if (typeof value === 'string' && value.length > 0) {
          client('openalex').setEnv({ OPENALEX_API_KEY: value })
          setOpenalexKey(value)
        }
      } catch (error) {
        ctx.logger?.warn?.('文献检索: 读 OpenAlex 凭据失败：' + String(error?.message ?? error))
      }
    })()
  })

  ctx.inject(['dshGo'], (ctx) => {
    // 输入框上方的胶囊：打开面板。
    ctx.dshGo.on('open-litreview', () => ({ open: 'panel:litreview' }))

    // 输入框上方的状态条：显示最近一次命中数。
    ctx.dshGo.strip('litreview-state', (scope, emit) => {
      pushStrip = (text) => emit({ text: text.slice(0, 24), icon: 'book' })
      emit({ text: stripText().slice(0, 24), icon: 'book' })
      return () => {
        pushStrip = null
      }
    })

    // 原生面板（v2 视图）。
    ctx.dshGo.panel('litreview', {
      view: (scope, caps) => ({
        v: 2,
        type: 'stack',
        title: t(caps, '文献检索', 'Literature'),
        style: { gap: 'M', padding: 'M' },
        children: [
          {
            type: 'textField',
            label: t(caps, '检索词 / DOI', 'Query / DOI'),
            bind: 'data.query',
            onChange: 'query-changed',
            placeholder: '10.1038/nature09492 或 base editing',
            maxLength: 200,
          },
          {
            type: 'segmented',
            label: t(caps, '来源', 'Source'),
            bind: 'data.source',
            onChange: 'source-changed',
            options: SOURCE_OPTIONS,
          },
          {
            type: 'actions',
            items: [
              { label: t(caps, '搜索', 'Search'), action: 'search', icon: 'search' },
              { label: t(caps, '清空', 'Clear'), action: 'clear', icon: 'clear' },
            ],
          },
          { type: 'divider', size: 'S' },
          { type: 'callout', text: { $: 'data.status' }, tone: { $: 'data.statusTone' } },
          { type: 'list', items: { $: 'data.results' } },
          { type: 'text', text: { $: 'data.hint' }, tone: 'muted', style: { size: 'caption' } },
          { type: 'divider', size: 'S' },
          {
            type: 'stack',
            style: { card: 'surface', padding: 'M', gap: 'M' },
            children: [
              {
                type: 'text',
                text: t(caps, '直取 PDF（Sci-Hub）', 'Direct PDF (Sci-Hub)'),
                style: { size: 'subtitle', weight: 'medium' },
              },
              {
                type: 'textField',
                label: t(caps, 'DOI', 'DOI'),
                bind: 'data.doiDraft',
                onChange: 'doi-changed',
                placeholder: '10.1038/nature09492',
                maxLength: 120,
              },
              {
                type: 'actions',
                items: [
                  { label: t(caps, '下载到手机', 'Download'), action: 'download', icon: 'download' },
                ],
              },
              { type: 'text', text: { $: 'data.downloadNote' }, tone: 'muted', style: { size: 'caption' } },
            ],
          },
        ],
      }),

      data: (scope, emit) => {
        pushPanel = (payload) => emit(payload)
        emit(panelData())
        return () => {
          pushPanel = null
        }
      },

      actions: {
        'query-changed': (scope, event) => {
          const value = changedValue(event)
          if (typeof value === 'string') state.query = value
          return {}
        },

        'source-changed': (scope, event) => {
          const value = changedValue(event)
          if (typeof value === 'string' && SOURCE_OPTIONS.includes(value)) state.source = value
          return {}
        },

        'doi-changed': (scope, event) => {
          const value = changedValue(event)
          if (typeof value === 'string') state.doiDraft = value
          return {}
        },

        // 搜索要几十秒，所以不等它跑完再回 App：先返回，状态靠面板数据更新。
        search: (scope, event) => {
          // 兜底：万一这次点按把输入框里的词一起送来了，就用它。
          const value = changedValue(event)
          if (typeof value === 'string' && value.trim() && !SOURCE_OPTIONS.includes(value.trim())) {
            state.query = value
          }
          void runSearch()
          return {}
        },

        clear: () => {
          state.results = []
          state.query = ''
          state.status = '已清空。'
          state.statusTone = 'info'
          state.hint = '填关键词或 DOI，点「搜索」。'
          push()
          return {}
        },

        // 点结果：把一句能发出去的话放进输入框，不自动发送。
        pick: (scope, event) => {
          const args = readArgs(event)
          const title = String(args.title ?? '').trim()
          const doi = String(args.doi ?? '').trim()
          const pmid = String(args.pmid ?? '').trim()
          const source = String(args.source ?? '')
          let text
          if (source === 'scihub') {
            text = `帮我下载这篇论文的 PDF 并总结要点：${title}（DOI: ${doi}）。\nPDF 存到 ${DOWNLOAD_DIR}/。`
          } else if (source === 'pubmed') {
            const id = pmid ? `PMID: ${pmid}` : ''
            const doiPart = doi ? `DOI: ${doi}` : ''
            text = `帮我查这篇论文的摘要和全文：${title}（${[id, doiPart].filter(Boolean).join('，')}）。`
          } else {
            text = `帮我查这篇论文的引用情况和开放获取版本：${title}（DOI: ${doi}）。`
          }
          return { insert: text.slice(0, 2000) }
        },

        download: (scope, event) => {
          const args = readArgs(event)
          const doi = String(args.doi ?? state.doiDraft ?? '').trim()
          if (!doi) {
            return { toast: t(null, '先填一个 DOI', 'Fill in a DOI first') }
          }
          void downloadPdf(doi, null)
          return { toast: t(null, '正在下载…', 'Downloading…') }
        },
      },
    })

    // 插件被卸掉时，把 MCP 子进程带走。
    ctx.on('dispose', () => {
      for (const instance of clients.values()) instance.stop()
      clients.clear()
    })
  })
}
