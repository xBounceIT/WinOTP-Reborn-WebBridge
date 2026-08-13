import {
  parseNativeResponse,
  type NativeRequest,
  type NativeResponse,
} from "../shared/protocol.ts";
import { isBackgroundReply, NativeTransportError } from "../shared/transport.ts";
import type { RuntimeApi } from "../shared/webextension.ts";
import type { NativeGateway } from "./state.ts";

const DEFAULT_BACKGROUND_TIMEOUT_MS = 7_000;

export function createGateway(
  runtime: RuntimeApi,
  timeoutMs = DEFAULT_BACKGROUND_TIMEOUT_MS,
): NativeGateway {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("Background message timeout must be positive");
  }
  return {
    request<T>(request: NativeRequest): Promise<NativeResponse<T>> {
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (action: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          action();
        };
        const timeout = setTimeout(
          () => finish(() => reject(new NativeTransportError("TIMEOUT"))),
          timeoutMs,
        );
        const handleReply = (rawReply: unknown): void => {
          const lastError = runtime.lastError;
          if (settled) return;
          if (lastError) {
            finish(() => reject(new NativeTransportError("NATIVE_ERROR")));
            return;
          }
          if (!isBackgroundReply(rawReply)) {
            finish(() => reject(new NativeTransportError("INVALID_RESPONSE")));
            return;
          }
          if (rawReply.kind === "transport-error") {
            finish(() => reject(new NativeTransportError(rawReply.reason)));
            return;
          }
          try {
            const response = parseNativeResponse<T>(request, rawReply.response);
            finish(() => resolve(response));
          } catch {
            finish(() => reject(new NativeTransportError("INVALID_RESPONSE")));
          }
        };
        try {
          runtime.sendMessage(request, handleReply);
        } catch {
          finish(() => reject(new NativeTransportError("NATIVE_ERROR")));
        }
      });
    },
  };
}
