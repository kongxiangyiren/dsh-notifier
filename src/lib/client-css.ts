/**
 * Client 半体的样式与类名前缀。
 *
 * 独立成模块是为了能被单测直接 import（client 入口本身会调用
 * `window.__ModuleLoader__.load`，不能在测试里 import）。
 *
 * 前缀约束：类名必须是合法的 CSS 标识符，**不能直接用 scoped 包名**
 * （`@kongxiangyiren/dsh-notifier` 里的 `@` 与 `/` 非法，`.@scope/pkg-x`
 * 这类选择器会被浏览器整条丢弃，样式全失效）。这里固定用包名的后半段。
 */

/** 所有类名的前缀。 */
export const CLASS_PREFIX = 'dsh-notifier'

/**
 * 组合类名：`cx()` 是根容器，`cx('row')` → `dsh-notifier-row`。
 * @param name 类名后缀（省略则为根容器）。
 */
export function cx(name?: string): string {
  return name === undefined || name === '' ? CLASS_PREFIX : `${CLASS_PREFIX}-${name}`
}

/** 拼一条规则，便于阅读与校验。 */
function rule(selector: string, body: string): string {
  return `${selector}{${body}}`
}

/** 表单样式：只用 `--dsw-alias-*` 主题 token，跟随明暗主题。 */
export const CLIENT_CSS: string = [
  rule(`.${CLASS_PREFIX}`, 'display:flex;flex-direction:column;gap:10px;max-width:660px'),
  rule(
    `.${cx('title')}`,
    'margin:0;color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:22px',
  ),
  rule(`.${cx('note')}`, 'margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px'),
  rule(`.${cx('rows')}`, 'display:flex;flex-direction:column;margin:0;padding:0;list-style:none'),
  rule(
    `.${cx('row')}`,
    'display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:.5px solid var(--dsw-alias-border-l2);padding:10px 2px',
  ),
  rule(`.${cx('row')}:last-child`, 'border-bottom:0'),
  rule(`.${cx('main')}`, 'display:flex;flex-direction:column;gap:2px;min-width:0'),
  rule(`.${cx('name')}`, 'color:var(--dsw-alias-label-primary);font-size:13.5px;line-height:20px'),
  rule(
    `.${cx('hint')}`,
    'color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:16px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace',
  ),
  rule(`.${cx('side')}`, 'display:flex;align-items:center;gap:8px;flex:none'),
  rule(
    `.${cx('input')}`,
    'box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;padding:5px 8px;width:190px',
  ),
  rule(`.${cx('input')}:focus-visible`, 'outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px'),
  rule(
    `.${cx('switch')}`,
    'box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;height:20px;padding:0;position:relative;width:36px;flex:none',
  ),
  rule(
    `.${cx('switch')}[aria-checked="true"]`,
    'background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)',
  ),
  rule(
    `.${cx('switch')}::after`,
    'content:"";background:var(--dsw-alias-bg-base);border-radius:50%;height:14px;left:2px;position:absolute;top:2px;transition:transform .12s ease;width:14px',
  ),
  rule(`.${cx('switch')}[aria-checked="true"]::after`, 'transform:translateX(16px)'),
  rule(`.${cx('switch')}:focus-visible`, 'outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px'),
  rule(`.${cx('switch')}:disabled`, 'opacity:.5;cursor:default'),
  rule(`.${cx('actions')}`, 'display:flex;align-items:center;gap:10px;padding-top:2px'),
  rule(
    `.${cx('button')}`,
    'border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);cursor:pointer;font:inherit;font-size:13px;line-height:18px;padding:5px 14px',
  ),
  rule(`.${cx('button')}:disabled`, 'opacity:.5;cursor:default'),
  rule(`.${cx('button')}:focus-visible`, 'outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px'),
  rule(
    `.${cx('link')}`,
    'border:0;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;font-size:12px;line-height:18px;padding:0;text-decoration:underline;text-underline-offset:3px',
  ),
  rule(`.${cx('status')}`, 'font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)'),
  rule(`.${cx('status')}[data-kind="saved"]`, 'color:var(--dsw-alias-state-success-primary)'),
  rule(`.${cx('status')}[data-kind="failed"]`, 'color:var(--dsw-alias-state-error-primary)'),
].join('')
