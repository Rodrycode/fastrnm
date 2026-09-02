import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { SORT_MODES } from '../src/sort.js';
import {
  DEFAULT_SORT,
  formatCommand,
  parsePad,
  parsePrefix,
  parseSeparator,
  parseSort,
  runWizard,
  SORT_CHOICES,
} from '../src/wizard.js';

const temporary = [];

async function makeDir() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fastrnm-wizard-'));
  temporary.push(dir);
  return dir;
}

/**
 * An `ask` that replies with a scripted list of answers and records every
 * prompt it was shown, so the questions themselves can be asserted.
 */
function scriptedAsk(answers) {
  const prompts = [];
  const remaining = [...answers];
  const ask = async (question) => {
    prompts.push(question);
    if (remaining.length === 0) throw new Error(`unexpected question: ${question}`);
    return remaining.shift();
  };
  ask.prompts = prompts;
  return ask;
}

after(async () => {
  await Promise.all(temporary.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

test('blank answers keep the value the flags already gave', () => {
  assert.equal(parsePrefix('', { fallback: 'holiday' }).value, 'holiday');
  assert.equal(parsePrefix('  ', {}).value, undefined);
  assert.equal(parsePad('', { fallback: 3 }).value, 3);
  assert.equal(parsePad('', {}).value, undefined);
  assert.equal(parseSeparator('', { fallback: '-' }).value, '-');
  assert.equal(parseSeparator('').value, '_');
  assert.equal(parseSort('').value, DEFAULT_SORT);
  assert.equal(parseSort('', { fallback: 'size' }).value, 'size');
});

test('a prefix is validated with the same rules as the flag', () => {
  assert.equal(parsePrefix('holiday').value, 'holiday');
  assert.equal(parsePrefix('  holiday  ').value, 'holiday');
  assert.match(parsePrefix('CON').error, /reserved system name/);
  assert.match(parsePrefix('foto/2024').error, /invalid characters/);
});

test('the padding must be a whole number within range', () => {
  assert.equal(parsePad('3').value, 3);
  assert.equal(parsePad('0').value, 0);
  assert.match(parsePad('abc').error, /not a whole number/);
  assert.match(parsePad('-2').error, /cannot be negative/);
  assert.match(parsePad('99').error, /unreasonably large/);
});

test('"none" is how the wizard asks for no separator at all', () => {
  assert.equal(parseSeparator('none').value, '');
  assert.equal(parseSeparator('NONE').value, '');
  assert.equal(parseSeparator('-').value, '-');
  assert.match(parseSeparator('/').error, /invalid characters/);
});

test('the order takes a mode name or its position in the list', () => {
  assert.equal(parseSort('1').value, 'created');
  assert.equal(parseSort('2').value, 'name');
  assert.equal(parseSort('exif').value, 'exif');
  assert.equal(parseSort('SIZE').value, 'size');
  assert.match(parseSort('9').error, /no option 9/);
  assert.match(parseSort('oldest').error, /unknown order "oldest"/);
});

test('every sort mode of the CLI is offered by the wizard', () => {
  assert.deepEqual(
    SORT_CHOICES.map((choice) => choice.mode).sort(),
    [...SORT_MODES].sort(),
  );
});

test('the five answers become the options of a normal run', async () => {
  const dir = await makeDir();
  const ask = scriptedAsk([dir, 'holiday', '3', '', '']);

  const answers = await runWizard({ ask });

  assert.deepEqual(answers, {
    folder: { dir: path.resolve(dir), explicit: true },
    prefix: 'holiday',
    pad: 3,
    separator: '_',
    sort: 'created',
  });
  assert.equal(ask.prompts.length, 5);
  assert.match(ask.prompts[0], /Which folder/);
  assert.match(ask.prompts[4], /In which order/);
});

test('blank answers all the way through use the current folder', async () => {
  const dir = await makeDir();
  const ask = scriptedAsk(['', '', '', '', '']);

  const answers = await runWizard({ ask, cwd: dir });

  // No folder was typed and none was given as a flag: the run stays implicit,
  // which is what makes the CLI ask for confirmation even with --yes.
  assert.equal(answers.folder.explicit, false);
  assert.equal(answers.folder.dir, path.resolve(dir));
  assert.equal(answers.prefix, undefined);
  assert.equal(answers.pad, undefined);
  assert.equal(answers.separator, '_');
  assert.equal(answers.sort, DEFAULT_SORT);
});

test('a wrong answer is asked again instead of losing the run', async () => {
  const dir = await makeDir();
  const missing = path.join(dir, 'does-not-exist');
  const ask = scriptedAsk([missing, dir, 'CON', 'trip', 'abc', '2', 'none', 'nope', 'size']);

  const answers = await runWizard({ ask });

  assert.equal(answers.prefix, 'trip');
  assert.equal(answers.pad, 2);
  assert.equal(answers.separator, '');
  assert.equal(answers.sort, 'size');
  assert.equal(ask.prompts.length, 9);
  // The rejection is shown on top of the question it belongs to.
  assert.match(ask.prompts[1], /does not exist[\s\S]*Which folder/);
  assert.match(ask.prompts[3], /reserved system name[\s\S]*Which prefix/);
  assert.match(ask.prompts[5], /not a whole number[\s\S]*How many digits/);
  assert.match(ask.prompts[8], /unknown order[\s\S]*In which order/);
});

test('flags already given are offered as the answer for blank', async () => {
  const dir = await makeDir();
  const ask = scriptedAsk(['', '', '', '', '']);

  const answers = await runWizard({
    ask,
    defaults: { dir, prefix: 'holiday', pad: 4, separator: '-', sort: 'name' },
  });

  assert.deepEqual(answers, {
    folder: { dir: path.resolve(dir), explicit: true },
    prefix: 'holiday',
    pad: 4,
    separator: '-',
    sort: 'name',
  });
  assert.match(ask.prompts[1], /Leave blank to keep "holiday"/);
  assert.match(ask.prompts[2], /Leave blank to keep 4/);
});

test('cancelling at any question cancels the run', async () => {
  const dir = await makeDir();
  assert.equal(await runWizard({ ask: async () => null }), null);
  assert.equal(await runWizard({ ask: scriptedAsk([dir, 'holiday', null]) }), null);
});

test('the equivalent command is printed with the flags that were answered', () => {
  const folder = { dir: path.resolve('photos'), explicit: true };
  assert.equal(
    formatCommand({ folder, prefix: 'holiday', pad: 3, separator: '_', sort: 'created' }),
    'fastrnm ./photos --prefix holiday --pad 3 --sort created',
  );
  assert.equal(
    formatCommand({ folder, prefix: undefined, pad: undefined, separator: '', sort: 'name' }),
    'fastrnm ./photos --separator ""',
  );
  // The implicit current folder is left out: writing it as "." would print a
  // command that no longer asks for confirmation.
  assert.equal(
    formatCommand({
      folder: { dir: process.cwd(), explicit: false },
      prefix: 'my trip',
      separator: '_',
      sort: 'name',
    }),
    'fastrnm --prefix "my trip"',
  );
});
