/** 宽限竞态、去重与节流：纯逻辑，时钟与定时器由外部注入，便于单测。 */

/** 定时与时钟抽象（生产实现见 {@link systemScheduler}）。 */
export interface Scheduler {
  now(): number
  /** 安排一次回调，返回取消函数。 */
  schedule(callback: () => void, delayMs: number): () => void
}

/** 基于 `setTimeout` / `Date.now` 的实现。插件里用 `ctx.timeout` 包装后传入亦可。 */
export function systemScheduler(): Scheduler {
  return {
    now: () => Date.now(),
    schedule(callback, delayMs) {
      const timer = setTimeout(callback, Math.max(0, delayMs))
      return () => clearTimeout(timer)
    },
  }
}

export interface PendingHooks {
  /** 宽限期结束时仍未 settle。 */
  onFire(): void
  /** 请求 settle（无论是否已 fire）。 */
  onSettle(fired: boolean): void
}

export interface PendingTracker {
  /** 观察一个尚未 settle 的请求；同键重复观察时以最后一次为准。 */
  watch(key: string, settled: Promise<unknown>, hooks: PendingHooks): void
  cancelAll(): void
}

/**
 * "询问后仍未作答"判定：宽限期内 settle 则不触发，超时则触发一次。
 * @param input 宽限毫秒数与调度器。
 */
export function createPendingTracker(input: { graceMs: number; scheduler: Scheduler }): PendingTracker {
  interface Entry {
    cancelTimer: () => void
    fired: boolean
    onSettle(fired: boolean): void
  }

  const active = new Map<string, Entry>()

  return {
    watch(key, settled, hooks) {
      active.get(key)?.cancelTimer()

      const entry: Entry = {
        cancelTimer: () => {},
        fired: false,
        onSettle: hooks.onSettle,
      }
      entry.cancelTimer = input.scheduler.schedule(() => {
        entry.fired = true
        hooks.onFire()
      }, input.graceMs)
      active.set(key, entry)

      const settle = (): void => {
        if (active.get(key) !== entry) return
        active.delete(key)
        entry.cancelTimer()
        entry.onSettle(entry.fired)
      }

      settled.then(settle, settle)
    },

    cancelAll() {
      for (const entry of active.values()) entry.cancelTimer()
      active.clear()
    },
  }
}

export interface Gate {
  /**
   * 该键此刻是否允许发出通知。
   * @param key 去重键。
   * @param options 可选：`pace: false` 表示不受全局最小间隔约束——确认类通知用它，
   *   因为"需要用户作答"的提示一旦被节流丢掉，就等于丢了一次请求。
   */
  allow(key: string, options?: { pace?: boolean }): boolean
}

/**
 * 去重 + 全局最小间隔。
 * 同键在窗口内重复返回 false；距上一条通知不足最小间隔时返回 false
 * （被最小间隔挡下时**不**记键：那只是"过密"，不是重复，同一键稍后仍应能发）。
 * @param input 窗口毫秒数、最小间隔毫秒数与时钟。
 */
export function createGate(input: { windowMs: number; minIntervalMs: number; now: () => number }): Gate {
  const lastByKey = new Map<string, number>()
  let lastAny = Number.NEGATIVE_INFINITY

  const prune = (now: number): void => {
    if (lastByKey.size <= 200) return
    for (const [key, at] of lastByKey) if (now - at > input.windowMs) lastByKey.delete(key)
  }

  return {
    allow(key, options = {}) {
      const now = input.now()
      const previous = lastByKey.get(key)
      if (previous !== undefined && now - previous < input.windowMs) return false
      const pace = options.pace !== false
      if (pace && now - lastAny < input.minIntervalMs) return false
      lastByKey.set(key, now)
      if (pace) lastAny = now
      prune(now)
      return true
    },
  }
}
