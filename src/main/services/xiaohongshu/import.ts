/**
 * 小红书图文导入：分享链接 → 下载图片到临时目录 → 复用本地导入流水线入库。
 *
 * 复用的两条缝：importLocalMedia（把文件复制到下载根、合成作者、写库、按内容哈希去重）
 * 和 addTagsToPosts（追加手动标签）。标题正文塞进 desc 即可显示与搜索，
 * 所以除「作者按 userId 区分」外不需要改任何现有代码。
 */

import { app } from 'electron'
import { randomUUID } from 'crypto'
import { mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { addTagsToPosts } from '../../database'
import { importLocalMedia } from '../import/local-import'
import { downloadImages, toImageUrl } from './image'
import { extractUrl, fetchStateHtml, parseInitialState } from './parse'

export interface XiaohongshuImportResult {
  ok: boolean
  /** true = 库里已有同一份内容，没有重复导入 */
  skipped?: boolean
  postId?: number
  imageCount?: number
  /** 失败原因（中文，直接展示给用户） */
  error?: string
}

/** 分享文案里的 `#xxx[话题]#` 是小红书的标签噪声，进正文前去掉 */
const TAG_NOISE = /#[^#[\]\s]+\[话题\]#/g

/** 毫秒时间戳 → 北京时间墙钟 `YYYY-MM-DDTHH:mm`（与 datetime-local 同形） */
function beijingLocal(ms: number): string {
  const d = new Date(ms + 8 * 3600_000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

function buildDesc(title: string, body: string): string {
  const cleanTitle = title.trim()
  const cleanBody = body.replace(TAG_NOISE, '').trim()
  if (cleanTitle && cleanBody) return `${cleanTitle}\n\n${cleanBody}`
  return cleanTitle || cleanBody
}

async function removeTempDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true })
  } catch {
    // 临时目录清理失败不阻断导入
  }
}

/**
 * 返回结果对象而不是抛异常：Electron 会给 rejected 的 IPC 加
 * `Error invoking remote method 'xiaohongshu:import'` 前缀，返回对象才能给用户干净的中文提示。
 */
export async function importXiaohongshu(raw: string): Promise<XiaohongshuImportResult> {
  const dir = join(app.getPath('temp'), 'dym-xhs', randomUUID())
  try {
    const url = extractUrl(raw)
    if (!url) return { ok: false, error: '请粘贴完整的小红书笔记分享链接' }

    const html = await fetchStateHtml(url)
    const note = parseInitialState(html)
    if (note.isVideo) return { ok: false, error: '暂不支持视频笔记，仅支持图文' }

    const urls = note.images.map(toImageUrl)
    if (urls.some((u) => !u)) return { ok: false, error: '图片下载失败，请重试' }

    await mkdir(dir, { recursive: true })
    const paths = await downloadImages(urls as string[], dir)

    const result = await importLocalMedia({
      kind: 'images',
      paths,
      desc: buildDesc(note.title, note.desc) || undefined,
      authorName: note.nickname || undefined,
      authorKey: note.userId || undefined,
      createTime: note.createMs != null ? beijingLocal(note.createMs) : undefined
    })

    if (!result.skipped && result.postId != null && note.tags.length > 0) {
      const tags = note.tags.map((t) => t.replace(/^#+/, '').trim()).filter(Boolean)
      if (tags.length > 0) addTagsToPosts([result.postId], tags)
    }

    return {
      ok: true,
      skipped: result.skipped,
      postId: result.postId,
      imageCount: paths.length
    }
  } catch (error) {
    return { ok: false, error: (error as Error).message || '导入失败' }
  } finally {
    await removeTempDir(dir)
  }
}
