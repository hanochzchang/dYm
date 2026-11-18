/**
 * 小红书图片地址重建与下载。
 *
 * urlDefault 里带会过期的签名日期路径，所以优先用 imageList 上的 fileId（= 图片 token）
 * 重建成稳定地址；只在没有 fileId 时才从 urlDefault 里抠 token（对同一个文件，两条路
 * 得到的 token 相同）。下载同样走主进程 net.fetch。
 */

import { net } from 'electron'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import type { ParsedNoteImage } from './parse'

const DOWNLOAD_TIMEOUT_MS = 30_000

function extractToken(url?: string): string | null {
  if (!url) return null
  const segment = url.split('!')[0].split('?')[0].split('/').filter(Boolean).pop()
  return segment && segment.length > 0 ? segment : null
}

/** 单张图 → 稳定的 CDN 地址；拿不到 token 返回 null */
export function toImageUrl(raw: ParsedNoteImage): string | null {
  const token = raw.fileId?.trim() || extractToken(raw.urlDefault)
  if (!token) return null
  return `https://ci.xiaohongshu.com/${token}?imageView2/format/jpeg`
}

/**
 * 依次下载到 dir，命名成补零的 `001.jpg`…（importLocalMedia 按字符串排序取图序）。
 * 任一张失败即整体失败——不导入半套图集。
 */
export async function downloadImages(urls: string[], dir: string): Promise<string[]> {
  const paths: string[] = []
  for (let i = 0; i < urls.length; i++) {
    const file = join(dir, `${String(i + 1).padStart(3, '0')}.jpg`)
    let res: Response
    try {
      res = await net.fetch(urls[i], { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    } catch {
      throw new Error('图片下载失败，请重试')
    }
    if (!res.ok) throw new Error('图片下载失败，请重试')
    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.length === 0) throw new Error('图片下载失败，请重试')
    await writeFile(file, buffer)
    paths.push(file)
  }
  return paths
}
