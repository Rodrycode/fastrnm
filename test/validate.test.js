import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isReservedName,
  sanitize,
  validateAffix,
  validateNumbering,
  validateSeparator,
} from '../src/validate.js';

test('reserved Windows names are rejected, with or without extension', () => {
  for (const name of ['CON', 'con', 'Con.txt', 'LPT1', 'com9.jpg', 'NUL']) {
    assert.ok(isReservedName(name), `${name} should be reserved`);
  }
  for (const name of ['CONS', 'COM10', 'photo', 'lpt']) {
    assert.ok(!isReservedName(name), `${name} should not be reserved`);
  }

  const { errors } = validateAffix('CON');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /reserved system name/);
  assert.match(errors[0].hint, /CON_file/);
});

test('forbidden characters are rejected and a fix is suggested', () => {
  const { errors } = validateAffix('foto/2024');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /invalid characters/);
  assert.match(errors[0].hint, /foto_2024/);
});

test('a prefix cannot start with a dot nor end with a dot or space', () => {
  assert.match(validateAffix('.hidden').errors[0].message, /cannot start with a dot/);
  assert.match(validateAffix('photo.').errors[0].message, /cannot end with a dot or a space/);
  assert.match(validateAffix('photo ').errors[0].message, /cannot end with a dot or a space/);
});

test('empty and whitespace only prefixes', () => {
  assert.equal(validateAffix(undefined).errors.length, 0);
  assert.equal(validateAffix('').errors.length, 0);
  assert.match(validateAffix('   ').errors[0].message, /only whitespace/);
});

test('length limit', () => {
  assert.equal(validateAffix('a'.repeat(100)).errors.length, 0);
  assert.match(validateAffix('a'.repeat(101)).errors[0].message, /too long/);
});

test('spaces and accents warn but do not block', () => {
  const spaces = validateAffix('my photos');
  assert.equal(spaces.errors.length, 0);
  assert.equal(spaces.warnings.length, 1);

  const accents = validateAffix('vacaciones_verano_ñ');
  assert.equal(accents.errors.length, 0);
  assert.match(accents.warnings[0], /non ASCII/);
});

test('separator validation', () => {
  assert.equal(validateSeparator('_').errors.length, 0);
  assert.equal(validateSeparator('').errors.length, 0);
  assert.equal(validateSeparator('/').errors.length, 1);
});

test('numbering validation', () => {
  assert.equal(validateNumbering({ start: 1, step: 1 }).errors.length, 0);
  assert.match(validateNumbering({ start: -1, step: 1 }).errors[0].message, /negative/);
  assert.match(validateNumbering({ start: 1, step: 0 }).errors[0].message, /at least 1/);
  assert.match(validateNumbering({ start: 1, step: 1, pad: -2 }).errors[0].message, /--pad/);
});

test('sanitize strips forbidden characters and edge dots', () => {
  assert.equal(sanitize('a/b:c'), 'a_b_c');
  assert.equal(sanitize('.photo.'), 'photo');
});
