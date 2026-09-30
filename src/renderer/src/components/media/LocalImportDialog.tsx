import { useState, useEffect, useCallback } from 'react'
import { Loader2, Images, Video, AlertCircle, FolderOpen, Upload } from 'lucide-react'
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
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

interface LocalImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: () => void
}

/** 渲染进程拿不到 node:path，这里只用来显示文件名 */
function baseName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath
}

export function LocalImportDialog({
  open,
  onOpenChange,
  onImported
}: LocalImportDialogProps): React.JSX.Element {
  const [kind, setKind] = useState<'video' | 'images'>('video')
  const [paths, setPaths] = useState<string[]>([])
  const [desc, setDesc] = useState('')
  const [authorName, setAuthorName] = useState('')
  const [createTime, setCreateTime] = useState('')
  const [existingNicknames, setExistingNicknames] = useState<string[]>([])
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setKind('video')
    setPaths([])
    setDesc('')
    setAuthorName('')
    setCreateTime('')
    setError(null)
    // 只用来在填了同名作者时提示一句，失败不影响导入
    window.api.user
      .getAll()
      .then((users) => setExistingNicknames(users.map((u) => u.nickname)))
      .catch(() => setExistingNicknames([]))
  }, [open])

  const pick = useCallback(async (next: 'video' | 'images'): Promise<void> => {
    try {
      const picked = await window.api.localImport.pick(next)
      if (picked.length === 0) return
      setKind(next)
      setPaths(picked)
      setError(null)
    } catch (err) {
      setError((err as Error).message || '选择文件失败')
    }
  }, [])

  const handleImport = async (): Promise<void> => {
    setImporting(true)
    setError(null)
    try {
      const result = await window.api.localImport.start({
        kind,
        paths,
        desc: desc.trim() || undefined,
        authorName: authorName.trim() || undefined,
        createTime: createTime || undefined
      })
      toast.success(result.skipped ? '库里已有同一份内容，未重复导入' : '导入完成')
      onImported()
      onOpenChange(false)
    } catch (err) {
      setError((err as Error).message || '导入失败')
    } finally {
      setImporting(false)
    }
  }

  const trimmedAuthor = authorName.trim()
  const nameExists = !!trimmedAuthor && existingNicknames.includes(trimmedAuthor)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>导入本地</DialogTitle>
          <DialogDescription>
            从本机导入已有的视频或图集，文件会复制到库中，原文件保留
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex gap-2">
            <Button
              variant={kind === 'video' ? 'default' : 'outline'}
              className="flex-1"
              onClick={() => pick('video')}
              disabled={importing}
            >
              <Video className="h-4 w-4 mr-2" />
              选择视频文件
            </Button>
            <Button
              variant={kind === 'images' ? 'default' : 'outline'}
              className="flex-1"
              onClick={() => pick('images')}
              disabled={importing}
            >
              <Images className="h-4 w-4 mr-2" />
              选择图片
            </Button>
          </div>

          {paths.length > 0 ? (
            <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
              <FolderOpen className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
              <span className="break-all">
                {kind === 'video'
                  ? baseName(paths[0])
                  : `已选 ${paths.length} 张图片，将组成一个图集作品`}
              </span>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              选一个视频 = 一条作品；选多张图片 = 一个图集作品
            </p>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="local-import-desc">描述</Label>
            <Textarea
              id="local-import-desc"
              placeholder="留空则显示为「无描述」"
              rows={3}
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              disabled={importing}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="local-import-author">作者</Label>
            <Input
              id="local-import-author"
              placeholder="留空则归到「本地导入」"
              value={authorName}
              onChange={(e) => setAuthorName(e.target.value)}
              disabled={importing}
            />
            {nameExists && (
              <p className="text-xs text-muted-foreground">
                已有同名作者，导入的作品会挂在新建的独立作者下，原同名作者的作品不受影响
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="local-import-time">发布时间</Label>
            <Input
              id="local-import-time"
              type="datetime-local"
              value={createTime}
              onChange={(e) => setCreateTime(e.target.value)}
              disabled={importing}
            />
            <p className="text-xs text-muted-foreground">留空则用当前时间</p>
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
            disabled={importing || paths.length === 0}
          >
            {importing ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                导入中...
              </>
            ) : (
              <>
                <Upload className="h-4 w-4 mr-2" />
                导入
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
