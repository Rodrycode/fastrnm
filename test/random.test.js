import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createTokenGenerator,
  DEFAULT_ALPHABET,
  fitsBatch,
  suggestLength,
  tokenSpace,
} from '../src/random.js';
import { buildName, buildPlan } from '../src/plan.js';

test('tokens have the requested length and use only the alphabet', () => {
  const nextToken = createTokenGenerator({ length: 12 });
  for (let i = 0; i < 50; i += 1) {
    const token = nextToken();
    assert.equal(token.length, 12);
    assert.match(token, /^[a-z0-9]+$/);
  }
});

test('the alphabet is lowercase only, so case-insensitive filesystems cannot collide', () => {
  assert.equal(DEFAULT_ALPHABET, DEFAULT_ALPHABET.toLowerCase());
  assert.equal(new Set(DEFAULT_ALPHABET).size, DEFAULT_ALPHABET.length);
});

test('tokens are unique within a batch', () => {
  const nextToken = createTokenGenerator({ length: 6 });
  const tokens = new Set(Array.from({ length: 2000 }, () => nextToken()));
  assert.equal(tokens.size, 2000);
});

test('a repeated draw is retried instead of returned twice', () => {
  // Scripted randomness: the second token draws "aa" again before "bb".
  const queue = [0, 0, 0, 0, 1, 1];
  const nextToken = createTokenGenerator({ length: 2, random: () => queue.shift() });

  assert.equal(nextToken(), 'aa');
  assert.equal(nextToken(), 'bb');
});

test('an exhausted space fails loudly instead of looping forever', () => {
  const nextToken = createTokenGenerator({ length: 2, random: () => 0 });
  assert.equal(nextToken(), 'aa');
  assert.throws(() => nextToken(), /could not generate a unique name/);
});

test('capacity helpers', () => {
  assert.equal(tokenSpace(2), 1296);
  assert.ok(fitsBatch(100, 2));
  assert.ok(!fitsBatch(1000, 2));
  assert.equal(suggestLength(4), 2);
  assert.equal(suggestLength(10000), 4);
});

test('buildName takes a token in place of the number', () => {
  assert.equal(buildName({ token: 'a7f3', ext: '.jpg' }), 'a7f3.jpg');
  assert.equal(
    buildName({ prefix: 'scan', token: 'a7f3', separator: '-', ext: '.jpg' }),
    'scan-a7f3.jpg',
  );
});

test('buildPlan uses the generator and keeps every extension', () => {
  const files = [
    { path: '/s/a.jpg', relativeDir: '', name: 'a.jpg', ext: '.jpg', size: 0 },
    { path: '/s/b.tar.gz', relativeDir: '', name: 'b.tar.gz', ext: '.tar.gz', size: 0 },
  ];
  const tokens = ['zzz1', 'zzz2'];
  const { operations } = buildPlan(files, {
    sourceDir: '/s',
    prefix: 'x',
    nextToken: () => tokens.shift(),
  });

  assert.deepEqual(operations.map((op) => op.toName), ['x_zzz1.jpg', 'x_zzz2.tar.gz']);
});
