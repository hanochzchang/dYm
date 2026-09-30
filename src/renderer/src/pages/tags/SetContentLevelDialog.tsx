import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface SetContentLevelDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  postId: number | null
  /** AI 原始评分，仅作参照 */
  aiLevel: number | null
  /** 当前手动分；非 null 表示已覆盖 AI */
  manualLevel: number | null
  onSaved?: () => void
}

const LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

/** 手动给单个视频打内容等级（1-10）；清除即回到 AI 分 */
export function SetContentLevelDialog({
  open,
  onOpenChange,
  postId,
  aiLevel,
  manualLevel,
  onSaved
}: SetContentLevelDialogProps): React.JSX.Element {
  const [picked, setPicked] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setPicked(manualLevel)
  }, [open, manualLevel])

  const save = async (level: number | null): Promise<void> => {
    if (postId === null) return
    setSaving(true)
    try {
      await window.api.post.setContentLevel(postId, level)
      toast.success(level === null ? '已清除，回到 AI 评分' : `已设为 ${level}/10`)
      onOpenChange(false)
      onSaved?.()
    } catch (err) {
      toast.error(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>设置内容等级</DialogTitle>
          <DialogDescription>
            {aiLevel !== null ? `AI 原评 ${aiLevel}/10，手动分优先` : '这个视频还没有 AI 评分'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-5 gap-2">
          {LEVELS.map((lv) => (
            <button
              key={lv}
              onClick={() => setPicked(lv)}
              className={cn(
                'h-10 rounded-lg border text-sm font-medium tabular-nums transition-colors',
                picked === lv
                  ? 'border-[#0A84FF] bg-[#0A84FF] text-white'
                  : 'border-[#E5E5E7] text-[#6E6E73] hover:border-[#0A84FF] hover:text-[#0A84FF]'
              )}
            >
              {lv}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2">
          <Button
            variant="ghost"
            className="text-[#A1A1A6]"
            disabled={manualLevel === null || saving}
            onClick={() => save(null)}
          >
            清除（回到 AI 分）
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button
              disabled={picked === null || saving || picked === manualLevel}
              onClick={() => save(picked)}
            >
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
