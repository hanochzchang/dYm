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

/** 设置页切换后即时刷新侧边栏，不必重启 */
export const NAV_VISIBILITY_EVENT = 'nav-visibility-change'

export function emitNavVisibilityChange(hidden: string[]): void {
  window.dispatchEvent(new CustomEvent<string[]>(NAV_VISIBILITY_EVENT, { detail: hidden }))
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
