import assert from "node:assert/strict";
import test from "node:test";

import { createRequest, type NativeRequest } from "../src/shared/protocol.ts";
import type { RuntimeApi, RuntimePort } from "../src/shared/webextension.ts";

type Listener = (event?: { currentTarget: unknown }) => void;

function setGlobal(name: string, value: unknown): PropertyDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
  return descriptor;
}

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}

function nativeResponse(request: NativeRequest): unknown {
  const envelope = { version: 1 as const, requestId: request.requestId, ok: true as const };
  switch (request.method) {
    case "importQr":
      return { ...envelope, result: { accepted: true } };
    case "ping":
      return { ...envelope, result: { protocolVersion: 1, bridgeVersion: "1.0.0" } };
    case "getStatus":
      return { ...envelope, result: { state: "unlocked", appVersion: "1.0.0" } };
    case "listAccounts":
      return {
        ...envelope,
        result: {
          accounts: [
            { id: "account-1", issuer: "Issuer & Co", name: "<user>" },
            { id: "account-2", issuer: "", name: "No issuer" },
          ],
        },
      };
    case "getTotp":
      return { ...envelope, result: { code: "123456", expiresIn: 30, period: 30 } };
  }
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("runs the popup and background entrypoints against browser-compatible APIs", async () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let now = 1_000;
  let wallOffset = 0;
  const originalNow = Date.now;
  let totpDelay = 0;
  let clipboardFails = false;
  const listeners = new Map<string, Listener>();
  let intervalListener: (() => void) | undefined;
  let timeoutListener: (() => void) | undefined;
  let markup = "";
  let copiedCode = "";
  const popupRequests: string[] = [];
  let popupMode:
    | "host-missing"
    | "app-not-running"
    | "connection-error"
    | "account-not-found"
    | "locked"
    | "incompatible"
    | "ready" = "host-missing";

  const search = {
    value: "",
    addEventListener(_type: string, listener: Listener) {
      listeners.set("search", listener);
    },
    focus() {},
    setSelectionRange() {},
  };
  const accountAction = {
    dataset: { accountId: "account-1" },
    addEventListener(_type: string, listener: Listener) {
      listeners.set("reveal", listener);
    },
  };
  const secondAccountAction = {
    dataset: { accountId: "account-2" },
    addEventListener(_type: string, listener: Listener) {
      listeners.set("reveal-second", listener);
    },
  };
  const copyButton = {
    dataset: { copyCode: "123456" },
    addEventListener(_type: string, listener: Listener) {
      listeners.set("copy", listener);
    },
  };
  const retryButton = {
    addEventListener(_type: string, listener: Listener) {
      listeners.set("retry", listener);
    },
  };
  const scanPageButton = {
    addEventListener(_type: string, listener: Listener) {
      listeners.set("scan-page", listener);
    },
  };
  const countdown = {
    textContent: "",
    label: "",
    style: { setProperty() {} },
    setAttribute(_name: string, value: string) {
      this.label = value;
    },
  };
  const toast = { hidden: true, textContent: "" };
  const root = {
    get innerHTML() {
      return markup;
    },
    set innerHTML(value: string) {
      markup = value;
    },
    querySelector(selector: string): unknown {
      if (selector === "[data-scan-page]" && markup.includes("data-scan-page"))
        return scanPageButton;
      if (selector === "[data-action='retry']" && markup.includes('data-action="retry"'))
        return retryButton;
      if (selector === "[data-search]" && markup.includes("data-search")) return search;
      if (selector === "[data-copy-code]" && markup.includes('data-copy-code="123456"'))
        return copyButton;
      if (selector === ".countdown" && markup.includes("account--revealed")) return countdown;
      if (selector === ".toast") return toast;
      return null;
    },
    querySelectorAll(selector: string): readonly unknown[] {
      if (selector !== "[data-account-id]") return [];
      const actions: unknown[] = [];
      if (markup.includes('data-account-id="account-1"')) actions.push(accountAction);
      if (markup.includes('data-account-id="account-2"')) actions.push(secondAccountAction);
      return actions;
    },
  };

  const popupRuntime: RuntimeApi = {
    id: "extension-id",
    onMessage: { addListener() {} },
    connectNative() {
      throw new Error("unused");
    },
    sendMessage(message, callback) {
      if (
        message &&
        typeof message === "object" &&
        "kind" in message &&
        message.kind === "qr-start"
      ) {
        callback({ error: "Page scanning is unavailable in this browser." });
        return;
      }
      const request = message as NativeRequest;
      popupRequests.push(request.method);
      if (popupMode === "incompatible") {
        callback({ kind: "transport-error", reason: "UNSUPPORTED_PROTOCOL" });
        return;
      }
      if (popupMode === "locked" && request.method === "getStatus") {
        callback({
          kind: "native-response",
          response: {
            version: 1,
            requestId: request.requestId,
            ok: true,
            result: { state: "locked", appVersion: "1.0.0" },
          },
        });
        return;
      }
      if (popupMode === "locked" && request.method === "getTotp") {
        callback({
          kind: "native-response",
          response: {
            version: 1,
            requestId: request.requestId,
            ok: false,
            error: { code: "APP_LOCKED", message: "APP_LOCKED" },
          },
        });
        return;
      }
      if (popupMode === "host-missing") {
        callback({ kind: "transport-error", reason: "HOST_UNAVAILABLE" });
        return;
      }
      if (popupMode === "connection-error") {
        callback({ kind: "transport-error", reason: "TIMEOUT" });
        return;
      }
      if (popupMode === "account-not-found" && request.method === "getTotp") {
        callback({
          kind: "native-response",
          response: {
            version: 1,
            requestId: request.requestId,
            ok: false,
            error: { code: "ACCOUNT_NOT_FOUND", message: "ACCOUNT_NOT_FOUND" },
          },
        });
        return;
      }
      if (popupMode === "app-not-running" && request.method === "getStatus") {
        callback({
          kind: "native-response",
          response: {
            version: 1,
            requestId: request.requestId,
            ok: false,
            error: { code: "APP_NOT_RUNNING", message: "APP_NOT_RUNNING" },
          },
        });
        return;
      }
      if (request.method === "getTotp") now += totpDelay;
      callback({ kind: "native-response", response: nativeResponse(request) });
    },
  };

  try {
    Date.now = () => now + wallOffset;
    descriptors.set("performance", setGlobal("performance", { now: () => now }));
    descriptors.set("browser", Object.getOwnPropertyDescriptor(globalThis, "browser"));
    descriptors.set("chrome", setGlobal("chrome", { runtime: popupRuntime }));
    descriptors.set(
      "document",
      setGlobal("document", {
        querySelector(selector: string) {
          return selector === "#app" ? root : null;
        },
      }),
    );
    descriptors.set(
      "window",
      setGlobal("window", {
        clearInterval() {
          intervalListener = undefined;
        },
        setInterval(listener: () => void) {
          intervalListener = listener;
          return 1;
        },
        setTimeout(listener: () => void) {
          timeoutListener = listener;
          return 2;
        },
      }),
    );
    descriptors.set(
      "navigator",
      setGlobal("navigator", {
        clipboard: {
          async writeText(value: string) {
            if (clipboardFails) throw new Error("denied");
            copiedCode = value;
          },
        },
      }),
    );

    await import("../src/popup/main.ts");
    await nextTurn();
    assert.match(markup, /WinOTP bridge not installed/u);
    assert.match(markup, /Allow browser extension access/u);
    assert.match(markup, /Retry connection/u);
    assert.match(markup, /<strong>WebBridge<\/strong>/u);
    assert.doesNotMatch(markup, /Codes stay on this device|<footer/u);

    popupMode = "app-not-running";
    listeners.get("retry")?.();
    await nextTurn();
    assert.match(markup, /WinOTP is not connected/u);
    assert.match(markup, /Allow browser extension access/u);

    popupMode = "connection-error";
    listeners.get("retry")?.();
    await nextTurn();
    assert.match(markup, /Couldn’t connect to WinOTP/u);
    assert.match(markup, /Allow browser extension access/u);

    popupMode = "locked";
    popupRequests.length = 0;
    listeners.get("retry")?.();
    assert.match(markup, /connection--connecting">Connecting<\/p>/u);
    assert.match(markup, /class="state-spinner"/u);
    assert.doesNotMatch(markup, /data-action="retry"/u);
    await nextTurn();
    assert.deepEqual(popupRequests, ["ping", "getStatus"]);
    assert.match(markup, /connection--locked">Locked<\/p>/u);
    assert.match(markup, /WinOTP is locked/u);
    assert.match(markup, /data-action="retry">Check again<\/button>/u);
    const lockedGlyph = markup.match(/<div class="state-glyph"[^>]*>.*?<\/div>/u)?.[0];
    assert.ok(lockedGlyph);
    assert.match(lockedGlyph, /aria-hidden="true"/u);
    assert.match(lockedGlyph, /<svg[^>]*focusable="false"/u);
    assert.match(lockedGlyph, /<rect\b/u);
    assert.doesNotMatch(markup, /Attention needed|state-spinner|data-account-id|data-copy-code/u);

    popupMode = "incompatible";
    listeners.get("retry")?.();
    await nextTurn();
    assert.match(markup, /Bridge version incompatible/u);
    assert.match(markup, /connection--incompatible">Attention needed<\/p>/u);
    const errorGlyph = markup.match(/<div class="state-glyph"[^>]*>.*?<\/div>/u)?.[0];
    assert.ok(errorGlyph);
    assert.notEqual(errorGlyph, lockedGlyph);
    assert.doesNotMatch(errorGlyph, /state-spinner/u);

    popupMode = "ready";
    listeners.get("retry")?.();
    await nextTurn();
    assert.match(markup, /connection--ready">Connected<\/p>/u);
    assert.match(markup, /data-scan-page/);
    assert.doesNotMatch(markup, /data-scan-image|data-qr-file|type="file"/);
    assert.match(markup, /Select QR area/);
    listeners.get("scan-page")?.();
    await nextTurn();
    assert.match(markup, /Page scanning is unavailable/);
    assert.doesNotMatch(markup, /WinOTP connected|connection--ready"><i>/u);
    assert.match(markup, /Issuer &amp; Co/u);
    assert.match(markup, /&lt;user&gt;/u);
    assert.match(markup, /<span class="account__issuer">No issuer<\/span>\s*<\/span>/u);
    assert.match(
      markup,
      /class="account__reveal"[^>]*>[\s\S]*class="reveal-action"[^>]*>Show<\/span>/u,
    );
    assert.equal(markup.match(/data-account-id=/gu)?.length, 2);

    search.value = "missing";
    listeners.get("search")?.();
    assert.match(markup, /No matching accounts/u);
    search.value = "";
    listeners.get("search")?.();

    listeners.get("reveal")?.();
    await nextTurn();
    assert.match(markup, /account--revealed/u);
    assert.equal(markup.match(/data-account-id=/gu)?.length, 1);
    assert.ok(intervalListener);

    now += 1_000;
    intervalListener?.();
    assert.equal(countdown.textContent, "29s");
    assert.equal(countdown.label, "29 seconds remaining");

    listeners.get("copy")?.({ currentTarget: copyButton });
    await nextTurn();
    assert.equal(copiedCode, "123456");
    assert.equal(toast.hidden, false);
    timeoutListener?.();
    assert.equal(toast.hidden, true);

    clipboardFails = true;
    listeners.get("copy")?.({ currentTarget: copyButton });
    await nextTurn();
    assert.equal(toast.textContent, "Could not copy code. Try again.");
    clipboardFails = false;

    now += 29_000;
    copiedCode = "";
    listeners.get("copy")?.({ currentTarget: copyButton });
    await nextTurn();
    assert.equal(copiedCode, "");
    intervalListener?.();
    assert.doesNotMatch(markup, /account--revealed/u);

    totpDelay = 4_000;
    listeners.get("reveal")?.();
    await nextTurn();
    intervalListener?.();
    assert.equal(countdown.textContent, "26s");
    now += 26_000;
    intervalListener?.();
    totpDelay = 31_000;
    listeners.get("reveal")?.();
    await nextTurn();
    assert.doesNotMatch(markup, /data-copy-code/u);
    assert.equal(toast.textContent, "Code expired before it arrived. Select the account again.");
    totpDelay = 0;

    listeners.get("reveal")?.();
    await nextTurn();
    wallOffset += 31_000;
    listeners.get("copy")?.({ currentTarget: copyButton });
    await nextTurn();
    assert.equal(copiedCode, "");
    assert.doesNotMatch(markup, /data-copy-code/u);
    wallOffset = 0;
    listeners.get("reveal")?.();
    await nextTurn();
    wallOffset -= 60_000;
    now += 30_000;
    intervalListener?.();
    assert.doesNotMatch(markup, /data-copy-code/u);
    wallOffset = 0;

    popupMode = "account-not-found";
    listeners.get("reveal")?.();
    await nextTurn();
    assert.match(markup, /Unexpected bridge error/u);
    assert.doesNotMatch(markup, /Allow browser extension access/u);
    assert.ok(markup.includes(errorGlyph));

    popupMode = "ready";
    listeners.get("retry")?.();
    await nextTurn();
    listeners.get("reveal")?.();
    await nextTurn();
    assert.match(markup, /data-copy-code="123456"/u);
    assert.ok(intervalListener);
    popupMode = "locked";
    listeners.get("reveal-second")?.();
    await nextTurn();
    assert.match(markup, /connection--locked">Locked<\/p>/u);
    assert.ok(markup.includes(lockedGlyph));
    assert.doesNotMatch(markup, /123456|Issuer &amp; Co|&lt;user&gt;|No issuer|data-account-id/u);
    assert.equal(intervalListener, undefined);

    popupMode = "ready";
    popupRequests.length = 0;
    listeners.get("retry")?.();
    await nextTurn();
    assert.deepEqual(popupRequests, ["ping", "getStatus", "listAccounts"]);
    assert.match(markup, /connection--ready">Connected<\/p>/u);
    assert.doesNotMatch(markup, /state-glyph|data-copy-code/u);

    let backgroundListener: Parameters<RuntimeApi["onMessage"]["addListener"]>[0] | undefined;
    let nativeMessageListener: ((response: unknown) => void) | undefined;
    let disconnectListener: (() => void) | undefined;
    let nativeMode: "success" | "disconnect" = "success";
    const port: RuntimePort = {
      onDisconnect: {
        addListener(listener) {
          disconnectListener = listener;
        },
      },
      onMessage: {
        addListener(listener) {
          nativeMessageListener = listener;
        },
      },
      disconnect() {},
      postMessage(message) {
        if (nativeMode === "disconnect") disconnectListener?.();
        else nativeMessageListener?.(nativeResponse(message as NativeRequest));
      },
    };
    const backgroundRuntime: RuntimeApi = {
      id: "extension-id",
      onMessage: {
        addListener(listener) {
          backgroundListener = listener;
        },
      },
      connectNative() {
        return port;
      },
      sendMessage() {
        throw new Error("unused");
      },
    };
    setGlobal("chrome", { runtime: backgroundRuntime });
    await import("../src/background/main.ts");
    assert.ok(backgroundListener);

    let invalidReply: unknown = "not called";
    assert.equal(
      backgroundListener?.(createRequest("ping"), { id: "other-extension" }, (response) => {
        invalidReply = response;
      }),
      undefined,
    );
    assert.equal(invalidReply, undefined);

    invalidReply = "not called";
    assert.equal(
      backgroundListener?.({ invalid: true }, { id: "extension-id" }, (response) => {
        invalidReply = response;
      }),
      undefined,
    );
    assert.equal(invalidReply, undefined);

    const request = createRequest("ping");
    const successfulReply = await new Promise<unknown>((resolve) => {
      assert.equal(backgroundListener?.(request, { id: "extension-id" }, resolve), true);
    });
    assert.deepEqual(successfulReply, {
      kind: "native-response",
      response: nativeResponse(request),
    });

    const importRequest = createRequest("importQr", { text: "otpauth://totp/Example?secret=TEST" });
    const importReply = await new Promise<unknown>((resolve) => {
      assert.equal(backgroundListener?.(importRequest, { id: "extension-id" }, resolve), true);
    });
    assert.deepEqual(importReply, {
      kind: "native-response",
      response: {
        version: 1,
        requestId: importRequest.requestId,
        ok: true,
        result: { accepted: true },
      },
    });
    assert.doesNotMatch(JSON.stringify(importReply), /otpauth|secret|TEST/);

    const pageSender = {
      id: "extension-id",
      frameId: 0,
      url: "https://example.test/setup",
      tab: { id: 10, windowId: 7 },
    };
    for (const pageRequest of [
      createRequest("listAccounts"),
      createRequest("getTotp", { accountId: "account-1" }),
      importRequest,
      { kind: "qr-import", request: createRequest("listAccounts") },
      { kind: "qr-start" },
    ]) {
      let reply: unknown = "not called";
      assert.equal(
        backgroundListener?.(pageRequest, pageSender, (value) => {
          reply = value;
        }),
        undefined,
      );
      assert.equal(reply, undefined);
    }
    let frameReply: unknown = "not called";
    assert.equal(
      backgroundListener?.(
        { kind: "qr-import", request: importRequest },
        { ...pageSender, frameId: 1 },
        (reply) => {
          frameReply = reply;
        },
      ),
      undefined,
    );
    assert.equal(frameReply, undefined);
    const scopedImport = await new Promise<unknown>((resolve) => {
      assert.equal(
        backgroundListener?.({ kind: "qr-import", request: importRequest }, pageSender, resolve),
        true,
      );
    });
    assert.deepEqual(scopedImport, importReply);
    assert.doesNotMatch(JSON.stringify(scopedImport), /secret|otpauth|TEST/);

    nativeMode = "disconnect";
    const failedReply = await new Promise<unknown>((resolve) => {
      assert.equal(
        backgroundListener?.(createRequest("ping"), { id: "extension-id" }, resolve),
        true,
      );
    });
    assert.deepEqual(failedReply, { kind: "transport-error", reason: "HOST_UNAVAILABLE" });

    const { getRuntime } = await import("../src/shared/webextension.ts");
    setGlobal("browser", { runtime: popupRuntime });
    assert.equal(getRuntime(), backgroundRuntime);
    Reflect.deleteProperty(globalThis, "chrome");
    assert.equal(getRuntime(), popupRuntime);
    Reflect.deleteProperty(globalThis, "browser");
    assert.throws(() => getRuntime(), /runtime is unavailable/u);
  } finally {
    Date.now = originalNow;
    for (const [name, descriptor] of descriptors) restoreGlobal(name, descriptor);
  }
});
