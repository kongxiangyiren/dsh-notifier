/**
 * @kongxiangyiren/dsh-notifier 的 Client 半体（TypeScript 源，tsdown 编译为 `dist/client.js`）。
 *
 * 在「插件」列表页（bundle 页）直接提供配置表单：注册到槽位 `plugins.bundle.config`，
 * 键为**包名** `@kongxiangyiren/dsh-notifier`——该座位渲染在 bundle 页"描述与组件行之间"，不用点进详情。
 *
 * 另外把「人在不在页面前」的事实上报给 Host 半体（`lib/presence-watch.ts`）：
 * 页面聚焦、可见性与指针点击只有浏览器知道，Host 据此决定要不要弹系统通知。
 *
 * 类型全部取自现成包，不自己声明：
 * - `@deepseek-ai/dsh-client-modules`：`DshWindow` / `ClientBundleRegistration`（模块装载器契约）
 * - `@deepseek-ai/dsh-client-ui-slots`：`Translate`（并增强 `ctx.slots`）
 * - `@deepseek-ai/dsh-client-ui-settings/client`：`ConfigForm` / `ConfigFormSnapshot`
 * - `@deepseek-ai/dsh-client-ui-plugin-manager/client`：`PluginConfigViewProps`（槽位 props）
 * - `@deepseek-ai/dsh-api-remotes/client`：`SettingsPathOpView`（一次配置编辑）
 * - `@deepseek-ai/cordis`：`Context`（`ctx.locale` 由 `@deepseek-ai/dsh-client-locale` 增强）
 * - `react`：运行时 React 仍从模块表 `require('react')` 取，类型用 `@types/react`
 *
 * 规范约束：不 import（打包）任何 Harness Client 包；样式仅用 `--dsw-alias-*` 主题 token；
 * 类名统一 `dsh-notifier-` 前缀——**不能用 scoped 包名做前缀**（`@` 与 `/` 不是合法的
 * CSS 标识符字符，`.@scope/pkg-x` 这类选择器会被浏览器整条丢弃）；可见文案走 Client locale 服务。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ClientBundleRegistration, DshWindow } from '@deepseek-ai/dsh-client-modules/client'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { LocaleDictOf, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReactElement } from 'react'
import { CLIENT_CSS } from './lib/client-css'
import { startPresenceWatch } from './lib/presence-watch'
// 仅为加载 `Context` 增强：`ctx.slots`（renderer/client）与 `ctx.locale`（locale/client）。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'

declare const window: DshWindow

/** 一次配置编辑：直接从表单 API 推导，避免再多一个包依赖。 */
type SettingsPathOpView = Parameters<ConfigForm<Record<string, unknown>>['mutate']>[0][number]

/** 一个配置字段在本表单里的展示方式。 */
interface FieldSpec {
  key: string
  kind: 'boolean' | 'enum' | 'number' | 'text'
  def: unknown
  options?: string[]
  min?: number
  max?: number
}

/** 表单组件收到的 props：槽位 ownerProps + 本插件注入的 `t` / `configForm`。 */
type PageProps = PluginConfigViewProps & {
  t: Translate
  configForm?: ConfigForm<Record<string, unknown>> | undefined
}

/** 本插件在 `plugins.bundle.config` 座位上的注册。 */
const registration: ClientBundleRegistration = {
  id: '@kongxiangyiren/dsh-notifier',
  factory(require) {
    const React = require('react') as typeof import('react')
    const h = React.createElement

    const NS = '@kongxiangyiren/dsh-notifier'
    /** 本包 patch 里的行 id，同时也是配置命名空间（profile entry id）。 */
    const ROW_ID = '@kongxiangyiren/dsh-notifier'

    const zh: LocaleDictOf<'@kongxiangyiren/dsh-notifier'> = {
      title: '通知设置',
      unavailable: '当前连接不提供该配置，或不允许写入。',
      save: '保存',
      reset: '恢复默认',
      saved: '已保存',
      saving: '保存中…',
      failed: '保存失败：{message}',
      refused: '保存被拒绝：配置可能已被其他窗口修改。',
      pending: '有未保存的修改',
      languageZh: '中文',
      languageEn: 'English',
      'field.onTurnComplete': '对话完成时通知',
      'field.onApproval': '需要审批时通知',
      'field.onQuestion': '需要回答或评审时通知',
      'field.onTurnError': '轮次以错误结束时也通知',
      'field.includeSubagents': '包含子代理会话的完成通知',
      'field.sound': '播放通知音',
      'field.dismissWhenAnswered': '作答后撤回通知',
      'field.stayQuietOnFocusedPage': '页面在前台且刚点过时不弹通知',
      'field.focusedClickWindowMs': '「刚点过」的时间窗（毫秒）',
      'field.onStartup': '激活时发测试通知（下次加载生效）',
      'field.language': '通知文案语言',
      'field.titlePrefix': '通知标题前缀',
      'field.debugLog': '诊断日志路径（下次加载生效）',
      'field.maxBodyLength': '正文最大字符数',
      'field.idleGraceMs': '完成后确认空闲的等待（毫秒）',
      'field.askGraceMs': '询问后等待作答（毫秒）',
      'field.dedupeWindowMs': '同一触发键去重窗口（毫秒）',
      'field.askCoalesceMs': '同会话确认合并窗口（毫秒，0 = 每条都弹）',
      'field.minIntervalMs': '对话完成通知最小间隔（毫秒）',
    }
    const en: LocaleDictOf<'@kongxiangyiren/dsh-notifier'> = {
      title: 'Notification settings',
      unavailable: 'This connection does not expose the configuration, or does not accept writes.',
      save: 'Save',
      reset: 'Reset',
      saved: 'Saved',
      saving: 'Saving…',
      failed: 'Save failed: {message}',
      refused: 'Save was refused: the configuration may have changed elsewhere.',
      pending: 'Unsaved changes',
      languageZh: '中文',
      languageEn: 'English',
      'field.onTurnComplete': 'Notify when a turn finishes',
      'field.onApproval': 'Notify when approval is needed',
      'field.onQuestion': 'Notify when a question or plan review is pending',
      'field.onTurnError': 'Also notify when a turn ends with an error',
      'field.includeSubagents': 'Include subagent sessions',
      'field.sound': 'Play the notification sound',
      'field.dismissWhenAnswered': 'Dismiss the notification once answered',
      'field.stayQuietOnFocusedPage': 'Stay quiet while the page is focused and just clicked',
      'field.focusedClickWindowMs': 'Recent-click window (ms)',
      'field.onStartup': 'Send a test notification on activation (applies on next load)',
      'field.language': 'Notification copy language',
      'field.titlePrefix': 'Notification title prefix',
      'field.debugLog': 'Diagnostic log path (applies on next load)',
      'field.maxBodyLength': 'Maximum body length',
      'field.idleGraceMs': 'Idle re-check delay (ms)',
      'field.askGraceMs': 'Ask grace before notifying (ms)',
      'field.dedupeWindowMs': 'Dedupe window (ms)',
      'field.askCoalesceMs': 'Per-session coalesce window (ms, 0 = notify every confirmation)',
      'field.minIntervalMs': 'Minimum interval between turn notifications (ms)',
    }

    /** 与 Host Config schema 一一对应的字段清单（标签走词典，`def` 用于回显与恢复）。 */
    const FIELDS: readonly FieldSpec[] = [
      { key: 'onTurnComplete', kind: 'boolean', def: true },
      { key: 'onApproval', kind: 'boolean', def: true },
      { key: 'onQuestion', kind: 'boolean', def: true },
      { key: 'onTurnError', kind: 'boolean', def: false },
      { key: 'includeSubagents', kind: 'boolean', def: false },
      { key: 'sound', kind: 'boolean', def: true },
      { key: 'dismissWhenAnswered', kind: 'boolean', def: true },
      { key: 'stayQuietOnFocusedPage', kind: 'boolean', def: true },
      { key: 'focusedClickWindowMs', kind: 'number', def: 60000, min: 0, max: 600000 },
      { key: 'onStartup', kind: 'boolean', def: false },
      { key: 'language', kind: 'enum', def: 'zh', options: ['zh', 'en'] },
      { key: 'titlePrefix', kind: 'text', def: 'DSH' },
      { key: 'debugLog', kind: 'text', def: '' },
      { key: 'maxBodyLength', kind: 'number', def: 200, min: 20, max: 1000 },
      { key: 'idleGraceMs', kind: 'number', def: 1200, min: 0, max: 60000 },
      { key: 'askGraceMs', kind: 'number', def: 800, min: 0, max: 60000 },
      { key: 'dedupeWindowMs', kind: 'number', def: 5000, min: 0, max: 600000 },
      { key: 'askCoalesceMs', kind: 'number', def: 0, min: 0, max: 600000 },
      { key: 'minIntervalMs', kind: 'number', def: 1000, min: 0, max: 600000 },
    ]

    /** 字段当前值：本地草稿优先，其次 Host 值，最后 schema 默认值。 */
    function currentValue(field: FieldSpec, draft: Record<string, unknown>, values: Record<string, unknown>): unknown {
      if (Object.prototype.hasOwnProperty.call(draft, field.key)) return draft[field.key]
      return values[field.key] === undefined ? field.def : values[field.key]
    }

    /** 还没有快照时的占位（hooks 必须无条件调用，所以先给一个稳定引用）。 */
    const EMPTY_SNAPSHOT: ConfigFormSnapshot<Record<string, unknown>> = {
      status: 'loading',
      value: undefined,
      base: undefined,
      user: undefined,
      revision: undefined,
      writable: false,
      mode: 'host',
    }

    /** 订阅 `configForms` 得到的表单视图。 */
    interface LiveForm {
      state: ConfigFormSnapshot<Record<string, unknown>>
      mutate(ops: readonly SettingsPathOpView[], revision: number | undefined): Promise<boolean>
    }

    /**
     * 订阅 client 的 `configForms` 服务（`ctx.configForms.get(ns)`）。
     * @param configForm 表单对象；服务不可用时 undefined。
     * @returns `{ state, mutate }`。
     */
    function useLiveForm(configForm: ConfigForm<Record<string, unknown>> | undefined): LiveForm | undefined {
      const subscribe = React.useCallback(
        (listener: () => void) => (configForm === undefined ? () => {} : configForm.subscribe(listener)),
        [configForm],
      )
      const getSnapshot = React.useCallback(
        () => (configForm === undefined ? EMPTY_SNAPSHOT : configForm.getSnapshot()),
        [configForm],
      )
      const snapshot = React.useSyncExternalStore<ConfigFormSnapshot<Record<string, unknown>>>(subscribe, getSnapshot)
      if (configForm === undefined) return undefined
      return { state: snapshot, mutate: (ops, revision) => configForm.mutate(ops, revision) }
    }

    /** 配置表单：读快照当前值，提交路径式编辑。 */
    function Page(props: PageProps): ReactElement | null {
      const { t, configForm } = props
      const live = useLiveForm(configForm)
      const [draft, setDraft] = React.useState<Record<string, unknown>>({})
      const [status, setStatus] = React.useState<{ kind: string; message?: string }>({ kind: 'idle' })
      const snapshot = (live !== undefined && live.state) || EMPTY_SNAPSHOT
      const revision = snapshot.revision
      const values = snapshot.value ?? {}
      const overrides = (snapshot.user ?? {}) as Record<string, unknown>

      // Host 接受新版本后丢弃草稿与状态。
      React.useEffect(() => {
        setDraft({})
        setStatus({ kind: 'idle' })
      }, [revision])

      if (live === undefined) return null

      const writable = snapshot.writable && snapshot.status === 'ready'
      const dirty = FIELDS.filter(
        (field) =>
          Object.prototype.hasOwnProperty.call(draft, field.key) &&
          JSON.stringify(draft[field.key]) !== JSON.stringify(currentValue(field, {}, values)),
      )

      const submit = (ops: readonly SettingsPathOpView[], refusalText: string): void => {
        setStatus({ kind: 'saving' })
        void live.mutate(ops, revision).then(
          (ok) => {
            setStatus(ok ? { kind: 'saved' } : { kind: 'failed', message: refusalText })
            if (ok) setDraft({})
          },
          (error: unknown) => setStatus({ kind: 'failed', message: String((error as Error | undefined)?.message ?? error) }),
        )
      }
      const save = (): void => {
        if (dirty.length === 0) return
        submit(
          dirty.map((field) => ({ op: 'set', path: [field.key], value: draft[field.key] }) as SettingsPathOpView),
          t('refused'),
        )
      }
      const reset = (field: FieldSpec): void => {
        setDraft((current) => {
          const next = { ...current }
          delete next[field.key]
          return next
        })
        submit([{ op: 'unset', path: [field.key] }], t('refused'))
      }

      const rows = FIELDS.map((field) => {
        const value = currentValue(field, draft, values)
        const label = t('field.' + field.key)
        let control: ReactElement
        if (field.kind === 'boolean') {
          control = h('button', {
            key: 'control',
            type: 'button',
            className: 'dsh-notifier-switch',
            role: 'switch',
            'aria-checked': value === true ? 'true' : 'false',
            'aria-label': label,
            disabled: !writable,
            onClick: () => setDraft((current) => ({ ...current, [field.key]: value !== true })),
          })
        } else if (field.kind === 'enum') {
          control = h(
            'select',
            {
              key: 'control',
              className: 'dsh-notifier-input',
              value: String(value),
              disabled: !writable,
              'aria-label': label,
              onChange: (event: { target: { value: string } }) =>
                setDraft((current) => ({ ...current, [field.key]: event.target.value })),
            },
            (field.options ?? []).map((option) =>
              h('option', { key: option, value: option }, option === 'zh' ? t('languageZh') : t('languageEn')),
            ),
          )
        } else if (field.kind === 'number') {
          control = h('input', {
            key: 'control',
            className: 'dsh-notifier-input',
            type: 'number',
            value: String(value),
            min: field.min,
            max: field.max,
            disabled: !writable,
            'aria-label': label,
            onChange: (event: { target: { value: string } }) => {
              const parsed = Number(event.target.value)
              if (event.target.value === '' || Number.isNaN(parsed)) return
              setDraft((current) => ({ ...current, [field.key]: parsed }))
            },
          })
        } else {
          control = h('input', {
            key: 'control',
            className: 'dsh-notifier-input',
            type: 'text',
            value: String(value ?? ''),
            placeholder: String(field.def ?? ''),
            disabled: !writable,
            'aria-label': label,
            onChange: (event: { target: { value: string } }) =>
              setDraft((current) => ({ ...current, [field.key]: event.target.value })),
          })
        }

        return h(
          'li',
          { className: 'dsh-notifier-row', key: field.key },
          h(
            'span',
            { className: 'dsh-notifier-main' },
            h('span', { className: 'dsh-notifier-name' }, label),
            h('span', { className: 'dsh-notifier-hint' }, field.key),
          ),
          h(
            'span',
            { className: 'dsh-notifier-side' },
            control,
            overrides[field.key] === undefined
              ? null
              : h(
                  'button',
                  {
                    key: 'reset',
                    type: 'button',
                    className: 'dsh-notifier-link',
                    disabled: !writable,
                    onClick: () => reset(field),
                  },
                  t('reset'),
                ),
          ),
        )
      })

      return h(
        'div',
        { className: 'dsh-notifier' },
        h('style', { key: 'css' }, CLIENT_CSS),
        h('p', { className: 'dsh-notifier-title', key: 'title' }, t('title')),
        writable ? null : h('p', { className: 'dsh-notifier-note', key: 'note' }, t('unavailable')),
        h('ul', { className: 'dsh-notifier-rows', key: 'rows' }, rows),
        h(
          'div',
          { className: 'dsh-notifier-actions', key: 'actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-notifier-button',
              disabled: !writable || dirty.length === 0,
              onClick: save,
            },
            t('save'),
          ),
          h(
            'span',
            { className: 'dsh-notifier-status', 'data-kind': status.kind },
            status.kind === 'saved'
              ? t('saved')
              : status.kind === 'saving'
                ? t('saving')
                : status.kind === 'failed'
                  ? t('failed', { message: status.message ?? '' })
                  : dirty.length > 0
                    ? t('pending')
                    : '',
          ),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx: Context): void {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), '@kongxiangyiren/dsh-notifier: dictionaries')
        const t = ctx.locale.bind(NS)

        // 「人在页面前」的上报：只有浏览器知道本页是否聚焦、上次点击是多久以前，
        // Host 半体据此决定要不要弹通知（协议与判定见 src/lib/presence.ts）。
        ctx.effect(
          () =>
            startPresenceWatch({
              log: (message) => ctx.logger.debug(`@kongxiangyiren/dsh-notifier: ${message}`),
            }),
          '@kongxiangyiren/dsh-notifier: presence reporting',
        )

        // 「插件」列表页：bundle 页"描述与组件行之间"的座位，键为包名。
        // owner 不带 form，所以自己从 client 的 configForms 服务取表单。
        ctx.inject(['configForms'], (scope) => {
          const configForm = scope.configForms.get(ROW_ID) as ConfigForm<Record<string, unknown>> | undefined
          scope.slots.inject('plugins.bundle.config', () =>
            scope.slots.register(
              {
                name: 'plugins.bundle.config',
                key: NS,
                locale: NS,
                inject: () => ({ t, configForm }),
              },
              Page,
            ),
          )
        })
      },
    }
  },
}

window.__ModuleLoader__?.load(registration)
