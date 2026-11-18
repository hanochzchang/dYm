import { useState, useEffect } from 'react'
import { Loader2, AlertCircle, Link2, Download } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

interface XiaohongshuImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: () => void
}

export function XiaohongshuImportDialog({
  open,
  onOpenChange,
  onImported
}: XiaohongshuImportDialogProps): React.JSX.Element {
  const [raw, setRaw] = useState('')
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setRaw('')
    setError(null)
  }, [open])

  const handleImport = async (): Promise<void> => {
    setImporting(true)
    setError(null)
    try {
      const result = await window.api.xiaohongshu.import(raw)
      if (!result.ok) {
        setError(result.error || '导入失败')
        return
      }
      toast.success(result.skipped ? '该笔记已在库中' : `导入完成，共 ${result.imageCount ?? 0} 张图`)
      onImported()
      onOpenChange(false)
    } catch (err) {
      setError((err as Error).message || '导入失败')
    } finally {
      setImporting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>导入小红书笔记</DialogTitle>
          <DialogDescription>
            粘贴小红书的完整分享文案（含链接），只支持图文笔记，图片会下载到库中
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Textarea
              placeholder="粘贴分享链接或整段分享文案…"
              rows={4}
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              disabled={importing}
            />
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Link2 className="h-3.5 w-3.5" />
              链接有时效，请在 App 里现分享现用
            </p>
          </div>

          {error && (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span className="break-all">{error}</span>
            </div>
          )}

          <Button
            className="w-full"
            onClick={handleImport}
            disabled={importing || !raw.trim()}
          >
            {importing ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                导入中...
              </>
            ) : (
              <>
                <Download className="h-4 w-4 mr-2" />
                导入
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
