import { isNativeRequest, type NativeRequest } from "./protocol.ts";
import type { RuntimeApi, RuntimeMessageSender } from "./webextension.ts";
import { MAX_IMAGE_BYTES } from "../popup/image-bounds.ts";

export type PageScanMessage =
  | { kind: "qr-start" }
  | { kind: "qr-capture" }
  | { kind: "qr-import"; request: NativeRequest };

export function isPageScanMessage(value: unknown): value is PageScanMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (message.kind === "qr-start" || message.kind === "qr-capture")
    return Object.keys(message).length === 1;
  return (
    message.kind === "qr-import" &&
    Object.keys(message).length === 2 &&
    isNativeRequest(message.request) &&
    message.request.method === "importQr"
  );
}

export function isPageSender(sender: RuntimeMessageSender): boolean {
  return (
    sender.frameId === 0 &&
    Number.isSafeInteger(sender.tab?.id) &&
    (sender.tab?.id ?? -1) >= 0 &&
    Number.isSafeInteger(sender.tab?.windowId) &&
    /^(https?:|file:)\/\//u.test(sender.url ?? "")
  );
}

export function pageMessage(
  runtime: Pick<RuntimeApi, "sendMessage" | "lastError">,
  message: PageScanMessage,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("The scan did not respond. Reopen the extension and try again.")),
      7000,
    );
    try {
      runtime.sendMessage(message, (reply) => {
        clearTimeout(timer);
        if (runtime.lastError)
          reject(
            new Error("Could not start the scan on this page. Reopen the extension and try again."),
          );
        else resolve(reply);
      });
    } catch {
      clearTimeout(timer);
      reject(new Error("Page scanning is unavailable in this browser."));
    }
  });
}

export function pageScanError(reply: unknown): string | undefined {
  if (reply && typeof reply === "object" && "error" in reply && typeof reply.error === "string")
    return reply.error;
  return undefined;
}

export function captureBlob(url: unknown): Blob {
  if (typeof url !== "string" || !url.startsWith("data:image/png;base64,"))
    throw new Error("Could not capture this page. Try again on the website containing the QR.");
  try {
    const encoded = url.slice("data:image/png;base64,".length);
    if (encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error();
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    try {
      return new Blob([bytes], { type: "image/png" });
    } finally {
      bytes.fill(0);
    }
  } catch {
    throw new Error("Page image is too large or unreadable. Try a smaller browser window.");
  }
}
