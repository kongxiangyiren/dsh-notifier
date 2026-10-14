/** 插件选项：`cordis.patch.yml` 里 config 的解析结果（也是 Config schema 的镜像）。 */

export type Language = 'zh' | 'en'

export interface Options {
  /** 一轮对话结束时是否通知。 */
  onTurnComplete: boolean
  /** 需要审批时是否通知。 */
  onApproval: boolean
  /** 需要用户回答（含计划评审）时是否通知。 */
  onQuestion: boolean
  /** 轮次以 error 结束时是否通知（默认关闭）。 */
  onTurnError: boolean
  /** 是否包含子代理/队友会话的"完成"通知（审批与提问始终通知）。 */
  includeSubagents: boolean
  /** 通知文案语言。 */
  language: Language
  /** 通知标题前缀。 */
  titlePrefix: string
  /** 是否播放系统通知音。 */
  sound: boolean
  /** 正文最大长度（字符）。 */
  maxBodyLength: number
  /** 轮次结束后等待多久再确认"确实空闲"（毫秒）。 */
  idleGraceMs: number
  /** 用户被询问后等待多久仍未作答才通知（毫秒）。 */
  askGraceMs: number
  /** 同一触发键的去重窗口（毫秒）。 */
  dedupeWindowMs: number
  /** 同一会话内多条确认的合并窗口（毫秒）。 */
  askCoalesceMs: number
  /** 两条通知之间的全局最小间隔（毫秒）。 */
  minIntervalMs: number
  /** 用户作答后是否撤回对应的"待确认"通知。 */
  dismissWhenAnswered: boolean
  /** 插件激活时发一条测试通知（用于验证投递链路）。 */
  onStartup: boolean
  /** 诊断日志文件路径：记录每次投递、撤回与点击回调（默认关闭）。 */
  debugLog?: string
}

export const DEFAULTS: Options = {
  onTurnComplete: true,
  onApproval: true,
  onQuestion: true,
  onTurnError: false,
  includeSubagents: false,
  language: 'zh',
  titlePrefix: 'DSH',
  sound: true,
  maxBodyLength: 200,
  idleGraceMs: 1200,
  askGraceMs: 800,
  dedupeWindowMs: 5000,
  askCoalesceMs: 6000,
  minIntervalMs: 1000,
  dismissWhenAnswered: true,
  onStartup: false,
}

const BOOLEAN_KEYS = [
  'onTurnComplete',
  'onApproval',
  'onQuestion',
  'onTurnError',
  'includeSubagents',
  'sound',
  'dismissWhenAnswered',
  'onStartup',
] as const satisfies readonly (keyof Options)[]

const NUMBER_LIMITS = {
  maxBodyLength: [20, 1000],
  idleGraceMs: [0, 60_000],
  askGraceMs: [0, 60_000],
  dedupeWindowMs: [0, 600_000],
  askCoalesceMs: [0, 600_000],
  minIntervalMs: [0, 600_000],
} as const satisfies Record<string, readonly [number, number]>

type BooleanKey = (typeof BOOLEAN_KEYS)[number]
type NumberKey = keyof typeof NUMBER_LIMITS

/** schemastery `.volatile()` 字段的运行时形状：读取当前值的访问器。 */
interface VolatileBox<T> {
  get(): T
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** 取出 `.volatile()` 访问器里的当前值；普通值原样返回。 */
function unbox(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && typeof (value as VolatileBox<unknown>).get === 'function') {
    return (value as VolatileBox<unknown>).get()
  }
  return value
}

/**
 * 把 `cordis.patch.yml` 的原始 config 归一化成完整选项。
 * 未知键忽略，类型不符的字段回退到默认值，数值字段按范围钳制；
 * `.volatile()` 字段（页面里可改的那些）会先取出访问器当前值。
 * @param raw 原始配置（可能为 undefined 或任意值）。
 * @returns 完整、可信的选项。
 */
export function resolveOptions(raw: unknown): Options {
  const input: Record<string, unknown> = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const output: Options = { ...DEFAULTS }

  for (const key of BOOLEAN_KEYS) {
    const value = unbox(input[key])
    if (typeof value === 'boolean') (output as Record<BooleanKey, boolean>)[key] = value
  }

  for (const key of Object.keys(NUMBER_LIMITS) as NumberKey[]) {
    const value = unbox(input[key])
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    const [min, max] = NUMBER_LIMITS[key]
    output[key] = clamp(value, min, max)
  }

  const language = unbox(input.language)
  if (language === 'zh' || language === 'en') output.language = language

  const prefix = unbox(input.titlePrefix)
  if (typeof prefix === 'string' && prefix.trim() !== '') output.titlePrefix = prefix.trim().slice(0, 40)

  const debugLog = unbox(input.debugLog)
  if (typeof debugLog === 'string' && debugLog.trim() !== '') output.debugLog = debugLog.trim()

  return output
}

/**
 * 生成一份**读取时归一化**的选项视图。
 *
 * 页面里改配置时会更新 volatile 访问器而不重新装配插件，因此每个属性都按需
 * 重新读取当前值——`options.sound` 这类读取永远拿到最新配置。
 * @param raw 插件收到的原始 config（含 volatile 访问器）。
 * @returns 与 {@link Options} 同形、但每次读取都取当前值的对象。
 */
export function liveOptions(raw: unknown): Options {
  const options = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS) as (keyof Options)[]) {
    Object.defineProperty(options, key, {
      enumerable: true,
      configurable: true,
      get: () => resolveOptions(raw)[key],
    })
  }
  return options
}
