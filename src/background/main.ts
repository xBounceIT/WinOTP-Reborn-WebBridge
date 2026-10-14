import {
  NativeHostTimeoutError,
  NativeHostUnavailableError,
  NativeProtocolMismatchError,
  sendNativeRequest,
} from "../native/client.ts";
import { isNativeRequest, type NativeRequest } from "../shared/protocol.ts";
import type { TransportFailureReason } from "../shared/transport.ts";
import { getRuntime } from "../shared/webextension.ts";

import { captureSenderPage, startPageScan } from "./page-scan.ts";
import { isPageScanMessage, isPageSender } from "../shared/page-scan.ts";

const runtime = getRuntime();
const importingTabs = new Set<number>();

async function nativeReply(message: NativeRequest): Promise<unknown> {
  try {
    return { kind: "native-response", response: await sendNativeRequest(runtime, message) };
  } catch (error) {
    return { kind: "transport-error", reason: failureReason(error) };
  }
}

function failureReason(error: unknown): TransportFailureReason {
  if (error instanceof NativeHostUnavailableError) return "HOST_UNAVAILABLE";
  if (error instanceof NativeHostTimeoutError) return "TIMEOUT";
  if (error instanceof NativeProtocolMismatchError) return "UNSUPPORTED_PROTOCOL";
  if (error instanceof TypeError) return "INVALID_RESPONSE";
  return "NATIVE_ERROR";
}

runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== runtime.id) {
    sendResponse(undefined);
    return undefined;
  }
  if (isPageScanMessage(message)) {
    if (message.kind === "qr-start" && !sender.tab) {
      void startPageScan().then(
        () => sendResponse({ ok: true }),
        (error: unknown) =>
          sendResponse({
            error: error instanceof Error ? error.message : "Could not start page scanning.",
          }),
      );
      return true;
    }
    if (isPageSender(sender) && message.kind === "qr-capture") {
      void captureSenderPage(sender).then(
        (url) => sendResponse({ url }),
        (error: unknown) =>
          sendResponse({
            error: error instanceof Error ? error.message : "Could not capture this page.",
          }),
      );
      return true;
    }
    if (isPageSender(sender) && message.kind === "qr-import") {
      const tabId = sender.tab!.id!;
      if (importingTabs.has(tabId)) {
        sendResponse({ kind: "transport-error", reason: "NATIVE_ERROR" });
        return undefined;
      }
      importingTabs.add(tabId);
      void nativeReply(message.request)
        .then(sendResponse)
        .finally(() => importingTabs.delete(tabId));
      return true;
    }
  }
  // Injected page code may submit only an explicit QR import through the scoped route.
  if (sender.tab || !isNativeRequest(message)) {
    sendResponse(undefined);
    return undefined;
  }
  void nativeReply(message).then(sendResponse);
  return true;
});
