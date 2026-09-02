/**
 * Minimal EXIF reader: just enough to answer "when was this photo taken?".
 *
 * The modification date lies as soon as the files are copied off the camera
 * card -- every photo ends up stamped with the date of the copy -- so for the
 * use case this tool was built for, the capture date is the one that matters.
 *
 * Only JPEG is understood. Anything else, or anything malformed, returns null
 * and the caller falls back to the modification date: a renamer must never
 * fail because a file was not the picture it expected.
 */

import fsp from 'node:fs/promises';

/** The APP1 segment lives near the start; its length field caps it at 64 KB. */
const HEAD_BYTES = 128 * 1024;

const TAG_EXIF_IFD = 0x8769;
const TAG_DATE_ORIGINAL = 0x9003;
const TAG_DATE_DIGITIZED = 0x9004;
const TAG_DATE = 0x0132;

const EXIF_HEADER = 'Exif\u0000\u0000';

/** Locates the TIFF header inside the EXIF APP1 segment of a JPEG. */
function findTiffHeader(buffer) {
  if (buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8) return null;

  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];

    // Encoders may pad with 0xFF bytes before a marker.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }

    // Standalone markers carry no payload.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      if (marker === 0xd9) return null;
      offset += 2;
      continue;
    }
    // Image data starts here: there is no metadata past this point.
    if (marker === 0xda) return null;

    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;

    const payload = offset + 4;
    if (
      marker === 0xe1 &&
      buffer.subarray(payload, payload + 6).toString('latin1') === EXIF_HEADER
    ) {
      return payload + 6;
    }
    offset += 2 + length;
  }
  return null;
}

/** Reads one image file directory into a map of tag -> entry. */
function readIfd(buffer, at, u16, u32) {
  if (at < 0 || at + 2 > buffer.length) return null;

  const count = u16(at);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    const entry = at + 2 + index * 12;
    if (entry + 12 > buffer.length) break;
    entries.set(u16(entry), {
      type: u16(entry + 2),
      count: u32(entry + 4),
      value: u32(entry + 8),
      at: entry + 8,
    });
  }
  return entries;
}

/** Values of four bytes or less are stored inline, longer ones by offset. */
function readAscii(buffer, tiff, entry) {
  if (entry.type !== 2 || entry.count === 0) return null;
  const start = entry.count <= 4 ? entry.at : tiff + entry.value;
  if (start < 0 || start + entry.count > buffer.length) return null;
  return buffer
    .subarray(start, start + entry.count)
    .toString('latin1')
    .split('\u0000')[0]
    .trim();
}

/** `2026:09:02 18:22:00` -> epoch milliseconds, read as local time. */
export function parseExifDateTime(text) {
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(text));
  if (!match) return null;

  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  // Cameras with no clock set write zeroes; that is not a date.
  if (year < 1800 || month < 1 || month > 12 || day < 1 || day > 31) return null;

  const date = new Date(year, month - 1, day, hour, minute, second);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

/** Capture date of a JPEG buffer, or null when there is none. */
export function parseExifDate(buffer) {
  const tiff = findTiffHeader(buffer);
  if (tiff === null || tiff + 8 > buffer.length) return null;

  const order = buffer.readUInt16BE(tiff);
  if (order !== 0x4949 && order !== 0x4d4d) return null;
  const little = order === 0x4949;

  const u16 = (at) =>
    at + 2 <= buffer.length ? (little ? buffer.readUInt16LE(at) : buffer.readUInt16BE(at)) : 0;
  const u32 = (at) =>
    at + 4 <= buffer.length ? (little ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at)) : 0;

  if (u16(tiff + 2) !== 42) return null;

  const ifd0 = readIfd(buffer, tiff + u32(tiff + 4), u16, u32);
  if (!ifd0) return null;

  const pointer = ifd0.get(TAG_EXIF_IFD);
  if (pointer) {
    const exif = readIfd(buffer, tiff + pointer.value, u16, u32);
    for (const tag of [TAG_DATE_ORIGINAL, TAG_DATE_DIGITIZED]) {
      const entry = exif?.get(tag);
      const text = entry && readAscii(buffer, tiff, entry);
      const parsed = text && parseExifDateTime(text);
      if (parsed) return parsed;
    }
  }

  // IFD0 DateTime is the last resort: it is the file's own timestamp, which
  // editing software rewrites, but it still beats the modification date.
  const fallback = ifd0.get(TAG_DATE);
  const text = fallback && readAscii(buffer, tiff, fallback);
  return text ? parseExifDateTime(text) : null;
}

/** Capture date of a file on disk, or null. Never throws. */
export async function readExifDate(filePath) {
  let handle;
  try {
    handle = await fsp.open(filePath, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return parseExifDate(buffer.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Annotates each file with `exifMs` where a capture date exists.
 * @returns {Promise<number>} how many files had none
 */
export async function attachExifDates(files, { concurrency = 16 } = {}) {
  let missing = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < files.length) {
      const file = files[cursor];
      cursor += 1;
      const taken = await readExifDate(file.path);
      if (taken === null) missing += 1;
      else file.exifMs = taken;
    }
  }

  const workers = Math.min(concurrency, files.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return missing;
}
