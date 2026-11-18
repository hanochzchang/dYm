import {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  useCallback,
  lazy,
  Suspense
} from 'react'
import {
  ChevronLeft,
  ChevronRight,
  X,
  Play,
  Heart,
  MessageCircle,
  Volume2,
  VolumeX,
  Download,
  GripHorizontal
} from 'lucide-react'
import { getMergedTags } from '@/lib/utils'

// xgplayer 体积大，只在真正播放视频时才加载
const VideoPlayer = lazy(() => import('./VideoPlayer').then((m) => ({ default: m.VideoPlayer })))

interface MediaViewerProps {
  post: DbPost | null
  open: boolean
  onOpenChange: (open: boolean) => void
  allPosts?: DbPost[]
  onSelectPost?: (post: DbPost) => void
  /** 传入后作者名可点击，用于查看该作者的全部作品 */
  onAuthorClick?: (post: DbPost) => void
}

const IMAGE_AUTO_INTERVAL = 3000
/** 相关推荐展示条数 */
const RECOMMEND_COUNT = 4

/** 右栏固定 400 宽，其余归视频区；改总宽就等于改视频区宽度 */
const VIEWER_SIDE_WIDTH = 400
const SIZE_STORAGE_KEY = 'media_viewer_size'
const DEFAULT_VIEWER_SIZE = { width: 780, height: 520 }
const MIN_VIEWER_SIZE = { width: 660, height: 400 }
const VIEWER_MARGIN = 40
/** 滚轮切作品：累计 deltaY 过阈值才切一次，切完冷却一段时间吸收同一次手势的惯性 */
const WHEEL_SWITCH_THRESHOLD = 80
const WHEEL_SWITCH_COOLDOWN = 500

/** 夹到 [最小值, 窗口留边] 之间；只拉高不会让画面变大，加宽才会 */
function clampViewerSize(size: { width: number; height: number }): {
  width: number
  height: number
} {
  const maxWidth = Math.max(MIN_VIEWER_SIZE.width, window.innerWidth - VIEWER_MARGIN)
  const maxHeight = Math.max(MIN_VIEWER_SIZE.height, window.innerHeight - VIEWER_MARGIN)
  return {
    width: Math.min(Math.max(size.width, MIN_VIEWER_SIZE.width), maxWidth),
    height: Math.min(Math.max(size.height, MIN_VIEWER_SIZE.height), maxHeight)
  }
}

function loadViewerSize(): { width: number; height: number } {
  try {
    const raw = localStorage.getItem(SIZE_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as { width?: unknown; height?: unknown }
      if (typeof parsed.width === 'number' && typeof parsed.height === 'number') {
        return clampViewerSize({ width: parsed.width, height: parsed.height })
      }
    }
  } catch {
    // 读取失败按默认
  }
  return clampViewerSize(DEFAULT_VIEWER_SIZE)
}

export function MediaViewer({
  post,
  open,
  onOpenChange,
  allPosts = [],
  onSelectPost,
  onAuthorClick
}: MediaViewerProps) {
  const [media, setMedia] = useState<MediaFiles | null>(null)
  const [loading, setLoading] = useState(false)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [isMuted, setIsMuted] = useState(false)
  const [recommendCovers, setRecommendCovers] = useState<Map<number, string>>(new Map())
  const [manualOverride, setManualOverride] = useState(false)
  // 按作品 id 记录展开状态，切换作品时自动收起
  const [expandedPostId, setExpandedPostId] = useState<number | null>(null)
  const [descOverflowing, setDescOverflowing] = useState(false)
  const descRef = useRef<HTMLHeadingElement | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const autoTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // 快速切换作品时，旧请求可能晚于新请求返回，用序号丢弃过期结果
  const mediaRequestSeq = useRef(0)
  const [viewerSize, setViewerSize] = useState(loadViewerSize)
  const viewerSizeRef = useRef(viewerSize)
  const resizeStartRef = useRef<{
    x: number
    y: number
    width: number
    height: number
  } | null>(null)
  const wheelAccumRef = useRef(0)
  const wheelLockUntilRef = useRef(0)

  useEffect(() => {
    if (open && post) {
      loadMedia()
      setManualOverride(false)
      setCurrentIndex(0)
      setExpandedPostId(null)
    } else {
      setMedia(null)
      setCurrentIndex(0)
      setManualOverride(false)
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current.currentTime = 0
      }
    }
  }, [open, post])

  useEffect(() => {
    if (media?.music && media.type === 'images' && audioRef.current) {
      audioRef.current.play().catch(() => {})
    }
  }, [media])

  // 相关推荐算法：多样化推荐（同标签优先，但保证作者多样性）
  const recommendations = useMemo(() => {
    if (!open || !post || allPosts.length === 0) return []

    const currentTags = getMergedTags(post)
    const currentSecUid = post.sec_uid
    const result: DbPost[] = []
    const usedIds = new Set<number>([post.id])

    // 候选池：排除当前视频
    const candidates = allPosts.filter((p) => p.id !== post.id)

    // 第一优先：同标签的其他作者视频
    if (currentTags.length > 0) {
      const sameTagOtherAuthor = candidates
        .filter((p) => {
          if (p.sec_uid === currentSecUid) return false
          const tags = getMergedTags(p)
          return tags.some((t) => currentTags.includes(t))
        })
        .slice(0, RECOMMEND_COUNT - 1)

      for (const p of sameTagOtherAuthor) {
        if (result.length < RECOMMEND_COUNT && !usedIds.has(p.id)) {
          result.push(p)
          usedIds.add(p.id)
        }
      }
    }

    // 第二优先：同作者的其他视频（最多1个）
    const sameAuthor = candidates.find((p) => p.sec_uid === currentSecUid && !usedIds.has(p.id))
    if (sameAuthor && result.length < RECOMMEND_COUNT) {
      result.push(sameAuthor)
      usedIds.add(sameAuthor.id)
    }

    // 第三优先：随机补充其他作者的视频。池子得先洗一遍，否则是照着列表排序取头几条，
    // 每次都是同一批（filter 返回新数组，就地洗不影响 candidates）
    const otherAuthors = candidates.filter((p) => p.sec_uid !== currentSecUid && !usedIds.has(p.id))
    for (let i = otherAuthors.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const tmp = otherAuthors[i]
      otherAuthors[i] = otherAuthors[j]
      otherAuthors[j] = tmp
    }
    for (const p of otherAuthors) {
      if (result.length >= RECOMMEND_COUNT) break
      result.push(p)
      usedIds.add(p.id)
    }

    // 如果还不够，补充同作者的
    if (result.length < RECOMMEND_COUNT) {
      const remaining = candidates.filter((p) => !usedIds.has(p.id))
      for (const p of remaining) {
        if (result.length >= RECOMMEND_COUNT) break
        result.push(p)
      }
    }

    return result
  }, [open, post, allPosts])

  // 加载推荐视频的封面
  useEffect(() => {
    const loadCovers = async () => {
      const covers = new Map<number, string>()
      for (const rec of recommendations) {
        try {
          // 总是调用 getCoverPath 获取实际封面路径
          const coverPath = await window.api.post.getCoverPath(rec.sec_uid, rec.folder_name)
          if (coverPath) {
            covers.set(rec.id, coverPath)
          }
        } catch (error) {
          console.error('Failed to load cover for', rec.id, error)
        }
      }
      setRecommendCovers(covers)
    }
    if (open && recommendations.length > 0) {
      loadCovers()
    }
  }, [open, recommendations])

  const loadMedia = async () => {
    if (!post) return
    const seq = ++mediaRequestSeq.current
    setMedia(null)
    setLoading(true)
    try {
      const result = await window.api.post.getMediaFiles(
        post.sec_uid,
        post.folder_name,
        post.aweme_type
      )
      if (seq !== mediaRequestSeq.current) return
      setMedia(result)
    } catch (error) {
      if (seq !== mediaRequestSeq.current) return
      console.error('Failed to load media:', error)
    } finally {
      if (seq === mediaRequestSeq.current) setLoading(false)
    }
  }

  const isImages = media?.type === 'images'
  const images = media?.images || []
  const imageVideos = media?.imageVideos || []
  const currentImageVideo = imageVideos[currentIndex] || null
  const hasMultipleImages = images.length > 1

  useEffect(() => {
    if (autoTimerRef.current) {
      clearInterval(autoTimerRef.current)
      autoTimerRef.current = null
    }
    if (!open || !isImages || !hasMultipleImages || manualOverride) return
    autoTimerRef.current = setInterval(() => {
      setCurrentIndex((prev) => (prev < images.length - 1 ? prev + 1 : 0))
    }, IMAGE_AUTO_INTERVAL)
    return () => {
      if (autoTimerRef.current) {
        clearInterval(autoTimerRef.current)
        autoTimerRef.current = null
      }
    }
  }, [open, isImages, hasMultipleImages, images.length, manualOverride])

  const handlePrev = useCallback(() => {
    setManualOverride(true)
    setCurrentIndex((prev) => (prev > 0 ? prev - 1 : images.length - 1))
  }, [images.length])

  const handleNext = useCallback(() => {
    setManualOverride(true)
    setCurrentIndex((prev) => (prev < images.length - 1 ? prev + 1 : 0))
  }, [images.length])

  const handleSelectIndex = (idx: number) => {
    setManualOverride(true)
    setCurrentIndex(idx)
  }

  /**
   * Esc 关闭，←/→ 翻图集，↑/↓ 切作品（与滚轮同方向）。
   * 原先挂在弹层 div 的 React onKeyDown 上，但那个 div 从没获得过焦点，
   * 这段一直没生效过，故改为 window 监听。
   * 视频作品不在这里处理 ←/→ —— 那是播放器的快进快退。
   */
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null
      if (el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable) return
      if (e.key === 'Escape') {
        onOpenChange(false)
        return
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (!onSelectPost || allPosts.length === 0) return
        e.preventDefault()
        const dir = e.key === 'ArrowDown' ? 1 : -1
        const idx = allPosts.findIndex((p) => p.id === post?.id)
        const next = idx >= 0 ? allPosts[idx + dir] : undefined
        if (next) onSelectPost(next)
        return
      }
      if (!isImages || !hasMultipleImages) return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        handlePrev()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        handleNext()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    open,
    isImages,
    hasMultipleImages,
    handlePrev,
    handleNext,
    onOpenChange,
    onSelectPost,
    allPosts,
    post?.id
  ])

  /**
   * 滚轮切换作品：下滚下一条、上滚上一条，到头即停。
   * 用原生 window 监听而不是 onWheel —— React 的 wheel 监听是 passive 的，
   * preventDefault 拦不住，滚轮会穿透去滚背后的列表。capture 是为了不被播放器内部的
   * 事件处理拦住。
   */
  useEffect(() => {
    if (!open) {
      wheelAccumRef.current = 0
      return
    }
    if (!onSelectPost || allPosts.length === 0) return
    const onWheel = (e: WheelEvent): void => {
      // 相关推荐列表自己可滚动，滚它时不切作品
      if ((e.target as HTMLElement | null)?.closest('[data-scroll-panel]')) return
      e.preventDefault()
      const now = performance.now()
      if (now < wheelLockUntilRef.current) return
      wheelAccumRef.current += e.deltaY
      if (Math.abs(wheelAccumRef.current) < WHEEL_SWITCH_THRESHOLD) return
      const dir = wheelAccumRef.current > 0 ? 1 : -1
      wheelAccumRef.current = 0
      wheelLockUntilRef.current = now + WHEEL_SWITCH_COOLDOWN
      const idx = allPosts.findIndex((p) => p.id === post?.id)
      const next = idx >= 0 ? allPosts[idx + dir] : undefined
      if (next) onSelectPost(next)
    }
    window.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => window.removeEventListener('wheel', onWheel, { capture: true })
  }, [open, post?.id, allPosts, onSelectPost])

  const handleDownload = async () => {
    if (!post) return
    try {
      await window.api.post.openFolder(post.sec_uid, post.folder_name)
    } catch (error) {
      console.error('Failed to open folder:', error)
    }
  }

  const handleSelectRecommend = (rec: DbPost) => {
    if (onSelectPost) {
      onSelectPost(rec)
    }
  }

  const handleResizeStart = (e: React.PointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    resizeStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      width: viewerSize.width,
      height: viewerSize.height
    }
    // 拖拽中禁用文字选择，免得选中标题/正文
    document.body.style.userSelect = 'none'
  }

  const handleResizeMove = (e: React.PointerEvent): void => {
    const start = resizeStartRef.current
    if (!start) return
    const next = clampViewerSize({
      width: start.width + (e.clientX - start.x),
      height: start.height + (e.clientY - start.y)
    })
    viewerSizeRef.current = next
    setViewerSize(next)
  }

  const handleResizeEnd = (e: React.PointerEvent): void => {
    if (!resizeStartRef.current) return
    resizeStartRef.current = null
    document.body.style.userSelect = ''
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      // 指针已释放
    }
    try {
      localStorage.setItem(SIZE_STORAGE_KEY, JSON.stringify(viewerSizeRef.current))
    } catch {
      // 写入失败忽略
    }
  }

  // 解析标签（合并 AI + 手动）
  const tags = post ? getMergedTags(post) : []

  const descExpanded = post?.id != null && expandedPostId === post.id

  // 只在收起时测量；被 line-clamp 截断时 scrollHeight 仍是全文高度
  useLayoutEffect(() => {
    if (descExpanded) return
    const el = descRef.current
    if (!el) {
      setDescOverflowing(false)
      return
    }
    setDescOverflowing(el.scrollHeight > el.clientHeight + 1)
  }, [post?.id, descExpanded])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={() => onOpenChange(false)}
    >
      <div
        className="relative flex bg-white rounded-2xl overflow-hidden shadow-xl border border-[#E5E5E7]"
        style={{ width: viewerSize.width, height: viewerSize.height }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 左侧 - 视频/图片区域 */}
        <div
          className="relative bg-black flex items-center justify-center"
          style={{ width: viewerSize.width - VIEWER_SIDE_WIDTH }}
        >
          {loading ? (
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white" />
          ) : media ? (
            isImages ? (
              <>
                {images.length > 0 &&
                  (currentImageVideo ? (
                    <video
                      key={currentImageVideo}
                      src={`local://file${currentImageVideo}`}
                      poster={`local://file${images[currentIndex]}`}
                      className="max-w-full max-h-full object-contain"
                      autoPlay
                      loop
                      muted
                      playsInline
                    />
                  ) : (
                    <img
                      src={`local://file${images[currentIndex]}`}
                      alt={`Image ${currentIndex + 1}`}
                      className="max-w-full max-h-full object-contain"
                    />
                  ))}
                {hasMultipleImages && (
                  <>
                    <button
                      className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/50 hover:bg-black/70 flex items-center justify-center text-white transition-colors"
                      onClick={handlePrev}
                    >
                      <ChevronLeft className="h-5 w-5" />
                    </button>
                    <button
                      className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/50 hover:bg-black/70 flex items-center justify-center text-white transition-colors"
                      onClick={handleNext}
                    >
                      <ChevronRight className="h-5 w-5" />
                    </button>
                    {/* 图片指示器 */}
                    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-1.5">
                      {images.map((_, idx) => (
                        <button
                          key={idx}
                          onClick={() => handleSelectIndex(idx)}
                          className={`w-1.5 h-1.5 rounded-full transition-colors ${
                            idx === currentIndex ? 'bg-white' : 'bg-white/40 hover:bg-white/70'
                          }`}
                          aria-label={`第 ${idx + 1} 张`}
                        />
                      ))}
                    </div>
                  </>
                )}
                {media.music && (
                  <>
                    <audio ref={audioRef} src={`local://file${media.music}`} loop muted={isMuted} />
                    <button
                      className="absolute bottom-4 right-4 w-8 h-8 rounded-full bg-black/50 hover:bg-black/70 flex items-center justify-center text-white transition-colors"
                      onClick={() => {
                        setIsMuted(!isMuted)
                        if (audioRef.current) {
                          audioRef.current.muted = !isMuted
                        }
                      }}
                    >
                      {isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                    </button>
                  </>
                )}
              </>
            ) : media.video ? (
              <Suspense
                fallback={
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white" />
                }
              >
                <VideoPlayer url={`local://file${media.video}`} className="w-full h-full" />
              </Suspense>
            ) : (
              <div className="text-white text-center">
                <p>视频文件未找到</p>
              </div>
            )
          ) : (
            <div className="text-white text-center">
              <p>无法加载媒体文件</p>
            </div>
          )}
        </div>

        {/* 右侧 - 内容区域 */}
        <div className="flex flex-col" style={{ width: 400, padding: 20 }}>
          {/* 标题行 */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <h3
                ref={descRef}
                className={`text-base font-medium text-[#1D1D1F] leading-tight ${
                  descExpanded
                    ? 'max-h-[min(30vh,220px)] overflow-y-auto overscroll-contain pr-1'
                    : 'line-clamp-2'
                }`}
                data-scroll-panel={descExpanded ? 'true' : undefined}
              >
                {post?.desc || post?.caption || '无标题'}
              </h3>
              {descOverflowing && (
                <button
                  onClick={() => setExpandedPostId(descExpanded ? null : (post?.id ?? null))}
                  className="mt-1 text-xs text-[#0A84FF] hover:underline"
                >
                  {descExpanded ? '收起' : '展开'}
                </button>
              )}
            </div>
            <button
              onClick={() => onOpenChange(false)}
              className="w-7 h-7 rounded-full bg-[#F2F2F4] hover:bg-[#E5E5E7] flex items-center justify-center flex-shrink-0 transition-colors"
            >
              <X className="h-4 w-4 text-[#6E6E73]" />
            </button>
          </div>

          {/* 标签行 */}
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-3">
              {tags.slice(0, 5).map((tag, idx) => (
                <span
                  key={idx}
                  className="px-2.5 py-1 rounded-full text-xs font-medium bg-[#E8F0FE] text-[#0A84FF]"
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}

          {/* 作者行 */}
          <div className="flex items-center justify-between mt-4">
            <div className="flex items-center gap-2.5">
              <div className="w-10 h-10 rounded-full bg-[#F2F2F4] flex items-center justify-center overflow-hidden">
                <span className="text-sm font-medium text-[#6E6E73]">
                  {post?.nickname?.charAt(0) || 'U'}
                </span>
              </div>
              <div>
                {onAuthorClick && post ? (
                  <button
                    onClick={() => onAuthorClick(post)}
                    title={`查看 @${post.nickname} 的全部作品`}
                    className="text-sm font-medium text-[#1D1D1F] hover:text-[#0A84FF] hover:underline transition-colors"
                  >
                    @{post.nickname}
                  </button>
                ) : (
                  <p className="text-sm font-medium text-[#1D1D1F]">@{post?.nickname}</p>
                )}
                <p className="text-xs text-[#A1A1A6]">粉丝 --</p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-1 text-[#6E6E73]">
                <Heart className="h-4 w-4" />
                <span className="text-xs">--</span>
              </div>
              <div className="flex items-center gap-1 text-[#6E6E73]">
                <MessageCircle className="h-4 w-4" />
                <span className="text-xs">--</span>
              </div>
            </div>
          </div>

          {/* 分割线 */}
          <div className="h-px bg-[#E5E5E7] my-4" />

          {/* 下载按钮 */}
          <button
            onClick={handleDownload}
            className="w-full h-11 rounded-lg bg-[#0A84FF] hover:bg-[#0060D5] text-white text-sm font-medium flex items-center justify-center gap-2 transition-colors"
          >
            <Download className="h-4 w-4" />
            打开文件夹
          </button>

          {/* 相关推荐：条数按 RECOMMEND_COUNT，窗口太矮时内部滚动 */}
          <div
            className="mt-4 flex-1 min-h-0 overflow-y-auto overscroll-contain"
            data-scroll-panel
          >
            <h4 className="text-sm font-medium text-[#1D1D1F] mb-3">相关推荐</h4>
            <div className="space-y-2.5">
              {recommendations.length > 0 ? (
                recommendations.map((rec) => (
                  <button
                    key={rec.id}
                    onClick={() => handleSelectRecommend(rec)}
                    className="w-full flex items-center gap-3 p-1.5 rounded-lg hover:bg-[#F2F2F4] transition-colors text-left"
                  >
                    <div className="w-[70px] h-[70px] rounded-lg bg-[#F2F2F4] overflow-hidden flex-shrink-0">
                      {recommendCovers.get(rec.id) ? (
                        <img
                          src={`local://file${recommendCovers.get(rec.id)}`}
                          alt=""
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Play className="h-5 w-5 text-[#A1A1A6]" />
                        </div>
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-[#1D1D1F] line-clamp-2 leading-tight">
                        {rec.desc || rec.caption || '无标题'}
                      </p>
                      <p className="text-xs text-[#A1A1A6] mt-1">@{rec.nickname}</p>
                    </div>
                  </button>
                ))
              ) : (
                <p className="text-xs text-[#A1A1A6] text-center py-4">暂无相关推荐</p>
              )}
            </div>
          </div>
        </div>

        {/* 右下角拖拽把手：同时改宽度（= 视频区宽度）与高度 */}
        <div
          onPointerDown={handleResizeStart}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
          className="absolute right-0 bottom-0 z-10 flex h-4 w-4 cursor-nwse-resize items-center justify-center text-[#A1A1A6] hover:text-[#6E6E73] touch-none"
          title="拖动调整大小"
        >
          <GripHorizontal className="h-4 w-4" />
        </div>
      </div>
    </div>
  )
}
