import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { attachExifDates, parseExifDate, parseExifDateTime, readExifDate } from '../src/exif.js';
import { jpegWithDate } from './helpers/jpeg.js';

const temporary = [];

after(async () => {
  await Promise.all(temporary.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

test('parses the capture date out of a JPEG', () => {
  const taken = parseExifDate(jpegWithDate('2019:07:14 09:30:15'));
  assert.equal(taken, new Date(2019, 6, 14, 9, 30, 15).getTime());
});

test('reads big endian files too', () => {
  const taken = parseExifDate(jpegWithDate('2019:07:14 09:30:15', { littleEndian: false }));
  assert.equal(taken, new Date(2019, 6, 14, 9, 30, 15).getTime());
});

test('falls back to the IFD0 date when there is no capture date', () => {
  const taken = parseExifDate(jpegWithDate('2001:02:03 04:05:06', { tag: 0x0132 }));
  assert.equal(taken, new Date(2001, 1, 3, 4, 5, 6).getTime());
});

test('a camera with no clock set is not a date', () => {
  assert.equal(parseExifDate(jpegWithDate('0000:00:00 00:00:00')), null);
  assert.equal(parseExifDateTime('not a date'), null);
  assert.equal(parseExifDateTime('2019:13:14 09:30:15'), null);
});

test('anything that is not an EXIF JPEG returns null instead of throwing', () => {
  assert.equal(parseExifDate(Buffer.from('plain text file')), null);
  assert.equal(parseExifDate(Buffer.alloc(0)), null);
  assert.equal(parseExifDate(Buffer.from([0xff, 0xd8, 0xff, 0xd9])), null);
  // Truncated halfway through the TIFF block.
  assert.equal(parseExifDate(jpegWithDate('2019:07:14 09:30:15').subarray(0, 20)), null);
});

test('reading a missing or unreadable file returns null', async () => {
  assert.equal(await readExifDate('/definitely/not/here.jpg'), null);
});

test('attachExifDates annotates what it can and counts the rest', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fastrnm-exif-'));
  temporary.push(dir);

  const withDate = path.join(dir, 'photo.jpg');
  const withoutDate = path.join(dir, 'note.txt');
  await fsp.writeFile(withDate, jpegWithDate('2022:05:06 07:08:09'));
  await fsp.writeFile(withoutDate, 'not a photo');

  const files = [{ path: withDate }, { path: withoutDate }];
  const missing = await attachExifDates(files);

  assert.equal(missing, 1);
  assert.equal(files[0].exifMs, new Date(2022, 4, 6, 7, 8, 9).getTime());
  assert.equal(files[1].exifMs, undefined);
});
