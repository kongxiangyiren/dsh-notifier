/**
 * @kongxiangyiren/dsh-notifier：对话完成或需要用户确认（审批 / 提问 / 计划评审）时发出 Windows 系统通知。
 * Host 插件半体；通知经 node-notifier 调 SnoreToast 投递。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import { shareCancellation, type CancellableRequest } from './lib/signal'
import { liveOptions } from './lib/config'
import { createDispatcher, type AgentLike, type AgentStatus, type SessionEventLike, type SessionLike } from './lib/dispatch'
import { createNotifier } from './lib/notifier'
import { systemScheduler } from './lib/pending'
import type { LoggerLike } from './lib/types'

/** Cordis 插件名（诊断用）。 */
export const name = '@kongxiangyiren/dsh-notifier'

/**
 * 插件配置 schema；字段与 `src/lib/config.ts` 的 Options 一一对应。
 *
 * 每个字段都标了 `.volatile()`：Harness 的 `settings` 服务只把 volatile 字段
 * 投影成「设置 → 插件」页面里的可编辑表单（`volatileForm`），写入走
 * `@Remote settings.update(ns, patch)` 并经由 Loader 应用——插件随之重启，
 * `apply()` 用新配置重新装配。
 */
export const Config = z.object({
  onTurnComplete: z.boolean().default(true).volatile().description('一轮对话结束时通知'),
  onApproval: z.boolean().default(true).volatile().description('需要审批（如沙箱/命令批准）时通知'),
  onQuestion: z.boolean().default(true).volatile().description('需要你回答提问或评审计划时通知'),
  onTurnError: z.boolean().default(false).volatile().description('轮次以错误结束时也通知'),
  includeSubagents: z.boolean().default(false).volatile().description('把子代理/队友会话的"完成"通知也算上'),
  language: z.union([z.const('zh'), z.const('en')]).default('zh').volatile().description('通知文案语言'),
  titlePrefix: z.string().default('DSH').volatile().description('通知标题前缀'),
  sound: z.boolean().default(true).volatile().description('播放系统通知音'),
  maxBodyLength: z.natural().default(200).volatile().description('通知正文最大字符数'),
  idleGraceMs: z.natural().default(1200).volatile().description('轮次结束后确认"确实空闲"的等待毫秒数'),
  askGraceMs: z.natural().default(800).volatile().description('询问用户后等待作答的毫秒数，超时才通知'),
  dedupeWindowMs: z.natural().default(5000).volatile().description('同一触发键的去重窗口（毫秒）'),
  askCoalesceMs: z.natural().default(6000).volatile().description('同一会话内多条确认的合并窗口（毫秒）'),
  minIntervalMs: z.natural().default(1000).volatile().description('两条通知之间的最小间隔（毫秒）'),
  dismissWhenAnswered: z.boolean().default(true).volatile().description('用户作答后撤回对应的待确认通知'),
  onStartup: z.boolean().default(false).volatile().description('插件激活时发一条测试通知（验证投递链路）'),
  debugLog: z.string().volatile().description('诊断日志文件路径：记录投递、撤回与点击回调的原始数据'),
})

/**
 * 通知图标：包内 `assets/deepseek.png`（DeepSeek 官方鲸鱼标，PNG 且 <200KB，符合 Windows Toast 要求）。
 * @returns 图标的绝对路径；缺失时 undefined（不带图标投递）。
 */
function resolveIconPath(): string | undefined {
  const path = fileURLToPath(new URL('../assets/deepseek.png', import.meta.url))
  return existsSync(path) ? path : undefined
}

/**
 * 安装插件：注册事件监听并持有通知投递器与定时器。
 * @param ctx 插件上下文。
 * @param config 行配置（已由 {@link Config} 校验）。
 */
export function apply(ctx: Context, config: unknown): void {
  // 读取时归一化：页面里改配置立刻生效，无需重装插件。
  const options = liveOptions(config)
  const logger: LoggerLike = ctx.logger

  const guard = <T>(operation: () => T, where: string): T | undefined => {
    try {
      return operation()
    } catch (error) {
      logger.warn(`@kongxiangyiren/dsh-notifier: ${where} 处理失败：${String(error)}`)
      return undefined
    }
  }

  const notifier = createNotifier({
    sound: () => options.sound,
    logger,
    iconPath: resolveIconPath(),
    debugLog: options.debugLog,
  })
  const dispatcher = createDispatcher({
    options,
    notifier,
    logger,
    scheduler: systemScheduler(),
    titleOf: (session) => ctx.get('sessionTitle')?.get(session as unknown as Session)?.title,
    statusOf: (sessionId): AgentStatus | undefined => {
      const agents = ctx.get('agents')
      if (agents === undefined) return undefined
      const agent = agents.get(sessionId as SessionId)
      if (agent === undefined) return 'gone'
      return agent.status === 'running' ? 'running' : 'idle'
    },
  })

  ctx.effect(
    () => () => {
      dispatcher.dispose()
      notifier.dispose()
    },
    '@kongxiangyiren/dsh-notifier: notifier and timers',
  )

  // 轮次结束：durable 的 session/event，只看 turn/end。
  ctx.on('session/event', (session, event) => {
    guard(() => {
      dispatcher.onSessionEvent(session as unknown as SessionLike, event as unknown as SessionEventLike)
    }, 'session/event')
  })

  // 审批与提问：prepend 到 waterfall 最前。
  // 审批为**双通道竞速**：先把请求照常交给后续链路（网页卡片立即出现），同时弹带按钮的通知；
  // 通知作答时通过取消请求的 signal 让客户端自动移除卡片（见 lib/signal.ts）。
  ctx.on(
    'approval/request',
    function (request, next) {
      const controller = new AbortController()
      shareCancellation(request as unknown as CancellableRequest, controller)
      const settled = next()
      const answer = guard(
        () =>
          dispatcher.answerApproval({
            agent: request.agent as unknown as AgentLike,
            payload: request,
            settled,
            onAnsweredByToast: () => {
              controller.abort(new Error('@kongxiangyiren/dsh-notifier: approval answered from notification'))
            },
          }),
        'approval/request',
      )
      return answer ?? settled
    },
    true,
  )

  ctx.on(
    'user-questions/request',
    function (request, next) {
      const settled = next()
      guard(() => {
        void dispatcher.notifyQuestion({
          agent: request.agent as unknown as AgentLike | undefined,
          payload: request,
          settled,
        })
      }, 'user-questions/request')
      return settled
    },
    true,
  )

  if (options.onStartup) dispatcher.notifyTest()
}
