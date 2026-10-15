import { expect, test } from 'vitest'
import { DEFAULTS, resolveOptions } from '../src/lib/config'
import { createDispatcher, type AgentStatus, type SessionLike } from '../src/lib/dispatch'
import type { Notifier } from '../src/lib/notifier'
import { fakeLogger, fakeNotifier, fakeScheduler, flush, throwingNotifier } from './fakes'

const session: SessionLike = { id: 's1', header: { cwd: 'D:\\code\\demo' } }
const childSession: SessionLike = { id: 's2', header: { cwd: 'D:\\code\\demo', origin: 'subagent', delegationDepth: 1 } }

function setup(overrides: Record<string, unknown> = {}, status: AgentStatus | undefined = 'idle', quiet = false) {
  const scheduler = fakeScheduler()
  const notifier = fakeNotifier()
  const logger = fakeLogger()
  const options = resolveOptions({ ...DEFAULTS, ...overrides })
  const dispatcher = createDispatcher({
    options,
    notifier,
    logger,
    scheduler,
    shouldStayQuiet: () => quiet,
    titleOf: () => 'demo-session',
    statusOf: () => status,
  })
  return { scheduler, notifier, logger, dispatcher }
}

/** 模拟"已经交给页面卡片"的那份请求：可被作答或拒绝。 */
function pageAnswer() {
  let answer: (value: unknown) => void = () => {}
  let reject: (reason: unknown) => void = () => {}
  const settled = new Promise<unknown>((resolve, rejectFn) => {
    answer = resolve
    reject = rejectFn
  })
  return { settled, answer, reject }
}

/** 记录通知按钮作答回调的调用次数。 */
function toastHook() {
  const state = { calls: 0 }
  return { state, onAnsweredByToast: () => (state.calls += 1) }
}

const turnEnd = (turn: number, kind: string) => ({ type: 'turn/end', data: { turn, reason: { kind } } })

test('turn/end completed 且宽限后仍空闲时通知', () => {
  const t = setup({ idleGraceMs: 1000 })
  t.dispatcher.onSessionEvent(session, turnEnd(3, 'completed'))

  t.scheduler.advance(999)
  expect(t.notifier.sent).toHaveLength(0)

  t.scheduler.advance(1)
  expect(t.notifier.sent).toHaveLength(1)
  expect(t.notifier.sent[0]).toMatchObject({ kind: 'turn', key: 'turn:s1:3', sessionId: 's1', title: 'DSH · demo-session' })
})

test('宽限期内开始下一轮则不通知', () => {
  const t = setup({ idleGraceMs: 1000 }, 'running')
  t.dispatcher.onSessionEvent(session, turnEnd(3, 'completed'))
  t.scheduler.advance(2000)
  expect(t.notifier.sent).toHaveLength(0)
})

test('Agent 已销毁则不通知', () => {
  const t = setup({ idleGraceMs: 100 }, 'gone')
  t.dispatcher.onSessionEvent(session, turnEnd(3, 'completed'))
  t.scheduler.advance(5000)
  expect(t.notifier.sent).toHaveLength(0)
})

test('取消/阻塞/中断结束的轮次不通知', () => {
  for (const kind of ['aborted', 'blocked', 'interrupted', 'forked']) {
    const t = setup({ idleGraceMs: 100 })
    t.dispatcher.onSessionEvent(session, turnEnd(1, kind))
    t.scheduler.advance(5000)
    expect(t.notifier.sent, kind).toHaveLength(0)
  }
})

test('错误结束默认不通知，开启 onTurnError 后通知', () => {
  const off = setup({ idleGraceMs: 100 })
  off.dispatcher.onSessionEvent(session, turnEnd(1, 'error'))
  off.scheduler.advance(5000)
  expect(off.notifier.sent).toHaveLength(0)

  const on = setup({ idleGraceMs: 100, onTurnError: true })
  on.dispatcher.onSessionEvent(session, turnEnd(1, 'error'))
  on.scheduler.advance(5000)
  expect(on.notifier.sent).toHaveLength(1)
})

test('子代理会话默认不通知，includeSubagents=true 时通知', () => {
  const off = setup({ idleGraceMs: 100 })
  off.dispatcher.onSessionEvent(childSession, turnEnd(1, 'completed'))
  off.scheduler.advance(5000)
  expect(off.notifier.sent).toHaveLength(0)

  const on = setup({ idleGraceMs: 100, includeSubagents: true })
  on.dispatcher.onSessionEvent(childSession, turnEnd(1, 'completed'))
  on.scheduler.advance(5000)
  expect(on.notifier.sent).toHaveLength(1)
})

test('onTurnComplete=false 时完全不通知', () => {
  const t = setup({ idleGraceMs: 100, onTurnComplete: false })
  t.dispatcher.onSessionEvent(session, turnEnd(1, 'completed'))
  t.scheduler.advance(5000)
  expect(t.notifier.sent).toHaveLength(0)
})

test('审批通知带 Allow/Deny 按钮；点 Allow 直接作答并请求取消页面那份', async () => {
  const t = setup()
  const page = pageAnswer()
  const hook = toastHook()
  const answer = t.dispatcher.answerApproval({
    agent: { session },
    payload: { toolName: 'pwsh', callId: 'c1' },
    settled: page.settled,
    onAnsweredByToast: hook.onAnsweredByToast,
  })

  expect(t.notifier.sent).toHaveLength(1)
  expect(t.notifier.sent[0]?.actions).toEqual(['Allow', 'Deny'])
  expect(t.notifier.sent[0]?.message).toContain('pwsh')
  expect(hook.state.calls).toBe(0)

  t.notifier.sent[0]?.onAction?.(0)
  await expect(answer).resolves.toBe('allowed-once')
  expect(hook.state.calls).toBe(1)
})

test('点 Deny 直接作答并请求取消页面那份', async () => {
  const t = setup()
  const page = pageAnswer()
  const hook = toastHook()
  const answer = t.dispatcher.answerApproval({
    agent: { session },
    payload: { toolName: 'pwsh', callId: 'c2' },
    settled: page.settled,
    onAnsweredByToast: hook.onAnsweredByToast,
  })

  t.notifier.sent[0]?.onAction?.(1)
  await expect(answer).resolves.toBe('rejected')
  expect(hook.state.calls).toBe(1)
})

test('取消页面请求是同步的：其拒绝不得覆盖通知结果', async () => {
  const t = setup()
  const page = pageAnswer()
  const answer = t.dispatcher.answerApproval({
    agent: { session },
    payload: { toolName: 'pwsh', callId: 'c8' },
    settled: page.settled,
    onAnsweredByToast: () => {
      // 呼应真实网关：signal 一 abort，转发请求立即被 reject。
      page.reject(new Error('Remote event was cancelled by the Host'))
    },
  })

  t.notifier.sent[0]?.onAction?.(0)
  await expect(answer).resolves.toBe('allowed-once')
})

test('页面先作答则返回页面结果并撤回通知', async () => {
  const t = setup()
  const page = pageAnswer()
  const hook = toastHook()
  const answer = t.dispatcher.answerApproval({
    agent: { session },
    payload: { toolName: 'pwsh', callId: 'c3' },
    settled: page.settled,
    onAnsweredByToast: hook.onAnsweredByToast,
  })

  page.answer('rejected')
  await expect(answer).resolves.toBe('rejected')
  await flush()
  expect(t.notifier.dismissed).toEqual([1])
  expect(hook.state.calls).toBe(0)
})

test('页面先作答后，再点通知不再请求取消（不会误撤已结束的请求）', async () => {
  const t = setup()
  const page = pageAnswer()
  const hook = toastHook()
  const answer = t.dispatcher.answerApproval({
    agent: { session },
    payload: { toolName: 'pwsh', callId: 'c4' },
    settled: page.settled,
    onAnsweredByToast: hook.onAnsweredByToast,
  })

  page.answer('allowed-once')
  await expect(answer).resolves.toBe('allowed-once')
  await flush()

  t.notifier.sent[0]?.onAction?.(1)
  await flush()
  expect(hook.state.calls).toBe(0)
})

test('页面拒绝时原样抛出', async () => {
  const t = setup()
  const page = pageAnswer()
  const failure = new Error('unavailable')
  const answer = t.dispatcher.answerApproval({
    agent: { session },
    payload: { toolName: 'pwsh', callId: 'c5' },
    settled: page.settled,
  })

  page.reject(failure)
  await expect(answer).rejects.toBe(failure)
  await flush()
  expect(t.notifier.dismissed).toEqual([1])
})

test('通知投递不可用时只走页面', async () => {
  const scheduler = fakeScheduler()
  const silentNotifier: Notifier = { notify: () => 0, dismiss: () => {}, dispose: () => {} }
  const dispatcher = createDispatcher({
    options: resolveOptions(DEFAULTS),
    notifier: silentNotifier,
    logger: fakeLogger(),
    scheduler,
    titleOf: () => 'demo',
    statusOf: () => 'idle',
  })
  const page = pageAnswer()
  const hook = toastHook()
  const answer = dispatcher.answerApproval({
    agent: { session },
    payload: { toolName: 'pwsh' },
    settled: page.settled,
    onAnsweredByToast: hook.onAnsweredByToast,
  })

  page.answer('allowed-once')
  await expect(answer).resolves.toBe('allowed-once')
  expect(hook.state.calls).toBe(0)
})

test('默认（askCoalesceMs=0）两次确认紧挨着也各弹一条', () => {
  const t = setup({ minIntervalMs: 1000 })
  const first = pageAnswer()
  const second = pageAnswer()

  void t.dispatcher.answerApproval({ agent: { session }, payload: { toolName: 'a', callId: 'c1' }, settled: first.settled })
  t.scheduler.advance(200)
  void t.dispatcher.answerApproval({ agent: { session }, payload: { toolName: 'b', callId: 'c2' }, settled: second.settled })

  expect(t.notifier.sent).toHaveLength(2)
})

test('开启合并窗口时：上一条通知还挂着才合并，用户处理掉之后下一条立刻弹', async () => {
  const t = setup({ askCoalesceMs: 6000, minIntervalMs: 0 })

  // 第一条投递成功 → 还挂着 → 3 秒内的第二条被合并（这是这个开关的本意：不叠两条横幅）。
  const first = pageAnswer()
  void t.dispatcher.answerApproval({ agent: { session }, payload: { toolName: 'a', callId: 'c1' }, settled: first.settled })
  t.scheduler.advance(3000)
  const second = pageAnswer()
  void t.dispatcher.answerApproval({ agent: { session }, payload: { toolName: 'b', callId: 'c2' }, settled: second.settled })
  expect(t.notifier.sent).toHaveLength(1)

  // 用户把第一条处理掉（页面作答 → 通知被撤回）→ 第三条必须弹，不能被窗口吞掉。
  first.answer('allowed-once')
  await flush()
  t.scheduler.advance(500)
  const third = pageAnswer()
  void t.dispatcher.answerApproval({ agent: { session }, payload: { toolName: 'c', callId: 'c3' }, settled: third.settled })
  expect(t.notifier.sent).toHaveLength(2)
})

test('被"前台保持安静"跳过的确认不占用合并窗口（离开页面后紧接着的确认照弹）', async () => {
  const scheduler = fakeScheduler()
  const notifier = fakeNotifier()
  let quiet = true
  const dispatcher = createDispatcher({
    options: resolveOptions({ ...DEFAULTS, askCoalesceMs: 6000, minIntervalMs: 0 }),
    notifier,
    logger: fakeLogger(),
    scheduler,
    shouldStayQuiet: () => quiet,
    titleOf: () => 'demo',
    statusOf: () => 'idle',
  })

  // 人在页面：第一条被安静规则跳过（没投递 → 不该算"更挂着"）。
  const first = pageAnswer()
  void dispatcher.answerApproval({ agent: { session }, payload: { toolName: 'a', callId: 'c1' }, settled: first.settled })
  expect(notifier.sent).toHaveLength(0)

  // 人离开了页面，1 秒后第二条确认到来：必须弹，而不是被合并窗口吞掉。
  quiet = false
  scheduler.advance(1000)
  const second = pageAnswer()
  void dispatcher.answerApproval({ agent: { session }, payload: { toolName: 'b', callId: 'c2' }, settled: second.settled })

  expect(notifier.sent).toHaveLength(1)
  expect(notifier.sent[0]?.key).toBe('approval:s1:c2')
})

test('从通知按钮作答后，同会话的下一条确认不再被合并窗口挡住', async () => {
  const t = setup({ askCoalesceMs: 6000, minIntervalMs: 0 })

  const first = pageAnswer()
  const answer = t.dispatcher.answerApproval({
    agent: { session },
    payload: { toolName: 'a', callId: 'c1' },
    settled: first.settled,
  })
  expect(t.notifier.sent).toHaveLength(1)

  // 直接点通知上的 Allow：这条通知已经用掉了，不该再"挂着"。
  t.notifier.sent[0]?.onAction?.(0)
  await expect(answer).resolves.toBe('allowed-once')

  const second = pageAnswer()
  void t.dispatcher.answerApproval({ agent: { session }, payload: { toolName: 'b', callId: 'c2' }, settled: second.settled })
  expect(t.notifier.sent).toHaveLength(2)
})

test('开关关闭时不弹通知，直接返回页面结果', async () => {
  const t = setup({ onApproval: false })
  const page = pageAnswer()
  const answer = t.dispatcher.answerApproval({ agent: { session }, payload: { toolName: 'pwsh' }, settled: page.settled })

  expect(t.notifier.sent).toHaveLength(0)
  page.answer('allowed-once')
  await expect(answer).resolves.toBe('allowed-once')
})

test('提问立即委托页面，并在宽限后提示、作答后撤回', async () => {
  const t = setup({ askGraceMs: 500 })
  const page = pageAnswer()
  const answer = t.dispatcher.notifyQuestion({
    agent: { session },
    payload: { questions: [{ id: 'q1', question: '选哪个？' }] },
    settled: page.settled,
  })

  t.scheduler.advance(499)
  expect(t.notifier.sent).toHaveLength(0)

  t.scheduler.advance(1)
  expect(t.notifier.sent).toHaveLength(1)
  expect(t.notifier.sent[0]?.actions).toBeUndefined()

  page.answer({ answers: [] })
  await flush()
  expect(t.notifier.dismissed).toEqual([1])
  await expect(answer).resolves.toEqual({ answers: [] })
})

test('计划评审使用专属标题', () => {
  const t = setup({ askGraceMs: 100 })
  const page = pageAnswer()
  void t.dispatcher.notifyQuestion({
    agent: { session },
    payload: { wait: { callId: 'call-1' }, questions: [{ id: 'review', question: '同意吗？', intent: { kind: 'plan-review' } }] },
    settled: page.settled,
  })
  t.scheduler.advance(100)
  expect(t.notifier.sent[0]).toMatchObject({ title: 'DSH · 计划待确认', key: 'question:s1:call-1' })
})

test('onQuestion=false 时提问不提示', () => {
  const t = setup({ askGraceMs: 100, onQuestion: false })
  const page = pageAnswer()
  void t.dispatcher.notifyQuestion({ agent: { session }, payload: { questions: [] }, settled: page.settled })
  t.scheduler.advance(5000)
  expect(t.notifier.sent).toHaveLength(0)
})

test('通知实现抛异常时只记录日志', () => {
  const scheduler = fakeScheduler()
  const logger = fakeLogger()
  const dispatcher = createDispatcher({
    options: resolveOptions(DEFAULTS),
    notifier: throwingNotifier(),
    logger,
    scheduler,
    titleOf: () => 'demo',
    statusOf: () => 'idle',
  })
  dispatcher.onSessionEvent(session, turnEnd(1, 'completed'))
  expect(() => scheduler.advance(5000)).not.toThrow()
  expect(logger.warnings.length).toBeGreaterThan(0)
})

test('dispose 取消未决通知', () => {
  const t = setup({ askGraceMs: 500 })
  const page = pageAnswer()
  void t.dispatcher.notifyQuestion({ agent: { session }, payload: { questions: [] }, settled: page.settled })
  t.dispatcher.dispose()
  t.scheduler.advance(5000)
  expect(t.notifier.sent).toHaveLength(0)
})

test('残缺或异常载荷不抛异常', () => {
  const t = setup()
  const page = pageAnswer()
  expect(() => {
    t.dispatcher.onSessionEvent(session, { type: 'turn/end' })
    t.dispatcher.onSessionEvent(session, { type: 'assistant/message', data: {} })
    void t.dispatcher.answerApproval({ payload: undefined, settled: page.settled })
    void t.dispatcher.notifyQuestion({ payload: { questions: 'nope' }, settled: page.settled })
  }).not.toThrow()
  t.scheduler.advance(5000)
})

test('页面在前台且刚点过：完成通知不弹，但仍照常判定空闲', () => {
  const t = setup({ idleGraceMs: 100 }, 'idle', true)
  t.dispatcher.onSessionEvent(session, turnEnd(3, 'completed'))
  t.scheduler.advance(5000)
  expect(t.notifier.sent).toHaveLength(0)
})

test('页面在前台且刚点过：审批只走页面卡片，通知不弹', async () => {
  const t = setup({}, 'idle', true)
  const page = pageAnswer()
  const hook = toastHook()
  const answer = t.dispatcher.answerApproval({
    agent: { session },
    payload: { toolName: 'pwsh', callId: 'c9' },
    settled: page.settled,
    onAnsweredByToast: hook.onAnsweredByToast,
  })

  expect(t.notifier.sent).toHaveLength(0)
  expect(t.notifier.dismissed).toEqual([])

  page.answer('allowed-once')
  await expect(answer).resolves.toBe('allowed-once')
  expect(hook.state.calls).toBe(0)
})

test('页面在前台且刚点过：提问提示也不弹', () => {
  const t = setup({ askGraceMs: 100 }, 'idle', true)
  const page = pageAnswer()
  void t.dispatcher.notifyQuestion({ agent: { session }, payload: { questions: [{ id: 'q1', question: '选哪个？' }] }, settled: page.settled })
  t.scheduler.advance(5000)
  expect(t.notifier.sent).toHaveLength(0)
})

test('被"保持安静"跳过的通知不占用去重窗口与最小间隔', () => {
  const scheduler = fakeScheduler()
  const notifier = fakeNotifier()
  let quiet = true
  const dispatcher = createDispatcher({
    options: resolveOptions({ ...DEFAULTS, idleGraceMs: 100, dedupeWindowMs: 5000, minIntervalMs: 1000 }),
    notifier,
    logger: fakeLogger(),
    scheduler,
    shouldStayQuiet: () => quiet,
    titleOf: () => 'demo',
    statusOf: () => 'idle',
  })

  // 安静期：同一个轮次键被跳过。
  dispatcher.onSessionEvent(session, turnEnd(7, 'completed'))
  scheduler.advance(100)
  expect(notifier.sent).toHaveLength(0)

  // 同一键随后（去重窗口内）再次触发：没被跳过的那次占用的窗口不该阻塞它。
  quiet = false
  dispatcher.onSessionEvent(session, turnEnd(7, 'completed'))
  scheduler.advance(100)
  expect(notifier.sent).toHaveLength(1)
})
