import { getDatabase } from './connection'

/**
 * 作者可见性判据的唯一出处。
 *
 * 物理字段仍叫 users.show_in_home（沿用旧名，因为脚本 API 契约里已经公开了它），
 * 但语义已经扩大成「该作者是否隐藏」：0 = 隐藏，其作品在所有展示面都不出现。
 *
 * 所有「列作品 / 统计作品 / 列作者」的查询都必须带上门禁，漏一处就等于没藏住，
 * 而且漏了不会有任何报错。新增这类查询时记得从这里取条件。
 */

export const VISIBLE_SEC_UIDS = '(SELECT sec_uid FROM users WHERE show_in_home = 1)'

/**
 * 作品表的门禁。column 传带表别名的列（tags.ts 里是 'posts.sec_uid'）。
 * unaryPlus 对应 posts.ts 里那个 `+sec_uid`：一元加号让 SQLite 别选 idx_posts_sec_uid
 * 再全表临时排序，而是沿排序列索引扫到 LIMIT 即停（3 万条时首页 11ms → <1ms）。
 */
export function visibleSecUidGate(column = 'sec_uid', unaryPlus = false): string {
  return `${unaryPlus ? '+' : ''}${column} IN ${VISIBLE_SEC_UIDS}`
}

/** users 表自己的门禁（LEFT JOIN posts 统计作者时用） */
export const VISIBLE_USERS = 'show_in_home = 1'

/**
 * 这个作者现在是否可见。users 里没有对应行时按**不可见**处理 ——
 * 与上面子查询的口径保持一致（列表里本来也扫不到孤儿作品）。
 */
export function isAuthorVisible(secUid: string): boolean {
  const row = getDatabase()
    .prepare(`SELECT 1 AS ok FROM users WHERE sec_uid = ? AND ${VISIBLE_USERS} LIMIT 1`)
    .get(secUid) as { ok: number } | undefined
  return row !== undefined
}
