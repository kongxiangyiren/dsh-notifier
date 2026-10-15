import { expect, test } from 'vitest'
import { createPresenceTracker, isQuiet, MAX_CLICK_AGE_MS, parsePresenceReport } from '../src/lib/presence'

test('合法上报原样归一化', () => {
  expect(parsePresenceReport({ focused: true, clickAgeMs: 1234 })).toEqual({ focused: true, clickAgeMs: 1234 })
  expect(parsePresenceReport({ focused: false, clickAgeMs: null })).toEqual({ focused: false, clickAgeMs: null })
  expect(parsePresenceReport({ focused: true })).toEqual({ focused: true, clickAgeMs: null })
})

test('异常上报一律拒绝', () => {
  for (const bad of [
    undefined,
    null,
    'focused',
    42,
    [],
    {},
    { focused: 'yes' },
    { focused: true, clickAgeMs: -1 },
    { focused: true, clickAgeMs: Number.NaN },
    { focused: true, clickAgeMs: Number.POSITIVE_INFINITY },
    { focused: true, clickAgeMs: '3' },
  ]) {
    expect(parsePresenceReport(bad), JSON.stringify(bad)).toBeUndefined()
  }
})

test('点击年龄被钳到上限，防止异常值参与判定', () => {
  expect(parsePresenceReport({ focused: true, clickAgeMs: MAX_CLICK_AGE_MS * 10 })?.clickAgeMs).toBe(MAX_CLICK_AGE_MS)
})

test('判定：前台 + 刚点过才安静', () => {
  const snapshot = { focused: true, clickAgeMs: 1000, receivedAt: 0 }
  expect(isQuiet(snapshot, 0, 60_000)).toBe(true)
  // 上报后时间流逝，年龄跟着长：1s + 58s = 59s，仍在 1 分钟窗口内。
  expect(isQuiet(snapshot, 58_000, 60_000)).toBe(true)
  // 60s 整仍算"不超过一分钟"。
  expect(isQuiet(snapshot, 59_000, 60_000)).toBe(true)
  expect(isQuiet(snapshot, 59_001, 60_000)).toBe(false)
})

test('判定：没上报、不在前台、没点过、窗口为 0 都不安静', () => {
  expect(isQuiet(undefined, 0, 60_000)).toBe(false)
  expect(isQuiet({ focused: false, clickAgeMs: 0, receivedAt: 0 }, 0, 60_000)).toBe(false)
  expect(isQuiet({ focused: true, clickAgeMs: null, receivedAt: 0 }, 0, 60_000)).toBe(false)
  expect(isQuiet({ focused: true, clickAgeMs: 0, receivedAt: 0 }, 0, 0)).toBe(true)
  // 窗口为 0 时，哪怕只过去 1ms 也不再安静。
  expect(isQuiet({ focused: true, clickAgeMs: 0, receivedAt: 0 }, 1, 0)).toBe(false)
})

test('判定器只认最后一次上报，且拒绝的上报不改变状态', () => {
  const presence = createPresenceTracker()
  expect(presence.snapshot()).toBeUndefined()
  expect(presence.shouldStayQuiet(0, 60_000)).toBe(false)

  expect(presence.report({ focused: true, clickAgeMs: 0 }, 1000)).toBe(true)
  expect(presence.snapshot()).toEqual({ focused: true, clickAgeMs: 0, receivedAt: 1000 })
  expect(presence.shouldStayQuiet(30_000, 60_000)).toBe(true)

  // 坏上报被拒，状态保持上一条。
  expect(presence.report({ focused: 'maybe' }, 31_000)).toBe(false)
  expect(presence.snapshot()?.receivedAt).toBe(1000)

  // 失焦上报立刻解除安静。
  expect(presence.report({ focused: false, clickAgeMs: 0 }, 32_000)).toBe(true)
  expect(presence.shouldStayQuiet(32_000, 60_000)).toBe(false)

  presence.clear()
  expect(presence.snapshot()).toBeUndefined()
})
