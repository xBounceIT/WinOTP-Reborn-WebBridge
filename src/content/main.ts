import { getRuntime } from "../shared/webextension.ts";
import { showQrOverlay, type Overlay } from "./overlay.ts";
import styles from "./overlay.css";

const root = globalThis as typeof globalThis & { __winotpQrOverlayInstalled?: boolean };
if (!root.__winotpQrOverlayInstalled) {
  root.__winotpQrOverlayInstalled = true;
  const runtime = getRuntime();
  let overlay: Overlay | undefined;
  runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (
      sender.id !== runtime.id ||
      !message ||
      typeof message !== "object" ||
      !("kind" in message) ||
      message.kind !== "activate-qr-overlay"
    )
      return undefined;
    if (overlay?.busy()) {
      sendResponse({ ok: true });
      return undefined;
    }
    overlay?.close();
    try {
      overlay = showQrOverlay(runtime, styles);
      sendResponse({ ok: true });
    } catch {
      sendResponse({ ok: false });
    }
    return undefined;
  });
}
