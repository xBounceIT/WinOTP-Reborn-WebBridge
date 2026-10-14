import jsQR from "jsqr";
import { validateImageHeader } from "./image-bounds.ts";
import { createRequest, isQrText, type ErrorCode } from "../shared/protocol.ts";
import type { NativeGateway } from "./state.ts";
import { getRuntime } from "../shared/webextension.ts";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;

export class QrImportError extends Error {
  public readonly code: ErrorCode;

  public constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "QrImportError";
    this.code = code;
  }
}

export function decodeQr(image: ImageData): string {
  if (image.width < 1 || image.height < 1 || image.width * image.height > MAX_IMAGE_PIXELS) {
    throw new Error("Image is too large. Crop it around the QR code and try again.");
  }
  // jsQR ignores alpha; transparent pixels from a canvas may have black RGB.
  // Composite the owned pixel buffer onto white before decoding.
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const alpha = (image.data[offset + 3] ?? 0) / 255;
    if (alpha === 1) continue;
    for (let channel = 0; channel < 3; channel++) {
      image.data[offset + channel] =
        (image.data[offset + channel] ?? 0) * alpha + 255 * (1 - alpha);
    }
    image.data[offset + 3] = 255;
  }
  const qr = jsQR(image.data, image.width, image.height, { inversionAttempts: "attemptBoth" });
  if (!qr)
    throw new Error("No QR code found. Make the QR fully visible or crop the image around it.");
  if (!isQrText(qr.data)) throw new Error("This QR code is not a supported authenticator QR code.");
  return qr.data;
}

export async function readQrImage(blob: Blob): Promise<string> {
  if (
    !/^(image\/png|image\/jpeg|image\/webp)$/u.test(blob.type) ||
    blob.size > MAX_IMAGE_BYTES ||
    blob.size === 0
  ) {
    throw new Error("Choose a PNG, JPEG or WebP image up to 10 MB.");
  }
  let encoded: Uint8Array;
  try {
    encoded = new Uint8Array(await blob.arrayBuffer());
  } catch {
    throw new Error("Could not read this image. Choose a PNG, JPEG or WebP file.");
  }
  try {
    validateImageHeader(encoded, blob.type, MAX_IMAGE_PIXELS);
  } finally {
    encoded.fill(0);
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new Error("Could not read this image. Choose a PNG, JPEG or WebP file.");
  }
  const canvas = document.createElement("canvas");
  try {
    if (bitmap.width * bitmap.height > MAX_IMAGE_PIXELS) {
      throw new Error("Image is too large. Crop it around the QR code and try again.");
    }
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Image scanning is unavailable in this browser.");
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    try {
      return decodeQr(image);
    } finally {
      image.data.fill(0);
    }
  } finally {
    bitmap.close();
    canvas.width = 0;
    canvas.height = 0;
  }
}

interface CaptureApi {
  captureVisibleTab(options: { format: "png" }, callback: (url: string) => void): void;
}

export function capturePage(): Promise<Blob> {
  const chrome = (globalThis as typeof globalThis & { chrome?: { tabs?: CaptureApi } }).chrome;
  return new Promise((resolve, reject) => {
    if (!chrome?.tabs) {
      reject(new Error("Page capture is unavailable. Scan a saved image instead."));
      return;
    }
    chrome.tabs.captureVisibleTab({ format: "png" }, (url) => {
      if (getRuntime().lastError || !url?.startsWith("data:image/png;base64,")) {
        reject(
          new Error(
            "Could not capture this page. Reopen the extension on the page or scan a saved image.",
          ),
        );
        return;
      }
      // Decode only the browser-generated inline image; never fetch a URL.
      try {
        const encoded = url.slice("data:image/png;base64,".length);
        if (encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error();
        const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
        resolve(new Blob([bytes], { type: "image/png" }));
      } catch {
        reject(new Error("Page image is too large. Scan a cropped image instead."));
      }
    });
  });
}

export async function sendQr(gateway: NativeGateway, text: string): Promise<void> {
  const response = await gateway.request<{ accepted: true }>(createRequest("importQr", { text }));
  if (response.ok) return;
  switch (response.error.code) {
    case "APP_LOCKED":
      throw new QrImportError(response.error.code, "Unlock WinOTP, then scan again.");
    case "APP_NOT_RUNNING":
      throw new QrImportError(response.error.code, "Open WinOTP, then scan again.");
    case "INVALID_REQUEST":
    case "UNSUPPORTED_PROTOCOL":
      throw new QrImportError(
        response.error.code,
        "Update WinOTP and its bridge to a version that supports QR import. The QR may also be unsupported.",
      );
    default:
      throw new QrImportError(
        response.error.code,
        "WinOTP could not accept the QR code. Try again from the desktop app.",
      );
  }
}
