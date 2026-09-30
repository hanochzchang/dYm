/**
 * 「本地导入」作品与合成作者的标识。
 *
 * 导入的作品在抖音上并不存在，凡是拿 aweme_id / sec_uid 回抖音求数据的入口
 * （重新下载、刷新作者、同步…）对它都会失败甚至造成破坏。主进程写入与守卫、
 * 渲染端隐藏按钮共用这一份判据，避免两处各写一遍字符串。
 *
 * 真实抖音的作品 ID 是纯数字、作者 sec_uid 是 `MS4wLjABAAAA...`，都不会撞上这两个前缀。
 */

/** 导入作品 aweme_id 的前缀 */
export const LOCAL_AWEME_PREFIX = 'local-'

/** 合成作者的 sec_uid 前缀。没填作者名时就用它本身，「本地导入」这个作者 */
export const LOCAL_IMPORT_SEC_UID = 'local-import'

export function isLocalAwemeId(awemeId?: string | null): boolean {
  return !!awemeId && awemeId.startsWith(LOCAL_AWEME_PREFIX)
}

export function isLocalAuthorSecUid(secUid?: string | null): boolean {
  return !!secUid && secUid.startsWith(LOCAL_IMPORT_SEC_UID)
}
