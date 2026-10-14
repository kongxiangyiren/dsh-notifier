/**
 * 审批请求的取消信号共享。
 *
 * Web 端把 `approval/request` 转发给浏览器时，网关（`dsh-api-gateway`）会监听请求的
 * `signal`：一旦 abort 就向客户端推送 `cancel` 帧，客户端的 `PendingApproval`
 * 随即移除"等待审批"卡片。插件据此让"通知作答"也能关掉页面卡片——
 * 用 `AbortSignal.any([原信号, 自己的控制器])` 替换请求的 signal，既保留原取消语义，
 * 又让插件可以主动取消。
 *
 * 注意：Cordis 的 waterfall `next()` 不接受改写后的参数，只能原地替换字段。
 */

/** 带可变取消信号的审批请求（`approval/request` 的载荷）。 */
export interface CancellableRequest {
  signal?: AbortSignal
}

/**
 * 让请求的取消信号同时受原信号与给定控制器支配。
 * @param request 审批请求载荷（会被原地修改）。
 * @param controller 插件自己的取消控制器。
 * @returns 实际写入请求的信号。
 */
export function shareCancellation(request: CancellableRequest, controller: AbortController): AbortSignal {
  const original = request.signal
  const shared = original === undefined || original === controller.signal
    ? (original ?? controller.signal)
    : AbortSignal.any([original, controller.signal])
  try {
    request.signal = shared
  } catch {
    // 请求对象被冻结时无法替换：仅退化为"不取消页面请求"，不影响审批结果。
  }
  return shared
}
