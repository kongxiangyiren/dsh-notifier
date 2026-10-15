/**
 * Host 半体：把 {@link PRESENCE_PATH} 注册成一条精确 HTTP 路由，接住 Client 上报的"在场"事实。
 *
 * 为什么走 HTTP 而不是 Remote/RPC：Remote 的能力集合由应用在**构建期**固定（见 `dsh-api-remotes`），
 * 第三方 bundle 加不进去；而 `dsh-host-webserver` 正是为"功能插件认领自己的路由"设计的。
 *
 * 这里只依赖 webserver 的最小结构面（`register`），因此组合里没有它时（CLI/TUI）插件照常加载，
 * 只是没有这条路由 → 永远判不出"在场" → 通知行为与从前完全一致。
 * `dsh-client-connection` 在场时，把它的浏览器会话 + Host/Origin 栅栏套在这条路由上
 * （`requestRejection`）；它不在时退化为同源检查（Fetch Metadata 头 + JSON content-type）。
 *
 * 这条路由只影响"要不要弹通知"：不读也不写任何业务状态，收到的最坏情况也只是"少弹一条提示"。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { PRESENCE_PATH, type PresenceTracker } from './presence'
import type { LoggerLike } from './types'

/** `dsh-host-webserver` 的最小结构面（不引入该包：缺失时只是少一条路由）。 */
export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }): () => void
}

/** `dsh-client-connection` 的最小结构面：浏览器会话认证 + Host/Origin 校验。 */
export interface ConnectionGuardLike {
  requestRejection(request: { headers: IncomingMessage['headers'] }): 401 | 403 | undefined
}

/** 请求体上限：一次上报只有两个字段，多出来的字节一律拒绝。 */
const MAX_BODY_BYTES = 2 * 1024

/** 溢出后仍继续排空的字节上限：再超就直接断开连接，免得被慢速大包拖住。 */
const MAX_DRAIN_BYTES = 64 * 1024

/** 取单个请求头的字符串值。 */
function header(request: IncomingMessage, name: string): string | undefined {
  const raw = request.headers[name]
  return Array.isArray(raw) ? raw[0] : raw
}

/**
 * 没有浏览器会话认证时的退化检查：浏览器发的跨站请求会被 Fetch Metadata 拦下。
 * 非浏览器客户端（curl/脚本）不带该头，无法区分——但这条路由只影响通知是否弹出。
 * @param request 原始请求。
 * @returns 是否允许继续处理。
 */
function sameOriginOnly(request: IncomingMessage): boolean {
  const site = header(request, 'sec-fetch-site')
  if (site === undefined) return true
  return site === 'same-origin' || site === 'none'
}

/** 上报体必须是 JSON（跨站 `text/plain` 这类"简单请求"连预检都不会发）。 */
function isJsonContentType(request: IncomingMessage): boolean {
  return (header(request, 'content-type') ?? '').toLowerCase().includes('application/json')
}

/**
 * 读完请求体。
 *
 * 超限时**不**立刻断开：只丢掉已缓冲的字节并继续排空，等请求结束后由调用方回 413
 * （先 destroy 会让 413 根本发不出去）。排空量超过上限才真正断开。
 * @param request 原始请求。
 * @returns 正文与是否超限；请求出错/中断时 undefined。
 */
async function readBody(request: IncomingMessage): Promise<{ body: string; overflow: boolean } | undefined> {
  return await new Promise<{ body: string; overflow: boolean } | undefined>((resolve) => {
    let size = 0
    let overflow = false
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (overflow) {
        if (size > MAX_BODY_BYTES + MAX_DRAIN_BYTES) request.destroy()
        return
      }
      if (size > MAX_BODY_BYTES) {
        overflow = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () =>
      resolve(overflow ? { body: '', overflow: true } : { body: Buffer.concat(chunks).toString('utf8'), overflow: false }),
    )
    request.on('error', () => resolve(undefined))
    request.on('aborted', () => resolve(undefined))
    // 客户端断开（现代 Node 走这条）：先于 end 到达时按出错处理；已 resolve 的会被忽略。
    request.on('close', () => resolve(undefined))
  })
}

/** 返回一个 JSON 响应（`HEAD` 只给头；已断开/已结束的响应直接跳过）。 */
function respondJson(response: ServerResponse, status: number, body: unknown, headOnly = false): void {
  if (response.destroyed || response.writableEnded) return
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store',
  })
  response.end(headOnly ? undefined : text)
}

/** 返回一个无正文的响应。 */
function respondEmpty(response: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  if (response.destroyed || response.writableEnded) return
  response.writeHead(status, { 'cache-control': 'no-store', ...headers })
  response.end()
}

export interface PresenceRouteDeps {
  /** HTTP 服务器服务（`ctx.get('webServer')`）。 */
  webServer: WebServerLike
  /** 共享的判定器（见 `presence.ts`）。 */
  presence: PresenceTracker
  /** 日志（只用于诊断）。 */
  logger: LoggerLike
  /** 判定用的时钟。 */
  now: () => number
  /** 此刻是否该保持安静——只用于 `GET` 诊断回显。 */
  quiet?: (() => boolean) | undefined
  /** 可选：浏览器会话 + Host/Origin 栅栏（`ctx.get('connection')`）。 */
  guard?: ConnectionGuardLike | undefined
}

/**
 * 注册上报路由：`POST` 记录事实，`GET`/`HEAD` 回显当前判定（排查用）。
 * @param deps 服务器、判定器、时钟与可选认证栅栏。
 * @returns 注销函数。
 */
export function registerPresenceRoute(deps: PresenceRouteDeps): () => void {
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const rejection = deps.guard?.requestRejection({ headers: request.headers })
    if (rejection !== undefined) {
      respondJson(response, rejection, { error: 'unauthenticated' })
      return
    }
    if (!sameOriginOnly(request)) {
      respondJson(response, 403, { error: 'cross-site' })
      return
    }

    const method = request.method ?? 'GET'
    if (method === 'GET' || method === 'HEAD') {
      const snapshot = deps.presence.snapshot()
      respondJson(
        response,
        200,
        {
          known: snapshot !== undefined,
          ...(snapshot === undefined
            ? {}
            : {
                focused: snapshot.focused,
                clickAgeMs: snapshot.clickAgeMs,
                receivedAgoMs: Math.max(0, deps.now() - snapshot.receivedAt),
              }),
          quiet: deps.quiet?.() === true,
        },
        method === 'HEAD',
      )
      return
    }
    if (method !== 'POST') {
      respondEmpty(response, 405, { allow: 'GET, HEAD, POST' })
      return
    }
    if (!isJsonContentType(request)) {
      respondJson(response, 415, { error: 'expected-application/json' })
      return
    }

    const read = await readBody(request)
    if (read === undefined) {
      respondJson(response, 400, { error: 'incomplete-body' })
      return
    }
    if (read.overflow) {
      respondJson(response, 413, { error: 'body-too-large' })
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(read.body)
    } catch {
      respondJson(response, 400, { error: 'invalid-json' })
      return
    }
    if (!deps.presence.report(parsed, deps.now())) {
      respondJson(response, 400, { error: 'invalid-report' })
      return
    }
    respondEmpty(response, 204)
  }

  // 任何意外都收敛成一条日志 + 500：这条路由绝不能把异常抛回 HTTP 传输层。
  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    void handle(request, response).catch((error: unknown) => {
      deps.logger.warn(`@kongxiangyiren/dsh-notifier: 在场判定请求处理失败：${String(error)}`)
      respondJson(response, 500, { error: 'internal' })
    })
  }

  try {
    return deps.webServer.register({ kind: 'exact', path: PRESENCE_PATH, handler })
  } catch (error) {
    deps.logger.warn(`@kongxiangyiren/dsh-notifier: 注册在场判定路由失败：${String(error)}`)
    return () => {}
  }
}
