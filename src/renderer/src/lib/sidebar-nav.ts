import {
  Download,
  Home,
  Users,
  Sparkles,
  Settings,
  ScrollText,
  HardDrive,
  LayoutGrid,
  Tags,
  Radio,
  Code2
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface NavItem {
  path: string
  label: string
  icon: LucideIcon
}

/** 侧边栏菜单项（顺序即显示顺序） */
export const navItems: NavItem[] = [
  { path: '/', label: '数据概览', icon: Home },
  { path: '/browse', label: '视频浏览', icon: LayoutGrid },
  { path: '/users', label: '用户管理', icon: Users },
  { path: '/download', label: '下载任务', icon: Download },
  { path: '/files', label: '文件管理', icon: HardDrive },
  { path: '/analysis', label: '视频分析', icon: Sparkles },
  { path: '/tags', label: '标签管理', icon: Tags },
  { path: '/live', label: '直播录制', icon: Radio },
  { path: '/logs', label: '同步日志', icon: ScrollText },
  { path: '/settings', label: '系统设置', icon: Settings }
]

/** 开发者模式下额外显示的菜单项（不参与隐藏开关，由开发者模式本身控制） */
export const devNavItems: NavItem[] = [{ path: '/scripts', label: '自定义脚本', icon: Code2 }]

/** 这一项藏了就没入口进设置页，因此锁死不可隐藏 */
export const LOCKED_NAV_PATH = '/settings'

/** 存储 key，值是 JSON 数组，如 ["/live","/logs"] */
export const HIDDEN_NAV_KEY = 'hidden_nav_items'

/** 菜单顺序存储 key，值是 JSON 数组，如 ["/browse","/"]；空数组 = 默认顺序 */
export const NAV_ORDER_KEY = 'nav_order'

/** 设置页切换后即时刷新侧边栏，不必重启 */
export const NAV_VISIBILITY_EVENT = 'nav-visibility-change'

/** 设置页调整顺序后即时刷新侧边栏 */
export const NAV_ORDER_EVENT = 'nav-order-change'

export function emitNavVisibilityChange(hidden: string[]): void {
  window.dispatchEvent(new CustomEvent<string[]>(NAV_VISIBILITY_EVENT, { detail: hidden }))
}

export function emitNavOrderChange(order: string[]): void {
  window.dispatchEvent(new CustomEvent<string[]>(NAV_ORDER_EVENT, { detail: order }))
}

const KNOWN_NAV_PATHS = new Set([...navItems, ...devNavItems].map((item) => item.path))

/** 只保留已知路径并去重，脏数据不会打乱菜单；注意 /settings 只是不可隐藏，顺序仍可调 */
export function parseNavOrder(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const seen = new Set<string>()
    const result: string[] = []
    for (const x of parsed) {
      if (typeof x !== 'string' || !KNOWN_NAV_PATHS.has(x) || seen.has(x)) continue
      seen.add(x)
      result.push(x)
    }
    return result
  } catch {
    return []
  }
}

/** 按保存的顺序排列；不在顺序里的项（如以后新增的菜单）保持原相对顺序排到末尾 */
export function sortNavItems(items: NavItem[], order: string[]): NavItem[] {
  if (order.length === 0) return items
  const rank = new Map(order.map((path, idx) => [path, idx]))
  return [...items].sort((a, b) => {
    const ra = rank.get(a.path)
    const rb = rank.get(b.path)
    if (ra === undefined && rb === undefined) return 0
    if (ra === undefined) return 1
    if (rb === undefined) return -1
    return ra - rb
  })
}

/** 读盘的值可以是任何东西，逐层兜底；顺手剔除锁定项，避免被脏数据锁在设置页外 */
export function parseHiddenNavItems(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string' && x !== LOCKED_NAV_PATH)
  } catch {
    return []
  }
}
