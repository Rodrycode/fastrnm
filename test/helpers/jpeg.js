/**
 * Builds the smallest JPEG that carries a capture date: SOI, an EXIF APP1
 * segment with a TIFF block, and EOI. Written by hand so the suite needs no
 * binary fixtures.
 */
export function jpegWithDate(text, { tag = 0x9003, littleEndian = true } = {}) {
  const value = Buffer.alloc(20);
  value.write(text, 'latin1');

  const tiff = Buffer.alloc(8 + 18 + 18 + 20);
  const u16 = (at, n) => (littleEndian ? tiff.writeUInt16LE(n, at) : tiff.writeUInt16BE(n, at));
  const u32 = (at, n) => (littleEndian ? tiff.writeUInt32LE(n, at) : tiff.writeUInt32BE(n, at));

  tiff.write(littleEndian ? 'II' : 'MM', 0, 'latin1');
  u16(2, 42);
  u32(4, 8); // IFD0 starts right after the header

  if (tag === 0x0132) {
    // The date sits directly in IFD0.
    u16(8, 1);
    u16(10, tag);
    u16(12, 2); // ASCII
    u32(14, 20);
    u32(18, 44); // offset of the string
    u32(22, 0); // no next IFD
  } else {
    // IFD0 holds a single pointer to the Exif sub-IFD.
    u16(8, 1);
    u16(10, 0x8769);
    u16(12, 4); // LONG
    u32(14, 1);
    u32(18, 26); // offset of the Exif IFD
    u32(22, 0);

    u16(26, 1);
    u16(28, tag);
    u16(30, 2);
    u32(32, 20);
    u32(36, 44);
    u32(40, 0);
  }
  value.copy(tiff, 44);

  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1]),
    Buffer.alloc(2),
    Buffer.from('Exif\u0000\u0000', 'latin1'),
    tiff,
  ]);
  app1.writeUInt16BE(2 + 6 + tiff.length, 2);

  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, Buffer.from([0xff, 0xd9])]);
}
