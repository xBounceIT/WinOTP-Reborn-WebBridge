import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { showQrOverlay } from "../src/content/overlay.ts";
import type { RuntimeApi } from "../src/shared/webextension.ts";
import type { NativeRequest } from "../src/shared/protocol.ts";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=";
const rows = (
  JSON.parse(readFileSync(new URL("./fixtures/qr.json", import.meta.url), "utf8")) as {
    auth: string[];
  }
).auth;
function qrPixels(): ImageData {
  const width = (rows.length + 8) * 5;
  const data = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < width; y++)
    for (let x = 0; x < width; x++) {
      const color = rows[Math.floor(y / 5) - 4]?.[Math.floor(x / 5) - 4] === "1" ? 0 : 255;
      data.set([color, color, color, 255], (y * width + x) * 4);
    }
  return { width, height: width, data, colorSpace: "srgb" };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("page overlay selects in place, hides before capture, cancels and prevents duplicate imports", async () => {
  for (const mode of [
    "ok",
    "cancel",
    "pagehide",
    "capture-error",
    "capture-moved",
    "capture-cancel",
    "locked",
    "uncertain",
  ]) {
    const undo: (() => void)[] = [];
    const set = (name: string, value: unknown) => {
      const old = Object.getOwnPropertyDescriptor(globalThis, name);
      Object.defineProperty(globalThis, name, { configurable: true, value });
      undo.push(() => {
        if (old) Object.defineProperty(globalThis, name, old);
        else Reflect.deleteProperty(globalThis, name);
      });
    };
    type Handler = (event: Record<string, unknown>) => void;
    class Element {
      style: Record<string, unknown> = { setProperty() {} };
      hidden = false;
      disabled = false;
      textContent = "";
      innerHTML = "";
      open = false;
      isConnected = true;
      listeners = new Map<string, Handler>();
      onclick: (() => void) | null = null;
      onpointerdown: Handler | null = null;
      onpointermove: Handler | null = null;
      onpointerup: Handler | null = null;
      onpointercancel: Handler | null = null;
      onlostpointercapture: Handler | null = null;
      focused = false;
      setAttribute() {}
      append() {}
      attachShadow() {
        return new Element();
      }
      querySelector(selector: string) {
        return elements[selector];
      }
      showModal() {
        this.open = true;
      }
      close() {
        this.open = false;
      }
      remove() {
        this.isConnected = false;
      }
      contains(node: unknown) {
        return node === this || node === scan || node === cancel;
      }
      focus() {
        this.focused = true;
      }
      setPointerCapture() {}
      releasePointerCapture(pointerId: number) {
        this.onlostpointercapture?.({ pointerId });
      }
      addEventListener(name: string, handler: Handler) {
        this.listeners.set(name, handler);
      }
    }
    const scan = new Element();
    scan.disabled = true;
    const cancel = new Element();
    const dialog = new Element();
    const title = new Element();
    const hint = new Element();
    const rectangle = new Element();
    const shade = new Element();
    const toolbar = new Element();
    const host = new Element();
    const previousFocus = new Element();
    const elements: Record<string, Element> = {
      ".scan": scan,
      ".cancel": cancel,
      ".title": title,
      ".hint": hint,
      ".selection": rectangle,
      ".shade": shade,
      ".toolbar": toolbar,
    };
    const windowEvents = new Map<string, Handler>();
    const viewport = {
      innerWidth: 1000,
      innerHeight: 600,
      scrollX: 0,
      scrollY: 0,
      addEventListener(name: string, handler: Handler) {
        windowEvents.set(name, handler);
      },
      removeEventListener(name: string) {
        windowEvents.delete(name);
      },
    };
    const image = qrPixels();
    let bitmapClosed = 0;
    let reads = 0;
    let captures = 0;
    let captureReply: ((reply: unknown) => void) | undefined;
    let importReply: ((reply: unknown) => void) | undefined;
    const imports: NativeRequest[] = [];
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage() {},
        getImageData() {
          reads++;
          return image;
        },
      }),
    };
    set("HTMLElement", Element);
    set("window", viewport);
    set("requestAnimationFrame", (callback: () => void) => {
      callback();
      return 1;
    });
    set("document", {
      activeElement: previousFocus,
      documentElement: new Element(),
      createElement(type: string) {
        if (type === "dialog") return dialog;
        if (type === "canvas") return canvas;
        if (type === "div") return host;
        return new Element();
      },
    });
    set("createImageBitmap", async () => ({
      width: 1000,
      height: 600,
      close() {
        bitmapClosed++;
      },
    }));
    const runtime: RuntimeApi = {
      id: "extension",
      onMessage: { addListener() {} },
      connectNative() {
        throw new Error("unused");
      },
      sendMessage(message, callback) {
        const request = message as { kind: string; request: NativeRequest };
        if (request.kind === "qr-capture") {
          captures++;
          assert.equal(dialog.open, false);
          captureReply = callback;
          if (mode !== "capture-cancel") {
            if (mode === "capture-moved") viewport.scrollY = 20;
            callback(
              mode === "capture-error"
                ? { error: "Could not capture this page." }
                : { url: `data:image/png;base64,${png}` },
            );
          }
        } else {
          imports.push(request.request);
          importReply = callback;
        }
      },
    };
    const event = (x: number, y: number, pointerId = 1, button = 0) => ({
      clientX: x,
      clientY: y,
      pointerId,
      button,
      target: dialog,
      preventDefault() {},
    });
    try {
      const overlay = showQrOverlay(runtime, "test styles");
      assert.equal(dialog.open, true);
      assert.equal(scan.disabled, true);
      assert.equal(captures, 0);
      scan.onclick?.();
      assert.equal(captures, 0);
      dialog.onpointerdown?.(event(400, 350, 1, 2));
      dialog.onpointerdown?.(event(400, 350));
      dialog.onpointerup?.(event(401, 351));
      assert.equal(scan.disabled, true);
      dialog.onpointerdown?.(event(400, 350));
      dialog.onpointercancel?.({ pointerId: 1 });
      assert.equal(scan.disabled, true);
      dialog.onpointerdown?.(event(400, 350));
      dialog.onpointercancel?.({ pointerId: 2 });
      dialog.onpointermove?.(event(200, 150));
      dialog.onpointerup?.(event(200, 150));
      assert.equal(scan.disabled, false);
      assert.equal(shade.hidden, true);
      let prevented = false;
      dialog.listeners.get("keydown")?.({
        key: "Enter",
        target: cancel,
        preventDefault() {
          prevented = true;
        },
      });
      assert.equal(prevented, false);
      assert.equal(captures, 0);
      assert.deepEqual(
        {
          left: rectangle.style.left,
          top: rectangle.style.top,
          width: rectangle.style.width,
          height: rectangle.style.height,
        },
        { left: "20%", top: "25%", width: "20%", height: "33.333333333333336%" },
      );
      if (mode === "cancel" || mode === "pagehide") {
        if (mode === "cancel") dialog.listeners.get("cancel")?.({ preventDefault() {} });
        else windowEvents.get("pagehide")?.({});
        assert.equal(captures, 0);
        assert.equal(host.isConnected, false);
        assert.equal(previousFocus.focused, true);
      } else {
        const click = scan.onclick;
        scan.onclick?.();
        click?.();
        await tick();
        assert.equal(captures, 1);
        if (mode === "capture-cancel") {
          windowEvents.get("keydown")?.({ key: "Escape", preventDefault() {} });
          captureReply?.({ url: `data:image/png;base64,${png}` });
          await tick();
          assert.equal(imports.length, 0);
          assert.equal(reads, 0);
        } else if (mode === "capture-error" || mode === "capture-moved") {
          assert.equal(imports.length, 0);
          assert.equal(dialog.open, true);
          assert.equal(scan.textContent, "Try again");
          scan.onclick?.();
          assert.equal(scan.textContent, "Scan area");
          assert.equal(scan.disabled, true);
        } else {
          assert.equal(imports.length, 1);
          assert.equal(imports[0]?.method, "importQr");
          assert.equal(reads, 1);
          assert.equal(overlay.busy(), true);
          if (mode === "uncertain") importReply?.({ kind: "transport-error", reason: "TIMEOUT" });
          else
            importReply?.({
              kind: "native-response",
              response: {
                version: 1,
                requestId: imports[0]?.requestId,
                ok: mode === "ok",
                ...(mode === "ok"
                  ? { result: { accepted: true } }
                  : { error: { code: "APP_LOCKED", message: "private" } }),
              },
            });
          await tick();
          assert.equal(overlay.busy(), false);
          assert.equal(bitmapClosed, 1);
          assert.equal(scan.hidden, true);
          assert.match(title.textContent, mode === "ok" ? /QR sent/ : /Could not scan/);
          if (mode === "uncertain") assert.match(hint.textContent, /pending import/);
          assert.doesNotMatch(title.textContent + hint.textContent, /secret=|JBSWY|private/);
          assert.ok(image.data.every((byte) => byte === 0));
          const completed = { title: title.textContent, hint: hint.textContent };
          windowEvents.get("resize")?.({});
          dialog.onpointerdown?.(event(100, 100));
          dialog.onpointerup?.(event(300, 300));
          assert.deepEqual({ title: title.textContent, hint: hint.textContent }, completed);
          assert.equal(scan.hidden, true);
          click?.();
          await tick();
          assert.equal(captures, 1);
          assert.equal(imports.length, 1);
        }
      }
      overlay.close();
      overlay.close();
      assert.equal(host.isConnected, false);
      assert.equal(windowEvents.size, 0);
    } finally {
      for (const restore of undo.reverse()) restore();
    }
  }
});
