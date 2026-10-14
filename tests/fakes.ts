/** 单测替身：手动时钟、记录型通知器与日志。 */

import type { Notifier } from '../src/lib/notifier'
import type { Scheduler } from '../src/lib/pending'
import type { LoggerLike, NotificationRequest } from '../src/lib/types'

export interface FakeScheduler extends Scheduler {
  /** 推进虚拟时间并按时序执行到期回调（期间新排的回调也会被执行）。 */
  advance(ms: number): void
  /** 仍在等待的定时器数量。 */
  pending(): number
}

export function fakeScheduler(): FakeScheduler {
  let now = 0
  let nextHandle = 1
  const timers = new Map<number, { at: number; callback: () => void }>()

  return {
    now: () => now,
    schedule(callback, delayMs) {
      const handle = nextHandle++
      timers.set(handle, { at: now + Math.max(0, delayMs), callback })
      return () => {
        timers.delete(handle)
      }
    },
    advance(ms) {
      const target = now + ms
      for (;;) {
        let next: { handle: number; at: number; callback: () => void } | undefined
        for (const [handle, timer] of timers) {
          if (timer.at > target) continue
          if (next === undefined || timer.at < next.at) next = { handle, at: timer.at, callback: timer.callback }
        }
        if (next === undefined) break
        timers.delete(next.handle)
        now = next.at
        next.callback()
      }
      now = target
    },
    pending: () => timers.size,
  }
}

export interface FakeNotifier extends Notifier {
  sent: NotificationRequest[]
  dismissed: number[]
}

export function fakeNotifier(): FakeNotifier {
  const sent: NotificationRequest[] = []
  const dismissed: number[] = []
  let nextId = 1

  return {
    sent,
    dismissed,
    notify(request) {
      sent.push(request)
      return nextId++
    },
    dismiss(id) {
      dismissed.push(id)
    },
    dispose() {},
  }
}

/** 每次投递都抛异常的通知器，用于验证失败不影响 Agent。 */
export function throwingNotifier(): Notifier {
  return {
    notify() {
      throw new Error('boom')
    },
    dismiss() {
      throw new Error('boom')
    },
    dispose() {},
  }
}

export interface FakeLogger extends LoggerLike {
  warnings: string[]
}

export function fakeLogger(): FakeLogger {
  const warnings: string[] = []
  return {
    warnings,
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => {
      warnings.push(args.map((value) => String(value)).join(' '))
    },
  }
}

/** 让已 resolve 的 Promise 链跑完。 */
export async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
