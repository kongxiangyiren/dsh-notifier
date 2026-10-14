/**
 * 向 Client locale 服务的命名空间表登记本插件的词典。
 *
 * `@deepseek-ai/dsh-client-ui-slots` 的 `LocaleNamespaceMap` 就是为此设计的
 * declaration merging 扩展点（"Dictionary owners extend via declaration merging"）：
 * 登记后 `ctx.locale.register('@kongxiangyiren/dsh-notifier', …)`、槽位注册的 `locale: '@kongxiangyiren/dsh-notifier'`
 * 以及组件 props 上的 `t` 都会按这个命名空间做类型检查。
 */

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** @kongxiangyiren/dsh-notifier 配置表单的界面词典（键见 `src/client.ts` 的 zh/en）。 */
    '@kongxiangyiren/dsh-notifier': string
  }
}

export {}
