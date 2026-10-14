import jsQR from "jsqr";
import { selectionPixels, type Selection } from "./selection.ts";
import { validateImageHeader, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS } from "./image-bounds.ts";
import { createRequest, isQrText, type ErrorCode } from "../shared/protocol.ts";
import { NativeTransportError } from "../shared/transport.ts";
import type { NativeGateway } from "./state.ts";

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
    throw new Error("Selected area is too large. Reopen the extension and select a smaller area.");
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
  if (!qr) throw new Error("No QR code found. Select the entire QR, including its white border.");
  if (!isQrText(qr.data)) throw new Error("This QR code is not a supported authenticator QR code.");
  return qr.data;
}

export async function readQrImage(
  blob: Blob,
  select: (bitmap: ImageBitmap) => Promise<Selection | undefined>,
): Promise<string | undefined> {
  if (
    !/^(image\/png|image\/jpeg|image\/webp)$/u.test(blob.type) ||
    blob.size > MAX_IMAGE_BYTES ||
    blob.size === 0
  ) {
    throw new Error("Page image is too large or unsupported. Try a smaller browser window.");
  }
  let encoded: Uint8Array;
  try {
    encoded = new Uint8Array(await blob.arrayBuffer());
  } catch {
    throw new Error("Could not read the page capture. Reopen the extension and try again.");
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
    throw new Error("Could not read the page capture. Reopen the extension and try again.");
  }
  const canvas = document.createElement("canvas");
  try {
    if (bitmap.width * bitmap.height > MAX_IMAGE_PIXELS) {
      throw new Error("Page image is too large. Try a smaller browser window.");
    }
    const selection = await select(bitmap);
    if (!selection) return undefined;
    const crop = selectionPixels(selection, bitmap.width, bitmap.height);
    canvas.width = crop.width;
    canvas.height = crop.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Image scanning is unavailable in this browser.");
    context.drawImage(
      bitmap,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      crop.width,
      crop.height,
    );
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

export async function sendQr(gateway: NativeGateway, text: string): Promise<void> {
  const response = await gateway.request<{ accepted: true }>(createRequest("importQr", { text }));
  if (response.ok) return;
  switch (response.error.code) {
    case "NATIVE_HOST_ERROR":
      // The host may have sent the QR before losing or rejecting the desktop reply.
      throw new NativeTransportError("NATIVE_ERROR");
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
