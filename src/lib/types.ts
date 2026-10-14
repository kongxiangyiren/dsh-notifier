/** 通知类别：对话完成 / 需要审批 / 需要回答。 */
export type NotifyKind = 'turn' | 'approval' | 'question'

/** 一条待发出的通知（文案已定稿、待去重与投递）。 */
export interface NotificationRequest {
  /** 触发类别，仅用于日志。 */
  kind: NotifyKind
  /** 去重与撤回用的稳定键。 */
  key: string
  /** 会话 id；无法确定时为 undefined。 */
  sessionId?: string
  /** 通知标题。 */
  title: string
  /** 通知正文（已折叠、已截断）。 */
  message: string
  /** 可点击按钮标签；给出时用户点击会回调 {@link NotificationRequest.onAction}。 */
  actions?: readonly string[]
  /** 用户点击第 index 个按钮（从 0 开始）。 */
  onAction?: (index: number) => void
  /** 通知已收起（被划掉/超时/点空白）且未点按钮。 */
  onClosed?: () => void
}

/** 插件用到的最小日志接口，与 `ctx.logger` 结构兼容。 */
export interface LoggerLike {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
}
