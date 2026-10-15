/**
 * apply() 装配的集成测试：用假 ctx 跑**真实的** apply()，再用真 HTTP 打它注册出来的路由。
 *
 * 这里钉住的是别处覆盖不到的一段：配置（`liveOptions`）→ 判定（`shouldStayQuiet`）→ 路由，
 * 以及"认证栅栏按请求现取"（connection 行可能比 webserver 出现得晚）。
 * dispatcher 的行为在 dispatch.test.ts 里用假 notifier 覆盖，这里不会真的弹通知：
 * `onStartup` 默认为 false，也没有任何 session 事件被触发。
 */

import type { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, test } from 'vitest'
import { apply } from '../src/index'
import { PRESENCE_PATH } from '../src/lib/presence'
import type { ConnectionGuardLike, WebServerLike } from '../src/lib/presence-channel'
import { fakeLogger, type FakeLogger } from './fakes'
import { postJson, serve, sendRequest, type TestServer } from './http'

interface Route {
  kind: 'exact' | 'prefix'
  path: string
  handler: Parameters<WebServerLike['register']>[0]['handler']
}

interface Wiring {
  /** 假 ctx（结构上够 apply() 用）。 */
  ctx: Context
  logger: FakeLogger
  /** 注册一件服务；此前挂起且依赖已满足的 inject 回调会在这一刻运行（模拟 Cordis）。 */
  provide(name: string, value: unknown): void
  route: () => Route | undefined
  server?: TestServer
}

const open: Wiring[] = []

afterEach(async () => {
  for (const wiring of open.splice(0)) await wiring.server?.close()
})

/**
 * 建一个假 ctx 并跑 apply()。
 * @param config 原始插件配置。
 * @param options.withWebServer 是否提供 `webServer` 服务（默认提供，用来观察路由注册）。
 */
function mount(config: unknown = {}, options: { withWebServer?: boolean } = {}): Wiring {
  const services = new Map<string, unknown>()
  const pending: Array<{ deps: string[]; callback: (scope: Context) => void; ran: boolean }> = []
  let registered: Route | undefined
  const logger = fakeLogger()

  const ctx = {
    logger,
    effect(execute: () => unknown) {
      execute()
      return () => {}
    },
    on: () => () => {},
    get: (name: string) => services.get(name),
    inject(deps: string[], callback: (scope: Context) => void) {
      pending.push({ deps: [...deps], callback, ran: false })
    },
  }

  const wiring: Wiring = {
    ctx: ctx as unknown as Context,
    logger,
    provide(name, value) {
      services.set(name, value)
      for (const entry of pending) {
        if (entry.ran || !entry.deps.every((dep) => services.has(dep))) continue
        entry.ran = true
        entry.callback(ctx as unknown as Context)
      }
    },
    route: () => registered,
  }
  open.push(wiring)

  apply(ctx as unknown as Context, config)

  if (options.withWebServer !== false) {
    wiring.provide('webServer', {
      register(route: Route) {
        registered = route
        return () => {
          registered = undefined
        }
      },
    } satisfies WebServerLike)
  }

  return wiring
}

/** 把注册出来的路由挂到真服务器上，并返回它的 URL。 */
async function mountServer(wiring: Wiring): Promise<string> {
  const server = await serve((request, response) => {
    const route = wiring.route()
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (route !== undefined && route.kind === 'exact' && pathname === route.path) {
      void route.handler(request, response)
      return
    }
    response.writeHead(404).end()
  })
  wiring.server = server
  return `${server.origin}${PRESENCE_PATH}`
}

/** 读回路由自己报出的判定（诊断回显就是给这件事用的）。 */
async function quietOf(url: string): Promise<boolean> {
  const response = await sendRequest(url)
  expect(response.status).toBe(200)
  return (JSON.parse(response.body) as { quiet: boolean }).quiet
}

test('webServer 出现后注册精确路由，路径与两侧协议一致', () => {
  const wiring = mount()

  const route = wiring.route()
  expect(route?.kind).toBe('exact')
  expect(route?.path).toBe(PRESENCE_PATH)
  expect(wiring.logger.warnings).toEqual([])
})

test('默认配置：前台 + 刚点过 → 判定为安静；失焦后立刻解除', async () => {
  const wiring = mount()
  const url = await mountServer(wiring)

  await postJson(url, { focused: true, clickAgeMs: 0 })
  expect(await quietOf(url)).toBe(true)

  await postJson(url, { focused: false, clickAgeMs: 0 })
  expect(await quietOf(url)).toBe(false)
})

test('窗口毫秒数按配置现算：窗口为 0 时刚点过也不再安静', async () => {
  const wiring = mount({ focusedClickWindowMs: 0 })
  const url = await mountServer(wiring)

  await postJson(url, { focused: true, clickAgeMs: 0 })
  // 窗口为 0 意味着"只有同一毫秒内才算刚点过"：等一会儿再读，保证时间确实走过了。
  await new Promise((resolve) => setTimeout(resolve, 5))
  expect(await quietOf(url)).toBe(false)
})

test('关掉开关后，任何上报都不再让通知闭嘴', async () => {
  const wiring = mount({ stayQuietOnFocusedPage: false })
  const url = await mountServer(wiring)

  await postJson(url, { focused: true, clickAgeMs: 0 })
  expect(await quietOf(url)).toBe(false)
})

test('认证栅栏按请求现取：connection 晚于注册出现也能生效', async () => {
  const wiring = mount()
  const url = await mountServer(wiring)

  // 路由已经注册、connection 还没出现：只走同源检查。
  expect((await postJson(url, { focused: true, clickAgeMs: 0 })).status).toBe(204)

  const rejections: string[] = []
  wiring.provide('connection', {
    requestRejection: (request: { headers: Record<string, unknown> }) => {
      rejections.push(String(request.headers['cookie'] ?? 'none'))
      return 401
    },
  } satisfies ConnectionGuardLike)

  const refused = await postJson(url, { focused: true, clickAgeMs: 0 }, { cookie: 'session=abc' })
  expect(refused.status).toBe(401)
  expect(rejections).toEqual(['session=abc'])
})

test('没有 webServer 的组合（CLI/TUI）：不注册任何路由，装配不报错', () => {
  const wiring = mount({}, { withWebServer: false })
  expect(wiring.route()).toBeUndefined()
  expect(wiring.logger.warnings).toEqual([])
})
