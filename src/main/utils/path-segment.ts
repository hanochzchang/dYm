/**
 * 渲染端传来的 secUid / folderName 会直接拼进下载目录后 rmSync / openPath。
 * 空串会让 join(root, '') 退化成下载根目录，'..' 会跑到上一级；进入口先把它们挡住。
 */

/** 单级目录名：不能为空、不能含路径分隔符、不能是 . / .. */
function assertSegment(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    /[\\/]/.test(value) ||
    value.includes('\0')
  ) {
    throw new Error(`非法的${label}：${String(value)}`)
  }
  return value
}

/**
 * sec_uid 也是当目录名用的。真实抖音的是 `MS4wLjABAAAA…`（纯 ASCII），但「本地导入」
 * 造的合成作者会把作者名直接写进去（可能含中文），所以只能按「合法的单级目录名」判，
 * 不能再拿抖音的字符集卡——否则导入的作品一右键「在文件管理器中打开」就报非法。
 */
export function assertSecUid(secUid: unknown): string {
  return assertSegment(secUid, 'sec_uid')
}

export function assertFolderName(name: unknown): string {
  return assertSegment(name, '目录名')
}
