/**
 * 测试用的真实 HTTP 小工具：原始请求 + 只挂一条路由的服务器。
 *
 * 用 `node:http` 而不是 `fetch`，是为了能完全控制方法、头部与"超大请求体"这类
 * 边界情况；服务器也是真的（异步读体、状态码、连接生命周期都按真实路径走）。
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface RawResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

/** 发一个原始 HTTP 请求。 */
export function sendRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<RawResponse> {
  const target = new URL(url)
  return new Promise<RawResponse>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: options.method ?? 'GET',
        headers: options.headers,
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    request.on('error', reject)
    if (options.body !== undefined) request.write(options.body)
    request.end()
  })
}

/** 以 JSON 正文 POST。 */
export function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<RawResponse> {
  return sendRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

export interface TestServer {
  origin: string
  close(): Promise<void>
}

/**
 * 起一个只把命中路径交给 handler 的真服务器，其余路径 404。
 * @param dispatch 接收原始请求/响应（自行读体并作答）。
 */
export async function serve(dispatch: (request: IncomingMessage, response: ServerResponse) => void): Promise<TestServer> {
  const server: Server = createServer((request, response) => dispatch(request, response))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
