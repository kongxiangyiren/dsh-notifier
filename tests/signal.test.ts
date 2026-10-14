import { expect, test } from 'vitest'
import { shareCancellation, type CancellableRequest } from '../src/lib/signal'

test('原信号已有的取消语义被保留', () => {
  const original = new AbortController()
  const own = new AbortController()
  const request: CancellableRequest = { signal: original.signal }

  const shared = shareCancellation(request, own)
  expect(request.signal).toBe(shared)
  expect(shared.aborted).toBe(false)

  original.abort(new Error('tool cancelled'))
  expect(shared.aborted).toBe(true)
  expect(shared.reason).toBeInstanceOf(Error)
})

test('插件自己的控制器可以取消请求（用于关掉页面卡片）', () => {
  const original = new AbortController()
  const own = new AbortController()
  const request: CancellableRequest = { signal: original.signal }

  const shared = shareCancellation(request, own)
  own.abort(new Error('answered from notification'))

  expect(shared.aborted).toBe(true)
  expect(String(shared.reason)).toContain('answered from notification')
  expect(original.signal.aborted).toBe(false)

  // 反向仍成立：原信号随后取消，共享信号已经处于取消态
  original.abort(new Error('later'))
  expect(shared.aborted).toBe(true)
})

test('没有原信号时直接使用自己的信号', () => {
  const own = new AbortController()
  const request: CancellableRequest = {}

  const shared = shareCancellation(request, own)
  expect(shared).toBe(own.signal)
  own.abort()
  expect(request.signal?.aborted).toBe(true)
})

test('原信号已取消时共享信号立即处于取消态', () => {
  const original = new AbortController()
  original.abort(new Error('already'))
  const request: CancellableRequest = { signal: original.signal }

  const shared = shareCancellation(request, new AbortController())
  expect(shared.aborted).toBe(true)
})

test('重复共享同一个控制器不会叠加包装', () => {
  const own = new AbortController()
  const request: CancellableRequest = { signal: own.signal }

  const shared = shareCancellation(request, own)
  expect(shared).toBe(own.signal)
})

test('请求对象被冻结时不抛异常', () => {
  const own = new AbortController()
  const request = Object.freeze({ signal: new AbortController().signal }) as CancellableRequest

  const shared = shareCancellation(request, own)
  expect(shared.aborted).toBe(false)
  expect(request.signal).not.toBe(shared)
})
