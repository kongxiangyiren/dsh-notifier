/**
 * 上报路由的真实 HTTP 测试：真 `node:http` 服务器 + 真请求。
 *
 * 这里刻意不 mock 请求/响应对象——异步读体、状态码、超限处理这些正是容易写错、
 * 又必须真的跑一遍才知道对不对的部分。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, expect, test } from 'vitest'
import { createPresenceTracker, PRESENCE_PATH, type PresenceTracker } from '../src/lib/presence'
import { registerPresenceRoute, type ConnectionGuardLike, type WebServerLike } from '../src/lib/presence-channel'
import { fakeLogger, type FakeLogger } from './fakes'
import { postJson, serve, sendRequest, type TestServer } from './http'

interface Harness {
  url: string
  presence: PresenceTracker
  logger: FakeLogger
  /** 当前注册的路由（验证 dispose 用）。 */
  route: () => { path: string } | undefined
  dispose: () => void
  server: TestServer
}

const open: Harness[] = []

afterEach(async () => {
  for (const harness of open.splice(0)) {
    harness.dispose()
    await harness.server.close()
  }
})

/** 起一个只挂本插件路由的真服务器。 */
async function start(
  options: {
    guard?: ConnectionGuardLike | undefined
    quiet?: (() => boolean) | undefined
    now?: (() => number) | undefined
    presence?: PresenceTracker | undefined
  } = {},
): Promise<Harness> {
  const presence = options.presence ?? createPresenceTracker()
  const logger = fakeLogger()
  let registered: { path: string; handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void> } | undefined

  const webServer: WebServerLike = {
    register(route) {
      registered = route
      return () => {
        registered = undefined
      }
    },
  }
  const dispose = registerPresenceRoute({
    webServer,
    presence,
    logger,
    now: options.now ?? (() => Date.now()),
    quiet: options.quiet,
    guard: options.guard,
  })

  const server = await serve((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (registered !== undefined && pathname === registered.path) {
      void registered.handler(request, response)
      return
    }
    response.writeHead(404).end()
  })

  const harness: Harness = {
    url: `${server.origin}${PRESENCE_PATH}`,
    presence,
    logger,
    route: () => registered,
    dispose,
    server,
  }
  open.push(harness)
  return harness
}

test('POST 上报被记录，回 204 且不带正文', async () => {
  const harness = await start()
  const response = await postJson(harness.url, { focused: true, clickAgeMs: 500 })

  expect(response.status).toBe(204)
  expect(response.body).toBe('')
  expect(harness.presence.snapshot()).toMatchObject({ focused: true, clickAgeMs: 500 })
})

test('时钟由注入的 now 决定（判定用的时刻就是收到上报的时刻）', async () => {
  const harness = await start({ now: () => 1_000_000 })
  await postJson(harness.url, { focused: true, clickAgeMs: 0 })
  expect(harness.presence.snapshot()?.receivedAt).toBe(1_000_000)
  expect(harness.presence.shouldStayQuiet(1_010_000, 60_000)).toBe(true)
})

test('GET 回显当前判定，HEAD 只给头', async () => {
  let now = 5_000
  const harness = await start({ now: () => now, quiet: () => true })
  const before = await sendRequest(harness.url)
  expect(before.status).toBe(200)
  expect(JSON.parse(before.body)).toEqual({ known: false, quiet: true })

  await postJson(harness.url, { focused: true, clickAgeMs: 2_000 })
  now = 8_000
  const after = await sendRequest(harness.url, { headers: { accept: 'application/json' } })
  expect(JSON.parse(after.body)).toEqual({ known: true, focused: true, clickAgeMs: 2_000, receivedAgoMs: 3_000, quiet: true })

  const head = await sendRequest(harness.url, { method: 'HEAD' })
  expect(head.status).toBe(200)
  expect(head.body).toBe('')
  expect(head.headers['content-length']).toBe(String(Buffer.byteLength(after.body)))
})

test('坏请求体：非法 JSON、字段不符、非 JSON 类型、超限', async () => {
  const harness = await start()

  const badJson = await postJson(harness.url, '{not json')
  expect(badJson.status).toBe(400)
  expect(JSON.parse(badJson.body).error).toBe('invalid-json')

  const badReport = await postJson(harness.url, { focused: 'yes' })
  expect(badReport.status).toBe(400)
  expect(JSON.parse(badReport.body).error).toBe('invalid-report')
  expect(harness.presence.snapshot()).toBeUndefined()

  const wrongType = await sendRequest(harness.url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })
  expect(wrongType.status).toBe(415)

  const tooLarge = await postJson(harness.url, { focused: true, clickAgeMs: 0, pad: 'x'.repeat(4096) })
  expect(tooLarge.status).toBe(413)
  expect(harness.presence.snapshot()).toBeUndefined()
})

test('只接受 POST/GET/HEAD，其余方法 405 且给出 Allow', async () => {
  const harness = await start()
  const response = await sendRequest(harness.url, { method: 'PUT' })
  expect(response.status).toBe(405)
  expect(response.headers.allow).toBe('GET, HEAD, POST')
})

test('跨站请求被 Fetch Metadata 拦下', async () => {
  const harness = await start()
  const response = await postJson(harness.url, { focused: true, clickAgeMs: 0 }, { 'sec-fetch-site': 'cross-site' })

  expect(response.status).toBe(403)
  expect(JSON.parse(response.body).error).toBe('cross-site')
  expect(harness.presence.snapshot()).toBeUndefined()
})

test('同源（以及非浏览器客户端）放行', async () => {
  const harness = await start()
  expect((await postJson(harness.url, { focused: true, clickAgeMs: 0 }, { 'sec-fetch-site': 'same-origin' })).status).toBe(204)
  expect((await postJson(harness.url, { focused: true, clickAgeMs: 0 }, { 'sec-fetch-site': 'none' })).status).toBe(204)
  expect((await postJson(harness.url, { focused: true, clickAgeMs: 0 })).status).toBe(204)
})

test('浏览器会话认证：栅栏拒绝时一律 401/403，且不改变状态', async () => {
  let rejection: 401 | 403 | undefined = 401
  const seen: string[] = []
  const harness = await start({
    guard: {
      requestRejection: (request) => {
        seen.push(String(request.headers['cookie'] ?? 'none'))
        return rejection
      },
    },
  })

  const refused = await postJson(harness.url, { focused: true, clickAgeMs: 0 }, { cookie: 'session=abc' })
  expect(refused.status).toBe(401)
  expect(harness.presence.snapshot()).toBeUndefined()
  expect(seen).toEqual(['session=abc'])

  rejection = 403
  expect((await sendRequest(harness.url)).status).toBe(403)

  rejection = undefined
  expect((await postJson(harness.url, { focused: true, clickAgeMs: 0 })).status).toBe(204)
})

test('dispose 之后路由不再存在', async () => {
  const harness = await start()
  expect((await postJson(harness.url, { focused: true, clickAgeMs: 0 })).status).toBe(204)

  harness.dispose()
  expect(harness.route()).toBeUndefined()
  expect((await postJson(harness.url, { focused: true, clickAgeMs: 0 })).status).toBe(404)
})

test('注册冲突只记日志，不抛给插件装配', () => {
  const logger = fakeLogger()
  const dispose = registerPresenceRoute({
    webServer: {
      register() {
        throw new Error('duplicate path')
      },
    },
    presence: createPresenceTracker(),
    logger,
    now: () => 0,
  })

  expect(logger.warnings).toHaveLength(1)
  expect(() => dispose()).not.toThrow()
})

test('处理过程抛异常时收敛成 500 + 一条日志，不冒泡到传输层', async () => {
  const broken = createPresenceTracker()
  const harness = await start({
    presence: {
      ...broken,
      report() {
        throw new Error('boom')
      },
    },
  })

  const response = await postJson(harness.url, { focused: true, clickAgeMs: 0 })
  expect(response.status).toBe(500)
  expect(JSON.parse(response.body).error).toBe('internal')
  expect(harness.logger.warnings).toHaveLength(1)
})

test('浏览器 fetch 形态的上报同样被接受（真实 fetch + keepalive）', async () => {
  const harness = await start()
  const response = await fetch(harness.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ focused: true, clickAgeMs: 42 }),
    keepalive: true,
    credentials: 'same-origin',
  })

  expect(response.status).toBe(204)
  expect(harness.presence.snapshot()).toMatchObject({ focused: true, clickAgeMs: 42 })
})
