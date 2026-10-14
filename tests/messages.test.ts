import { expect, test } from 'vitest'
import { DEFAULTS } from '../src/lib/config'
import { approvalText, collapse, questionText, sessionLabel, testText, truncate, turnCompleteText } from '../src/lib/messages'

const zh = DEFAULTS
const en = { ...DEFAULTS, language: 'en' as const }

test('collapse 与 truncate 折叠空白并截断', () => {
  expect(collapse(' a\n\n  b\tc ')).toBe('a b c')
  expect(truncate('abcdef', 4)).toBe('abc…')
  expect(truncate('abc', 4)).toBe('abc')
})

test('sessionLabel 依次回退到标题、目录名、会话 id', () => {
  expect(sessionLabel({ title: ' 修复登录 ', cwd: 'D:\\code\\x', id: 'abcdefgh1234' })).toBe('修复登录')
  expect(sessionLabel({ cwd: 'D:\\code\\demo-project\\', id: 'abcdefgh1234' })).toBe('demo-project')
  expect(sessionLabel({ id: 'abcdefgh1234' })).toBe('abcdefgh')
  expect(sessionLabel({})).toBeUndefined()
})

test('turnCompleteText 使用标题前缀与会话标签', () => {
  expect(turnCompleteText(zh, '@kongxiangyiren/dsh-notifier')).toEqual({ title: 'DSH · @kongxiangyiren/dsh-notifier', message: '本轮回复完成，等待你的输入' })
  expect(turnCompleteText(zh, undefined).title).toBe('DSH · 会话')
  expect(turnCompleteText(en, 'demo').message).toBe('Turn finished — waiting for your input')
})

test('approvalText 优先本地化 displayReason，其次 reason，最后兜底', () => {
  const localized = approvalText(zh, { session: 'demo', toolName: 'pwsh', displayReason: { en: 'Allow escalation', zh: '允许提权' } })
  expect(localized.title).toBe('DSH · 需要确认')
  expect(localized.message).toBe('demo：允许提权')

  const fromReason = approvalText(en, { session: 'demo', toolName: 'pwsh', reason: 'needs approval', displayReason: { en: 'Allow escalation' } })
  expect(fromReason.message).toBe('demo: Allow escalation')

  const fallback = approvalText(en, { toolName: 'pwsh' })
  expect(fallback.message).toBe('Tool pwsh needs your approval')
})

test('questionText 区分计划评审与多问题', () => {
  const plan = questionText(zh, { session: 'demo', questions: [{ id: 'review', question: '同意这个计划吗？', intent: { kind: 'plan-review' } }] })
  expect(plan.title).toBe('DSH · 计划待确认')
  expect(plan.message).toBe('demo：计划已提交，等待你批准或继续规划')

  const many = questionText(zh, {
    session: 'demo',
    questions: [
      { id: 'a', question: '选哪个方案？' },
      { id: 'b', question: '第二个问题' },
    ],
  })
  expect(many.title).toBe('DSH · 需要你的回答')
  expect(many.message).toBe('demo：选哪个方案？（另有 1 个问题）')

  const empty = questionText(zh, { questions: [] })
  expect(empty.message).toBe('计划已提交，等待你批准或继续规划')
})

test('正文按 maxBodyLength 截断', () => {
  const text = approvalText({ ...zh, maxBodyLength: 20 }, { toolName: 'pwsh', reason: 'x'.repeat(50) })
  expect(text.message).toHaveLength(20)
  expect(text.message.endsWith('…')).toBe(true)
})

test('testText 使用前缀', () => {
  expect(testText({ ...zh, titlePrefix: 'Harness' }).title).toBe('Harness · 通知测试')
})
