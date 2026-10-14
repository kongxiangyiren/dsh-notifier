/** 通知文案：单行折叠、截断、会话标签与中英文模板。 */

import type { Options } from './config'

export interface TextPair {
  title: string
  message: string
}

/** 一条待回答的问题（用户提问事件的子集）。 */
export interface QuestionItemLike {
  id: string
  question: string
  header?: string
  intent?: { kind?: string }
}

/** 审批事件里用得到的字段。 */
export interface ApprovalFacts {
  session?: string
  toolName: string
  reason?: string
  displayReason?: Record<string, string>
}

/** 用户提问事件里用得到的字段。 */
export interface QuestionFacts {
  session?: string
  questions: readonly QuestionItemLike[]
}

interface Templates {
  turnTitle(prefix: string, session: string | undefined): string
  turnMessage: string
  approvalTitle(prefix: string): string
  approvalFallback(toolName: string): string
  questionTitle(prefix: string): string
  planTitle(prefix: string): string
  planMessage: string
  moreQuestions(count: number): string
  join(session: string | undefined, detail: string): string
  testTitle(prefix: string): string
  testMessage: string
}

const TEMPLATES: Record<'zh' | 'en', Templates> = {
  zh: {
    turnTitle: (prefix, session) => `${prefix} · ${session ?? '会话'}`,
    turnMessage: '本轮回复完成，等待你的输入',
    approvalTitle: (prefix) => `${prefix} · 需要确认`,
    approvalFallback: (toolName) => `工具 ${toolName} 需要你的批准`,
    questionTitle: (prefix) => `${prefix} · 需要你的回答`,
    planTitle: (prefix) => `${prefix} · 计划待确认`,
    planMessage: '计划已提交，等待你批准或继续规划',
    moreQuestions: (count) => `（另有 ${count} 个问题）`,
    join: (session, detail) => (session === undefined ? detail : `${session}：${detail}`),
    testTitle: (prefix) => `${prefix} · 通知测试`,
    testMessage: '看到这条通知说明 @kongxiangyiren/dsh-notifier 工作正常。',
  },
  en: {
    turnTitle: (prefix, session) => `${prefix} · ${session ?? 'session'}`,
    turnMessage: 'Turn finished — waiting for your input',
    approvalTitle: (prefix) => `${prefix} · Approval needed`,
    approvalFallback: (toolName) => `Tool ${toolName} needs your approval`,
    questionTitle: (prefix) => `${prefix} · Your answer is needed`,
    planTitle: (prefix) => `${prefix} · Plan ready for review`,
    planMessage: 'A plan was submitted — approve it or keep planning',
    moreQuestions: (count) => ` (+${count} more question${count === 1 ? '' : 's'})`,
    join: (session, detail) => (session === undefined ? detail : `${session}: ${detail}`),
    testTitle: (prefix) => `${prefix} · Notification test`,
    testMessage: 'If you can see this, @kongxiangyiren/dsh-notifier is working.',
  },
}

/** 折叠所有空白（含换行）为单个空格。 */
export function collapse(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/** 折叠空白并截断到 `max` 个字符，截断处补省略号。 */
export function truncate(text: string, max: number): string {
  const single = collapse(text)
  if (single.length <= max) return single
  return `${single.slice(0, Math.max(1, max - 1))}…`
}

/**
 * 会话标签：标题 → 工作目录名 → 会话 id 前缀。
 * @param facts 可选事实，全部缺失时返回 undefined。
 */
export function sessionLabel(facts: { title?: string; cwd?: string; id?: string }): string | undefined {
  const title = facts.title === undefined ? '' : collapse(facts.title)
  if (title !== '') return truncate(title, 48)

  const cwd = facts.cwd === undefined ? '' : facts.cwd.replace(/[\\/]+$/u, '')
  if (cwd !== '') {
    const base = cwd.split(/[\\/]/u).pop()
    if (base !== undefined && base !== '') return truncate(base, 48)
  }

  if (facts.id !== undefined && facts.id !== '') return facts.id.slice(0, 8)
  return undefined
}

function languageOf(options: Options): Templates {
  return TEMPLATES[options.language]
}

function body(options: Options, text: string): string {
  return truncate(text, options.maxBodyLength)
}

/** 轮次完成文案。 */
export function turnCompleteText(options: Options, session: string | undefined): TextPair {
  const templates = languageOf(options)
  return { title: truncate(templates.turnTitle(options.titlePrefix, session), 64), message: body(options, templates.turnMessage) }
}

/** 审批请求文案：优先本地化 displayReason，其次 reason，最后内置兜底。 */
export function approvalText(options: Options, facts: ApprovalFacts): TextPair {
  const templates = languageOf(options)
  const localized = facts.displayReason?.[options.language] ?? facts.displayReason?.en
  const reason = localized ?? facts.reason
  const detail = reason === undefined || collapse(reason) === '' ? templates.approvalFallback(facts.toolName) : reason
  return {
    title: truncate(templates.approvalTitle(options.titlePrefix), 64),
    message: body(options, templates.join(facts.session, detail)),
  }
}

/** 用户提问文案；计划评审使用专属标题。 */
export function questionText(options: Options, facts: QuestionFacts): TextPair {
  const templates = languageOf(options)
  const first = facts.questions[0]
  const isPlanReview = facts.questions.some((item) => item.intent?.kind === 'plan-review')

  if (isPlanReview) {
    return {
      title: truncate(templates.planTitle(options.titlePrefix), 64),
      message: body(options, templates.join(facts.session, templates.planMessage)),
    }
  }

  const detail = first === undefined ? templates.planMessage : first.question
  const extra = facts.questions.length > 1 ? templates.moreQuestions(facts.questions.length - 1) : ''
  return {
    title: truncate(templates.questionTitle(options.titlePrefix), 64),
    message: body(options, templates.join(facts.session, `${detail}${extra}`)),
  }
}

/** `onStartup` 测试通知文案。 */
export function testText(options: Options): TextPair {
  const templates = languageOf(options)
  return {
    title: truncate(templates.testTitle(options.titlePrefix), 64),
    message: body(options, templates.testMessage),
  }
}

/**
 * 审批通知的按钮标签。
 * 必须是 ASCII：SnoreToast 经 node-notifier 的命名管道回传点击结果时，
 * 非 ASCII 标签会被 UTF-8/UTF-16 双重解码破坏，只有 ASCII 能无损匹配。
 */
export const APPROVAL_ACTIONS: readonly string[] = ['Allow', 'Deny']
