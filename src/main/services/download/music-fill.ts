import { createWriteStream } from 'fs'
import { stat, unlink } from 'fs/promises'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import { getSetting, type DbPost } from '../../database'
import { fetchVideoDetail } from '../douyin/client'
import { resolvePostFolder } from '../media'

export type FillMusicResult =
  | { status: 'filled' }
  | { status: 'no-music' }
  | { status: 'failed'; error: string }

/** 按 aweme_id 拉取原声并写入现有作品文件夹；不删记录、不动已有媒体文件 */
export async function fillPostMusic(post: DbPost): Promise<FillMusicResult> {
  const folderPath = resolvePostFolder(post.sec_uid, post.folder_name)
  if (!folderPath) return { status: 'failed', error: '作品文件夹不存在' }

  const cookie = getSetting('douyin_cookie') || ''
  if (!cookie) return { status: 'failed', error: '未配置抖音 Cookie' }

  let detail: { musicStatus?: number; musicPlayUrl?: string }
  try {
    detail = (await fetchVideoDetail(post.aweme_id)) as {
      musicStatus?: number
      musicPlayUrl?: string
    }
  } catch (error) {
    return { status: 'failed', error: (error as Error).message }
  }

  const musicUrl = detail.musicPlayUrl
  if (detail.musicStatus !== 1 || !musicUrl) return { status: 'no-music' }

  const targetPath = join(folderPath, `${post.aweme_id}_music.mp3`)
  try {
    const response = await fetch(musicUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: 'https://www.douyin.com/',
        Cookie: cookie
      }
    })
    if (!response.ok || !response.body) {
      return { status: 'failed', error: `音频下载失败（HTTP ${response.status}）` }
    }
    await pipeline(response.body as unknown as NodeJS.ReadableStream, createWriteStream(targetPath))
    const { size } = await stat(targetPath)
    if (size === 0) {
      await unlink(targetPath).catch(() => {})
      return { status: 'failed', error: '音频文件为空' }
    }
    return { status: 'filled' }
  } catch (error) {
    await unlink(targetPath).catch(() => {})
    return { status: 'failed', error: (error as Error).message }
  }
}
