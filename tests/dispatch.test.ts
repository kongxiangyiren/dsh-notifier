import { expect, test } from 'vitest'
import { DEFAULTS, resolveOptions } from '../src/lib/config'
import { createDispatcher, type AgentStatus, type SessionLike } from '../src/lib/dispatch'
import type { Notifier } from '../src/lib/notifier'
import { fakeLogger, fakeNotifier, fakeScheduler, flush, throwingNotifier } from './fakes'

const session: SessionLike = { id: 's1', header: { cwd: 'D:\\code\\demo' } }
const childSession: SessionLike = { id: 's2', header: { cwd: 'D:\\code\\demo', origin: 'subagent', delegationDepth: 1 } }

function setup(overrides: Record<string, unknown> = {}, status: AgentStatus | undefined = 'idle') {
  const scheduler = fakeScheduler()
  const notifier = fakeNotifier()
  const logger = fakeLogger()
  const options = resolveOptions({ ...DEFAULTS, ...overrides })
  const dispatcher = createDispatcher({
    options,
    notifier,
    logger,
    scheduler,
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

test('同一会话内的多条确认只弹第一条通知，第二条只走页面', () => {
  const t = setup({ askCoalesceMs: 6000, minIntervalMs: 0 })
  const first = pageAnswer()
  const second = pageAnswer()

  void t.dispatcher.answerApproval({ agent: { session }, payload: { toolName: 'a', callId: 'c1' }, settled: first.settled })
  void t.dispatcher.answerApproval({ agent: { session }, payload: { toolName: 'b', callId: 'c2' }, settled: second.settled })

  expect(t.notifier.sent).toHaveLength(1)
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
