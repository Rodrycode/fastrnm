import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { autoPadding, buildName, buildPlan, digits } from '../src/plan.js';
import { splitName, globToRegExp, parseExtensions } from '../src/collect.js';
import { applyManualOrder, naturalCompare, sortFiles } from '../src/sort.js';
import { detectCollisions } from '../src/collisions.js';

const SOURCE = '/tmp/source';

function file(name, extra = {}) {
  const { stem, ext } = splitName(name);
  return {
    path: path.join(SOURCE, extra.relativeDir ?? '', name),
    dir: path.join(SOURCE, extra.relativeDir ?? ''),
    relativeDir: extra.relativeDir ?? '',
    name,
    stem,
    ext,
    size: extra.size ?? 0,
    mtimeMs: extra.mtimeMs ?? 0,
    birthtimeMs: extra.birthtimeMs ?? 0,
  };
}

test('automatic padding follows the file count', () => {
  assert.equal(digits(9), 1);
  assert.equal(autoPadding({ count: 9, start: 1, step: 1 }), 1);
  assert.equal(autoPadding({ count: 12, start: 1, step: 1 }), 2);
  assert.equal(autoPadding({ count: 120, start: 1, step: 1 }), 3);
  // --start and --step move the highest number, and the padding with it.
  assert.equal(autoPadding({ count: 5, start: 96, step: 1 }), 3);
  assert.equal(autoPadding({ count: 6, start: 1, step: 2 }), 2);
});

test('buildName joins the parts with the separator', () => {
  assert.equal(buildName({ number: 1, pad: 3, ext: '.jpg' }), '001.jpg');
  assert.equal(
    buildName({ prefix: 'holiday', number: 2, pad: 3, ext: '.jpg' }),
    'holiday_002.jpg',
  );
  assert.equal(
    buildName({ prefix: 'holiday', suffix: 'raw', separator: '-', number: 2, pad: 2, ext: '.jpg' }),
    'holiday-02-raw.jpg',
  );
  assert.equal(
    buildName({ prefix: 'img', separator: '', number: 7, pad: 2, ext: '.png' }),
    'img07.png',
  );
});

test('extensions are preserved, including double ones', () => {
  assert.deepEqual(splitName('photo.jpg'), { stem: 'photo', ext: '.jpg' });
  assert.deepEqual(splitName('archive.tar.gz'), { stem: 'archive', ext: '.tar.gz' });
  assert.deepEqual(splitName('backup.tar.bz2'), { stem: 'backup', ext: '.tar.bz2' });
  assert.deepEqual(splitName('README'), { stem: 'README', ext: '' });
  assert.deepEqual(splitName('.gitignore'), { stem: '.gitignore', ext: '' });
  assert.deepEqual(splitName('.env.local'), { stem: '.env', ext: '.local' });

  const { operations } = buildPlan([file('archive.tar.gz'), file('photo.JPG')], {
    sourceDir: SOURCE,
    prefix: 'x',
  });
  assert.equal(operations[0].toName, 'x_1.tar.gz');
  assert.equal(operations[1].toName, 'x_2.JPG');
});

test('natural order puts file2 before file10', () => {
  const names = ['file10.txt', 'file2.txt', 'file1.txt'];
  assert.deepEqual([...names].sort(naturalCompare), ['file1.txt', 'file2.txt', 'file10.txt']);

  const sorted = sortFiles(names.map((name) => file(name)));
  assert.deepEqual(sorted.map((item) => item.name), ['file1.txt', 'file2.txt', 'file10.txt']);
});

test('sorting by date, size and reverse', () => {
  const files = [
    file('a.txt', { mtimeMs: 300, size: 10 }),
    file('b.txt', { mtimeMs: 100, size: 30 }),
    file('c.txt', { mtimeMs: 200, size: 20 }),
  ];
  assert.deepEqual(
    sortFiles(files, { sort: 'date' }).map((f) => f.name),
    ['b.txt', 'c.txt', 'a.txt'],
  );
  assert.deepEqual(
    sortFiles(files, { sort: 'size' }).map((f) => f.name),
    ['a.txt', 'c.txt', 'b.txt'],
  );
  assert.deepEqual(
    sortFiles(files, { sort: 'name', reverse: true }).map((f) => f.name),
    ['c.txt', 'b.txt', 'a.txt'],
  );
});

test('start and step drive the sequence', () => {
  const { operations } = buildPlan([file('a.txt'), file('b.txt'), file('c.txt')], {
    sourceDir: SOURCE,
    prefix: 'n',
    start: 5,
    step: 2,
  });
  assert.deepEqual(operations.map((op) => op.toName), ['n_5.txt', 'n_7.txt', 'n_9.txt']);
});

test('a destination folder does not touch the source paths', () => {
  const { operations } = buildPlan([file('a.txt')], {
    sourceDir: SOURCE,
    destination: '/tmp/dest',
    prefix: 'p',
  });
  assert.equal(operations[0].from, path.join(SOURCE, 'a.txt'));
  assert.equal(operations[0].to, path.join('/tmp/dest', 'p_1.txt'));
});

test('recursive keeps the folder structure unless --flatten', () => {
  const files = [file('a.txt', { relativeDir: 'one' }), file('b.txt', { relativeDir: 'two' })];

  const nested = buildPlan(files, { sourceDir: SOURCE, destination: '/tmp/dest', prefix: 'p' });
  assert.equal(nested.operations[0].to, path.join('/tmp/dest', 'one', 'p_1.txt'));

  const flat = buildPlan(files, {
    sourceDir: SOURCE,
    destination: '/tmp/dest',
    prefix: 'p',
    flatten: true,
  });
  assert.equal(flat.operations[0].to, path.join('/tmp/dest', 'p_1.txt'));
  assert.equal(flat.operations[1].to, path.join('/tmp/dest', 'p_2.txt'));
});

test('restart-per-folder restarts the numbering on every folder', () => {
  const files = [
    file('a.txt', { relativeDir: 'one' }),
    file('b.txt', { relativeDir: 'one' }),
    file('c.txt', { relativeDir: 'two' }),
  ];
  const { operations } = buildPlan(files, {
    sourceDir: SOURCE,
    prefix: 'p',
    restartPerFolder: true,
  });
  assert.deepEqual(operations.map((op) => op.toName), ['p_1.txt', 'p_2.txt', 'p_1.txt']);
});

test('collision between two files of the batch is detected', () => {
  const operations = [
    { index: 0, from: '/s/a.txt', to: '/s/x.txt', toName: 'x.txt', unchanged: false },
    { index: 1, from: '/s/b.txt', to: '/s/x.txt', toName: 'x.txt', unchanged: false },
  ];
  const { errors, conflicts } = detectCollisions(operations, { caseInsensitive: false });
  assert.equal(conflicts, 2);
  assert.match(errors.get(0), /duplicate target/);
});

test('collision with a pre-existing file is detected, unless --force', () => {
  const operations = [
    { index: 0, from: '/s/a.txt', to: '/s/taken.txt', toName: 'taken.txt', unchanged: false },
  ];
  const existing = new Set(['/s/taken.txt']);

  assert.equal(detectCollisions(operations, { existing }).conflicts, 1);
  assert.equal(detectCollisions(operations, { existing, force: true }).conflicts, 0);
});

test('a swap is not a collision but needs two phases', () => {
  const operations = [
    { index: 0, from: '/s/a.jpg', to: '/s/b.jpg', toName: 'b.jpg', unchanged: false },
    { index: 1, from: '/s/b.jpg', to: '/s/a.jpg', toName: 'a.jpg', unchanged: false },
  ];
  const result = detectCollisions(operations, { existing: new Set() });
  assert.equal(result.conflicts, 0);
  assert.equal(result.needsTwoPhase, true);
});

test('a generated reserved name is rejected', () => {
  const operations = [
    { index: 0, from: '/s/a.txt', to: '/s/CON.txt', toName: 'CON.txt', unchanged: false },
  ];
  assert.match(detectCollisions(operations).errors.get(0), /reserved system name/);
});

test('glob and extension helpers', () => {
  assert.ok(globToRegExp('IMG_*').test('IMG_2931.jpg'));
  assert.ok(!globToRegExp('IMG_*').test('DSC_1.jpg'));
  assert.ok(globToRegExp('*.tmp').test('cache.tmp'));
  assert.deepEqual(parseExtensions('jpg, .PNG'), ['jpg', 'png']);
  assert.equal(parseExtensions(''), null);
});

test('applyManualOrder reorders by the positions the user typed', () => {
  const files = [file('a.txt'), file('b.txt'), file('c.txt')];
  const names = (list) => list.map((item) => item.name);

  assert.deepEqual(names(applyManualOrder(files, '3,1,2')), ['c.txt', 'a.txt', 'b.txt']);
  assert.deepEqual(names(applyManualOrder(files, '3 1 2')), ['c.txt', 'a.txt', 'b.txt']);
  // Enter keeps the current order.
  assert.deepEqual(names(applyManualOrder(files, '')), ['a.txt', 'b.txt', 'c.txt']);
  // Unmentioned files keep their relative order at the end.
  assert.deepEqual(names(applyManualOrder(files, '2')), ['b.txt', 'a.txt', 'c.txt']);
  // Repeats are ignored rather than duplicating a file.
  assert.deepEqual(names(applyManualOrder(files, '2,2,1')), ['b.txt', 'a.txt', 'c.txt']);
  // The input array is never mutated.
  assert.deepEqual(names(files), ['a.txt', 'b.txt', 'c.txt']);
});

test('applyManualOrder rejects positions outside the list', () => {
  const files = [file('a.txt'), file('b.txt')];
  assert.throws(() => applyManualOrder(files, '1,5'), /between 1 and 2/);
  assert.throws(() => applyManualOrder(files, '0'), /between 1 and 2/);
  assert.throws(() => applyManualOrder(files, 'x'), /between 1 and 2/);
});
