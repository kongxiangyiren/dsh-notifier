/** 三个触发的编排：判定 → 文案 → 双通道竞速 → 去重投递 → 作答/点击后撤回。 */

import type { Options } from './config'
import {
  APPROVAL_ACTIONS,
  approvalText,
  questionText,
  sessionLabel,
  testText,
  turnCompleteText,
  type QuestionItemLike,
} from './messages'
import type { Notifier } from './notifier'
import { createGate, createPendingTracker, type Scheduler } from './pending'
import type { LoggerLike, NotificationRequest, NotifyKind } from './types'

export interface SessionHeaderLike {
  cwd?: string
  origin?: string
  delegationDepth?: number
}

export interface SessionLike {
  id: string
  header?: SessionHeaderLike
}

export interface AgentLike {
  session: SessionLike
}

export interface SessionEventLike {
  type: string
  data?: unknown
}

/** Agent 可观测状态；`gone` 表示 Agent 已不在注册表中。 */
export type AgentStatus = 'idle' | 'running' | 'gone'

export interface DispatchDeps {
  options: Options
  notifier: Notifier
  logger: LoggerLike
  scheduler: Scheduler
  /** 会话标题（可选服务）。 */
  titleOf?: (session: SessionLike) => string | undefined
  /** Agent 当前状态；返回 undefined 表示无法判定（此时按空闲处理）。 */
  statusOf?: (sessionId: string) => AgentStatus | undefined
}

export interface AskInput {
  agent?: AgentLike
  /** 原始事件载荷（`approval/request` 或 `user-questions/request` 的请求体）。 */
  payload: unknown
  /**
   * 已经**立即**委托给后续应答者（网页卡片/其他插件）的 Promise。
   * 审批时它与通知按钮竞速；提问时它就是返回值。
   */
  settled: Promise<unknown>
  /**
   * 通知按钮作答时回调：调用方据此取消网页侧那份请求，
   * 客户端会自动移除"等待审批"卡片（见 `signal.ts`）。
   */
  onAnsweredByToast?: () => void
}

/** 审批结果词表（与 `@deepseek-ai/dsh-user-approval` 的 ApprovalOutcome 一致）。 */
export type ApprovalOutcomeLike = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export interface Dispatcher {
  /** `session/event` 入口：只关心 `turn/end`。 */
  onSessionEvent(session: SessionLike, event: SessionEventLike): void
  /**
   * `approval/request` 入口：通知与页面卡片**同时出现**并竞速，任一作答即生效：
   * - 点了通知按钮 → 以该结果作答，并回调 {@link AskInput.onAnsweredByToast} 取消网页那份请求，
   *   页面卡片随即消失；
   * - 页面卡片先作答 → 返回其结果，并撤回通知。
   */
  answerApproval(input: AskInput): Promise<ApprovalOutcomeLike>
  /**
   * `user-questions/request` 入口：网页面板照常出现，通知只提示、不参与作答，
   * 并返回 `settled`。
   */
  notifyQuestion(input: AskInput): Promise<unknown>
  /** `onStartup` 用的测试通知。 */
  notifyTest(): void
  dispose(): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function asStringDict(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

function asQuestions(value: unknown): QuestionItemLike[] {
  if (!Array.isArray(value)) return []
  return value.filter(isRecord).map((item) => ({
    id: asString(item.id) ?? '?',
    question: asString(item.question) ?? '',
    ...(asString(item.header) === undefined ? {} : { header: asString(item.header) as string }),
    ...(isRecord(item.intent) && asString(item.intent.kind) !== undefined
      ? { intent: { kind: asString(item.intent.kind) as string } }
      : {}),
  }))
}

/**
 * 创建触发器编排器。
 * @param deps 选项、投递器、日志、调度器与会话信息读取器。
 */
export function createDispatcher(deps: DispatchDeps): Dispatcher {
  const { options, notifier, logger, scheduler } = deps
  const gate = createGate({ windowMs: options.dedupeWindowMs, minIntervalMs: options.minIntervalMs, now: () => scheduler.now() })
  const pending = createPendingTracker({ graceMs: options.askGraceMs, scheduler })
  const askAt = new Map<string, number>()
  const liveIds = new Map<string, number>()

  const labelOf = (session: SessionLike | undefined): string | undefined => {
    if (session === undefined) return undefined
    return sessionLabel({ title: deps.titleOf?.(session), cwd: session.header?.cwd, id: session.id })
  }

  const isSubagent = (session: SessionLike): boolean =>
    session.header?.origin === 'subagent' || (session.header?.delegationDepth ?? 0) > 0

  const emit = (request: NotificationRequest): number | undefined => {
    if (!gate.allow(request.key)) {
      logger.debug(`@kongxiangyiren/dsh-notifier: 跳过重复/过密通知（${request.key}）`)
      return undefined
    }
    let id = 0
    try {
      id = notifier.notify(request)
    } catch (error) {
      logger.warn(`@kongxiangyiren/dsh-notifier: 投递通知失败：${String(error)}`)
      return undefined
    }
    if (id > 0) liveIds.set(request.key, id)
    logger.info(`@kongxiangyiren/dsh-notifier: 已发出通知（${request.kind}, ${request.key}）`)
    return id
  }

  const dismissId = (id: number): void => {
    if (id <= 0) return
    try {
      notifier.dismiss(id)
    } catch (error) {
      logger.debug(`@kongxiangyiren/dsh-notifier: 撤回通知失败（可忽略）：${String(error)}`)
    }
  }

  /** 同会话内的多条确认只通知第一条。 */
  const rememberAsk = (sessionId: string | undefined): boolean => {
    if (sessionId === undefined) return true
    const now = scheduler.now()
    const previous = askAt.get(sessionId)
    if (previous !== undefined && now - previous < options.askCoalesceMs) return false
    askAt.set(sessionId, now)
    if (askAt.size > 200) {
      for (const [id, at] of askAt) if (now - at > options.askCoalesceMs) askAt.delete(id)
    }
    return true
  }

  const onTurnEnd = (session: SessionLike, event: SessionEventLike): void => {
    if (event.type !== 'turn/end' || !options.onTurnComplete) return

    const data = isRecord(event.data) ? event.data : {}
    const reason = isRecord(data.reason) ? data.reason : {}
    const kind = asString(reason.kind)
    if (kind === undefined) return
    if (kind === 'error') {
      if (!options.onTurnError) return
    } else if (kind !== 'completed' && kind !== 'max-tokens') {
      return
    }

    if (!options.includeSubagents && isSubagent(session)) return

    const turn = typeof data.turn === 'number' ? data.turn : 0
    const key = `turn:${session.id}:${turn}`
    const label = labelOf(session)

    scheduler.schedule(() => {
      const status = deps.statusOf?.(session.id)
      if (status === 'running') {
        logger.debug(`@kongxiangyiren/dsh-notifier: 跳过完成通知，${session.id} 的下一轮已经开始`)
        return
      }
      if (status === 'gone') {
        logger.debug(`@kongxiangyiren/dsh-notifier: 跳过完成通知，Agent ${session.id} 已销毁`)
        return
      }
      emit({ kind: 'turn', key, sessionId: session.id, ...turnCompleteText(options, label) })
    }, options.idleGraceMs)
  }

  /**
   * 审批的**双通道竞速**作答：页面卡片与通知同时出现，任一作答即生效，另一方随之消失。
   * - 通知按钮作答 → **先**返回其结果，**再**回调 `onAnsweredByToast()` 取消网页那份请求
   *   （取消是同步的：网关会立刻 reject 转发请求，若顺序颠倒，页面侧的拒绝会抢先赢得竞速，
   *   审批会被归一化成 `unavailable`）；
   * - 页面卡片先作答 → 返回其结果，并撤回通知。
   * @param input 通知键、会话、文案、已委托的网页 Promise 与取消回调。
   * @returns 与 `ApprovalOutcomeLike` 兼容的竞速结果。
   */
  const answerByToast = (input: {
    key: string
    sessionId: string | undefined
    hash: { title: string; message: string }
    settled: Promise<unknown>
    onAnsweredByToast?: () => void
  }): Promise<ApprovalOutcomeLike> => {
    let decideFromToast: ((outcome: ApprovalOutcomeLike) => void) | undefined
    const fromToast = new Promise<ApprovalOutcomeLike>((resolve) => {
      decideFromToast = resolve
    })

    let finished = false
    /** 只让先到的一方生效。 */
    const finish = (apply: () => void): void => {
      if (finished) return
      finished = true
      apply()
    }

    const viaPage = input.settled
    let outcome: ApprovalOutcomeLike | undefined
    let settled = false
    /** 竞速：先到者生效；通知一旦作答，页面侧随后的拒绝不得覆盖它。 */
    const race = new Promise<ApprovalOutcomeLike>((resolve, reject) => {
      fromToast.then((value) => {
        outcome = value
        if (settled) return
        settled = true
        resolve(value)
      })
      viaPage.then(
        (value) => {
          if (settled) return
          settled = true
          resolve(value as ApprovalOutcomeLike)
        },
        (error: unknown) => {
          if (settled) return
          settled = true
          reject(error)
        },
      )
    })
    void race.catch(() => undefined)

    const closeToast = (): void => {
      if (outcome !== undefined) return
      finish(() => {
        if (options.dismissWhenAnswered) dismissId(liveIds.get(input.key) ?? 0)
        liveIds.delete(input.key)
      })
    }
    void viaPage.then(closeToast, closeToast)

    const id = emit({
      kind: 'approval',
      key: input.key,
      sessionId: input.sessionId,
      ...input.hash,
      actions: APPROVAL_ACTIONS,
      onAction: (index: number) => {
        const result: ApprovalOutcomeLike = index === 0 ? 'allowed-once' : 'rejected'
        finish(() => {
          logger.info(`@kongxiangyiren/dsh-notifier: 通知按钮作答（${result}, ${input.key}）`)
          // 先确立通知结果，再取消页面请求（顺序不可颠倒）。
          decideFromToast?.(result)
          input.onAnsweredByToast?.()
        })
      },
    })

    if (id === undefined) {
      // 通知被去重/节流或投递失败：只走页面。
      return viaPage as Promise<ApprovalOutcomeLike>
    }

    return race
  }

  /**
   * 审批与提问的公共处理：开关、会话内合并、文案与稳定键。
   * @param kind 触发类别。
   * @param input 触发输入。
   * @returns 应当作为 waterfall 结果的 Promise。
   */
  const handleAsk = (kind: 'approval' | 'question', input: AskInput): Promise<unknown> => {
    const { agent, payload, settled } = input

    if (kind === 'approval' ? !options.onApproval : !options.onQuestion) return settled

    const facts = isRecord(payload) ? payload : {}
    const session = agent?.session
    const sessionId = session?.id
    const callId = asString(facts.callId) ?? (isRecord(facts.wait) ? asString(facts.wait.callId) : undefined)
    const toolName = asString(facts.toolName) ?? 'tool'
    const questions = asQuestions(facts.questions)

    const subject = kind === 'approval' ? (callId ?? toolName) : (callId ?? questions[0]?.id ?? '?')
    const key = `${kind}:${sessionId ?? '-'}:${subject}`

    if (!rememberAsk(sessionId)) {
      logger.debug(`@kongxiangyiren/dsh-notifier: 跳过同会话内重复的确认通知（${key}）`)
      return settled
    }

    const label = labelOf(session)
    const hash =
      kind === 'approval'
        ? approvalText(options, {
            session: label,
            toolName,
            reason: asString(facts.reason),
            displayReason: asStringDict(facts.displayReason),
          })
        : questionText(options, { session: label, questions })

    if (kind === 'approval') {
      return answerByToast({
        key,
        sessionId,
        hash,
        settled,
        ...(input.onAnsweredByToast === undefined ? {} : { onAnsweredByToast: input.onAnsweredByToast }),
      })
    }

    // 提问：网页面板照常出现，通知只提示、并在作答后撤回。
    pending.watch(key, settled, {
      onFire: () => {
        emit({ kind: kind as NotifyKind, key, sessionId, ...hash })
      },
      onSettle: () => {
        const id = liveIds.get(key)
        liveIds.delete(key)
        if (id !== undefined && options.dismissWhenAnswered) dismissId(id)
      },
    })
    return settled
  }

  return {
    onSessionEvent: onTurnEnd,

    // 审批结果在运行时始终是审批词表里的值（网页侧同样如此），这里收敛类型。
    answerApproval: (input) => handleAsk('approval', input) as Promise<ApprovalOutcomeLike>,

    notifyQuestion: (input) => handleAsk('question', input),

    notifyTest() {
      const text = testText(options)
      try {
        const id = notifier.notify({ kind: 'turn', key: 'startup', title: text.title, message: text.message })
        if (id > 0) liveIds.set('startup', id)
        logger.info('@kongxiangyiren/dsh-notifier: 已发出启动测试通知')
      } catch (error) {
        logger.warn(`@kongxiangyiren/dsh-notifier: 启动测试通知失败：${String(error)}`)
      }
    },

    dispose() {
      pending.cancelAll()
      liveIds.clear()
      askAt.clear()
    },
  }
}
