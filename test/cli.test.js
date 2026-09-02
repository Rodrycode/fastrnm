import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, test } from 'node:test';

import { expandHome, isInside, isSamePath, resolvePath } from '../src/paths.js';
import { sortFiles } from '../src/sort.js';
import { jpegWithDate } from './helpers/jpeg.js';

const exec = promisify(execFile);
const CLI = fileURLToPath(new URL('../index.js', import.meta.url));
const temporary = [];

async function makeDir(files = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fastrnm-'));
  temporary.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content);
  }
  return dir;
}

/** Runs the CLI and never throws: the exit code is part of the assertion. */
async function run(args, options = {}) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [CLI, ...args], {
      env: { ...process.env, NO_COLOR: '1' },
      ...options,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

async function listFiles(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name !== '.fastrnm-log.json')
    .map((entry) => entry.name)
    .sort();
}

after(async () => {
  await Promise.all(temporary.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

test('renames in place with automatic padding and natural order', async () => {
  const dir = await makeDir({ 'IMG_2.jpg': 'b', 'IMG_10.jpg': 'c', 'IMG_1.jpg': 'a' });
  const { code } = await run([dir, '--prefix', 'holiday', '--yes']);

  assert.equal(code, 0);
  assert.deepEqual(await listFiles(dir), ['holiday_1.jpg', 'holiday_2.jpg', 'holiday_3.jpg']);
  // Natural order: IMG_2 comes before IMG_10.
  assert.equal(await fsp.readFile(path.join(dir, 'holiday_2.jpg'), 'utf8'), 'b');
  assert.equal(await fsp.readFile(path.join(dir, 'holiday_3.jpg'), 'utf8'), 'c');
});

test('dry run changes nothing', async () => {
  const dir = await makeDir({ 'a.txt': 'a', 'b.txt': 'b' });
  const { code, stdout } = await run([dir, '--prefix', 'x', '--dry-run']);

  assert.equal(code, 0);
  assert.match(stdout, /nothing has been changed/i);
  assert.deepEqual(await listFiles(dir), ['a.txt', 'b.txt']);
});

test('a reserved prefix is rejected before touching anything', async () => {
  const dir = await makeDir({ 'a.txt': 'a' });
  const { code, stderr } = await run([dir, '--prefix', 'CON', '--yes']);

  assert.equal(code, 1);
  assert.match(stderr, /reserved system name/);
  assert.deepEqual(await listFiles(dir), ['a.txt']);
});

test('an invalid character in the prefix is rejected', async () => {
  const dir = await makeDir({ 'a.txt': 'a' });
  const { code, stderr } = await run([dir, '--prefix', 'a/b', '--yes']);

  assert.equal(code, 1);
  assert.match(stderr, /invalid characters/);
});

test('a collision aborts the whole batch', async () => {
  const dir = await makeDir({ 'a.txt': 'a', 'b.txt': 'b', 'x_1.txt': 'taken' });
  const { code, stderr } = await run([dir, '--prefix', 'x', '--exclude', 'x_*', '--yes']);

  assert.equal(code, 1);
  assert.match(stderr, /collision/i);
  // Nothing renamed: a.txt and b.txt are still there.
  assert.deepEqual(await listFiles(dir), ['a.txt', 'b.txt', 'x_1.txt']);
});

test('undo restores the original names', async () => {
  const dir = await makeDir({ 'one.txt': '1', 'two.txt': '2' });
  await run([dir, '--prefix', 'p', '--yes']);
  assert.deepEqual(await listFiles(dir), ['p_1.txt', 'p_2.txt']);

  const { code } = await run([dir, '--undo', '--yes']);
  assert.equal(code, 0);
  assert.deepEqual(await listFiles(dir), ['one.txt', 'two.txt']);
  // The log is removed once fully applied.
  await assert.rejects(fsp.access(path.join(dir, '.fastrnm-log.json')));
});

test('undo without a previous run fails with a clear message', async () => {
  const dir = await makeDir({ 'a.txt': 'a' });
  const { code, stderr } = await run([dir, '--undo', '--yes']);

  assert.equal(code, 1);
  assert.match(stderr, /no rename log found/);
});

test('double extensions survive a round trip', async () => {
  const dir = await makeDir({ 'backup.tar.gz': 'z', 'notes.md': 'm' });
  await run([dir, '--prefix', 'f', '--yes']);

  assert.deepEqual(await listFiles(dir), ['f_1.tar.gz', 'f_2.md']);
});

test('a swap between two files is applied in two phases', async () => {
  const dir = await makeDir({ '2.txt': 'two', '1.txt': 'one' });
  const { code } = await run([dir, '--start', '2', '--yes']);

  assert.equal(code, 0);
  assert.deepEqual(await listFiles(dir), ['2.txt', '3.txt']);
  assert.equal(await fsp.readFile(path.join(dir, '2.txt'), 'utf8'), 'one');
  assert.equal(await fsp.readFile(path.join(dir, '3.txt'), 'utf8'), 'two');
});

test('with --output the originals are untouched', async () => {
  const source = await makeDir({ 'a.jpg': 'a', 'b.jpg': 'b' });
  const destination = path.join(source, '..', path.basename(source) + '-out');
  temporary.push(destination);

  const { code } = await run([source, '--output', destination, '--prefix', 'p', '--create-dir', '--yes']);

  assert.equal(code, 0);
  assert.deepEqual(await listFiles(source), ['a.jpg', 'b.jpg']);
  assert.deepEqual(await listFiles(destination), ['p_1.jpg', 'p_2.jpg']);
  assert.equal(await fsp.readFile(path.join(destination, 'p_1.jpg'), 'utf8'), 'a');
});

test('undo of a copy deletes the copies and keeps the originals', async () => {
  const source = await makeDir({ 'a.jpg': 'a' });
  const destination = await makeDir();

  await run([source, '--output', destination, '--prefix', 'p', '--yes']);
  assert.deepEqual(await listFiles(destination), ['p_1.jpg']);

  const { code } = await run([destination, '--undo', '--yes']);
  assert.equal(code, 0);
  assert.deepEqual(await listFiles(destination), []);
  assert.deepEqual(await listFiles(source), ['a.jpg']);
});

test('--move empties the source folder and undo brings the files back', async () => {
  const source = await makeDir({ 'a.jpg': 'a', 'b.jpg': 'b' });
  const destination = await makeDir();

  const { code } = await run([source, '--output', destination, '--move', '--prefix', 'm', '--yes']);
  assert.equal(code, 0);
  assert.deepEqual(await listFiles(source), []);
  assert.deepEqual(await listFiles(destination), ['m_1.jpg', 'm_2.jpg']);

  // In move mode the log stays in the source folder, which is where the
  // files came from.
  await run([source, '--undo', '--yes']);
  assert.deepEqual(await listFiles(source), ['a.jpg', 'b.jpg']);
  assert.deepEqual(await listFiles(destination), []);
});

test('a collision against a pre-existing file in the destination aborts', async () => {
  const source = await makeDir({ 'a.jpg': 'a' });
  const destination = await makeDir({ 'p_1.jpg': 'already here' });

  const { code, stderr } = await run([source, '--output', destination, '--prefix', 'p', '--yes']);

  assert.equal(code, 1);
  assert.match(stderr, /collision/i);
  assert.deepEqual(await listFiles(source), ['a.jpg']);
  assert.equal(await fsp.readFile(path.join(destination, 'p_1.jpg'), 'utf8'), 'already here');
});

test('destination equal to source is treated as an in-place rename', async () => {
  const dir = await makeDir({ 'a.txt': 'a', 'b.txt': 'b' });
  const { code } = await run([dir, '--output', dir, '--prefix', 'p', '--yes']);

  assert.equal(code, 0);
  assert.deepEqual(await listFiles(dir), ['p_1.txt', 'p_2.txt']);
});

test('a destination inside the source is rejected with --recursive', async () => {
  const source = await makeDir({ 'a.txt': 'a', 'sub/b.txt': 'b' });
  const destination = path.join(source, 'out');

  const { code, stderr } = await run([
    source, '--recursive', '--output', destination, '--prefix', 'p', '--create-dir', '--yes',
  ]);

  assert.equal(code, 1);
  assert.match(stderr, /inside the source folder/);
});

test('a missing folder and a file instead of a folder give clear errors', async () => {
  const missing = await run([path.join(os.tmpdir(), 'fastrnm-does-not-exist-xyz')]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /does not exist/);

  const dir = await makeDir({ 'a.txt': 'a' });
  const asFile = await run([path.join(dir, 'a.txt')]);
  assert.equal(asFile.code, 1);
  assert.match(asFile.stderr, /is a file, not a folder/);
});

test('an empty folder reports it instead of renaming zero files', async () => {
  const dir = await makeDir();
  const { code, stderr } = await run([dir, '--yes']);

  assert.equal(code, 1);
  assert.match(stderr, /no files to rename/);
});

test('hidden files are skipped unless --include-hidden', async () => {
  const dir = await makeDir({ 'a.txt': 'a', '.secret': 's' });

  await run([dir, '--prefix', 'p', '--yes']);
  const names = await fsp.readdir(dir);
  assert.ok(names.includes('.secret'));
  assert.ok(names.includes('p_1.txt'));
});

test('filters: --ext, --match and --exclude', async () => {
  const dir = await makeDir({ 'IMG_1.jpg': '1', 'IMG_2.png': '2', 'note.txt': 't', 'tmp.jpg': 'x' });

  await run([dir, '--ext', 'jpg', '--exclude', 'tmp.*', '--prefix', 'p', '--yes']);
  assert.deepEqual(await listFiles(dir), ['IMG_2.png', 'note.txt', 'p_1.jpg', 'tmp.jpg']);
});

test('--recursive with --flatten writes everything into one folder', async () => {
  const source = await makeDir({ 'one/a.txt': 'a', 'two/b.txt': 'b' });
  const destination = await makeDir();

  const { code } = await run([
    source, '--recursive', '--flatten', '--output', destination, '--prefix', 'f', '--yes',
  ]);

  assert.equal(code, 0);
  assert.deepEqual(await listFiles(destination), ['f_1.txt', 'f_2.txt']);
});

test('--json emits structured output and requires --yes to apply', async () => {
  const dir = await makeDir({ 'a.txt': 'a', 'b.txt': 'b' });

  const preview = await run([dir, '--prefix', 'p', '--json', '--dry-run']);
  const payload = JSON.parse(preview.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.applied, false);
  assert.equal(payload.operations.length, 2);
  assert.deepEqual(await listFiles(dir), ['a.txt', 'b.txt']);

  const blocked = await run([dir, '--prefix', 'p', '--json']);
  assert.equal(blocked.code, 1);
  assert.match(JSON.parse(blocked.stdout).error, /--json requires --yes/);
});

test('a non interactive run without --yes refuses to touch anything', async () => {
  const dir = await makeDir({ 'a.txt': 'a' });
  const { code, stderr } = await run([dir, '--prefix', 'p']);

  assert.equal(code, 1);
  assert.match(stderr, /not interactive/);
  assert.deepEqual(await listFiles(dir), ['a.txt']);
});

test('the current folder always asks, even with --yes', async () => {
  const dir = await makeDir({ 'a.txt': 'a' });
  const { code, stderr } = await run(['--prefix', 'p', '--yes'], { cwd: dir });

  assert.equal(code, 1);
  assert.match(stderr, /not interactive/);
  assert.deepEqual(await listFiles(dir), ['a.txt']);
});

test('the wizard needs a terminal to ask its questions', async () => {
  const dir = await makeDir({ 'a.txt': 'a' });
  const { code, stderr } = await run([dir, '--wizard']);

  assert.equal(code, 1);
  assert.match(stderr, /--wizard requires an interactive terminal/);
  assert.deepEqual(await listFiles(dir), ['a.txt']);
});

test('the wizard refuses the flags that cannot answer or apply its questions', async () => {
  const dir = await makeDir({ 'a.txt': 'a' });

  const json = await run([dir, '--wizard', '--json']);
  assert.equal(json.code, 1);
  assert.match(JSON.parse(json.stdout).error, /--json cannot answer/);

  const undo = await run([dir, '--wizard', '--undo']);
  assert.equal(undo.code, 1);
  assert.match(undo.stderr, /--wizard and --undo/);

  const random = await run([dir, '--wizard', '--random']);
  assert.equal(random.code, 1);
  assert.match(random.stderr, /--wizard and --random/);

  assert.deepEqual(await listFiles(dir), ['a.txt']);
});

test('a tilde path is expanded', () => {
  assert.equal(expandHome('~'), os.homedir());
  assert.equal(expandHome('~/photos'), path.join(os.homedir(), 'photos'));
  assert.equal(expandHome('/absolute/photos'), '/absolute/photos');
  assert.equal(resolvePath('~/photos'), path.join(os.homedir(), 'photos'));
});

test('isInside detects nested paths', () => {
  assert.ok(isInside('/a/b/c', '/a'));
  assert.ok(isInside('/a', '/a'));
  assert.ok(!isInside('/a', '/a/b'));
  assert.ok(!isInside('/ab', '/a'));
});

test('a second run warns that the previous original names will be lost', async () => {
  const dir = await makeDir({ 'IMG_1.jpg': 'a', 'IMG_2.jpg': 'b' });
  const first = await run([dir, '--prefix', 'p', '--yes']);
  assert.equal(first.code, 0);
  assert.doesNotMatch(first.stderr, /has not been undone/);

  const second = await run([dir, '--prefix', 'q', '--yes']);
  assert.equal(second.code, 0);
  assert.match(second.stderr, /has not been undone/);
  assert.match(second.stderr, /IMG_1\.jpg, IMG_2\.jpg/);
  assert.match(second.stderr, /unrecoverable/);
  // The warning informs, it does not block.
  assert.deepEqual(await listFiles(dir), ['q_1.jpg', 'q_2.jpg']);
});

test('the warning also shows up on a dry run, before committing to anything', async () => {
  const dir = await makeDir({ 'a.txt': 'a' });
  await run([dir, '--prefix', 'p', '--yes']);

  const preview = await run([dir, '--prefix', 'q', '--dry-run']);
  assert.equal(preview.code, 0);
  assert.match(preview.stderr, /has not been undone/);
});

test('no warning once the previous run has been undone', async () => {
  const dir = await makeDir({ 'a.txt': 'a' });
  await run([dir, '--prefix', 'p', '--yes']);
  await run([dir, '--undo', '--yes']);

  const { stderr } = await run([dir, '--prefix', 'q', '--yes']);
  assert.doesNotMatch(stderr, /has not been undone/);
});

test('no warning when the log no longer matches what is on disk', async () => {
  const dir = await makeDir({ 'a.txt': 'a' });
  await run([dir, '--prefix', 'p', '--yes']);
  // The user renamed the file by hand: the log can no longer revert anything.
  await fsp.rename(path.join(dir, 'p_1.txt'), path.join(dir, 'manual.txt'));

  const { stderr } = await run([dir, '--prefix', 'q', '--yes']);
  assert.doesNotMatch(stderr, /has not been undone/);
});

test('in copy mode the warning is about the copies that will be stranded', async () => {
  const source = await makeDir({ 'a.jpg': 'a' });
  const destination = await makeDir();

  await run([source, '--output', destination, '--prefix', 'c', '--yes']);
  const { stderr } = await run([source, '--output', destination, '--prefix', 'd', '--yes']);

  assert.match(stderr, /copied into this folder/);
  assert.match(stderr, /stay here for good/);
});

test('--json exposes the pending undo instead of printing it', async () => {
  const dir = await makeDir({ 'a.txt': 'a' });
  await run([dir, '--prefix', 'p', '--yes']);

  const { stdout } = await run([dir, '--prefix', 'q', '--json', '--dry-run']);
  const payload = JSON.parse(stdout);
  assert.equal(payload.pendingUndo.mode, 'rename');
  assert.equal(payload.pendingUndo.count, 1);
  assert.deepEqual(payload.pendingUndo.samples, ['a.txt']);
});

test('--random gives every file an opaque name and keeps the extension', async () => {
  const dir = await makeDir({
    'IMG_2931.jpg': 'a',
    'IMG_2932.jpg': 'b',
    'backup.tar.gz': 'z',
  });

  const { code } = await run([dir, '--random', '--yes']);
  assert.equal(code, 0);

  const names = await listFiles(dir);
  assert.equal(names.length, 3);
  assert.equal(new Set(names).size, 3);
  for (const name of names) {
    assert.match(name, /^[a-z0-9]{8}(\.jpg|\.tar\.gz)$/);
  }
  assert.equal(names.filter((name) => name.endsWith('.tar.gz')).length, 1);
});

test('--random combines with a prefix and a custom length', async () => {
  const dir = await makeDir({ 'a.png': 'a', 'b.png': 'b' });

  await run([dir, '--random', '--random-length', '4', '--prefix', 'scan', '--yes']);

  for (const name of await listFiles(dir)) {
    assert.match(name, /^scan_[a-z0-9]{4}\.png$/);
  }
});

test('undo is the only way back from random names, and it works', async () => {
  const dir = await makeDir({ 'holiday.jpg': 'a', 'work.jpg': 'b' });
  await run([dir, '--random', '--yes']);
  assert.doesNotMatch((await listFiles(dir)).join(), /holiday/);

  const { code } = await run([dir, '--undo', '--yes']);
  assert.equal(code, 0);
  assert.deepEqual(await listFiles(dir), ['holiday.jpg', 'work.jpg']);
});

test('--random rejects the numbering options instead of ignoring them', async () => {
  const dir = await makeDir({ 'a.txt': 'a' });

  for (const flag of [['--pad', '3'], ['--start', '5'], ['--step', '2']]) {
    const { code, stderr } = await run([dir, '--random', ...flag, '--dry-run']);
    assert.equal(code, 1);
    assert.match(stderr, /--random cannot be combined with/);
  }

  const orphan = await run([dir, '--random-length', '4', '--dry-run']);
  assert.equal(orphan.code, 1);
  assert.match(orphan.stderr, /only makes sense together with --random/);
});

test('a random length too small for the batch is refused with a suggestion', async () => {
  const dir = await makeDir(
    Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}.txt`, 'x'])),
  );

  const { code, stderr } = await run([dir, '--random', '--random-length', '1', '--dry-run']);
  assert.equal(code, 1);
  assert.match(stderr, /cannot safely name 30 files/);
  assert.match(stderr, /--random-length 2 or more/);
});

test('--sort exif orders by capture date, not by the copy date', async () => {
  const dir = await makeDir();
  // Written newest-capture-first, and all three get the same mtime, which is
  // exactly what happens after copying a card onto a laptop.
  const captures = [
    ['c.jpg', '2021:03:03 10:00:00'],
    ['a.jpg', '2019:01:01 10:00:00'],
    ['b.jpg', '2020:02:02 10:00:00'],
  ];
  for (const [name, taken] of captures) {
    await fsp.writeFile(path.join(dir, name), jpegWithDate(taken));
  }
  const sameTime = new Date('2026-01-01T00:00:00Z');
  for (const [name] of captures) {
    await fsp.utimes(path.join(dir, name), sameTime, sameTime);
  }

  const { code } = await run([dir, '--sort', 'exif', '--prefix', 'p', '--yes']);
  assert.equal(code, 0);

  // a.jpg was taken first, so it gets number 1.
  const log = JSON.parse(await fsp.readFile(path.join(dir, '.fastrnm-log.json'), 'utf8'));
  assert.deepEqual(
    log.operations.map((op) => [path.basename(op.from), path.basename(op.to)]),
    [
      ['a.jpg', 'p_1.jpg'],
      ['b.jpg', 'p_2.jpg'],
      ['c.jpg', 'p_3.jpg'],
    ],
  );
});

test('--sort exif warns about the photos it could not read a date from', async () => {
  // A .txt is not a photo and must not be counted: only real JPEGs are.
  const dir = await makeDir({ 'note.txt': 'x', 'broken.jpg': 'not really a jpeg' });
  await fsp.writeFile(path.join(dir, 'photo.jpg'), jpegWithDate('2019:01:01 10:00:00'));

  const { stderr } = await run([dir, '--sort', 'exif', '--prefix', 'p', '--dry-run']);
  assert.match(stderr, /1 of 2 JPEG file\(s\) have no EXIF capture date/);
});

test('--sort exif on a folder with no photos says so instead of staying silent', async () => {
  const dir = await makeDir({ 'a.txt': 'a', 'b.txt': 'b' });

  const { stderr } = await run([dir, '--sort', 'exif', '--prefix', 'p', '--dry-run']);
  assert.match(stderr, /no JPEG files here/);
});

test('--flatten and --restart-per-folder are refused as contradictory', async () => {
  const source = await makeDir({ 'one/a.txt': 'a', 'two/b.txt': 'b' });
  const destination = await makeDir();

  const { code, stderr } = await run([
    source, '-r', '--flatten', '--restart-per-folder', '--output', destination, '--dry-run',
  ]);
  assert.equal(code, 1);
  assert.match(stderr, /contradict each other/);
});

test('a hidden subfolder does not advertise --recursive, which would skip it too', async () => {
  const dir = await makeDir({ '.git/config': 'x' });

  const { code, stderr } = await run([dir, '--yes']);
  assert.equal(code, 1);
  assert.match(stderr, /1 hidden \(use --include-hidden\)/);
  assert.doesNotMatch(stderr, /--recursive/);
});

test('--keep-name numbers the files without discarding their names', async () => {
  const dir = await makeDir({ 'holiday.jpg': 'a', 'work.jpg': 'b' });

  const { code } = await run([dir, '--keep-name', '--yes']);
  assert.equal(code, 0);
  assert.deepEqual(await listFiles(dir), ['holiday_1.jpg', 'work_2.jpg']);
});

test('--keep-name combines with a prefix', async () => {
  const dir = await makeDir({ 'a.png': 'a' });
  await run([dir, '--keep-name', '--prefix', 'trip', '--pad', '2', '--yes']);

  assert.deepEqual(await listFiles(dir), ['trip_a_01.png']);
});

test('an empty result says what was skipped and why', async () => {
  const dir = await makeDir({ 'note.txt': 'a', 'other.md': 'b' });

  const { code, stderr } = await run([dir, '--ext', 'jpg', '--yes']);
  assert.equal(code, 1);
  assert.match(stderr, /no files to rename/);
  assert.match(stderr, /2 not matching --ext/);
});

test('a folder of subfolders points at --recursive instead of claiming to be empty', async () => {
  const dir = await makeDir({ 'one/a.txt': 'a', 'two/b.txt': 'b' });

  const { code, stderr } = await run([dir, '--yes']);
  assert.equal(code, 1);
  assert.match(stderr, /2 subfolders \(use --recursive\)/);
  assert.doesNotMatch(stderr, /The folder is empty/);
});

test('skipped symbolic links are reported instead of vanishing', async () => {
  const dir = await makeDir({ 'real.txt': 'r' });
  await fsp.symlink('real.txt', path.join(dir, 'link.txt'));

  const { code, stderr } = await run([dir, '--prefix', 'p', '--yes']);
  assert.equal(code, 0);
  assert.match(stderr, /1 symbolic link skipped/);
  assert.deepEqual(await listFiles(dir), ['p_1.txt']);
});

test('a truly empty folder still says so', async () => {
  const dir = await makeDir();
  const { stderr } = await run([dir, '--yes']);
  assert.match(stderr, /The folder is empty/);
});

test('a failure halfway through rolls everything back', async () => {
  const dir = await makeDir({ 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
  // A directory sitting on the second target name: --force gets past the
  // collision check, and the rename itself then fails with EISDIR.
  await fsp.mkdir(path.join(dir, 'p_2.txt'));

  const { code, stderr } = await run([dir, '--prefix', 'p', '--force', '--yes']);

  assert.equal(code, 1);
  assert.match(stderr, /rolled back/);
  // Every original name is back, and nothing was left half renamed.
  assert.deepEqual(await listFiles(dir), ['a.txt', 'b.txt', 'c.txt']);

  const entries = await fsp.readdir(dir);
  assert.ok(entries.includes('p_2.txt'), 'the blocking directory must be untouched');
  assert.equal(entries.filter((name) => name.startsWith('.fastrnm-tmp')).length, 0);
  // A failed run must not leave an undo log claiming it did something.
  assert.ok(!entries.includes('.fastrnm-log.json'));
});

test('a swap is rolled back too, temporary names included', async () => {
  const dir = await makeDir({ '1.txt': 'one', '2.txt': 'two', '3.txt': 'three' });
  await fsp.mkdir(path.join(dir, '4.txt'));

  const { code } = await run([dir, '--start', '2', '--force', '--yes']);

  assert.equal(code, 1);
  assert.deepEqual(await listFiles(dir), ['1.txt', '2.txt', '3.txt']);
  assert.equal(await fsp.readFile(path.join(dir, '1.txt'), 'utf8'), 'one');
  const entries = await fsp.readdir(dir);
  assert.equal(entries.filter((name) => name.startsWith('.fastrnm-tmp')).length, 0);
});

test('--json reports errors as JSON too, not as prose on stderr', async () => {
  const missing = await run([path.join(os.tmpdir(), 'fastrnm-nope-xyz'), '--json', '--yes']);
  assert.equal(missing.code, 1);
  const payload = JSON.parse(missing.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.applied, false);
  assert.match(payload.error, /does not exist/);

  // Including the errors raised before the arguments are even parsed.
  const badFlag = await run(['--not-a-flag', '--json']);
  assert.equal(badFlag.code, 1);
  assert.equal(JSON.parse(badFlag.stdout).ok, false);
});

test('isSamePath does not trust an inode of zero', async () => {
  const dir = await makeDir({ 'a.txt': 'a' });

  assert.ok(isSamePath(dir, dir));
  assert.ok(isSamePath(dir, path.join(dir, '.')));
  assert.ok(!isSamePath(dir, path.join(dir, '..')));

  // On case-insensitive platforms the same folder spelled differently is
  // still the same folder, and that is decided on the path, not on the inode
  // -- FAT32 and exFAT report zero for every entry.
  if (process.platform === 'darwin' || process.platform === 'win32') {
    assert.ok(isSamePath(dir, dir.toUpperCase()));
  }
});

test('--sort created falls back to the modification date where there is none', async () => {
  const files = [
    { name: 'a', relativeDir: '', birthtimeMs: 0, mtimeMs: 300, size: 0 },
    { name: 'b', relativeDir: '', birthtimeMs: 0, mtimeMs: 100, size: 0 },
    { name: 'c', relativeDir: '', birthtimeMs: 0, mtimeMs: 200, size: 0 },
  ];

  assert.deepEqual(
    sortFiles(files, { sort: 'created' }).map((file) => file.name),
    ['b', 'c', 'a'],
  );
});

test('--version reports what package.json says, not a copy of it', async () => {
  const manifest = JSON.parse(
    await fsp.readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const { code, stdout } = await run(['--version']);

  assert.equal(code, 0);
  assert.equal(stdout.trim(), manifest.version);
});

test('leftover temporary files are never swept into a batch', async () => {
  const dir = await makeDir({ 'a.txt': 'a' });
  // What a run killed between the two phases of a swap leaves behind.
  const orphan = path.join(dir, '.fastrnm-tmp-abc123');
  await fsp.writeFile(orphan, 'data that still matters');

  const { code } = await run([dir, '--include-hidden', '--prefix', 'p', '--yes']);

  assert.equal(code, 0);
  const names = await listFiles(dir);
  assert.ok(names.includes('p_1.txt'), 'the real file is renamed');
  assert.ok(names.includes('.fastrnm-tmp-abc123'), 'the leftover keeps its name');
  assert.equal(await fsp.readFile(orphan, 'utf8'), 'data that still matters');
});
