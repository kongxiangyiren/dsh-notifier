import { expect, test } from 'vitest'
import { createNotifier, DESKTOP_APP_ID, mojibakeOf, type NotifierImpl } from '../src/lib/notifier'
import { APPROVAL_ACTIONS } from '../src/lib/messages'
import { fakeLogger } from './fakes'

interface RecordingImpl extends NotifierImpl {
  calls: Record<string, unknown>[]
  /** 触发最后一次投递的回调，模拟用户点击/超时。 */
  fire(metadata?: unknown, response?: unknown): void
}

function recordingImpl(): RecordingImpl {
  const calls: Record<string, unknown>[] = []
  let callback: ((error: Error | null, response?: unknown, metadata?: unknown) => void) | undefined

  return {
    calls,
    notify(options, cb) {
      calls.push(options)
      callback = cb
      return undefined
    },
    fire(metadata, response) {
      callback?.(null, response, metadata)
    },
  }
}

const request = { kind: 'turn' as const, key: 'turn:s1:1', title: 'T', message: 'M' }

test('普通通知固定 appID=dsh 且带图标', () => {
  const impl = recordingImpl()
  const notifier = createNotifier({ sound: true, logger: fakeLogger(), impl, iconPath: 'D:\\icons\\deepseek.png' })

  const id = notifier.notify(request)

  expect(DESKTOP_APP_ID).toBe('dsh')
  expect(id).toBeGreaterThan(0)
  expect(impl.calls[0]).toMatchObject({
    title: 'T',
    message: 'M',
    sound: true,
    id,
    appID: 'dsh',
    icon: 'D:\\icons\\deepseek.png',
  })
  expect(impl.calls[0]).not.toHaveProperty('actions')
})

test('带按钮的通知不带 appID（否则 SnoreToast 不回传点击）', () => {
  const impl = recordingImpl()
  const notifier = createNotifier({ sound: false, logger: fakeLogger(), impl })

  notifier.notify({ ...request, actions: APPROVAL_ACTIONS, onAction: () => {} })

  expect(impl.calls[0]).not.toHaveProperty('appID')
  expect(impl.calls[0]?.actions).toEqual(['Allow', 'Deny'])
})

test('通知收起（无按钮回报）时回调 onClosed，点击时回调 onAction', () => {
  const impl = recordingImpl()
  const picked: number[] = []
  let closed = 0
  const notifier = createNotifier({ sound: false, logger: fakeLogger(), impl })

  notifier.notify({ ...request, actions: APPROVAL_ACTIONS, onAction: (index) => picked.push(index), onClosed: () => (closed += 1) })
  impl.fire({ action: 'timedout' })
  impl.fire({ action: 'buttonClicked', button: 'Deny' })
  impl.fire({ action: 'buttonClicked', button: 'Unknown' })

  expect(closed).toBe(2)
  expect(picked).toEqual([1])
})

test('点击按钮回调其索引（标签原样）', () => {
  const impl = recordingImpl()
  const picked: number[] = []
  const notifier = createNotifier({ sound: false, logger: fakeLogger(), impl })

  notifier.notify({ ...request, actions: APPROVAL_ACTIONS, onAction: (index) => picked.push(index) })

  impl.fire({ action: 'buttonClicked', button: 'Allow' })
  impl.fire({ action: 'buttonClicked', button: 'Deny' })
  impl.fire({ action: 'buttonClicked', button: 'Other' })
  impl.fire({ action: 'timedout' })

  expect(picked).toEqual([0, 1])
})

test('非 ASCII 标签的管道失真也能匹配', () => {
  const impl = recordingImpl()
  const picked: number[] = []
  const notifier = createNotifier({ sound: false, logger: fakeLogger(), impl })

  notifier.notify({ ...request, actions: ['允许', '拒绝'], onAction: (index) => picked.push(index) })
  impl.fire({ action: 'buttonClicked', button: mojibakeOf('拒绝') })

  expect(picked).toEqual([1])
})

test('撤回沿用投递时的 appID', () => {
  const impl = recordingImpl()
  const notifier = createNotifier({ sound: false, logger: fakeLogger(), impl })

  const plain = notifier.notify(request)
  notifier.dismiss(plain)
  expect(impl.calls[1]).toMatchObject({ close: plain, appID: 'dsh' })

  const actionable = notifier.notify({ ...request, key: 'k2', actions: APPROVAL_ACTIONS, onAction: () => {} })
  notifier.dismiss(actionable)
  expect(impl.calls[3]).toMatchObject({ close: actionable })
  expect(impl.calls[3]).not.toHaveProperty('appID')
})

test('实现抛错时不影响调用方，只记录日志', () => {
  const logger = fakeLogger()
  const notifier = createNotifier({
    sound: false,
    logger,
    impl: {
      notify() {
        throw new Error('boom')
      },
    },
  })

  expect(() => notifier.notify(request)).not.toThrow()
  expect(() => notifier.dismiss(1)).not.toThrow()
  expect(logger.warnings.length).toBeGreaterThan(0)
})

test('dispose 之后不再投递', () => {
  const impl = recordingImpl()
  const notifier = createNotifier({ sound: false, logger: fakeLogger(), impl })

  notifier.dispose()

  expect(notifier.notify(request)).toBe(0)
  notifier.dismiss(1)
  expect(impl.calls).toHaveLength(0)
})

test('回调报错只记日志', () => {
  const logger = fakeLogger()
  const notifier = createNotifier({
    sound: false,
    logger,
    impl: {
      notify(_options, callback) {
        callback(new Error('hidden'))
      },
    },
  })

  notifier.notify(request)
  expect(logger.warnings.some((line) => line.includes('hidden'))).toBe(true)
})
