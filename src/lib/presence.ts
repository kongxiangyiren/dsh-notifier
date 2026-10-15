/**
 * 「你现在就在页面前吗」——两侧共用的上报协议与 Host 侧判定。
 *
 * 系统通知只在**人不在页面前**时才有价值。判定需要两条只有浏览器才知道的事实：
 * 页面是否处于前台、以及最近一次指针点击过去了多久；所以 Client 半体按下面的协议
 * 把事实 POST 给 Host 半体注册的路由（路由注册见 `presence-channel.ts`）：
 *
 * ```text
 * POST /@kongxiangyiren/dsh-notifier/presence
 * {"focused": true, "clickAgeMs": 1234}
 * ```
 *
 * 上报的是**点击年龄**而不是时间戳：这样两端时钟不齐也不影响判定——Host 收到时记下
 * 自己的时刻，之后每次判定让年龄自然增长即可。
 *
 * 本文件没有任何宿主/浏览器专有依赖，Host 与 Client 两个半体共用（协议只有一份）。
 */

/** 上报路由：Host 注册精确路由，Client 以**相对文档**的地址 POST（支持非根挂载）。 */
export const PRESENCE_PATH = '/@kongxiangyiren/dsh-notifier/presence'

/** 点击年龄上限：超过即视为"很久以前"，防止异常值参与判定。 */
export const MAX_CLICK_AGE_MS = 24 * 60 * 60 * 1000

/** 一次上报里的事实。 */
export interface PresenceReport {
  /** 页面是否在前台：窗口有焦点且文档可见。 */
  focused: boolean
  /** 距最近一次指针点击的毫秒数；从未点击过时为 null。 */
  clickAgeMs: number | null
}

/**
 * 归一化一条上报：字段缺失或类型不符时返回 undefined（调用方应丢弃整条上报，不改变现有状态）。
 * @param value 请求体解析出的任意值。
 * @returns 可信的事实，或 undefined。
 */
export function parsePresenceReport(value: unknown): PresenceReport | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (typeof input.focused !== 'boolean') return undefined
  const age = input.clickAgeMs
  if (age !== null && age !== undefined && (typeof age !== 'number' || !Number.isFinite(age) || age < 0)) {
    return undefined
  }
  return {
    focused: input.focused,
    clickAgeMs: typeof age === 'number' ? Math.min(age, MAX_CLICK_AGE_MS) : null,
  }
}

/** Host 侧保存的一条事实，外加收到它的时刻。 */
export interface PresenceSnapshot extends PresenceReport {
  /** Host 收到该上报的时刻（与判定使用同一个时钟）。 */
  receivedAt: number
}

/**
 * 判定：页面在前台，且最近一次点击还在窗口内。
 * @param snapshot 最近一条上报；从未上报过时 undefined。
 * @param now 判定时刻。
 * @param clickWindowMs "刚点过"的时间窗（毫秒）。
 * @returns true 表示此刻应当保持安静（不弹通知）。
 */
export function isQuiet(snapshot: PresenceSnapshot | undefined, now: number, clickWindowMs: number): boolean {
  if (snapshot === undefined || !snapshot.focused) return false
  if (snapshot.clickAgeMs === null) return false
  return snapshot.clickAgeMs + Math.max(0, now - snapshot.receivedAt) <= Math.max(0, clickWindowMs)
}

/** 「用户在不在页面前」的状态机（纯逻辑，时钟由调用方给出）。 */
export interface PresenceTracker {
  /** 记下一条上报；协议不合法时返回 false 且不改变状态。 */
  report(value: unknown, now: number): boolean
  /** 最近一条上报（诊断用）。 */
  snapshot(): PresenceSnapshot | undefined
  /** 此刻是否该保持安静。 */
  shouldStayQuiet(now: number, clickWindowMs: number): boolean
  clear(): void
}

/**
 * 创建判定器。
 *
 * 状态就是**最后一次**上报：多个 DSH 标签页各自上报、后到的为准（正常的聚焦/失焦顺序
 * 下即"当前在前台的那个标签页"，这与只开一个标签页时的直觉一致）。
 * @returns 判定器。
 */
export function createPresenceTracker(): PresenceTracker {
  let current: PresenceSnapshot | undefined

  return {
    report(value, now) {
      const parsed = parsePresenceReport(value)
      if (parsed === undefined) return false
      current = { ...parsed, receivedAt: now }
      return true
    },
    snapshot: () => current,
    shouldStayQuiet: (now, clickWindowMs) => isQuiet(current, now, clickWindowMs),
    clear() {
      current = undefined
    },
  }
}
