import {
  MAX_NATIVE_MESSAGE_BYTES,
  NATIVE_HOST_NAME,
  type NativeRequest,
  type NativeResponse,
  parseNativeResponse,
} from "../shared/protocol.ts";
import type { RuntimeApi, RuntimePort } from "../shared/webextension.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

export class NativeHostUnavailableError extends Error {
  public constructor() {
    super("Native Messaging host unavailable");
    this.name = "NativeHostUnavailableError";
  }
}

export class NativeHostTimeoutError extends Error {
  public constructor() {
    super("Native Messaging host timed out");
    this.name = "NativeHostTimeoutError";
  }
}

export class NativeProtocolMismatchError extends Error {
  public constructor() {
    super("Native Messaging protocol is incompatible");
    this.name = "NativeProtocolMismatchError";
  }
}

function isProtocolMismatch(request: NativeRequest, value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  if ("version" in response && response.version !== request.version) return true;
  if (request.method !== "ping" || response.ok !== true) return false;
  const result = response.result;
  return (
    typeof result === "object" &&
    result !== null &&
    !Array.isArray(result) &&
    "protocolVersion" in result &&
    result.protocolVersion !== request.version
  );
}

export function sendNativeRequest<T>(
  runtime: RuntimeApi,
  request: NativeRequest,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<NativeResponse<T>> {
  const requestBytes = new TextEncoder().encode(JSON.stringify(request)).byteLength;
  if (requestBytes > MAX_NATIVE_MESSAGE_BYTES) {
    return Promise.reject(new TypeError("Native Messaging request exceeds the size limit"));
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new TypeError("Native Messaging timeout must be positive"));
  }

  return new Promise((resolve, reject) => {
    let port: RuntimePort;
    try {
      port = runtime.connectNative(NATIVE_HOST_NAME);
    } catch {
      reject(new NativeHostUnavailableError());
      return;
    }

    let settled = false;
    const finish = (action: () => void, disconnect = true): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (disconnect) {
        try {
          port.disconnect();
        } catch {
          // The browser may already have closed a failed native connection.
        }
      }
      action();
    };
    const timeout = setTimeout(() => finish(() => reject(new NativeHostTimeoutError())), timeoutMs);

    port.onMessage.addListener((rawResponse) => {
      try {
        const responseBytes = new TextEncoder().encode(JSON.stringify(rawResponse)).byteLength;
        if (responseBytes > MAX_NATIVE_MESSAGE_BYTES) {
          throw new TypeError("Native Messaging response exceeds the size limit");
        }
        const response = parseNativeResponse<T>(request, rawResponse);
        finish(() => resolve(response));
      } catch (error) {
        finish(() =>
          reject(
            isProtocolMismatch(request, rawResponse) ? new NativeProtocolMismatchError() : error,
          ),
        );
      }
    });

    port.onDisconnect.addListener(() => {
      // Reading lastError in this callback suppresses browser console noise.
      void runtime.lastError?.message;
      finish(() => reject(new NativeHostUnavailableError()), false);
    });

    try {
      port.postMessage(request);
    } catch {
      finish(() => reject(new NativeHostUnavailableError()));
    }
  });
}
