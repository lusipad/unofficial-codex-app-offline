import type { GatewayInvokeContext } from "../types";

export const UNHANDLED_CODEX_CHANNEL = Symbol("UNHANDLED_CODEX_CHANNEL");

/**
 * Codex 业务 IPC 抽象。
 *
 * 这一层只关心 Codex 自身的业务 channel，例如会话、模型、设置、
 * 终端、审批等。它不负责实现 Electron 的通用 IPC 语义。
 */
export abstract class IGatewayCodexIpcPort {
  /** 尝试执行业务 IPC；不属于 Codex 业务层时返回 UNHANDLED_CODEX_CHANNEL。 */
  abstract handleCodexRequest(
    channel: string,
    payload: unknown,
    context: GatewayInvokeContext
  ): Promise<unknown | typeof UNHANDLED_CODEX_CHANNEL> | unknown | typeof UNHANDLED_CODEX_CHANNEL;
}
