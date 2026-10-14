import { open } from "node:fs/promises";

export async function readBoundedArchive(
  archivePath: string,
  maximumBytes: number,
  description: string,
): Promise<Buffer<ArrayBuffer>> {
  const invalidSize = () => new Error(`${description} has an invalid size`);
  const file = await open(archivePath, "r");
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size === 0 || metadata.size > maximumBytes)
      throw invalidSize();
    const chunks: Buffer[] = [];
    let length = 0;
    // Also cap the read itself: the open file may grow after stat().
    for await (const chunk of file.createReadStream({
      autoClose: false,
      start: 0,
      end: maximumBytes,
    })) {
      const bytes = chunk as Buffer;
      length += bytes.byteLength;
      if (length > maximumBytes) throw invalidSize();
      chunks.push(bytes);
    }
    if (length === 0) throw invalidSize();
    return Buffer.concat(chunks, length);
  } finally {
    await file.close();
  }
}

/** Bound all ZIP entries before the decoder allocates their declared output buffers. */
export function assertBoundedZipDirectory(
  archive: Uint8Array,
  maximumBytes: number,
  description: string,
  expectedEntries?: number,
): void {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const fail = () => {
    throw new Error(`${description} is not a valid ZIP directory`);
  };
  let end = archive.byteLength - 22;
  const searchStart = Math.max(0, archive.byteLength - 65_557);
  for (; end >= searchStart; end -= 1) {
    if (view.getUint32(end, true) === 0x0605_4b50) break;
  }
  if (end < searchStart) fail();
  if (
    view.getUint16(end + 20, true) !== archive.byteLength - end - 22 ||
    view.getUint16(end + 4, true) !== 0 ||
    view.getUint16(end + 6, true) !== 0 ||
    (end >= 20 && view.getUint32(end - 20, true) === 0x0706_4b50)
  )
    fail();
  const entries = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (
    entries === 0xffff ||
    view.getUint16(end + 8, true) !== entries ||
    (expectedEntries !== undefined && entries !== expectedEntries) ||
    directoryOffset + directorySize !== end
  )
    fail();

  let offset = directoryOffset;
  let uncompressedBytes = 0;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x0201_4b50) fail();
    const compression = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    if (
      ![0, 8].includes(compression) ||
      uncompressedSize === 0xffff_ffff ||
      compressedSize === 0xffff_ffff ||
      (compression === 0 && compressedSize !== uncompressedSize) ||
      localOffset + 30 > directoryOffset ||
      view.getUint32(localOffset, true) !== 0x0403_4b50
    )
      fail();
    const dataOffset =
      localOffset +
      30 +
      view.getUint16(localOffset + 26, true) +
      view.getUint16(localOffset + 28, true);
    if (dataOffset + compressedSize > directoryOffset) fail();
    uncompressedBytes += uncompressedSize;
    if (uncompressedBytes > maximumBytes)
      throw new Error(`${description} exceeds the uncompressed size limit`);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== end) fail();
}
