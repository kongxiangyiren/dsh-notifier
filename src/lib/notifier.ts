/** node-notifier 包装：投递、撤回、按钮点击回调与错误收敛（任何失败都只记录日志，绝不影响 Agent）。 */

import { appendFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { LoggerLike, NotificationRequest } from './types'

/** node-notifier 的最小接口（可注入假实现用于单测）。 */
export interface NotifierImpl {
  notify(options: Record<string, unknown>, callback: (error: Error | null, response?: unknown, metadata?: unknown) => void): unknown
}

export interface Notifier {
  /** 发出通知，返回可用于撤回的 id；未投递时返回 0。 */
  notify(request: NotificationRequest): number
  /** 尽力撤回一条已发出的通知（Windows 走 SnoreToast `-close`）。 */
  dismiss(id: number): void
  dispose(): void
}

export interface NotifierInput {
  /** 是否播放系统通知音；给函数时每次投递读取（页面里改配置即时生效）。 */
  sound: boolean | (() => boolean)
  logger: LoggerLike
  /** 通知图标（PNG 绝对路径）；缺省时不带图标。 */
  iconPath?: string
  /** 诊断日志文件：记录每次投递/撤回/回调的原始数据（默认关闭）。 */
  debugLog?: string
  /** 测试注入点；缺省时加载 node-notifier。 */
  impl?: NotifierImpl
}

/**
 * 普通通知使用的 Windows AUMID：通知里显示的应用名即 `dsh`。
 * 注意：带按钮的通知必须留空 appID —— 只有 SnoreToast 默认身份才会把按钮点击回传到管道，
 * 自定义 appID（即使已在系统注册）点击时只会以退出码 4 结束、拿不到按钮信息。
 */
export const DESKTOP_APP_ID = 'dsh'

/** 运行时模块名放进变量，避免打包器把这次 require 静态解析掉。 */
const NODE_NOTIFIER_MODULE = 'node-notifier'

function loadNodeNotifier(logger: LoggerLike): NotifierImpl | undefined {
  try {
    const load = createRequire(import.meta.url)
    return load(NODE_NOTIFIER_MODULE) as NotifierImpl
  } catch (error) {
    logger.warn(`@kongxiangyiren/dsh-notifier: 无法加载 node-notifier，通知已禁用：${String(error)}`)
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/**
 * SnoreToast 把结果以 UTF-16LE 写入命名管道，而 node-notifier 先按 UTF-8 解码再按 UTF-16LE 读回，
 * 因此非 ASCII 标签会变形。这里复现同一条变形链，作为标签匹配的兜底。
 * @param label 原始按钮标签。
 * @returns node-notifier 可能回报的变形字符串。
 */
export function mojibakeOf(label: string): string {
  try {
    return Buffer.from(Buffer.from(label, 'utf16le').toString('utf8'), 'utf8').toString('utf16le')
  } catch {
    return label
  }
}

/** 从 node-notifier 的回调里取出被点击按钮的标签。 */
function clickedLabel(metadata: unknown, response: unknown): string | undefined {
  const record = isRecord(metadata) ? metadata : {}
  if (record.action !== 'buttonClicked') return undefined
  const raw = record.button ?? record.activationType ?? response
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}

/**
 * 创建通知投递器。
 * @param input 声音、图标、日志与（测试用）实现。
 */
export function createNotifier(input: NotifierInput): Notifier {
  const impl = input.impl ?? loadNodeNotifier(input.logger)
  const icon = input.iconPath === undefined ? {} : { icon: input.iconPath }
  /** 记录每条通知投递时使用的 appID，撤回时保持一致。 */
  const appIDs = new Map<number, string | undefined>()
  let nextId = 1
  let disposed = false

  const trace = (entry: Record<string, unknown>): void => {
    if (input.debugLog === undefined) return
    try {
      appendFileSync(input.debugLog, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
    } catch {
      // 诊断日志失败不影响通知
    }
  }

  const report = (error: Error | null, action: string): void => {
    if (error === null || error === undefined) return
    const detail = String(error instanceof Error ? error.message : error)
    if (action === 'dismiss') input.logger.debug(`@kongxiangyiren/dsh-notifier: 撤回通知失败（可忽略）：${detail}`)
    else input.logger.warn(`@kongxiangyiren/dsh-notifier: ${action} 失败：${detail}`)
  }

  return {
    notify(request) {
      if (disposed || impl === undefined) return 0

      const actions = request.actions
      const id = nextId++
      // 带按钮时必须用默认身份：只有它会把点击结果写回管道。
      const appID = actions === undefined || actions.length === 0 ? DESKTOP_APP_ID : undefined
      appIDs.set(id, appID)

      const options: Record<string, unknown> = {
        title: request.title,
        message: request.message,
        sound: typeof input.sound === 'function' ? input.sound() : input.sound,
        id,
        ...icon,
        ...(appID === undefined ? {} : { appID }),
        ...(actions === undefined || actions.length === 0 ? {} : { actions: [...actions] }),
      }

      trace({ kind: 'notify', request: { kind: request.kind, key: request.key }, options })
      try {
        impl.notify(options, (error, response, metadata) => {
          trace({ kind: 'callback', id, error: error === null ? null : String(error), response, metadata })
          report(error, `notify(${request.kind})`)
          if (actions === undefined || actions.length === 0) {
            request.onClosed?.()
            return
          }
          const label = clickedLabel(metadata, response)
          if (label === undefined) {
            // 收起/超时/点空白：没有按钮决定，交给调用方回退。
            request.onClosed?.()
            return
          }
          if (request.onAction === undefined) return
          const index = actions.findIndex((candidate) => candidate === label || mojibakeOf(candidate) === label)
          if (index < 0) {
            input.logger.debug(`@kongxiangyiren/dsh-notifier: 未识别的按钮回报（${label}）`)
            request.onClosed?.()
            return
          }
          request.onAction(index)
        })
      } catch (error) {
        input.logger.warn(`@kongxiangyiren/dsh-notifier: notify 抛出异常：${String(error)}`)
      }
      return id
    },

    dismiss(id) {
      if (disposed || impl === undefined || id <= 0) return
      const appID = appIDs.get(id)
      appIDs.delete(id)
      try {
        impl.notify({ close: id, ...(appID === undefined ? {} : { appID }) }, (error) => {
          report(error, 'dismiss')
        })
      } catch (error) {
        input.logger.debug(`@kongxiangyiren/dsh-notifier: dismiss 抛出异常：${String(error)}`)
      }
    },

    dispose() {
      disposed = true
      appIDs.clear()
    },
  }
}
