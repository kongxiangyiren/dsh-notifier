/**
 * Client 侧上报的单元测试：假 DOM + 假发送实现 + 假时钟。
 *
 * 断言的重点是"什么时候上报什么"：状态变化必须立刻上报、点击被节流但年龄始终准确、
 * 关页后不再声称在场、Host 说没有这条路之后不再白试。
 */

import { expect, test } from 'vitest'
import { startPresenceWatch, type DocumentLike, type EventTargetLike } from '../src/lib/presence-watch'
import type { PresenceReport } from '../src/lib/presence'

/** 记录型事件源：手动触发监听器。 */
interface FakeTarget extends EventTargetLike {
  emit(type: string): void
  listenerCount(type: string): number
}

function fakeTarget(): FakeTarget {
  const listeners = new Map<string, Set<() => void>>()
  return {
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener)
    },
    emit(type) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener()
    },
    listenerCount: (type) => listeners.get(type)?.size ?? 0,
  }
}

interface Harness {
  window: FakeTarget
  document: FakeTarget & DocumentLike
  focus(value: boolean): void
  hide(): void
  show(): void
  advance(ms: number): void
  reports: PresenceReport[]
  sent: string[]
  stop(): void
}

function harness(options: { baseURI?: string; status?: number | undefined } = {}): Harness {
  let focused = true
  let now = 0
  const window = fakeTarget()
  const document = Object.assign(fakeTarget(), {
    baseURI: options.baseURI ?? 'http://127.0.0.1:3080/',
    visibilityState: 'visible',
    hasFocus: () => focused,
  }) as FakeTarget & DocumentLike

  const reports: PresenceReport[] = []
  const sent: string[] = []
  const state = { status: options.status ?? 204 }

  const stop = startPresenceWatch({
    document,
    window,
    now: () => now,
    send: (url, body) => {
      sent.push(url)
      reports.push(JSON.parse(body) as PresenceReport)
      return Promise.resolve(state.status)
    },
  })

  return {
    window,
    document,
    focus: (value) => {
      focused = value
    },
    hide: () => {
      document.visibilityState = 'hidden'
    },
    show: () => {
      document.visibilityState = 'visible'
    },
    advance: (ms) => {
      now += ms
    },
    reports,
    sent,
    stop,
  }
}

/** 让 `send(...).then(...)` 的回调跑完。 */
const turn = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

test('启动时先报一次：页面在前台但还没点过', async () => {
  const h = harness()
  await turn()

  expect(h.reports).toEqual([{ focused: true, clickAgeMs: null }])
  expect(h.sent).toEqual(['http://127.0.0.1:3080/@kongxiangyiren/dsh-notifier/presence'])
})

test('聚焦/失焦/可见性变化立刻上报，且携带累计的点击年龄', async () => {
  const h = harness()
  h.document.emit('pointerdown')
  h.advance(5_000)

  h.focus(false)
  h.window.emit('blur')
  expect(h.reports.at(-1)).toEqual({ focused: false, clickAgeMs: 5_000 })

  h.advance(1_000)
  h.focus(true)
  h.window.emit('focus')
  expect(h.reports.at(-1)).toEqual({ focused: true, clickAgeMs: 6_000 })

  h.hide()
  h.document.emit('visibilitychange')
  expect(h.reports.at(-1)).toEqual({ focused: false, clickAgeMs: 6_000 })

  h.show()
  h.document.emit('visibilitychange')
  expect(h.reports.at(-1)).toEqual({ focused: true, clickAgeMs: 6_000 })
})

test('连点被节流，但年龄始终按最后一次点击计算', async () => {
  const h = harness()
  const before = h.reports.length

  h.document.emit('pointerdown')
  h.advance(100)
  h.document.emit('pointerdown')
  h.advance(100)
  h.document.emit('pointerdown')
  // 1 秒内的连点只发第一条。
  expect(h.reports.length - before).toBe(1)
  expect(h.reports.at(-1)).toEqual({ focused: true, clickAgeMs: 0 })

  // 又过了 2 秒：才允许下一条点击上报，年龄是"距最后一次点击"，不是距上一次上报。
  h.advance(2_000)
  h.document.emit('pointerdown')
  expect(h.reports.length - before).toBe(2)
  expect(h.reports.at(-1)?.clickAgeMs).toBe(0)

  // 状态变化不受节流影响，且年龄仍是最后那次点击。
  h.advance(3_000)
  h.focus(false)
  h.window.emit('blur')
  expect(h.reports.at(-1)).toEqual({ focused: false, clickAgeMs: 3_000 })
})

test('pagehide 之后一律按"不在场"上报', async () => {
  const h = harness()
  h.window.emit('pagehide')
  expect(h.reports.at(-1)?.focused).toBe(false)

  h.document.emit('pointerdown')
  expect(h.reports.at(-1)?.focused).toBe(false)
})

test('Host 没有这条路由（404/405）后停止上报', async () => {
  const missing = harness({ status: 404 })
  await turn()
  expect(missing.reports).toHaveLength(1)

  missing.document.emit('pointerdown')
  missing.window.emit('blur')
  await turn()
  expect(missing.reports).toHaveLength(1)
})

test('上报被拒绝（4xx）时记一条日志，但不停止上报', async () => {
  const window = fakeTarget()
  const document = Object.assign(fakeTarget(), {
    baseURI: 'http://127.0.0.1:3080/',
    visibilityState: 'visible',
    hasFocus: () => true,
  }) as FakeTarget & DocumentLike
  const logs: string[] = []
  const stop = startPresenceWatch({
    document,
    window,
    send: () => Promise.resolve(400),
    log: (message) => logs.push(message),
  })
  await turn()
  expect(logs).toHaveLength(1)

  document.emit('pointerdown')
  await turn()
  expect(logs).toHaveLength(2)
  stop()
})

test('stop 之后不再上报，监听器全部摘掉', async () => {
  const h = harness()
  h.stop()

  expect(h.window.listenerCount('focus')).toBe(0)
  expect(h.window.listenerCount('blur')).toBe(0)
  expect(h.window.listenerCount('pagehide')).toBe(0)
  expect(h.document.listenerCount('visibilitychange')).toBe(0)
  expect(h.document.listenerCount('pointerdown')).toBe(0)

  const before = h.reports.length
  h.document.emit('pointerdown')
  h.window.emit('focus')
  await turn()
  expect(h.reports.length).toBe(before)
})

test('没有 document/window（非浏览器）或解析不出地址时安静地什么都不做', () => {
  expect(() => startPresenceWatch({})()).not.toThrow()
  expect(() => startPresenceWatch({ document: fakeTarget(), window: fakeTarget() })()).not.toThrow()
})
