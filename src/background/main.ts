import {
  NativeHostTimeoutError,
  NativeHostUnavailableError,
  NativeProtocolMismatchError,
  sendNativeRequest,
} from "../native/client.ts";
import { isNativeRequest } from "../shared/protocol.ts";
import type { TransportFailureReason } from "../shared/transport.ts";
import { getRuntime } from "../shared/webextension.ts";

const runtime = getRuntime();

function failureReason(error: unknown): TransportFailureReason {
  if (error instanceof NativeHostUnavailableError) return "HOST_UNAVAILABLE";
  if (error instanceof NativeHostTimeoutError) return "TIMEOUT";
  if (error instanceof NativeProtocolMismatchError) return "UNSUPPORTED_PROTOCOL";
  if (error instanceof TypeError) return "INVALID_RESPONSE";
  return "NATIVE_ERROR";
}

runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== runtime.id || !isNativeRequest(message)) {
    sendResponse(undefined);
    return undefined;
  }

  void sendNativeRequest(runtime, message).then(
    (response) => sendResponse({ kind: "native-response", response }),
    (error: unknown) =>
      sendResponse({
        kind: "transport-error",
        reason: failureReason(error),
      }),
  );
  return true;
});
