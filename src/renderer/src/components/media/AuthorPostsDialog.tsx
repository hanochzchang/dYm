import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ExternalLink, Images, Loader2, Play, Video, X } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { MediaViewer } from '@/components/media/MediaViewer'
import { getInitialSort } from '@/lib/post-sort'
import { formatPostDate } from '@/lib/format'
import { getAvatarUrl } from '@/lib/utils'

const PAGE_SIZE = 50
const IMAGE_AWEME_TYPE = 68
const isImagePost = (post: DbPost): boolean => post.aweme_type === IMAGE_AWEME_TYPE

/** 弹窗只用到身份和头像；视频库/标签页手里只有作品，凑不出完整 DbUser */
export type AuthorSummary = Pick<DbUser, 'sec_uid' | 'nickname'> &
  Partial<Pick<DbUser, 'avatar' | 'avatar_path'>>

interface AuthorPostsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  user: AuthorSummary | null
  /** 自定义「在视频库中打开该作者」；不传则跳转 /browse。视频库内用，同路由跳转不会重新读 ?user= */
  onOpenInBrowse?: (secUid: string) => void
}

/**
 * 用户管理页里就地查看某个作者的作品。
 * 不用 Radix Dialog：那是模态的，会给 body 加 pointer-events:none，盖在上面的播放弹层就点不动了；
 * 这里自绘背景 + 面板（z-40），播放弹层仍是 z-50，天然叠在上面。
 */
export function AuthorPostsDialog({
  open,
  onOpenChange,
  user,
  onOpenInBrowse
}: AuthorPostsDialogProps): React.JSX.Element | null {
  const navigate = useNavigate()
  const [posts, setPosts] = useState<DbPost[]>([])
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [coverPaths, setCoverPaths] = useState<Record<string, string>>({})
  const [selectedPost, setSelectedPost] = useState<DbPost | null>(null)
  const [viewerOpen, setViewerOpen] = useState(false)
  const seqRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  const loadCovers = async (list: DbPost[]): Promise<void> => {
    const entries = await Promise.all(
      list.map(async (post) => {
        if (!post.folder_name) return [post.aweme_id, null] as const
        try {
          const path = await window.api.post.getCoverPath(post.sec_uid, post.folder_name)
          return [post.aweme_id, path] as const
        } catch {
          return [post.aweme_id, null] as const
        }
      })
    )
    setCoverPaths((prev) => {
      const next = { ...prev }
      for (const [awemeId, path] of entries) {
        if (path) next[awemeId] = path
      }
      return next
    })
  }

  const loadPage = async (pageNum: number): Promise<void> => {
    if (!user) return
    const seq = ++seqRef.current
    if (pageNum === 1) {
      setLoading(true)
    } else {
      setLoadingMore(true)
    }
    try {
      const result = await window.api.post.getAll(
        pageNum,
        PAGE_SIZE,
        { secUid: user.sec_uid },
        getInitialSort('home_post_sort')
      )
      if (seq !== seqRef.current) return
      setPosts((prev) => (pageNum === 1 ? result.posts : [...prev, ...result.posts]))
      setTotal(result.total)
      setHasMore(result.posts.length === PAGE_SIZE)
      void loadCovers(result.posts)
    } catch (e) {
      if (seq === seqRef.current) setError((e as Error).message || '加载失败')
    } finally {
      if (seq === seqRef.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }

  useEffect(() => {
    if (!open || !user) return
    // 切换作者时让在途的旧请求作废
    seqRef.current++
    setPosts([])
    setTotal(0)
    setHasMore(false)
    setError(null)
    setCoverPaths({})
    setSelectedPost(null)
    setViewerOpen(false)
    scrollRef.current?.scrollTo({ top: 0 })
    void loadPage(1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, user?.sec_uid])

  // Esc 关闭；播放弹层开着时由它自己处理
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || viewerOpen) return
      onOpenChange(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, viewerOpen, onOpenChange])

  if (!open || !user) return null

  const openInBrowse = (): void => {
    onOpenChange(false)
    if (onOpenInBrowse) onOpenInBrowse(user.sec_uid)
    else navigate(`/browse?user=${encodeURIComponent(user.sec_uid)}`)
  }

  return (
    <>
      <div
        className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-6"
        onClick={() => onOpenChange(false)}
      >
        <div
          className="flex h-[85vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-[#E5E5E7] bg-white shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-3 border-b border-[#E5E5E7] px-6 py-4">
            <Avatar className="h-9 w-9">
              <AvatarImage src={getAvatarUrl(user)} className="object-cover" />
              <AvatarFallback className="bg-[#E8F0FE] text-[#0A84FF]">
                {user.nickname?.charAt(0).toUpperCase() || 'U'}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-[#1D1D1F]">@{user.nickname}</p>
              <p className="text-xs text-[#A1A1A6]">共 {total} 个作品</p>
            </div>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-full p-2 text-[#6E6E73] transition-colors hover:bg-[#F2F2F4]"
              title="关闭"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto p-5">
            {loading ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-[#A1A1A6]" />
              </div>
            ) : error ? (
              <div className="flex h-full items-center justify-center text-sm text-red-500">
                {error}
              </div>
            ) : posts.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-[#A1A1A6]">
                该作者还没有作品
              </div>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
                  {posts.map((post) => (
                    <button
                      key={post.id}
                      type="button"
                      onClick={() => {
                        setSelectedPost(post)
                        setViewerOpen(true)
                      }}
                      className="group overflow-hidden rounded-xl border border-[#E5E5E7] bg-white text-left transition-shadow hover:shadow-md"
                    >
                      <div className="relative aspect-[9/16] bg-[#F2F2F4]">
                        {coverPaths[post.aweme_id] ? (
                          <img
                            src={`local://file${coverPaths[post.aweme_id]}`}
                            alt={post.desc}
                            loading="lazy"
                            decoding="async"
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center">
                            {isImagePost(post) ? (
                              <Images className="h-8 w-8 text-[#A1A1A6]" />
                            ) : (
                              <Video className="h-8 w-8 text-[#A1A1A6]" />
                            )}
                          </div>
                        )}
                        <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/30">
                          {isImagePost(post) ? (
                            <Images className="h-8 w-8 text-white opacity-0 transition-opacity group-hover:opacity-100" />
                          ) : (
                            <Play className="h-8 w-8 text-white opacity-0 transition-opacity group-hover:opacity-100" />
                          )}
                        </div>
                        <div className="absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
                          {isImagePost(post) ? '图集' : '视频'}
                        </div>
                        {post.create_time && (
                          <div className="absolute bottom-2 right-2 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
                            {formatPostDate(post.create_time)}
                          </div>
                        )}
                      </div>
                      <p className="line-clamp-2 p-2 text-sm text-[#1D1D1F]">
                        {post.desc || post.caption || '无标题'}
                      </p>
                    </button>
                  ))}
                </div>
                {hasMore && (
                  <div className="mt-4 flex justify-center">
                    <Button
                      variant="outline"
                      onClick={() => void loadPage(Math.floor(posts.length / PAGE_SIZE) + 1)}
                      disabled={loadingMore}
                    >
                      {loadingMore ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          加载中...
                        </>
                      ) : (
                        '加载更多'
                      )}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="flex items-center justify-between border-t border-[#E5E5E7] px-6 py-3">
            <span className="text-xs text-[#A1A1A6]">点击卡片可预览</span>
            <Button variant="outline" onClick={openInBrowse}>
              <ExternalLink className="mr-2 h-4 w-4" />
              在视频库中打开该作者
            </Button>
          </div>
        </div>
      </div>

      <MediaViewer
        post={selectedPost}
        open={viewerOpen}
        onOpenChange={setViewerOpen}
        allPosts={posts}
        onSelectPost={setSelectedPost}
      />
    </>
  )
}
