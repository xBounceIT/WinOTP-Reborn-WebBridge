export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 16 * 1024 * 1024;

// Inspect encoded headers before the browser allocates decoded pixels.
// PNG: https://www.w3.org/TR/png-3/#11IHDR
// JPEG: https://www.w3.org/Graphics/JPEG/itu-t81.pdf (B.2.2)
// WebP: https://developers.google.com/speed/webp/docs/riff_container
export function validateImageHeader(bytes: Uint8Array, type: string, maxPixels: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const invalid = (): never => {
    throw new Error(
      "Could not read the page capture dimensions. Reopen the extension and try again.",
    );
  };
  const dimensions = (width: number, height: number): void => {
    if (!width || !height) invalid();
    if (width * height > maxPixels) {
      throw new Error("Page image is too large. Try a smaller browser window.");
    }
  };
  const matches = (offset: number, value: string): boolean =>
    [...value].every((char, index) => bytes[offset + index] === char.charCodeAt(0));

  if (type === "image/png") {
    if (
      bytes.length < 33 ||
      !matches(0, "\x89PNG\r\n\x1a\n") ||
      view.getUint32(8) !== 13 ||
      !matches(12, "IHDR")
    )
      invalid();
    dimensions(view.getUint32(16), view.getUint32(20));
    return;
  }

  if (type === "image/jpeg") {
    if (!matches(0, "\xff\xd8")) invalid();
    let offset = 2;
    let hasFrame = false;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 0xff) invalid();
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda && hasFrame) return; // Start of entropy-coded image data.
      if (marker === undefined || marker === 0xd9 || offset + 2 > bytes.length) invalid();
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) invalid();
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        if (hasFrame || length < 8) invalid();
        dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3));
        hasFrame = true;
      }
      offset += length;
    }
    invalid();
  }

  if (type === "image/webp") {
    if (
      bytes.length < 20 ||
      !matches(0, "RIFF") ||
      !matches(8, "WEBP") ||
      view.getUint32(4, true) + 8 !== bytes.length
    )
      invalid();
    let hasImage = false;
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const length = view.getUint32(offset + 4, true);
      const start = offset + 8;
      const end = start + length;
      if (end + (length % 2) > bytes.length) invalid();
      if (matches(offset, "VP8X")) {
        if (offset !== 12 || length !== 10 || bytes[start]! & 2) invalid();
        const uint24 = (at: number): number => view.getUint16(at, true) + bytes[at + 2]! * 65536;
        dimensions(uint24(start + 4) + 1, uint24(start + 7) + 1);
      } else if (matches(offset, "VP8 ")) {
        if (hasImage || length < 10 || bytes[start]! & 1 || !matches(start + 3, "\x9d\x01\x2a"))
          invalid();
        dimensions(
          view.getUint16(start + 6, true) & 0x3fff,
          view.getUint16(start + 8, true) & 0x3fff,
        );
        hasImage = true;
      } else if (matches(offset, "VP8L")) {
        if (hasImage || length < 5 || bytes[start] !== 0x2f) invalid();
        const bits = view.getUint32(start + 1, true);
        dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
        hasImage = true;
      } else if (matches(offset, "ANIM") || matches(offset, "ANMF")) {
        invalid(); // Animated WebP has separate frame dimensions; require a still image.
      }
      offset = end + (length % 2);
    }
    if (!hasImage || offset !== bytes.length) invalid();
    return;
  }
  invalid();
}
