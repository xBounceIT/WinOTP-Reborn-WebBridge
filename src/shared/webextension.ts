export interface RuntimeError {
  readonly message?: string;
}

export interface RuntimeMessageSender {
  readonly id?: string;
}

export interface RuntimePort {
  readonly onDisconnect: {
    addListener(listener: () => void): void;
  };
  readonly onMessage: {
    addListener(listener: (message: unknown) => void): void;
  };
  disconnect(): void;
  postMessage(message: unknown): void;
}

export interface RuntimeApi {
  readonly id: string;
  readonly lastError?: RuntimeError;
  readonly onMessage: {
    addListener(
      listener: (
        message: unknown,
        sender: RuntimeMessageSender,
        sendResponse: (response: unknown) => void,
      ) => boolean | undefined,
    ): void;
  };
  sendMessage(message: unknown, callback: (response: unknown) => void): void;
  connectNative(application: string): RuntimePort;
}

type ExtensionGlobals = typeof globalThis & {
  browser?: { runtime?: RuntimeApi };
  chrome?: { runtime?: RuntimeApi };
};

export function getRuntime(): RuntimeApi {
  const root = globalThis as ExtensionGlobals;
  // Firefox exposes the callback-compatible `chrome` namespace as well. Prefer
  // it so this small abstraction has identical behavior in both browsers.
  const runtime = root.chrome?.runtime ?? root.browser?.runtime;
  if (!runtime) throw new Error("WebExtensions runtime is unavailable");
  return runtime;
}
