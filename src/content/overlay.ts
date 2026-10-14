import type { RuntimeApi } from "../shared/webextension.ts";
import { captureBlob, pageMessage, pageScanError } from "../shared/page-scan.ts";
import { NativeTransportError } from "../shared/transport.ts";
import { createGateway } from "../popup/gateway.ts";
import { readQrImage, sendQr, QrImportError } from "../popup/scan.ts";
import { selectionBetween, type Point, type Selection } from "../popup/selection.ts";

export interface Overlay {
  readonly busy: () => boolean;
  readonly close: () => void;
}

export function showQrOverlay(runtime: RuntimeApi, styles: string): Overlay {
  const previousFocus = document.activeElement;
  const host = document.createElement("div");
  host.style.setProperty("all", "initial", "important");
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = styles;
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-label", "Select a QR code area");
  dialog.innerHTML = `<div class="shade"></div><div class="selection" hidden></div>
    <section class="toolbar" aria-label="QR scan controls">
      <div class="copy" role="status" aria-live="polite"><p class="title">Select a QR code</p>
      <p class="hint">Drag around the code, including its white border · Esc to cancel</p></div>
      <div class="actions"><button class="cancel">Cancel</button><button class="primary scan" disabled>Scan area</button></div>
    </section>`;
  shadow.append(style, dialog);
  document.documentElement.append(host);
  const shade = dialog.querySelector<HTMLElement>(".shade")!;
  const rectangle = dialog.querySelector<HTMLElement>(".selection")!;
  const toolbar = dialog.querySelector<HTMLElement>(".toolbar")!;
  const title = dialog.querySelector<HTMLElement>(".title")!;
  const hint = dialog.querySelector<HTMLElement>(".hint")!;
  const scan = dialog.querySelector<HTMLButtonElement>(".scan")!;
  const cancel = dialog.querySelector<HTMLButtonElement>(".cancel")!;
  let selection: Selection | undefined;
  let start: Point | undefined;
  let pointerId: number | undefined;
  let busy = false;
  let retryMode = false;
  let disposed = false;

  const close = () => {
    if (disposed) return;
    disposed = true;
    dialog.close();
    host.remove();
    window.removeEventListener("pagehide", close);
    window.removeEventListener("resize", resize);
    window.removeEventListener("keydown", captureKey, true);
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
      previousFocus.focus({ preventScroll: true });
  };
  const reset = () => {
    if (busy || disposed) return;
    retryMode = false;
    selection = undefined;
    start = undefined;
    pointerId = undefined;
    shade.hidden = false;
    rectangle.hidden = true;
    scan.hidden = false;
    scan.textContent = "Scan area";
    scan.disabled = true;
    cancel.textContent = "Cancel";
    title.textContent = "Select a QR code";
    hint.textContent = "Drag around the code, including its white border · Esc to cancel";
  };
  const captureKey = (event: KeyboardEvent) => {
    if (busy && event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };
  const canSelect = () => !disposed && !busy && !retryMode && !scan.hidden;
  const resize = () => {
    if (canSelect()) reset();
  };
  const point = (event: PointerEvent): Point => ({
    x: event.clientX / window.innerWidth,
    y: event.clientY / window.innerHeight,
  });
  const update = (event: PointerEvent) => {
    if (!start || pointerId !== event.pointerId || busy) return;
    selection = selectionBetween(start, point(event));
    Object.assign(rectangle.style, {
      left: `${selection.x * 100}%`,
      top: `${selection.y * 100}%`,
      width: `${selection.width * 100}%`,
      height: `${selection.height * 100}%`,
    });
    shade.hidden = true;
    rectangle.hidden = false;
  };
  dialog.onpointerdown = (event) => {
    if (
      !canSelect() ||
      event.button !== 0 ||
      pointerId !== undefined ||
      toolbar.contains(event.target as Node)
    )
      return;
    event.preventDefault();
    start = point(event);
    pointerId = event.pointerId;
    selection = undefined;
    scan.disabled = true;
    dialog.setPointerCapture(event.pointerId);
    update(event);
  };
  dialog.onpointermove = update;
  dialog.onpointerup = (event) => {
    if (event.pointerId !== pointerId) return;
    update(event);
    pointerId = undefined;
    start = undefined;
    dialog.releasePointerCapture(event.pointerId);
    scan.disabled =
      !selection ||
      selection.width * window.innerWidth < 8 ||
      selection.height * window.innerHeight < 8;
    title.textContent = scan.disabled ? "Select the entire QR code" : "Area selected";
    hint.textContent = scan.disabled
      ? "Drag a larger rectangle around the code."
      : "Drag again to adjust, then scan the area.";
  };
  dialog.onlostpointercapture = dialog.onpointercancel = (event) => {
    if (event.pointerId === pointerId) reset();
  };
  dialog.addEventListener("wheel", (event) => event.preventDefault(), { passive: false });
  dialog.addEventListener("contextmenu", (event) => event.preventDefault());
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Enter" && event.target === dialog && !scan.disabled && !scan.hidden) {
      event.preventDefault();
      if (retryMode) reset();
      else void scanArea();
    } else if (
      ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key) &&
      event.target === dialog
    )
      event.preventDefault();
  });
  cancel.onclick = close;
  window.addEventListener("pagehide", close);
  window.addEventListener("resize", resize);
  window.addEventListener("keydown", captureKey, true);

  async function scanArea(): Promise<void> {
    if (!canSelect() || !selection || scan.disabled) return;
    const chosen = selection;
    const viewport = [window.innerWidth, window.innerHeight, window.scrollX, window.scrollY];
    busy = true;
    scan.disabled = true;
    dialog.close();
    try {
      // Remove the dimming layer and controls from the browser's next captured frame.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      if (disposed) return;
      const reply = await pageMessage(runtime, { kind: "qr-capture" });
      if (disposed) return;
      const error = pageScanError(reply);
      if (error) throw new Error(error);
      if (
        viewport.some(
          (value, index) =>
            value !==
            [window.innerWidth, window.innerHeight, window.scrollX, window.scrollY][index],
        )
      )
        throw new Error("The page moved during capture. Select the QR area again.");
      const url = reply && typeof reply === "object" && "url" in reply ? reply.url : undefined;
      const text = await readQrImage(captureBlob(url), async () => (disposed ? undefined : chosen));
      if (!text || disposed) return;
      shade.hidden = true;
      rectangle.hidden = true;
      title.textContent = "Sending to WinOTP…";
      hint.textContent = "Review the import in the desktop app.";
      scan.hidden = true;
      cancel.textContent = "Close";
      dialog.showModal();
      const gateway = createGateway({
        get lastError() {
          return runtime.lastError;
        },
        sendMessage(request, callback) {
          runtime.sendMessage({ kind: "qr-import", request }, callback);
        },
      });
      await sendQr(gateway, text);
      if (!disposed) {
        title.textContent = "QR sent to WinOTP";
        hint.textContent = "Review and confirm the import in WinOTP.";
      }
    } catch (error) {
      if (disposed) return;
      shade.hidden = true;
      rectangle.hidden = true;
      title.textContent = "Could not scan this area";
      hint.textContent =
        error instanceof NativeTransportError
          ? "Check WinOTP for a pending import before scanning again."
          : error instanceof Error
            ? error.message
            : "Try selecting the QR area again.";
      const retry = !(error instanceof NativeTransportError || error instanceof QrImportError);
      scan.hidden = !retry;
      scan.textContent = "Try again";
      scan.disabled = false;
      retryMode = true;
      cancel.textContent = "Close";
      if (!dialog.open) dialog.showModal();
    } finally {
      busy = false;
    }
  }
  scan.onclick = () => {
    if (disposed || busy || scan.hidden) return;
    if (retryMode) reset();
    else void scanArea();
  };
  try {
    dialog.showModal();
  } catch (error) {
    close();
    throw error;
  }
  return { busy: () => busy, close };
}
