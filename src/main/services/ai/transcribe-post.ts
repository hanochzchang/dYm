import type { DbPost } from '../../database'
import { getPostTranscript, savePostTranscript } from '../../database'
import type { AnalysisStage, TranscriptSegment } from '../../../shared/analysis'
import { probeMedia } from './ffmpeg'
import { findVideoFile } from './frames'
import type { AnalysisWindow } from './plan'
import {
  asrEngineKey,
  transcribeWindow,
  transcriptText,
  type AsrClient,
  type ResolvedAsrProvider
} from './asr'
import type { RateLimiter } from './rate-limit'

/**
 * 「只转写」作业的单条执行：探测 → 按固定时长切块转写 → 落库。
 * 不抽帧、不调 AI、不写标签，所以不依赖 AI 提供方。
 * 覆盖范围按时间记在 post_transcripts.coverage 里，之后正式分析同引擎同模型时可直接复用。
 */

export interface TranscribePostOptions {
  client: AsrClient
  provider: ResolvedAsrProvider
  limiter: RateLimiter
  signal: AbortSignal
  language?: string
  onStage?: (stage: AnalysisStage, detail?: string) => void
}

export interface TranscribePostResult {
  /** 没有可做的工作时给出原因（图集 / 无音轨 / 已有完整转写） */
  skipped: string | null
  windows: number
  newWindows: number
  segments: number
}

/** 切块长度：太长会让单次转写占用过多内存，太短则本地模型反复加载 */
const CHUNK_SECONDS = 600

function buildChunks(duration: number): AnalysisWindow[] {
  const chunks: AnalysisWindow[] = []
  for (let start = 0, index = 0; start < duration - 0.5; start += CHUNK_SECONDS, index++) {
    chunks.push({ index, start, end: Math.min(duration, start + CHUNK_SECONDS) })
  }
  return chunks.length ? chunks : [{ index: 0, start: 0, end: duration }]
}

function covers(coverage: { start: number; end: number }[], chunk: AnalysisWindow): boolean {
  return coverage.some((c) => c.start <= chunk.start + 0.5 && c.end >= chunk.end - 0.5)
}

/** 合并重叠区间，避免多次部分转写后 coverage 里堆一堆碎块 */
function mergeCoverage(ranges: { start: number; end: number }[]): { start: number; end: number }[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const out: { start: number; end: number }[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end + 0.5) last.end = Math.max(last.end, r.end)
    else out.push({ ...r })
  }
  return out
}

export async function transcribePost(
  post: DbPost,
  options: TranscribePostOptions
): Promise<TranscribePostResult> {
  if (post.aweme_type === 68) {
    return { skipped: '图集没有音轨', windows: 0, newWindows: 0, segments: 0 }
  }

  options.onStage?.('probe')
  const videoPath = findVideoFile(post)
  const info = await probeMedia(videoPath)
  if (!info.hasAudio) {
    return { skipped: '视频没有音轨', windows: 0, newWindows: 0, segments: 0 }
  }

  const engine = asrEngineKey(options.provider)
  const existing = getPostTranscript(post.id)
  const reusable = existing && existing.engine === engine ? existing : null
  const chunks = buildChunks(info.duration)

  const newSegments: TranscriptSegment[] = []
  const newCoverage: { start: number; end: number }[] = []
  let language: string | null = null

  for (const chunk of chunks) {
    options.signal.throwIfAborted()
    if (reusable && covers(reusable.coverage, chunk)) continue
    options.onStage?.('transcribe', `${chunk.index + 1}/${chunks.length}`)
    const result = await transcribeWindow(videoPath, chunk, {
      client: options.client,
      provider: options.provider,
      limiter: options.limiter,
      signal: options.signal,
      language: options.language
    })
    newSegments.push(...result.segments)
    newCoverage.push({ start: chunk.start, end: chunk.end })
    language = language ?? result.language
  }

  if (!newCoverage.length) {
    return {
      skipped: '已有完整转写',
      windows: chunks.length,
      newWindows: 0,
      segments: reusable?.segments.length ?? 0
    }
  }

  const coverage = mergeCoverage([...(reusable?.coverage ?? []), ...newCoverage])
  const segments = [...(reusable?.segments ?? []), ...newSegments].sort(
    (a, b) => a.start - b.start
  )
  const partial = chunks.some((c) => !covers(coverage, c))

  options.onStage?.('save')
  savePostTranscript({
    postId: post.id,
    engine,
    language: language ?? existing?.language ?? null,
    partial,
    coverage,
    segments,
    text: transcriptText(segments)
  })

  return {
    skipped: null,
    windows: chunks.length,
    newWindows: newCoverage.length,
    segments: segments.length
  }
}
