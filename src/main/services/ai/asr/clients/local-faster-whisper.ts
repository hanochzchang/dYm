import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { basename, extname, join } from 'path'
import { promisify } from 'util'
import type { TranscriptSegment } from '../../../../../shared/analysis'
import { makeTempDir, removeTempDir } from '../../ffmpeg'
import type { AsrClient, AsrRequest, AsrResult, ResolvedAsrProvider } from '../types'
import { AsrConfigError } from '../types'
import { normalizeSegments, verifyRequest } from './shared'

const execFileAsync = promisify(execFile)

/**
 * 本地 faster-whisper-xxl（Purfview 的独立版，PotPlayer 内置的就是它）：
 * 音频写临时文件 → 起子进程转写 → 读它输出的 JSON。
 * 本机转写吃 CPU/显卡，所有调用串行执行，避免分析队列并发时几个进程互相抢资源。
 */

const MODEL_DIR_KEY = 'model_dir'
const DEVICE_KEY = 'device'
const DEFAULT_DEVICE = 'cpu'

/** 已知的 whisper 幻觉句式：静音 / 音乐段落上模型会「背」出这些固定台词 */
const HALLUCINATIONS = [
  /请不吝点赞/,
  /明镜与点点/,
  /字幕由.*?提供/,
  /Amara\.org/i,
  /请订阅.*频道/
]

function isHallucination(text: string): boolean {
  return HALLUCINATIONS.some((re) => re.test(text))
}

let chain: Promise<unknown> = Promise.resolve()

/** 同一时刻只允许一个 whisper 进程 */
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const next = chain.then(task, task)
  chain = next.catch(() => undefined)
  return next
}

function tail(text: string, max = 400): string {
  return text.trim().split('\n').slice(-3).join(' ').slice(0, max)
}

interface RawSegment {
  start?: number
  end?: number
  text?: string
}

interface RawOutput {
  segments?: RawSegment[]
  text?: string
  language?: string
}

export class LocalFasterWhisperClient implements AsrClient {
  constructor(private readonly provider: ResolvedAsrProvider) {}

  private get exePath(): string {
    return this.provider.baseUrl.trim()
  }

  private get modelDir(): string {
    return (this.provider.extraForm[MODEL_DIR_KEY] ?? '').trim()
  }

  private get device(): string {
    return (this.provider.extraForm[DEVICE_KEY] ?? '').trim() || DEFAULT_DEVICE
  }

  private buildArgs(input: string, outDir: string, language?: string): string[] {
    const args = [
      input,
      '--model',
      this.provider.model,
      '--device',
      this.device,
      '--output_format',
      'json',
      '--output_dir',
      outDir,
      '--beep_off',
      '--vad_filter',
      'True',
      '--no_speech_threshold',
      '0.6'
    ]
    if (this.modelDir) args.push('--model_dir', this.modelDir)
    if (language) args.push('--language', language)
    return args
  }

  private async run(input: string, outDir: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const exe = this.exePath
    if (!exe) throw new AsrConfigError('未填写 faster-whisper-xxl.exe 路径')
    if (!existsSync(exe)) throw new AsrConfigError(`找不到 faster-whisper-xxl.exe：${exe}`)
    if (this.modelDir && !existsSync(this.modelDir)) {
      throw new AsrConfigError(`模型目录不存在：${this.modelDir}`)
    }
    try {
      await execFileAsync(exe, this.buildArgs(input, outDir), {
        timeout: timeoutMs,
        maxBuffer: 32 << 20,
        windowsHide: true,
        signal,
        encoding: 'utf8'
      })
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? new Error('已取消')
      const err = error as Error & { stdout?: string; stderr?: string; code?: string }
      const detail = tail(`${err.stderr ?? ''} ${err.stdout ?? ''}`) || err.message
      if (/Unknown model not found|Model .*not found|Invalid model/i.test(detail)) {
        throw new AsrConfigError(`本地模型不可用：${detail}`)
      }
      if (err.code === 'ENOENT') throw new AsrConfigError(`找不到 faster-whisper-xxl.exe：${exe}`)
      if (err.code === 'ETIMEDOUT' || /timed out/i.test(err.message)) {
        throw new Error('本地转写超时，可在设置里把单段音频上限调小')
      }
      throw new Error(`本地转写失败：${detail}`)
    }
  }

  async transcribe(request: AsrRequest): Promise<AsrResult> {
    return serialize(async () => {
      request.signal?.throwIfAborted()
      const dir = await makeTempDir('local-whisper')
      try {
        const audioPath = join(dir, request.filename)
        const outDir = join(dir, 'out')
        await mkdir(outDir, { recursive: true })
        await writeFile(audioPath, request.audio)

        // 首次调用要加载模型（1.6G 的 large-v3-turbo 约 4 秒），推理本身通常快于实时
        const timeoutMs = Math.min(30 * 60_000, 120_000 + request.durationSec * 4_000)
        await this.run(audioPath, outDir, timeoutMs, request.signal)

        const jsonPath = join(outDir, `${basename(audioPath, extname(audioPath))}.json`)
        if (!existsSync(jsonPath)) throw new Error('本地转写没有输出 JSON')
        const data = JSON.parse(await readFile(jsonPath, 'utf8')) as RawOutput
        const segments: TranscriptSegment[] = normalizeSegments(
          data.segments,
          request.durationSec
        ).filter((s) => !isHallucination(s.text))
        const fallback = (data.text ?? '').trim()
        const text = segments.length
          ? segments.map((s) => s.text).join('\n')
          : isHallucination(fallback)
            ? ''
            : fallback
        return {
          text,
          segments,
          language: typeof data.language === 'string' ? data.language : null
        }
      } finally {
        await removeTempDir(dir)
      }
    })
  }

  async verify(): Promise<void> {
    await this.transcribe(verifyRequest())
  }
}
