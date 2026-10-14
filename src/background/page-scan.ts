import { getRuntime, type RuntimeMessageSender } from "../shared/webextension.ts";
import { MAX_IMAGE_BYTES } from "../popup/image-bounds.ts";

interface Tab {
  readonly id?: number;
  readonly windowId: number;
}
interface ScanBrowser {
  tabs: {
    query(
      options: { active: true; currentWindow?: true; windowId?: number },
      callback: (tabs?: Tab[]) => void,
    ): void;
    sendMessage(
      tabId: number,
      message: { kind: "activate-qr-overlay" },
      options: { frameId: 0 },
      callback: (reply: unknown) => void,
    ): void;
    captureVisibleTab(
      windowId: number,
      options: { format: "png" },
      callback: (url?: string) => void,
    ): void;
  };
  scripting: {
    executeScript(
      options: { target: { tabId: number; frameIds: [0] }; files: ["overlay.js"] },
      callback: (results?: { error?: unknown }[]) => void,
    ): void;
  };
}

function browserApi(): ScanBrowser {
  const browser = (globalThis as typeof globalThis & { chrome?: ScanBrowser }).chrome;
  if (!browser?.tabs || !browser.scripting)
    throw new Error("Page scanning is unavailable in this browser.");
  return browser;
}

async function activeTab(windowId?: number): Promise<Tab> {
  return new Promise((resolve, reject) => {
    browserApi().tabs.query(
      windowId === undefined ? { active: true, currentWindow: true } : { active: true, windowId },
      (tabs) => {
        const tab = tabs?.[0];
        if (getRuntime().lastError || !tab || tab.id === undefined)
          reject(new Error("Could not find the page. Reopen the extension and try again."));
        else resolve(tab);
      },
    );
  });
}

export async function startPageScan(): Promise<void> {
  const tab = await activeTab();
  const tabId = tab.id!;
  const api = browserApi();
  await new Promise<void>((resolve, reject) => {
    api.scripting.executeScript(
      { target: { tabId, frameIds: [0] }, files: ["overlay.js"] },
      (results) => {
        if (
          getRuntime().lastError ||
          !results ||
          results.some((result) => result.error !== undefined)
        )
          reject(
            new Error(
              "This browser page does not allow overlays. Open the website containing the QR and try again.",
            ),
          );
        else resolve();
      },
    );
  });
  await new Promise<void>((resolve, reject) => {
    api.tabs.sendMessage(tabId, { kind: "activate-qr-overlay" }, { frameId: 0 }, (reply) => {
      if (
        getRuntime().lastError ||
        !reply ||
        typeof reply !== "object" ||
        !("ok" in reply) ||
        reply.ok !== true
      )
        reject(
          new Error("Could not show the selection overlay. Reopen the extension and try again."),
        );
      else resolve();
    });
  });
}

export async function captureSenderPage(sender: RuntimeMessageSender): Promise<string> {
  const tabId = sender.tab!.id!;
  const windowId = sender.tab!.windowId;
  const ensureSource = async () => {
    if ((await activeTab(windowId)).id !== tabId)
      throw new Error("The active tab changed. Return to the QR page and try again.");
  };
  await ensureSource();
  const image = await new Promise<string>((resolve, reject) => {
    browserApi().tabs.captureVisibleTab(windowId, { format: "png" }, (url) => {
      if (getRuntime().lastError || !url?.startsWith("data:image/png;base64,"))
        reject(
          new Error("Could not capture this page. Try again on the website containing the QR."),
        );
      else if (url.length - "data:image/png;base64,".length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4)
        reject(new Error("Page image is too large. Try a smaller browser window."));
      else resolve(url);
    });
  });
  await ensureSource();
  return image;
}
