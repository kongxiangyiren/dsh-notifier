# @kongxiangyiren/dsh-notifier

> 对话完成、或需要你确认时，弹出 **Windows 系统通知**的 DeepSeek Harness 插件。

[DeepSeek Harness](https://github.com/deepseek-ai) 在后台跑任务时，你通常不会一直盯着页面。这个插件在一轮对话结束、或它需要你审批 / 回答时，把 Windows 通知横幅推到桌面上；审批通知上还能**直接点 `Allow` / `Deny`** 完成审批，不用切回窗口。

*Windows toast notifications for the DeepSeek Harness: get notified when a turn finishes or your confirmation is needed, and answer approvals straight from the notification.*

---

## 它能做什么

- **对话完成通知** — 一轮对话正常结束时提醒你；用户取消（`aborted`）、被阻塞、崩溃续接，以及宽限期内又开始了新一轮（比如 goal 自动续轮）都不会打扰你。
- **需要确认时通知** — 审批请求（沙箱提权、命令批准等）与结构化提问（`ask_user_question`、计划评审）在你**尚未作答**时才提示；作答或取消后通知仅作提示，**不改变任何审批结果**。
- **审批双通道** — 提示出现时，**页面卡片和系统通知同时存在**，任一方作答即生效、另一方立刻消失：点通知上的按钮后，"等待审批"的页面卡片会自动移除；在页面里作答，通知横幅也会被撤回。不会出现一边已处理、另一边还挂着等待的残留。
- **通知里直接审批** — 审批通知带 `Allow`（允许一次）/ `Deny`（拒绝）两个按钮，点击即完成审批。
- **图形界面里改参数** — 侧边栏 → 插件 → 本插件，表单直接出现在插件页上，改动即时生效，无需重启（跟随明暗主题）。

通知本身**只是提示**：GUI 里的事件才是权威；插件不认领提问、不改变审批，投递失败也只写日志。

## 环境要求

- **Windows**（用系统 Toast 通道；其他平台走 `node-notifier` 默认实现，未做专项验证）
- DeepSeek Harness `0.2.0-rc.2` 环境（插件依赖宿主提供的 `@deepseek-ai/schemastery`）

## 安装

在 Harness 里安装这个 bundle：

1. 打开 **侧边栏 → 插件**，在安装入口填入包名 `@kongxiangyiren/dsh-notifier`（本地开发则填目录绝对路径）；
2. 安装后插件行即生效。想先验证投递链路，可以把配置里的 **`onStartup` 设为 `true`**，下次加载插件时会发一条测试通知。

> 安装的是 Host bundle：Host 半体 `dist/index.mjs` 负责监听与投递，Client 半体 `dist/client.js` 提供上面的配置表单。

## 使用

**通知出现时：**

| 你想做的事 | 怎么做 |
| --- | --- |
| 允许一次审批 | 点通知上的 `Allow`（或直接点横幅正文） |
| 拒绝审批 | 点通知上的 `Deny` |
| 在页面里处理 | 直接在页面卡片上作答，通知会随之撤回 |

有两个由 SnoreToast/Windows 决定的细节：按钮标签固定为 ASCII 的 `Allow` / `Deny`；**横幅收起后（约 7 秒）进程已退出，再点不会回传**——此时在页面卡片上作答即可，两者等价。

## 配置

全部参数都能在 **侧边栏 → 插件 → 本插件** 的表单里修改（改完即时生效）。也可在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: '@kongxiangyiren/dsh-notifier'
  config:
    language: zh            # 默认即是 zh，可改 en
    titlePrefix: DSH        # 通知标题前缀
    askCoalesceMs: 10000    # 同一会话内多条确认的合并窗口（默认 6000）
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `onTurnComplete` | `true` | 一轮对话结束时通知 |
| `onApproval` | `true` | 需要审批时通知 |
| `onQuestion` | `true` | 需要你回答提问或评审计划时通知 |
| `onTurnError` | `false` | 轮次以错误结束时也通知 |
| `includeSubagents` | `false` | 把子代理/队友会话的"完成"通知也算上（审批与提问始终通知） |
| `language` | `zh` | 文案语言：`zh` / `en` |
| `titlePrefix` | `DSH` | 通知标题前缀 |
| `sound` | `true` | 播放系统通知音（`false` 静音） |
| `maxBodyLength` | `200` | 正文最大字符数（超出截断加省略号） |
| `idleGraceMs` | `1200` | 轮次结束后等待多久再确认"确实空闲" |
| `askGraceMs` | `800` | 询问你之后等待多久仍未作答才通知 |
| `dedupeWindowMs` | `5000` | 同一触发键的去重窗口 |
| `askCoalesceMs` | `6000` | 同一会话内多条确认的合并窗口（只弹第一条） |
| `minIntervalMs` | `1000` | 两条通知之间的最小间隔 |
| `dismissWhenAnswered` | `true` | 你作答后撤回对应的"待确认"通知（尽力而为） |
| `onStartup` | `false` | 插件激活时发一条测试通知，用于验证投递链路（下次加载插件时生效） |
| `debugLog` | — | 诊断日志文件路径：记录每次投递、撤回与点击回调的原始数据（下次加载插件时生效） |

字段同时由 schemastery schema 校验，非法值会被钳制到合法区间。表单上改过的字段旁会出现「恢复默认」，等于清掉该字段的覆盖、回落到默认值。

> **覆盖存在哪里**：页面上保存的值由 Harness 写进 profile 的 patch 覆盖层。注意**重装或移除本 bundle 时，安装器会按包内 `cordis.patch.yml` 重新生成那一行配置**，页面里改过的值会随之丢失——改完参数后如无必要不要重装；确需重装，重装后重存一次即可。

## 常见问题

**通知没弹出来？**
先看 Windows 的通知设置：专注助手/勿扰会静音或丢弃 Toast，此时插件侧看不到错误。普通通知以 AUMID `dsh` 投递，Windows 会自动在「设置 → 系统 → 通知」里为它建一项，可单独开关（**不需要**手动注册什么应用）。

**通知上的按钮点不动？**
只有约 7 秒的窗口期（横幅收起后处理进程已退出）。错过窗口时在页面卡片上作答，效果一样。

**带按钮的通知为什么署名 `SnoreToast`？**
实测只有 SnoreToast 默认身份会把按钮点击经命名管道回传；一旦传自定义 `appID`，点击只会以退出码 4 结束、拿不到按钮信息。所以审批类通知用默认身份（署名为 `SnoreToast`），其余通知仍是 `dsh` 身份 + DeepSeek 图标。

**改了参数没生效？**
除 `onStartup` / `debugLog` 外都是即时生效的（这两项在插件装配时读一次）。如果刚重装过插件，见上面的"覆盖存在哪里"。另外：更新插件代码后，已加载进内存的旧模块不会因重装而替换（Node ESM 缓存），需要重启 `dsh web`。

**会不会替我点了审批？**
不会。插件从不认领请求，也不改变审批结果：通知作答与页面作答走的是同一条审批通道，只是把"你的选择"提交进去。

## 开发

```bash
pnpm install
pnpm run build      # tsdown：Host dist/index.mjs + Client dist/client.js（含 sourcemap）
pnpm run typecheck  # tsc --noEmit
pnpm test           # vitest（67 个单测）
pnpm run dev        # tsdown --watch
```

结构：

```
src/index.ts          # Host 半体：Config schema（全部 .volatile()）+ apply()：注册监听、持有 notifier 与定时器
src/client.ts         # Client 半体：注册 plugins.bundle.config，渲染插件页里的配置表单
src/locale.d.ts       # 把词典命名空间登记进 LocaleNamespaceMap（官方声明合并扩展点）
src/lib/config.ts     # 选项归一化（默认值、钳制、未知键忽略）+ 解开 volatile 访问器的 liveOptions()
src/lib/messages.ts   # 单行折叠/截断、会话标签、中英文文案
src/lib/pending.ts    # 宽限竞态、去重、全局最小间隔（注入时钟，便于单测）
src/lib/signal.ts     # 共享审批请求的取消信号：让"通知作答"也能关掉页面卡片
src/lib/dispatch.ts   # 三个触发的编排与撤回
src/lib/notifier.ts   # node-notifier 封装（图标、按钮、点击映射；错误只记日志）
src/lib/client-css.ts # Client 表单样式与类名前缀
```

两条构建管线都在 [tsdown.config.ts](tsdown.config.ts)：Host 走 `platform: node`（生成 `.d.mts`），Client 走 `platform: browser`（带 sourcemap，React 由浏览器模块表提供、不打包）。

### 实现要点

- **配置可实时读取**：字段全部标注 schemastery 的 `.volatile()`，Harness 的 `settings` 服务只把 volatile 字段投影成可编辑表单；`apply()` 通过 `liveOptions()` 每次读取都取当前值。
- **Client 半体的类型全部来自现成包**（`Context` / `DshWindow` / `ClientBundleRegistration` / `ConfigForm` / `Translate` / 槽位 props 等），不自己声明接口。
- **双通道互撤**：插件把 `approval/request` 请求的 `signal` 换成"原信号 + 自己的控制器"，通知作答时取消它；网关随即向客户端推送 `cancel` 帧，页面卡片被移除。反向则由 `dismissWhenAnswered` 撤回通知。
- **样式**：只用 `--dsw-alias-*` 主题 token，不出现任何硬编码颜色（有单测守着：品牌色在深色主题里是近白色，写死白字会看不见）。

## 已知限制

- 通知是否可见由 Windows 决定：专注助手/通知设置可能静音或丢弃 Toast，此时插件侧看不到错误。
- 带按钮的通知必须使用 SnoreToast 默认身份（署名显示 `SnoreToast`）；普通通知是 `dsh` 身份 + 包内 DeepSeek 图标。
- 按钮标签固定 ASCII（`Allow` / `Deny`）：SnoreToast 的管道回传经过 UTF-8/UTF-16 双重解码，非 ASCII 标签会失真。
- 点击窗口约 7 秒：横幅收起（进入通知中心）后处理进程已退出，之后再点不会回传。
- "作答后撤回通知"依赖 SnoreToast 的 `-close`，属于尽力而为，失败只写 debug 日志。
- 计划内容等长文本不会整段展示，正文按 `maxBodyLength` 折叠为单行。
- 仅针对 Windows 桌面通知做实现与验证。

## 许可

[MIT](LICENSE) © 空巷一人
