/**
 * 小红书笔记解析：从分享文案里抠链接 → 抓页面 → 把注入的 window.__INITIAL_STATE__ 解析出来。
 *
 * 传输层用 Electron 主进程的 net.fetch（Chromium 网络栈）。小红书拦截的是 TLS 指纹，
 * 不是登录——用 Python urllib / headless Chrome 会被打到「安全限制」页，net.fetch 不会，
 * 且不需要任何 cookie、登录或 UA 伪装。
 *
 * 注入的 state 不是合法 JSON：含裸 `undefined` 和 `new Map([])`，直接 JSON.parse 会失败，
 * 所以要先做「字符串感知」的清洗再解析。别用朴素 String.replace——正文/标题里可能就有
 * 同名字串，会被改坏；也别上 YAML（js-yaml 只是传递依赖，不进生产包）。
 */

import { net } from 'electron'

const FETCH_TIMEOUT_MS = 15_000

export interface ParsedNoteImage {
  /** 图片 token，优先用它重建地址（urlDefault 里带会过期的签名日期路径） */
  fileId?: string
  urlDefault?: string
}

export interface ParsedNote {
  noteId: string
  title: string
  desc: string
  nickname: string
  userId: string
  tags: string[]
  images: ParsedNoteImage[]
  isVideo: boolean
  /** 发布时间（毫秒） */
  createMs: number | null
}

/** 从分享文案里抠出第一个 http(s) 链接，并去掉尾部的中英文标点 */
export function extractUrl(raw: string): string | null {
  const matched = raw.match(/https?:\/\/[^\s]+/i)
  if (!matched) return null
  const cleaned = matched[0].replace(/[)\]}>）】」』》〕］，。、；；！？…"'‘’“”]+$/u, '')
  return cleaned || null
}

/** 抓笔记页面 HTML；net.fetch 默认跟随跳转，所以 xhslink.com 短链也能直接到这里 */
export async function fetchStateHtml(url: string): Promise<string> {
  let res: Response
  try {
    res = await net.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  } catch {
    throw new Error('请求失败，请检查网络后重试')
  }
  if (!res.ok) throw new Error(`请求失败（HTTP ${res.status}）`)
  return res.text()
}

/** 定位并抠出 `window.__INITIAL_STATE__ = {...}` 里配平的对象字面量（字符串感知的括号扫描） */
function extractLiteral(html: string): string | null {
  const marker = 'window.__INITIAL_STATE__'
  const at = html.indexOf(marker)
  if (at < 0) return null
  const start = html.indexOf('{', at + marker.length)
  if (start < 0) return null
  let depth = 0
  let inString = false
  for (let i = start; i < html.length; i++) {
    const c = html[i]
    if (inString) {
      if (c === '\\') {
        i++
        continue
      }
      if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      continue
    }
    if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') {
      depth--
      if (depth === 0) return html.slice(start, i + 1)
    }
  }
  return null
}

const IDENT_CHAR = /[A-Za-z0-9_$]/

function boundaryBefore(text: string, i: number): boolean {
  return i === 0 || !IDENT_CHAR.test(text[i - 1])
}

function boundaryAfter(text: string, i: number, len: number): boolean {
  const j = i + len
  return j >= text.length || !IDENT_CHAR.test(text[j])
}

/** 只在字符串外做替换：裸 undefined→null、new Map([])→[]、尾逗号删除、控制字符清除 */
function sanitize(literal: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < literal.length; i++) {
    const c = literal[i]
    const code = literal.charCodeAt(i)
    if (inString) {
      if (c === '\\') {
        out += c + (literal[i + 1] ?? '')
        i++
        continue
      }
      if (c === '"') inString = false
    } else {
      if (c === '"') {
        inString = true
        out += c
        continue
      }
      if (c === ',') {
        let j = i + 1
        while (j < literal.length && /\s/.test(literal[j])) j++
        // 尾逗号：JSON 不允许
        if (literal[j] === '}' || literal[j] === ']') continue
      } else if (
        literal.startsWith('undefined', i) &&
        boundaryBefore(literal, i) &&
        boundaryAfter(literal, i, 9)
      ) {
        out += 'null'
        i += 8
        continue
      } else if (literal.startsWith('new Map([])', i)) {
        out += '[]'
        i += 9
        continue
      } else if (
        literal.startsWith('Infinity', i) &&
        boundaryBefore(literal, i) &&
        boundaryAfter(literal, i, 8)
      ) {
        out += 'null'
        i += 7
        continue
      } else if (literal.startsWith('-Infinity', i) && boundaryBefore(literal, i)) {
        out += 'null'
        i += 8
        continue
      } else if (
        literal.startsWith('NaN', i) &&
        boundaryBefore(literal, i) &&
        boundaryAfter(literal, i, 3)
      ) {
        out += 'null'
        i += 2
        continue
      }
    }
    // JSON 字符串里不允许的裸控制字符（\t \n \r 除外）一律丢掉
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue
    out += c
  }
  return out
}

/** 兼容 PC（note.noteDetailMap[*].note）和手机（noteData.data.noteData）两种形状 */
function pickNote(root: unknown): Record<string, unknown> | null {
  const map = (root as { note?: { noteDetailMap?: unknown } })?.note?.noteDetailMap
  if (map && typeof map === 'object') {
    for (const value of Object.values(map as Record<string, unknown>)) {
      const note = (value as { note?: Record<string, unknown> })?.note
      if (note) return note
    }
  }
  const phone = (root as { noteData?: { data?: { noteData?: Record<string, unknown> } } })?.noteData
    ?.data?.noteData
  return phone ?? null
}

export function parseInitialState(html: string): ParsedNote {
  const literal = extractLiteral(html)
  if (!literal) throw new Error('笔记数据结构解析失败（小红书可能已改版）')

  let root: unknown
  try {
    root = JSON.parse(sanitize(literal))
  } catch {
    throw new Error('笔记数据结构解析失败（小红书可能已改版）')
  }

  const note = pickNote(root)
  if (!note) throw new Error('链接已失效或授权过期，请在 App 里重新分享后再粘贴')

  const rawImages = Array.isArray(note.imageList) ? (note.imageList as unknown[]) : []
  const images: ParsedNoteImage[] = rawImages.map((item) => {
    const it = item as { fileId?: unknown; urlDefault?: unknown }
    return {
      fileId: typeof it?.fileId === 'string' ? it.fileId : undefined,
      urlDefault: typeof it?.urlDefault === 'string' ? it.urlDefault : undefined
    }
  })

  const type = typeof note.type === 'string' ? note.type : ''
  const isVideo = type === 'video'
  // 视频笔记只带一张封面；图文却没有图 = 链接失效
  if (!isVideo && images.length === 0) {
    throw new Error('链接已失效或授权过期，请在 App 里重新分享后再粘贴')
  }

  const user = (note.user ?? {}) as { nickname?: unknown; nickName?: unknown; userId?: unknown }
  const rawTags = Array.isArray(note.tagList) ? (note.tagList as unknown[]) : []

  return {
    noteId: note.noteId != null ? String(note.noteId) : '',
    title: typeof note.title === 'string' ? note.title : '',
    desc: typeof note.desc === 'string' ? note.desc : '',
    nickname: String(user.nickname ?? user.nickName ?? '').trim(),
    userId: String(user.userId ?? '').trim(),
    tags: rawTags
      .map((t) => (t as { name?: unknown })?.name)
      .filter((n): n is string => typeof n === 'string' && n.trim().length > 0),
    images,
    isVideo,
    createMs: typeof note.time === 'number' ? note.time : null
  }
}
