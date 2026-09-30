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
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { applyAnalysisOverride } from '@shared/analysis'
import type { AnalysisOverride, VideoAnalysis } from '@shared/analysis'

interface EditAnalysisDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  postId: number | null
  /** AI 原始结果；旧版（v1）作品没有结构化结果，也就没得改 */
  ai: VideoAnalysis | null
  /** 当前人工修订；null 表示全部跟着 AI 走 */
  manual: AnalysisOverride | null
  onSaved?: () => void
}

/** 表单态：列表字段在界面上就是「一行一条」的纯文本 */
interface FormState {
  summary: string
  content: string
  categoryPrimary: string
  categorySecondary: string
  location: string
  place: string
  timeOfDay: string
  peopleCount: string
  appearance: string
  outfit: string
  actions: string
  style: string
  onScreenText: string
  speechTopics: string
}

const linesOf = (list: string[] | undefined): string => (list ?? []).join('\n')

const toList = (text: string): string[] =>
  text
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)

function formOf(analysis: VideoAnalysis): FormState {
  return {
    summary: analysis.summary ?? '',
    content: analysis.content ?? '',
    categoryPrimary: analysis.category?.primary ?? '',
    categorySecondary: analysis.category?.secondary ?? '',
    location: analysis.setting?.location ?? '',
    place: analysis.setting?.place ?? '',
    timeOfDay: analysis.setting?.timeOfDay ?? '',
    peopleCount: analysis.subjects?.peopleCount ?? '',
    appearance: linesOf(analysis.subjects?.appearance),
    outfit: linesOf(analysis.subjects?.outfit),
    actions: linesOf(analysis.actions),
    style: linesOf(analysis.style),
    onScreenText: linesOf(analysis.onScreenText),
    speechTopics: linesOf(analysis.speechTopics)
  }
}

const EMPTY_FORM: FormState = {
  summary: '',
  content: '',
  categoryPrimary: '',
  categorySecondary: '',
  location: '',
  place: '',
  timeOfDay: '',
  peopleCount: '',
  appearance: '',
  outfit: '',
  actions: '',
  style: '',
  onScreenText: '',
  speechTopics: ''
}

/**
 * 与 AI 原值逐项比对，只把真正改过的项收进修订。
 * 改回原值的项会被丢掉 —— 那样它重新跟着 AI 走，重新分析后也能拿到新结果。
 */
function buildOverride(ai: VideoAnalysis, form: FormState): AnalysisOverride | null {
  const override: AnalysisOverride = {}

  if (ai.summary !== form.summary) override.summary = form.summary
  if ((ai.content ?? '') !== form.content) override.content = form.content

  const category: { primary?: string; secondary?: string } = {}
  if ((ai.category?.primary ?? '') !== form.categoryPrimary) category.primary = form.categoryPrimary
  if ((ai.category?.secondary ?? '') !== form.categorySecondary) {
    category.secondary = form.categorySecondary
  }
  if (Object.keys(category).length) override.category = category

  const setting: { location?: string; place?: string; timeOfDay?: string } = {}
  if ((ai.setting?.location ?? '') !== form.location) setting.location = form.location
  if ((ai.setting?.place ?? '') !== form.place) setting.place = form.place
  if ((ai.setting?.timeOfDay ?? '') !== form.timeOfDay) setting.timeOfDay = form.timeOfDay
  if (Object.keys(setting).length) override.setting = setting

  const subjects: { peopleCount?: string; appearance?: string[]; outfit?: string[] } = {}
  if ((ai.subjects?.peopleCount ?? '') !== form.peopleCount) subjects.peopleCount = form.peopleCount
  if (linesOf(ai.subjects?.appearance) !== toList(form.appearance).join('\n')) {
    subjects.appearance = toList(form.appearance)
  }
  if (linesOf(ai.subjects?.outfit) !== toList(form.outfit).join('\n')) {
    subjects.outfit = toList(form.outfit)
  }
  if (Object.keys(subjects).length) override.subjects = subjects

  if (linesOf(ai.actions) !== toList(form.actions).join('\n')) override.actions = toList(form.actions)
  if (linesOf(ai.style) !== toList(form.style).join('\n')) override.style = toList(form.style)
  if (linesOf(ai.onScreenText) !== toList(form.onScreenText).join('\n')) {
    override.onScreenText = toList(form.onScreenText)
  }
  if (linesOf(ai.speechTopics) !== toList(form.speechTopics).join('\n')) {
    override.speechTopics = toList(form.speechTopics)
  }

  return Object.keys(override).length ? override : null
}

/** 人工修改「AI 理解」的文本字段；评分、章节、字幕、标签不在这里改 */
export function EditAnalysisDialog({
  open,
  onOpenChange,
  postId,
  ai,
  manual,
  onSaved
}: EditAnalysisDialogProps): React.JSX.Element | null {
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open || !ai) return
    // 预填当前生效的值（AI 盖上已有修订），打开时看到的跟卡片上一致
    setForm(formOf(manual ? applyAnalysisOverride(ai, manual) : ai))
  }, [open, ai, manual])

  if (!ai) return null

  const set = (key: keyof FormState) => (value: string): void =>
    setForm((prev) => ({ ...prev, [key]: value }))

  const save = async (override: AnalysisOverride | null): Promise<void> => {
    if (postId === null) return
    setSaving(true)
    try {
      await window.api.analysis.setOverride(postId, override)
      toast.success(override ? '已保存人工修订' : '已恢复 AI 原值')
      onOpenChange(false)
      onSaved?.()
    } catch (err) {
      toast.error(`保存失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const dirty = buildOverride(ai, form)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto]">
        <DialogHeader>
          <DialogTitle>修改 AI 理解</DialogTitle>
          <DialogDescription>
            只保存你改过的项；改回 AI 原值的项会重新跟着 AI 走，之后重新分析也能更新。
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
          <Field label="摘要" hint="两三句话讲这条视频在做什么">
            <Textarea
              value={form.summary}
              rows={2}
              className="min-h-[56px]"
              onChange={(e) => set('summary')(e.target.value)}
            />
          </Field>

          <Field label="内容" hint="看完视频后向别人复述级别的描述">
            <Textarea
              value={form.content}
              rows={6}
              onChange={(e) => set('content')(e.target.value)}
            />
          </Field>

          <div className="grid gap-4 md:grid-cols-2">
            <Field label="主分类">
              <Input
                value={form.categoryPrimary}
                onChange={(e) => set('categoryPrimary')(e.target.value)}
              />
            </Field>
            <Field label="次分类">
              <Input
                value={form.categorySecondary}
                onChange={(e) => set('categorySecondary')(e.target.value)}
              />
            </Field>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <Field label="室内外">
              <Input value={form.location} onChange={(e) => set('location')(e.target.value)} />
            </Field>
            <Field label="具体地点">
              <Input value={form.place} onChange={(e) => set('place')(e.target.value)} />
            </Field>
            <Field label="时段">
              <Input value={form.timeOfDay} onChange={(e) => set('timeOfDay')(e.target.value)} />
            </Field>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <Field label="人数">
              <Input
                value={form.peopleCount}
                onChange={(e) => set('peopleCount')(e.target.value)}
              />
            </Field>
            <Field label="人物特征" hint="一行一条">
              <Textarea
                value={form.appearance}
                rows={3}
                onChange={(e) => set('appearance')(e.target.value)}
              />
            </Field>
            <Field label="穿着" hint="一行一条">
              <Textarea
                value={form.outfit}
                rows={3}
                onChange={(e) => set('outfit')(e.target.value)}
              />
            </Field>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Field label="动作" hint="一行一条">
              <Textarea
                value={form.actions}
                rows={3}
                onChange={(e) => set('actions')(e.target.value)}
              />
            </Field>
            <Field label="风格" hint="一行一条">
              <Textarea
                value={form.style}
                rows={3}
                onChange={(e) => set('style')(e.target.value)}
              />
            </Field>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Field label="口播话题" hint="一行一条">
              <Textarea
                value={form.speechTopics}
                rows={3}
                onChange={(e) => set('speechTopics')(e.target.value)}
              />
            </Field>
            <Field label="画面文字" hint="一行一条">
              <Textarea
                value={form.onScreenText}
                rows={3}
                onChange={(e) => set('onScreenText')(e.target.value)}
              />
            </Field>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <Button
            variant="ghost"
            className="text-[#A1A1A6]"
            disabled={!manual || saving}
            onClick={() => save(null)}
          >
            恢复 AI 原值
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button disabled={saving || !dirty} onClick={() => save(dirty)}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="block space-y-1.5">
      <span className="flex items-baseline gap-2">
        <span className="text-xs font-medium text-[#6E6E73]">{label}</span>
        {hint && <span className="text-[11px] text-[#A1A1A6]">{hint}</span>}
      </span>
      {children}
    </label>
  )
}
