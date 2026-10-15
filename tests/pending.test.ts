import { expect, test } from 'vitest'
import { createGate, createPendingTracker } from '../src/lib/pending'
import { fakeScheduler, flush } from './fakes'

test('宽限期内作答不触发，超时才触发一次', async () => {
  const scheduler = fakeScheduler()
  const fired: string[] = []
  const settledLog: Array<[string, boolean]> = []
  const tracker = createPendingTracker({ graceMs: 800, scheduler })

  let answer: () => void = () => {}
  const settled = new Promise<void>((resolve) => {
    answer = resolve
  })
  tracker.watch('k', settled, { onFire: () => fired.push('k'), onSettle: (wasFired) => settledLog.push(['k', wasFired]) })

  scheduler.advance(799)
  expect(fired).toEqual([])

  scheduler.advance(1)
  expect(fired).toEqual(['k'])

  answer()
  await flush()
  expect(settledLog).toEqual([['k', true]])
  expect(scheduler.pending()).toBe(0)
})

test('先作答则不触发，并报告 settle', async () => {
  const scheduler = fakeScheduler()
  const fired: string[] = []
  const settledLog: Array<[string, boolean]> = []
  const tracker = createPendingTracker({ graceMs: 800, scheduler })

  const settled = Promise.resolve()
  tracker.watch('k', settled, { onFire: () => fired.push('k'), onSettle: (wasFired) => settledLog.push(['k', wasFired]) })
  await flush()

  scheduler.advance(10_000)
  expect(fired).toEqual([])
  expect(settledLog).toEqual([['k', false]])
})

test('拒绝的请求同样算 settle', async () => {
  const scheduler = fakeScheduler()
  const settledLog: Array<[string, boolean]> = []
  const tracker = createPendingTracker({ graceMs: 100, scheduler })

  const settled = Promise.reject(new Error('unavailable'))
  tracker.watch('k', settled, { onFire: () => {}, onSettle: (wasFired) => settledLog.push(['k', wasFired]) })
  await flush()

  expect(settledLog).toEqual([['k', false]])
})

test('cancelAll 清掉所有定时器', () => {
  const scheduler = fakeScheduler()
  const fired: string[] = []
  const tracker = createPendingTracker({ graceMs: 100, scheduler })

  tracker.watch('a', new Promise(() => {}), { onFire: () => fired.push('a'), onSettle: () => {} })
  tracker.watch('b', new Promise(() => {}), { onFire: () => fired.push('b'), onSettle: () => {} })
  expect(scheduler.pending()).toBe(2)

  tracker.cancelAll()
  scheduler.advance(10_000)
  expect(fired).toEqual([])
  expect(scheduler.pending()).toBe(0)
})

test('gate 做同键去重与全局最小间隔', () => {
  let now = 0
  const gate = createGate({ windowMs: 5000, minIntervalMs: 1000, now: () => now })

  expect(gate.allow('a')).toBe(true)
  expect(gate.allow('a')).toBe(false)

  now = 1200
  expect(gate.allow('b')).toBe(true)

  now = 1300
  expect(gate.allow('c')).toBe(false)

  now = 6000
  expect(gate.allow('a')).toBe(true)
})

test('pace: false 的调用不受全局最小间隔约束（确认类通知不会被节流丢掉）', () => {
  let now = 0
  const gate = createGate({ windowMs: 5000, minIntervalMs: 1000, now: () => now })

  expect(gate.allow('ask:1', { pace: false })).toBe(true)
  now = 100
  expect(gate.allow('ask:2', { pace: false })).toBe(true)
  now = 200
  expect(gate.allow('ask:3', { pace: false })).toBe(true)
  // 也不该因此占用"上一条通知"的位置：对话完成通知仍按自己的节奏走。
  expect(gate.allow('turn:1')).toBe(true)
  now = 300
  expect(gate.allow('turn:2')).toBe(false)
})

test('被最小间隔挡下时不记键：同一键稍后仍然可以发', () => {
  let now = 0
  const gate = createGate({ windowMs: 5000, minIntervalMs: 1000, now: () => now })

  expect(gate.allow('turn:1')).toBe(true)
  now = 100
  expect(gate.allow('turn:2')).toBe(false) // 过密，被挡下
  now = 1100
  // 旧实现在被节流时也记了键，于是这里会被去重窗口再挡 5 秒；现在不会。
  expect(gate.allow('turn:2')).toBe(true)
})
