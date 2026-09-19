import { join, sep } from 'path'
import { existsSync, readFileSync } from 'fs'
import { getDatabase } from './connection'
import { replacePostTags, tagKeywordSql, tagMatchSql } from './tags'

// Post CRUD
export interface DbPost {
  id: number
  aweme_id: string
  user_id: number
  sec_uid: string
  nickname: string
  caption: string
  desc: string
  aweme_type: number
  create_time: string
  folder_name: string
  cover_path: string | null
  video_path: string | null
  music_path: string | null
  downloaded_at: number
  // 分析结果
  analysis_tags: string | null
  analysis_category: string | null
  analysis_summary: string | null
  analysis_scene: string | null
  analysis_content_level: number | null
  analyzed_at: number | null
  // 手动添加的标签（JSON 字符串数组，与 analysis_tags 同格式）
  manual_tags: string | null
  // 模型原始输出（JSON 文本）与所用模型
  analysis_raw: string | null
  analysis_model: string | null
}

export interface CreatePostInput {
  aweme_id: string
  user_id: number
  sec_uid: string
  nickname?: string
  caption?: string
  desc?: string
  aweme_type?: number
  create_time?: string
  folder_name: string
  cover_path?: string
  video_path?: string
  music_path?: string
}

export function createPost(input: CreatePostInput): DbPost {
  const database = getDatabase()
  const stmt = database.prepare(`
    INSERT INTO posts (aweme_id, user_id, sec_uid, nickname, caption, desc, aweme_type, create_time, folder_name, cover_path, video_path, music_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const result = stmt.run(
    input.aweme_id,
    input.user_id,
    input.sec_uid,
    input.nickname || '',
    input.caption || '',
    input.desc || '',
    input.aweme_type || 0,
    input.create_time || '',
    input.folder_name,
    input.cover_path || null,
    input.video_path || null,
    input.music_path || null
  )
  return getPostById(result.lastInsertRowid as number)!
}

export function getPostById(id: number): DbPost | undefined {
  const database = getDatabase()
  return database.prepare('SELECT * FROM posts WHERE id = ?').get(id) as DbPost | undefined
}

export function getPostByAwemeId(awemeId: string): DbPost | undefined {
  const database = getDatabase()
  return database.prepare('SELECT * FROM posts WHERE aweme_id = ?').get(awemeId) as
    | DbPost
    | undefined
}

export function getPostsByUserId(
  userId: number,
  page = 1,
  pageSize = 50,
  sort?: PostSortConfig
): { posts: DbPost[]; total: number } {
  const database = getDatabase()
  const offset = (page - 1) * pageSize
  const posts = database
    .prepare(`SELECT * FROM posts WHERE user_id = ? ${buildOrderBy(sort)} LIMIT ? OFFSET ?`)
    .all(userId, pageSize, offset) as DbPost[]
  const row = database
    .prepare('SELECT COUNT(*) as count FROM posts WHERE user_id = ?')
    .get(userId) as { count: number }
  return { posts, total: row.count }
}

export function getPostCountByUserId(userId: number): number {
  const database = getDatabase()
  const row = database
    .prepare('SELECT COUNT(*) as count FROM posts WHERE user_id = ?')
    .get(userId) as { count: number }
  return row.count
}

// ========== 标题修复 ==========
// polydl 返回的 desc 已被转义（特殊字符变下划线），但会额外写一份
// {aweme_id}_desc.txt 保存原始文案。历史数据可据此回填修复。

function readDescFromFile(folderPath: string | null, awemeId: string): string | null {
  if (!folderPath) return null
  try {
    const descPath = join(folderPath, `${awemeId}_desc.txt`)
    if (existsSync(descPath)) {
      return readFileSync(descPath, 'utf-8').trim()
    }
  } catch (error) {
    console.warn(`[DB] Failed to read desc file for ${awemeId}:`, error)
  }
  return null
}

export function fixAllPostTitles(): { fixed: number; skipped: number; failed: number } {
  const database = getDatabase()
  const posts = database.prepare('SELECT id, aweme_id, video_path, desc FROM posts').all() as Pick<
    DbPost,
    'id' | 'aweme_id' | 'video_path' | 'desc'
  >[]

  let fixed = 0
  let skipped = 0
  let failed = 0

  const updateStmt = database.prepare('UPDATE posts SET desc = ? WHERE id = ?')

  // 全量回填放在一个事务里：几千条 UPDATE 从逐条 fsync 变成一次提交，快一到两个数量级
  database.transaction(() => {
    for (const post of posts) {
      const original = readDescFromFile(post.video_path, post.aweme_id)
      if (original === null) {
        failed++
        continue
      }
      if (post.desc === original) {
        skipped++
        continue
      }
      try {
        updateStmt.run(original, post.id)
        fixed++
      } catch (error) {
        failed++
        console.error(`[DB] Failed to update post ${post.id}:`, error)
      }
    }
  })()

  console.log(`[DB] fixAllPostTitles: fixed=${fixed}, skipped=${skipped}, failed=${failed}`)
  return { fixed, skipped, failed }
}

export interface PostAuthor {
  sec_uid: string
  nickname: string
}

export interface PostFilters {
  secUid?: string
  tags?: string[]
  minContentLevel?: number
  maxContentLevel?: number
  analyzedOnly?: boolean
  keyword?: string
}

export type PostSortField =
  | 'create_time'
  | 'downloaded_at'
  | 'analyzed_at'
  | 'analysis_content_level'
  | 'random'

export interface PostSortConfig {
  field: PostSortField
  order: 'ASC' | 'DESC'
  /** field 为 random 时的洗牌种子；同一个种子翻页顺序恒定，换种子即重洗 */
  seed?: number
}

type SortableField = Exclude<PostSortField, 'random'>

// 白名单映射，避免 ORDER BY 注入
const SORT_COLUMNS: Record<SortableField, string> = {
  create_time: 'create_time',
  downloaded_at: 'downloaded_at',
  analyzed_at: 'analyzed_at',
  analysis_content_level: 'analysis_content_level'
}

// 认不出的字段一律回落发布时间。random 不走这里（它在 JS 里洗牌），
// 但运行期混进来的脏值也必须被挡住，所以查表结果为空就回落。
function sortColumn(field?: PostSortField): string {
  if (!field || field === 'random') return 'create_time'
  return SORT_COLUMNS[field] || 'create_time'
}

function buildOrderBy(sort?: PostSortConfig): string {
  const order = sort?.order === 'ASC' ? 'ASC' : 'DESC'
  // NULL 值始终排在最后，避免未分析作品挤占头部
  return `ORDER BY ${sortColumn(sort?.field)} ${order} NULLS LAST`
}

/**
 * 可播种的 PRNG（mulberry32）：同一个 seed 给出的序列完全相同，
 * 随机序翻页要靠这个才稳定 —— Math.random() 每次都不一样。
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 就地做一次 Fisher-Yates，与网页端原来的洗牌算法同款 */
function shuffleIds(ids: number[], seed: number): void {
  const random = mulberry32(seed)
  for (let i = ids.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    const tmp = ids[i]
    ids[i] = ids[j]
    ids[j] = tmp
  }
}

function hasVisibleUsers(): boolean {
  return Boolean(
    getDatabase().prepare('SELECT 1 AS ok FROM users WHERE show_in_home = 1 LIMIT 1').get()
  )
}

// 下拉以 users 当前昵称为准、一人一条。posts.nickname 是下载时的快照，
// 用户改名后同一 sec_uid 会冒出多个名字，DISTINCT(sec_uid, nickname)
// 会让筛选列表重复，find() 还可能显示成改名前的名字。
function listVisibleAuthors(): PostAuthor[] {
  return getDatabase()
    .prepare(
      `SELECT u.sec_uid, u.nickname
       FROM users u
       WHERE u.show_in_home = 1
         AND u.sec_uid != ''
         AND u.nickname IS NOT NULL AND u.nickname != ''
         AND EXISTS (SELECT 1 FROM posts p WHERE p.sec_uid = u.sec_uid)
       ORDER BY u.nickname`
    )
    .all() as PostAuthor[]
}

// 构建查询（子查询代替把全部 sec_uid 展开成 IN (?,?,…)，可见用户上千时会顶变量上限）。
// 一元 + 让规划器不要用 idx_posts_sec_uid 再全表临时排序，而是沿排序列索引扫到 LIMIT 即停：
// 3 万条时首页从 ~11ms 降到 <1ms
function buildPostWhere(filters?: PostFilters): { whereClause: string; params: unknown[] } {
  const conditions: string[] = [`+sec_uid IN (SELECT sec_uid FROM users WHERE show_in_home = 1)`]
  const params: unknown[] = []

  if (filters?.secUid) {
    conditions.push('sec_uid = ?')
    params.push(filters.secUid)
  }

  if (filters?.tags && filters.tags.length > 0) {
    // 标签命中 AI 或手动任一来源（走 post_tags 索引）
    conditions.push(`(${tagMatchSql(filters.tags, 'any', params)})`)
  }

  if (filters?.minContentLevel !== undefined) {
    conditions.push('analysis_content_level >= ?')
    params.push(filters.minContentLevel)
  }

  if (filters?.maxContentLevel !== undefined) {
    conditions.push('analysis_content_level <= ?')
    params.push(filters.maxContentLevel)
  }

  if (filters?.analyzedOnly) {
    conditions.push('analyzed_at IS NOT NULL')
  }

  if (filters?.keyword?.trim()) {
    // posts.nickname 存的是净化过的文件夹名（emoji/特殊字符被转义成下划线），
    // 故按真实作者名搜索时还需匹配 users.nickname。
    const keyword = `%${filters.keyword.trim()}%`
    params.push(keyword, keyword, keyword)
    const tagClause = tagKeywordSql(params, keyword)
    params.push(keyword)
    conditions.push(
      `(caption LIKE ? OR desc LIKE ? OR nickname LIKE ? OR ${tagClause}` +
        ' OR sec_uid IN (SELECT sec_uid FROM users WHERE nickname LIKE ?))'
    )
  }

  return { whereClause: `WHERE ${conditions.join(' AND ')}`, params }
}

/**
 * 随机序。SQL 里没有可播种的哈希，纯 ORDER BY RANDOM() 又是每查一次重掷一次，
 * OFFSET 翻页必然重复+漏行；所以在 JS 里按 seed 洗一遍过滤后的 id 列表。
 * 顺序只由 (seed, 过滤结果) 决定 —— 同一 seed 下第 N 页永远落在同一段，
 * 不用缓存整副牌，也不会随请求次数漂移。
 */
function getRandomPosts(
  page: number,
  pageSize: number,
  filters: PostFilters | undefined,
  rawSeed: number | undefined
): { posts: DbPost[]; total: number; authors: PostAuthor[] } {
  const database = getDatabase()
  const { whereClause, params } = buildPostWhere(filters)
  const authors = listVisibleAuthors()
  const nameBySec = new Map(authors.map((a) => [a.sec_uid, a.nickname]))

  const ids = (
    database
      .prepare(`SELECT id FROM posts ${whereClause} ORDER BY id`)
      .all(...params) as { id: number }[]
  ).map((row) => row.id)

  const seed = Number.isSafeInteger(rawSeed) ? Math.abs(rawSeed as number) : 0
  shuffleIds(ids, seed)

  const offset = (page - 1) * pageSize
  const window = ids.slice(offset, offset + pageSize)
  if (window.length === 0) return { posts: [], total: ids.length, authors }

  // IN 不带顺序，按洗好的 window 重新排一遍
  const placeholders = window.map(() => '?').join(',')
  const rows = database
    .prepare(`SELECT * FROM posts WHERE id IN (${placeholders})`)
    .all(...window) as DbPost[]
  const byId = new Map(rows.map((row) => [row.id, row]))

  const posts: DbPost[] = []
  for (const id of window) {
    const post = byId.get(id)
    if (!post) continue
    const current = nameBySec.get(post.sec_uid)
    posts.push(!current || current === post.nickname ? post : { ...post, nickname: current })
  }

  return { posts, total: ids.length, authors }
}

export function getAllPosts(
  page: number = 1,
  pageSize: number = 20,
  filters?: PostFilters,
  sort?: PostSortConfig
): { posts: DbPost[]; total: number; authors: PostAuthor[] } {
  // 随机序要在 JS 里洗牌，走另一条路径
  if (sort?.field === 'random') {
    return getRandomPosts(page, pageSize, filters, sort.seed)
  }

  const database = getDatabase()
  const offset = (page - 1) * pageSize

  if (!hasVisibleUsers()) {
    return { posts: [], total: 0, authors: [] }
  }

  const authors = listVisibleAuthors()
  const nameBySec = new Map(authors.map((a) => [a.sec_uid, a.nickname]))

  const { whereClause, params } = buildPostWhere(filters)

  const rows = database
    .prepare(`SELECT * FROM posts ${whereClause} ${buildOrderBy(sort)} LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset) as DbPost[]

  const countRow = database
    .prepare(`SELECT COUNT(*) as count FROM posts ${whereClause}`)
    .get(...params) as { count: number }

  const posts = rows.map((p) => {
    const current = nameBySec.get(p.sec_uid)
    if (!current || current === p.nickname) return p
    return { ...p, nickname: current }
  })

  return { posts, total: countRow.count, authors }
}

export function deletePost(id: number): DbPost | undefined {
  const database = getDatabase()
  const post = getPostById(id)
  if (!post) return undefined
  database.prepare('DELETE FROM posts WHERE id = ?').run(id)
  return post
}

export function deletePostsByUserId(userId: number): number {
  const database = getDatabase()
  const result = database.prepare('DELETE FROM posts WHERE user_id = ?').run(userId)
  return result.changes
}

export interface AnalysisResult {
  tags: string[]
  category: string
  summary: string
  scene: string
  content_level: number
  /** 模型原始输出（JSON 文本） */
  raw?: string
  model?: string
}

export function getUnanalyzedPostsCount(secUid?: string): number {
  const database = getDatabase()
  if (secUid) {
    const row = database
      .prepare('SELECT COUNT(*) as count FROM posts WHERE sec_uid = ? AND analyzed_at IS NULL')
      .get(secUid) as { count: number }
    return row.count
  }
  const row = database
    .prepare('SELECT COUNT(*) as count FROM posts WHERE analyzed_at IS NULL')
    .get() as { count: number }
  return row.count
}

export function getUnanalyzedPostsCountByUser(): {
  sec_uid: string
  nickname: string
  count: number
}[] {
  const database = getDatabase()
  return database
    .prepare(
      `
    SELECT sec_uid, nickname, COUNT(*) as count
    FROM posts
    WHERE analyzed_at IS NULL
    GROUP BY sec_uid
    ORDER BY count DESC
  `
    )
    .all() as { sec_uid: string; nickname: string; count: number }[]
}

export interface UserAnalysisStats {
  sec_uid: string
  nickname: string
  total: number
  analyzed: number
  unanalyzed: number
}

export function getUserAnalysisStats(): UserAnalysisStats[] {
  const database = getDatabase()

  // 所有用户一条聚合查询（分析页面不受 show_in_home 限制），避免每用户一次查询
  return database
    .prepare(
      `SELECT u.sec_uid, u.nickname,
         COUNT(p.id) as total,
         COALESCE(SUM(CASE WHEN p.analyzed_at IS NOT NULL THEN 1 ELSE 0 END), 0) as analyzed,
         COALESCE(SUM(CASE WHEN p.id IS NOT NULL AND p.analyzed_at IS NULL THEN 1 ELSE 0 END), 0) as unanalyzed
       FROM users u
       LEFT JOIN posts p ON p.sec_uid = u.sec_uid
       GROUP BY u.id
       ORDER BY u.nickname`
    )
    .all() as UserAnalysisStats[]
}

export function getTotalAnalysisStats(): { total: number; analyzed: number; unanalyzed: number } {
  const database = getDatabase()

  // 获取所有帖子的分析统计（分析页面不受 show_in_home 限制）
  const stats = database
    .prepare(
      `
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN analyzed_at IS NOT NULL THEN 1 ELSE 0 END) as analyzed,
        SUM(CASE WHEN analyzed_at IS NULL THEN 1 ELSE 0 END) as unanalyzed
      FROM posts
    `
    )
    .get() as { total: number; analyzed: number; unanalyzed: number }

  return stats || { total: 0, analyzed: 0, unanalyzed: 0 }
}

export function getUnanalyzedPosts(secUid?: string, limit?: number): DbPost[] {
  const database = getDatabase()
  let sql = 'SELECT * FROM posts WHERE analyzed_at IS NULL'
  const params: unknown[] = []

  if (secUid) {
    sql += ' AND sec_uid = ?'
    params.push(secUid)
  }

  sql += ' ORDER BY downloaded_at DESC'

  if (limit) {
    sql += ' LIMIT ?'
    params.push(limit)
  }

  return database.prepare(sql).all(...params) as DbPost[]
}

/**
 * 写入一次分析结果：标签进 post_tags（并回写 JSON 列），其余字段进 posts。
 * tagMode=closed 时只保留标签库里已有的标签。返回实际保留的标签。
 */
export function savePostAnalysis(
  id: number,
  result: AnalysisResult,
  tagMode: 'open' | 'closed' = 'open'
): string[] {
  const database = getDatabase()
  return database.transaction(() => {
    const kept = replacePostTags(id, 'ai', result.tags, tagMode)
    database
      .prepare(
        `UPDATE posts SET
           analysis_category = ?, analysis_summary = ?, analysis_scene = ?, analysis_content_level = ?,
           analysis_raw = ?, analysis_model = ?, analyzed_at = strftime('%s', 'now')
         WHERE id = ?`
      )
      .run(
        result.category,
        result.summary,
        result.scene,
        result.content_level,
        result.raw ?? null,
        result.model ?? null,
        id
      )
    return kept
  })()
}

/**
 * 封闭模式专用：先在事务里试写标签，一个都没匹配上则回滚，不改动 analyzed_at，返回 null。
 */
export function savePostAnalysisIfMatched(id: number, result: AnalysisResult): string[] | null {
  const database = getDatabase()
  try {
    return database.transaction(() => {
      const kept = savePostAnalysis(id, result, 'closed')
      if (kept.length === 0) throw new NoTagMatched()
      return kept
    })()
  } catch (error) {
    if (error instanceof NoTagMatched) return null
    throw error
  }
}

class NoTagMatched extends Error {}

// 标准化路径前缀（确保尾部有平台分隔符）。
// 库里的路径由 join() 生成，Windows 上是反斜杠；只补 '/' 会让 LIKE 永远不匹配，迁移变成静默空操作
function normalizeDirPrefix(p: string): string {
  return p.endsWith('/') || p.endsWith('\\') ? p : p + sep
}

// 获取需要迁移的帖子数量
export function getMigrationCount(oldBasePath: string): number {
  const prefix = normalizeDirPrefix(oldBasePath)
  const database = getDatabase()
  const row = database
    .prepare(`SELECT COUNT(*) as cnt FROM posts WHERE video_path LIKE ?`)
    .get(`${prefix}%`) as { cnt: number }
  return row.cnt
}

// 批量替换路径前缀
/**
 * 把 posts 里以 oldBasePath 开头的路径改成 newBasePath。
 * 传 secUids 时只改这些作者目录下的记录：迁移时哪些作者真正搬成功了就只改哪些，
 * 否则搬失败的作者在库里会指向一个不存在的新位置。
 */
export function batchReplacePaths(
  oldBasePath: string,
  newBasePath: string,
  secUids?: string[]
): number {
  const oldPrefix = normalizeDirPrefix(oldBasePath)
  const newPrefix = normalizeDirPrefix(newBasePath)
  const database = getDatabase()
  const len = oldPrefix.length + 1
  const stmt = database.prepare(
    `UPDATE posts SET
      video_path = CASE WHEN video_path LIKE ? THEN ? || substr(video_path, ?) ELSE video_path END,
      cover_path = CASE WHEN cover_path LIKE ? THEN ? || substr(cover_path, ?) ELSE cover_path END,
      music_path = CASE WHEN music_path LIKE ? THEN ? || substr(music_path, ?) ELSE music_path END
    WHERE video_path LIKE ? OR cover_path LIKE ? OR music_path LIKE ?`
  )
  const runFor = (like: string): number =>
    stmt.run(like, newPrefix, len, like, newPrefix, len, like, newPrefix, len, like, like, like)
      .changes

  if (!secUids) return runFor(`${oldPrefix}%`)
  if (secUids.length === 0) return 0
  return database.transaction(() =>
    secUids.reduce((sum, secUid) => sum + runFor(`${oldPrefix}${secUid}${sep}%`), 0)
  )()
}

// 获取需要迁移的不重复作者目录
export function getMigrationSecUids(oldBasePath: string): string[] {
  const prefix = normalizeDirPrefix(oldBasePath)
  const database = getDatabase()
  const rows = database
    .prepare(`SELECT DISTINCT video_path FROM posts WHERE video_path LIKE ?`)
    .all(`${prefix}%`) as { video_path: string }[]

  const secUids = new Set<string>()
  for (const row of rows) {
    const relative = row.video_path.slice(prefix.length)
    const slashIdx = relative.search(/[\\/]/)
    if (slashIdx > 0) {
      secUids.add(relative.slice(0, slashIdx))
    }
  }
  return [...secUids]
}

export function deletePostByAwemeId(awemeId: string): DbPost | undefined {
  const database = getDatabase()
  const post = getPostByAwemeId(awemeId)
  if (!post) return undefined
  database.prepare('DELETE FROM posts WHERE aweme_id = ?').run(awemeId)
  return post
}

export function getPostsByUserIdAll(userId: number): DbPost[] {
  const database = getDatabase()
  return database
    .prepare('SELECT * FROM posts WHERE user_id = ? ORDER BY downloaded_at DESC')
    .all(userId) as DbPost[]
}
