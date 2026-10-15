/**
 * Client 半体：监听本页的聚焦/可见性与指针点击，把"在场"事实 POST 给 Host 半体的路由。
 *
 * 这里只上报事实，不做判断（判断在 Host，见 `presence.ts`）：
 * - 窗口 `focus` / `blur`、`document` 的 `visibilitychange`、`pagehide` → **立刻**上报（状态变化必须及时）；
 * - `pointerdown`（捕获阶段、passive）→ 刷新"点击年龄"，最多每 {@link DEFAULT_MIN_INTERVAL_MS} 一条，
 *   连点不会刷屏；被节流掉的那次仍然刷新年龄，所以年龄始终准确；
 * - 启动时上报一次，让 Host 知道"页面在这儿、还没点过"（`clickAgeMs: null`）。
 *
 * 浏览器 API 在这里用最小结构面声明：本仓库 tsconfig 只带 node 类型（不引 DOM lib），
 * 而实际用到的只有 `addEventListener` / `hasFocus` / `visibilityState` / `fetch` 这几样；
 * 声明成可注入的选项后，单测不需要真浏览器（与 `pending.ts` 注入时钟同一思路）。
 */

import { PRESENCE_PATH, type PresenceReport } from './presence'

/** 可订阅事件的最小结构面。 */
export interface EventTargetLike {
  addEventListener(type: string, listener: () => void, options?: { capture?: boolean; passive?: boolean }): void
  removeEventListener(type: string, listener: () => void, options?: { capture?: boolean; passive?: boolean }): void
}

/** 本模块用到的 `document` 部分。 */
export interface DocumentLike extends EventTargetLike {
  /** 相对 URL 的解析基准（`document.baseURI`）。 */
  baseURI?: string | undefined
  /** `document.visibilityState`。 */
  visibilityState?: string | undefined
  /** `document.hasFocus()`。 */
  hasFocus?: (() => boolean) | undefined
}

/** 本模块用到的 `window` 部分。 */
export type WindowLike = EventTargetLike

/** 一次上报的发送结果。 */
export type PresenceSender = (url: string, body: string) => Promise<number | undefined>

/** 桌面壳注入的传输事实（官方 Client 包同样的取法，见 `dsh-api-gateway` 的 Client 半体）。 */
interface TransportFacts {
  streamBaseUrl?: string | undefined
}

/** 用到的最小 `fetch` 形状。 */
interface FetchLike {
  (
    input: string,
    init: {
      method: string
      headers: Record<string, string>
      body: string
      keepalive?: boolean
      credentials?: string
    },
  ): Promise<{ status: number }>
}

/** 点击上报的最小间隔，避免连点刷屏。 */
export const DEFAULT_MIN_INTERVAL_MS = 1000

/** 默认发送实现：同源 POST，带会话 cookie；关页/切走时靠 `keepalive` 送出最后一条。 */
async function defaultSender(url: string, body: string): Promise<number | undefined> {
  const fetchImpl = (globalThis as { fetch?: FetchLike }).fetch
  if (fetchImpl === undefined) return undefined
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true,
    credentials: 'same-origin',
  })
  return response.status
}

/** 解析上报地址：优先显式地址，其次走页面基地址（与官方 Client 包一致的相对解析）。 */
function resolveUrl(options: PresenceWatchOptions, doc: DocumentLike): string | undefined {
  if (options.url !== undefined) return options.url
  const transport = (globalThis as { __DSH_TRANSPORT__?: TransportFacts }).__DSH_TRANSPORT__
  const base = transport?.streamBaseUrl ?? doc.baseURI
  if (base === undefined) return undefined
  try {
    return new URL(PRESENCE_PATH.replace(/^\//, ''), base).href
  } catch {
    return undefined
  }
}

export interface PresenceWatchOptions {
  /** 页面 document；缺省取 `globalThis.document`。 */
  document?: DocumentLike | undefined
  /** 页面 window；缺省取 `globalThis.window`。 */
  window?: WindowLike | undefined
  /** 上报地址；缺省按页面基地址解析 {@link PRESENCE_PATH}。 */
  url?: string | undefined
  /** 发送实现；缺省用 `fetch`（单测注入）。 */
  send?: PresenceSender | undefined
  /** 时钟；缺省 `Date.now`（单测注入）。 */
  now?: (() => number) | undefined
  /** 两次点击上报的最小间隔，缺省 {@link DEFAULT_MIN_INTERVAL_MS}。 */
  minIntervalMs?: number | undefined
  /** 诊断输出（例如 Host 没有这条路由）。 */
  log?: ((message: string) => void) | undefined
}

/**
 * 开始上报。没有 document/window（非浏览器）或解析不出地址时什么也不做。
 * @param options 事件源、地址、发送实现与时钟。
 * @returns 停止函数：摘掉全部监听（此后不再上报）。
 */
export function startPresenceWatch(options: PresenceWatchOptions = {}): () => void {
  const globals = globalThis as { document?: DocumentLike; window?: WindowLike }
  const doc = options.document ?? globals.document
  const win = options.window ?? globals.window
  if (doc === undefined || win === undefined) return () => {}
  const url = resolveUrl(options, doc)
  if (url === undefined) return () => {}

  const send = options.send ?? defaultSender
  const now = options.now ?? ((): number => Date.now())
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS

  let stopped = false
  /** Host 明确说"没有这条路由"后就不再白试。 */
  let disabled = false
  /** `pagehide` 之后页面就不再是"在场"了。 */
  let leaving = false
  let lastClickAt: number | undefined
  let lastClickSentAt = Number.NEGATIVE_INFINITY

  const isFocused = (): boolean => {
    if (leaving || doc.visibilityState === 'hidden') return false
    return doc.hasFocus?.() === true
  }

  const report = (kind: 'event' | 'click'): void => {
    if (stopped || disabled) return
    const at = now()
    if (kind === 'click') {
      // 无论是否被节流，年龄都要刷新——Host 依赖它判定"刚点过"。
      lastClickAt = at
      if (at - lastClickSentAt < minIntervalMs) return
      lastClickSentAt = at
    }
    const payload: PresenceReport = {
      focused: isFocused(),
      clickAgeMs: lastClickAt === undefined ? null : Math.max(0, Math.round(at - lastClickAt)),
    }
    void send(url, JSON.stringify(payload)).then(
      (status) => {
        if (status === 404 || status === 405) {
          disabled = true
          options.log?.('Host 未提供在场判定路由，已停止上报')
        } else if (status !== undefined && status >= 400) {
          options.log?.(`在场判定上报被拒绝（HTTP ${status}）`)
        }
      },
      () => {
        // 上报失败只影响"是否少弹一条通知"，不值得打扰用户。
      },
    )
  }

  const onFocus = (): void => report('event')
  const onBlur = (): void => report('event')
  const onVisibility = (): void => report('event')
  const onPointerDown = (): void => report('click')
  const onPageHide = (): void => {
    leaving = true
    report('event')
  }

  win.addEventListener('focus', onFocus)
  win.addEventListener('blur', onBlur)
  win.addEventListener('pagehide', onPageHide)
  doc.addEventListener('visibilitychange', onVisibility)
  doc.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })

  report('event')

  return () => {
    stopped = true
    win.removeEventListener('focus', onFocus)
    win.removeEventListener('blur', onBlur)
    win.removeEventListener('pagehide', onPageHide)
    doc.removeEventListener('visibilitychange', onVisibility)
    doc.removeEventListener('pointerdown', onPointerDown, { capture: true })
  }
}
