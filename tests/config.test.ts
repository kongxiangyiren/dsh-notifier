import { expect, test } from 'vitest'
import { DEFAULTS, liveOptions, resolveOptions } from '../src/lib/config'

test('缺失或非法配置回退到默认值', () => {
  expect(resolveOptions(undefined)).toEqual(DEFAULTS)
  expect(resolveOptions(null)).toEqual(DEFAULTS)
  expect(resolveOptions('nope')).toEqual(DEFAULTS)
  expect(resolveOptions({ onApproval: 'yes', language: 'fr', maxBodyLength: Number.NaN })).toEqual(DEFAULTS)
})

test('合法字段被接受', () => {
  const options = resolveOptions({
    onApproval: false,
    includeSubagents: true,
    language: 'en',
    titlePrefix: '  Harness  ',
    onStartup: true,
  })

  expect(options.onApproval).toBe(false)
  expect(options.includeSubagents).toBe(true)
  expect(options.language).toBe('en')
  expect(options.titlePrefix).toBe('Harness')
  expect(options.onStartup).toBe(true)
})

test('appID 不可被配置覆盖（固定为 dsh）', () => {
  expect(resolveOptions({ appID: 'other' })).toEqual(DEFAULTS)
})

test('数值字段取整并钳制到范围内', () => {
  const options = resolveOptions({
    idleGraceMs: -5,
    askGraceMs: 999_999,
    maxBodyLength: 10.6,
    minIntervalMs: 1.4,
    dedupeWindowMs: 0,
  })

  expect(options.idleGraceMs).toBe(0)
  expect(options.askGraceMs).toBe(60_000)
  expect(options.maxBodyLength).toBe(20)
  expect(options.minIntervalMs).toBe(1)
  expect(options.dedupeWindowMs).toBe(0)
})

test('未知键与空白字符串被忽略', () => {
  const options = resolveOptions({ nope: 1, titlePrefix: '   ' })
  expect(options).toEqual(DEFAULTS)
})

test('resolveOptions 解开 .volatile() 访问器（{ get() }）', () => {
  const options = resolveOptions({
    sound: { get: () => false },
    language: { get: () => 'en' },
    idleGraceMs: { get: () => 2500 },
    titlePrefix: { get: () => 'Harness' },
  })

  expect(options.sound).toBe(false)
  expect(options.language).toBe('en')
  expect(options.idleGraceMs).toBe(2500)
  expect(options.titlePrefix).toBe('Harness')
})

test('liveOptions 每次读取都取当前值：页面改配置即时生效', () => {
  const live: Record<string, unknown> = { sound: true }
  const config = new Proxy(
    {},
    {
      get: (_target, key: string) => {
        const value = live[key]
        return value === undefined ? undefined : { get: () => value }
      },
      has: () => true,
    },
  )
  const options = liveOptions(config)

  expect(options.sound).toBe(true)
  expect(options.language).toBe('zh')

  // 模拟页面里把配置改掉（volatile 访问器返回新值，插件不重新装配）
  live.sound = false
  live.language = 'en'
  live.askCoalesceMs = 12_000

  expect(options.sound).toBe(false)
  expect(options.language).toBe('en')
  expect(options.askCoalesceMs).toBe(12_000)
  expect(options.dismissWhenAnswered).toBe(true)
})

test('liveOptions 对残缺配置仍给出默认值', () => {
  const options = liveOptions(undefined)
  expect(options).toEqual(DEFAULTS)
  expect(options.sound).toBe(true)
})
