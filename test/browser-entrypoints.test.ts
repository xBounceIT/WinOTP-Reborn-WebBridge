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
    case "ping":
      return { ...envelope, result: { protocolVersion: 1, bridgeVersion: "1.0.0" } };
    case "getStatus":
      return { ...envelope, result: { state: "unlocked", appVersion: "1.0.0" } };
    case "listAccounts":
      return {
        ...envelope,
        result: { accounts: [{ id: "account-1", issuer: "Issuer & Co", name: "<user>" }] },
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
  const originalNow = Date.now;
  const listeners = new Map<string, Listener>();
  let intervalListener: (() => void) | undefined;
  let timeoutListener: (() => void) | undefined;
  let markup = "";
  let copiedCode = "";
  let popupMode: "host-missing" | "ready" = "host-missing";

  const search = {
    value: "",
    addEventListener(_type: string, listener: Listener) {
      listeners.set("search", listener);
    },
    focus() {},
    setSelectionRange() {},
  };
  const accountButton = {
    dataset: { accountId: "account-1" },
    addEventListener(_type: string, listener: Listener) {
      listeners.set("account", listener);
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
  const countdown = {
    textContent: "",
    label: "",
    style: { setProperty() {} },
    setAttribute(_name: string, value: string) {
      this.label = value;
    },
  };
  const toast = { hidden: true };
  const root = {
    get innerHTML() {
      return markup;
    },
    set innerHTML(value: string) {
      markup = value;
    },
    querySelector(selector: string): unknown {
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
      return selector === "[data-account-id]" && markup.includes("data-account-id")
        ? [accountButton]
        : [];
    },
  };

  const popupRuntime: RuntimeApi = {
    id: "extension-id",
    onMessage: { addListener() {} },
    connectNative() {
      throw new Error("unused");
    },
    sendMessage(message, callback) {
      const request = message as NativeRequest;
      if (popupMode === "host-missing") {
        callback({ kind: "transport-error", reason: "HOST_UNAVAILABLE" });
        return;
      }
      callback({ kind: "native-response", response: nativeResponse(request) });
    },
  };

  try {
    Date.now = () => now;
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
            copiedCode = value;
          },
        },
      }),
    );

    await import("../src/popup/main.ts");
    await nextTurn();
    assert.match(markup, /WinOTP bridge not installed/u);

    popupMode = "ready";
    listeners.get("retry")?.();
    await nextTurn();
    assert.match(markup, /WinOTP connected/u);
    assert.match(markup, /Issuer &amp; Co/u);
    assert.match(markup, /&lt;user&gt;/u);

    search.value = "missing";
    listeners.get("search")?.();
    assert.match(markup, /No matching accounts/u);
    search.value = "";
    listeners.get("search")?.();

    listeners.get("account")?.();
    await nextTurn();
    assert.match(markup, /account--revealed/u);
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

    now += 29_000;
    intervalListener?.();
    assert.doesNotMatch(markup, /account--revealed/u);

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
