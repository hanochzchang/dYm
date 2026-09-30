import { getDatabase } from './connection'
import { replacePostTags } from './tags'
import { applyAnalysisOverride } from '../../shared/analysis'
import type {
  AnalysisOverride,
  AnalysisRunMeta,
  PostAnalysisDetail,
  PostTranscript,
  VideoAnalysis
} from '../../shared/analysis'

/**
 * 结构化分析结果（schema v2）的读写。
 * 写入时同步映射回 posts.analysis_* 扁平列，老的列表 / 筛选 / 脚本 API 不用改就能继续用。
 */

interface AnalysisRow {
  post_id: number
  schema_version: number
  prompt_version: string
  model: string | null
  asr_engine: string | null
  result: string
  meta: string
  created_at: number
}

interface TranscriptRow {
  post_id: number
  engine: string
  language: string | null
  partial: number
  coverage: string
  segments: string
  text: string
}

/** v2 结果映射到旧扁平字段：标签名、主分类、地点、摘要、评分 */
export function legacyFieldsOf(analysis: VideoAnalysis): {
  tags: string[]
  category: string
  scene: string
  summary: string
  content_level: number
} {
  return {
    tags: analysis.tags.map((t) => t.name),
    category: analysis.category.primary,
    scene: analysis.setting.place || analysis.setting.location,
    summary: analysis.summary,
    content_level: analysis.rating.level
  }
}

export function savePostAnalysisV2(
  postId: number,
  analysis: VideoAnalysis,
  meta: AnalysisRunMeta,
  options: { tagMode: 'open' | 'closed'; raw?: string | null }
): string[] {
  const database = getDatabase()
  return database.transaction(() => {
    const details = new Map<string, { facet: string; confidence: number }>()
    for (const tag of analysis.tags) {
      details.set(tag.name, { facet: tag.facet, confidence: tag.confidence })
    }
    const kept = replacePostTags(
      postId,
      'ai',
      analysis.tags.map((t) => t.name),
      options.tagMode,
      details
    )
    // closed 模式下没匹配上的标签不算失败：整片摘要、评分等仍然有价值，照常落库。
    // 扁平列要按「盖上人工修订后」的结果写，否则重新分析会把用户改过的摘要/分类冲掉
    const manual = readAnalysisOverride(postId)
    const legacy = legacyFieldsOf(manual ? applyAnalysisOverride(analysis, manual) : analysis)
    database
      .prepare(
        `UPDATE posts SET
           analysis_category = ?, analysis_summary = ?, analysis_scene = ?, analysis_content_level = ?,
           analysis_raw = ?, analysis_model = ?, analyzed_at = strftime('%s', 'now')
         WHERE id = ?`
      )
      .run(
        legacy.category,
        legacy.summary,
        legacy.scene,
        legacy.content_level,
        options.raw ?? null,
        meta.model,
        postId
      )
    database
      .prepare(
        `INSERT INTO post_analysis (post_id, schema_version, prompt_version, model, asr_engine, result, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
         ON CONFLICT(post_id) DO UPDATE SET
           schema_version = excluded.schema_version, prompt_version = excluded.prompt_version,
           model = excluded.model, asr_engine = excluded.asr_engine, result = excluded.result,
           meta = excluded.meta, created_at = excluded.created_at`
      )
      .run(
        postId,
        analysis.schemaVersion,
        meta.promptVersion,
        meta.model,
        meta.asrEngine,
        JSON.stringify(analysis),
        JSON.stringify(meta)
      )
    database.prepare('DELETE FROM post_chapters WHERE post_id = ?').run(postId)
    const insertChapter = database.prepare(
      `INSERT INTO post_chapters (post_id, start_sec, end_sec, title, summary, tags) VALUES (?, ?, ?, ?, ?, ?)`
    )
    for (const chapter of analysis.chapters) {
      insertChapter.run(
        postId,
        chapter.start,
        chapter.end,
        chapter.title,
        chapter.summary,
        JSON.stringify(chapter.tags)
      )
    }
    return kept
  })()
}

export function savePostTranscript(transcript: PostTranscript): void {
  getDatabase()
    .prepare(
      `INSERT INTO post_transcripts (post_id, engine, language, partial, coverage, segments, text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
       ON CONFLICT(post_id) DO UPDATE SET
         engine = excluded.engine, language = excluded.language, partial = excluded.partial,
         coverage = excluded.coverage, segments = excluded.segments, text = excluded.text,
         created_at = excluded.created_at`
    )
    .run(
      transcript.postId,
      transcript.engine,
      transcript.language,
      transcript.partial ? 1 : 0,
      JSON.stringify(transcript.coverage),
      JSON.stringify(transcript.segments),
      transcript.text
    )
}

export function getPostTranscript(postId: number): PostTranscript | null {
  const row = getDatabase()
    .prepare('SELECT * FROM post_transcripts WHERE post_id = ?')
    .get(postId) as TranscriptRow | undefined
  if (!row) return null
  return {
    postId: row.post_id,
    engine: row.engine,
    language: row.language,
    partial: row.partial === 1,
    coverage: safeParse(row.coverage, []),
    segments: safeParse(row.segments, []),
    text: row.text
  }
}

export function getPostAnalysisDetail(postId: number): PostAnalysisDetail {
  const row = getDatabase().prepare('SELECT * FROM post_analysis WHERE post_id = ?').get(postId) as
    | AnalysisRow
    | undefined
  const ai = row ? safeParse<VideoAnalysis | null>(row.result, null) : null
  const meta = row
    ? { ...safeParse<AnalysisRunMeta>(row.meta, {} as AnalysisRunMeta), createdAt: row.created_at }
    : null
  const manual = readAnalysisOverride(postId)
  return {
    analysis: ai && manual ? applyAnalysisOverride(ai, manual) : ai,
    ai,
    manual,
    meta,
    transcript: getPostTranscript(postId)
  }
}

/** 人工修订存在 posts.manual_analysis 里（JSON）；空对象等同没改过 */
function readAnalysisOverride(postId: number): AnalysisOverride | null {
  const row = getDatabase()
    .prepare('SELECT manual_analysis FROM posts WHERE id = ?')
    .get(postId) as { manual_analysis: string | null } | undefined
  if (!row?.manual_analysis) return null
  const parsed = safeParse<AnalysisOverride | null>(row.manual_analysis, null)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return Object.keys(parsed).length > 0 ? parsed : null
}

/** 写人工修订（传 null 或空对象即清回 AI 原值），并同步扁平列 */
export function setPostAnalysisOverride(postId: number, override: AnalysisOverride | null): void {
  const clean = override && Object.keys(override).length > 0 ? override : null
  getDatabase()
    .prepare('UPDATE posts SET manual_analysis = ? WHERE id = ?')
    .run(clean ? JSON.stringify(clean) : null, postId)
  syncLegacyColumns(postId)
}

/**
 * 把「AI + 人工修订」的合并结果写回 posts 的扁平列。
 * 只同步摘要 / 分类 / 场景 —— 这些是列表与分面筛选取值的地方；
 * 评分走 manual_content_level 那套，不在这里动。
 */
function syncLegacyColumns(postId: number): void {
  const database = getDatabase()
  const row = database.prepare('SELECT result FROM post_analysis WHERE post_id = ?').get(postId) as
    | { result: string }
    | undefined
  const ai = row ? safeParse<VideoAnalysis | null>(row.result, null) : null
  if (!ai) return
  const manual = readAnalysisOverride(postId)
  const legacy = legacyFieldsOf(manual ? applyAnalysisOverride(ai, manual) : ai)
  database
    .prepare('UPDATE posts SET analysis_category = ?, analysis_scene = ?, analysis_summary = ? WHERE id = ?')
    .run(legacy.category, legacy.scene, legacy.summary, postId)
}

/** 更新媒体元数据列（探测一次就够，下次分析直接复用） */
export function savePostMediaInfo(
  postId: number,
  info: { duration: number; width: number; height: number; hasAudio: boolean }
): void {
  getDatabase()
    .prepare('UPDATE posts SET duration = ?, width = ?, height = ?, has_audio = ? WHERE id = ?')
    .run(info.duration, info.width, info.height, info.hasAudio ? 1 : 0, postId)
}

/** 字幕全文检索：返回命中的作品 id 与片段高亮 */
export function searchTranscripts(
  keyword: string,
  limit = 50
): { postId: number; snippet: string }[] {
  const q = keyword.trim()
  if (!q) return []
  const database = getDatabase()
  // trigram 分词要求查询词至少 3 个字符，更短的直接 LIKE
  if ([...q].length < 3) {
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
    return database
      .prepare(
        `SELECT post_id AS postId, substr(text, max(1, instr(text, ?) - 12), 40) AS snippet
         FROM post_transcripts WHERE text LIKE ? ESCAPE '\\' LIMIT ?`
      )
      .all(q, like, limit) as { postId: number; snippet: string }[]
  }
  // 用短语查询避免用户输入里的 fts 语法字符（* " -）被当成操作符
  const phrase = `"${q.replace(/"/g, '""')}"`
  try {
    return (
      database
        .prepare(
          `SELECT rowid AS postId, snippet(post_transcripts_fts, 0, '[', ']', '…', 12) AS snippet
           FROM post_transcripts_fts WHERE post_transcripts_fts MATCH ? ORDER BY rank LIMIT ?`
        )
        .all(phrase, limit) as { postId: number; snippet: string }[]
    ).map((r) => ({ postId: r.postId, snippet: r.snippet }))
  } catch (error) {
    console.warn('[AI] 字幕检索失败:', (error as Error).message)
    return []
  }
}

function safeParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T
  } catch {
    return fallback
  }
}
