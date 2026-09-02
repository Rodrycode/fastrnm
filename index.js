#!/usr/bin/env node
/**
 * fastrnm -- bulk rename the files of a folder to a numbered sequence.
 *
 * Entrypoint: argument parsing and orchestration. Every step that touches the
 * disk lives in src/, and the rename map is built without any I/O so --dry-run
 * is just "build the plan and stop".
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { parseArgs } from 'node:util';

import { applyPlan, logDirectory, writeLog, MODES, ApplyError } from './src/apply.js';
import { buildMatcher, collectFiles, describeSkipped, parseExtensions } from './src/collect.js';
import { detectCollisions } from './src/collisions.js';
import { attachExifDates } from './src/exif.js';
import {
  assertWritable,
  createDirectory,
  displayPath,
  freeSpace,
  isSameFilesystem,
  PathError,
  resolveDestination,
  resolveSource,
} from './src/paths.js';
import { buildPlan, totalSize } from './src/plan.js';
import {
  createTokenGenerator,
  DEFAULT_TOKEN_LENGTH,
  fitsBatch,
  MAX_TOKEN_LENGTH,
  suggestLength,
} from './src/random.js';
import { applyManualOrder, sortFiles, SORT_MODES } from './src/sort.js';
import { inspectLog, pendingUndo, readLog, removeLog, revert, UndoError } from './src/undo.js';
import {
  color,
  formatBytes,
  printError,
  printJson,
  printPreview,
  printSummary,
  printWarnings,
  setColorEnabled,
} from './src/output.js';
import { validateAffix, validateNumbering, validateSeparator } from './src/validate.js';
import { DEFAULT_SORT, formatCommand, runWizard } from './src/wizard.js';

const PREVIEW_LIMIT = 40;
const PROGRESS_THRESHOLD = 200;
const JPEG_EXTENSION = /^\.jpe?g$/i;

/**
 * Whether output must stay machine readable. Set from the raw arguments so an
 * error in parsing itself is still reported as JSON to a JSON consumer.
 */
let jsonMode = false;

const OPTIONS = {
  dir: { type: 'string' },
  output: { type: 'string', short: 'o' },
  move: { type: 'boolean', default: false },
  'create-dir': { type: 'boolean', default: false },
  flatten: { type: 'boolean', default: false },

  prefix: { type: 'string' },
  suffix: { type: 'string' },
  start: { type: 'string' },
  step: { type: 'string' },
  pad: { type: 'string' },
  separator: { type: 'string' },
  random: { type: 'boolean', default: false },
  'random-length': { type: 'string' },

  sort: { type: 'string' },
  'keep-name': { type: 'boolean', default: false },
  reverse: { type: 'boolean', default: false },
  interactive: { type: 'boolean', default: false },
  wizard: { type: 'boolean', short: 'w', default: false },

  ext: { type: 'string' },
  match: { type: 'string' },
  exclude: { type: 'string' },
  recursive: { type: 'boolean', short: 'r', default: false },
  'restart-per-folder': { type: 'boolean', default: false },
  'include-hidden': { type: 'boolean', default: false },

  'dry-run': { type: 'boolean', default: false },
  yes: { type: 'boolean', short: 'y', default: false },
  undo: { type: 'boolean', default: false },
  force: { type: 'boolean', default: false },

  json: { type: 'boolean', default: false },
  'no-color': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
};

const HELP = `
${color.bold('fastrnm')} -- bulk rename files to a numbered sequence

${color.bold('Usage')}
  fastrnm [folder] [options]

${color.bold('Guided mode')}
  -w, --wizard            Ask for folder, prefix, padding, separator and order

${color.bold('Source and destination')}
  [folder]                Folder to process (default: current folder)
  --dir <path>            Explicit alternative to the positional argument
  -o, --output <path>     Copy the renamed files here, leaving the originals untouched
  --move                  With --output: move instead of copy
  --create-dir            Create the destination folder if it does not exist
  --flatten               With --recursive and --output: write everything into one flat folder

${color.bold('Naming')}
  --prefix <text>         Text before the number (photo_1.jpg)
  --suffix <text>         Text after the number (photo_1_raw.jpg)
  --start <n>             First number of the sequence (default: 1)
  --step <n>              Increment between numbers (default: 1)
  --pad <n>               Leading zeros (default: automatic, from the file count)
  --separator <char>      Separator between parts (default: _)
  --random                Random names instead of a sequence (a7f3k9x2.jpg)
  --random-length <n>     Characters per random name (default: 8)
  --keep-name             Keep the original name before the number

${color.bold('Order')}
  --sort <mode>           name (natural, default) | date | created | exif | size
  --reverse               Reverse the chosen order
  --interactive           Show the numbered list and allow reordering before applying

${color.bold('Filters')}
  --ext jpg,png           Only these extensions
  --match "IMG_*"         Glob, or /regex/ when wrapped in slashes
  --exclude "*.tmp"       Skip files matching this pattern
  -r, --recursive         Include subfolders
  --restart-per-folder    With --recursive: restart numbering in every folder
  --include-hidden        Include hidden files (skipped by default)

${color.bold('Safety')}
  --dry-run               Show the current -> new table without touching anything
  -y, --yes               Skip the confirmation prompt (for scripts)
  --undo                  Revert the last run of this folder
  --force                 Allow overwriting on collision (never the default)

${color.bold('Output')}
  --json                  Structured output for scripting
  --no-color              Disable colors
  -h, --help              Show this help
  -v, --version           Show the version

${color.bold('Examples')}
  fastrnm --wizard
  fastrnm ./photos --prefix holiday --pad 3 --dry-run
  fastrnm ./photos --output ./renamed --prefix holiday --create-dir
  fastrnm ./scans --random --output ./anonymous --create-dir
  fastrnm ./photos --sort exif --keep-name
  fastrnm ./photos --undo
`;

class CliError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'CliError';
    this.hint = hint;
  }
}

function parseInteger(value, flag) {
  if (value === undefined) return undefined;
  if (!/^-?\d+$/.test(value.trim())) {
    throw new CliError(`${flag} must be a whole number, got "${value}".`);
  }
  return Number.parseInt(value, 10);
}

async function confirm(question, { defaultYes = false } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError(
      'confirmation is required but the terminal is not interactive.',
      'Re-run with --yes to skip the prompt, or with --dry-run to preview.',
    );
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultYes ? '[Y/n]' : '[y/N]';
    const answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase();
    if (answer === '') return defaultYes;
    return answer === 'y' || answer === 'yes';
  } catch {
    // Ctrl+D or a closed stdin: no answer means no.
    process.stdout.write('\n');
    return false;
  } finally {
    rl.close();
  }
}

/**
 * A readline interface kept open for the whole wizard: one per question would
 * lose the line editing and print a stray prompt on every step.
 */
function createPrompter() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError(
      '--wizard requires an interactive terminal.',
      'Pass the options as flags instead, for example: fastrnm ./photos --prefix holiday --yes',
    );
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    async ask(question) {
      try {
        return await rl.question(question);
      } catch {
        // Ctrl+D or a closed stdin: no answer means no run.
        return null;
      }
    },
    close() {
      rl.close();
    },
  };
}

/** Interactive reordering: the user types the new order as a list of indexes. */
async function reorder(files) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError('--interactive requires an interactive terminal.');
  }

  process.stdout.write(`\n${color.bold('Current order')}\n`);
  for (const [index, file] of files.entries()) {
    process.stdout.write(`  ${color.cyan(String(index + 1).padStart(3))}  ${file.name}\n`);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let answer;
  try {
    answer = (
      await rl.question('\nNew order as a list of numbers (e.g. 3,1,2), or Enter to keep it: ')
    ).trim();
  } catch {
    // Ctrl+D here is a cancellation, not "keep the order and go ahead".
    return null;
  } finally {
    rl.close();
  }

  try {
    return applyManualOrder(files, answer);
  } catch (error) {
    throw new CliError(error.message);
  }
}

/**
 * Wording of the pending-undo warning. What is about to be lost depends on
 * what the previous run did, so the message says it outright.
 */
function pendingUndoWarning(previous) {
  const when = new Date(previous.timestamp).toLocaleString();
  if (previous.mode === MODES.COPY) {
    return (
      `${previous.count} file(s) were copied into this folder on ${when} and have not been undone. ` +
      'Running again replaces the undo log, and those copies will stay here for good.'
    );
  }
  const more = previous.count > previous.samples.length ? ', ...' : '';
  const samples = previous.samples.join(', ') + more;
  const verb = previous.mode === MODES.MOVE ? 'move' : 'rename';
  return (
    `this folder has a ${verb} from ${when} that has not been undone. ` +
    `Running again replaces the undo log and the original names (${samples}) become unrecoverable.`
  );
}

/**
 * Progress line for batches long enough that silence looks like a hang.
 * Returns null when there is nothing worth reporting.
 */
function createProgressReporter(total, { json }) {
  if (json || !process.stdout.isTTY || total < PROGRESS_THRESHOLD) return null;

  let last = 0;
  return {
    report(_operation, done) {
      const now = Date.now();
      if (done < total && now - last < 100) return;
      last = now;
      process.stdout.write(`\r  ${done}/${total} files...`);
    },
    clear() {
      process.stdout.write(`\r${' '.repeat(30)}\r`);
    },
  };
}

/**
 * The version is read from package.json instead of being duplicated here: a
 * hardcoded copy is one release away from reporting the wrong number. npm
 * always ships package.json, whatever the `files` field lists.
 */
async function readVersion() {
  try {
    const manifest = await fsp.readFile(new URL('./package.json', import.meta.url), 'utf8');
    return JSON.parse(manifest).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/** Absolute target paths that already exist on disk. */
async function existingTargets(operations) {
  const existing = new Set();
  await Promise.all(
    operations.map(async (op) => {
      if (await pathExists(op.to)) existing.add(op.to);
    }),
  );
  return existing;
}

async function runUndo(source, { json, yes }) {
  const log = await readLog(source);
  const { ready, skipped } = await inspectLog(log);

  if (json) {
    // The JSON consumer decides; nothing is reverted without --yes.
    if (!yes) {
      printJson({ action: 'undo', mode: log.mode, ready: ready.length, skipped, applied: false });
      return 0;
    }
  }

  if (ready.length === 0) {
    throw new UndoError(
      'none of the logged files can be reverted.',
      'They were renamed, moved or deleted after the last run.',
    );
  }

  if (!json) {
    process.stdout.write(`\n${color.bold(`Undo of the last run (${log.mode} mode)`)}\n\n`);
    printPreview(
      ready.map((operation, index) => ({
        index,
        fromDisplay: path.basename(operation.to),
        toDisplay:
          log.mode === MODES.COPY ? color.red('deleted') : path.basename(operation.from),
      })),
      new Map(),
      { limit: PREVIEW_LIMIT },
    );

    for (const item of skipped) {
      process.stderr.write(
        `${color.yellow('Skipped:')} ${path.basename(item.operation.to)} -- ${item.reason}\n`,
      );
    }

    if (!yes) {
      const question =
        log.mode === MODES.COPY
          ? `Delete ${ready.length} copied file(s) from "${displayPath(source)}"?`
          : `Revert ${ready.length} file(s) to their original names?`;
      const ok = await confirm(`\n${question}`, { defaultYes: false });
      if (!ok) {
        process.stdout.write('Nothing has been changed.\n');
        return 0;
      }
    } else if (log.mode === MODES.COPY) {
      // Deleting files is more destructive than renaming them: even with
      // --yes the user is told exactly what is about to happen.
      process.stdout.write(color.yellow(`Deleting ${ready.length} copied file(s).\n`));
    }
  }

  const { reverted, failed } = await revert(ready, { mode: log.mode });
  if (failed.length === 0) await removeLog(source);

  if (json) {
    printJson({
      action: 'undo',
      mode: log.mode,
      applied: true,
      reverted: reverted.length,
      failed,
      skipped,
    });
  } else {
    printSummary({
      processed: reverted.length,
      skipped: skipped.length,
      failed: failed.length,
      verb: log.mode === MODES.COPY ? 'deleted' : 'restored',
      dryRun: false,
    });
    if (failed.length > 0) {
      for (const item of failed) {
        printError(`could not revert ${path.basename(item.operation.to)}: ${item.reason}`);
      }
    }
  }

  return failed.length > 0 ? 1 : 0;
}

async function run(argv) {
  jsonMode = argv.includes('--json');

  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new CliError(error.message, 'Run fastrnm --help to see the available options.');
  }

  const { values, positionals } = parsed;

  if (values['no-color'] || values.json) setColorEnabled(false);

  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${await readVersion()}\n`);
    return 0;
  }

  if (positionals.length > 1) {
    throw new CliError(
      `expected at most one folder, got ${positionals.length}.`,
      'Quote paths that contain spaces.',
    );
  }
  if (positionals.length === 1 && values.dir) {
    throw new CliError('use either the positional folder or --dir, not both.');
  }

  const json = values.json;
  const dryRun = values['dry-run'];
  const sourceInput = values.dir ?? positionals[0];

  if (values.wizard) {
    if (values.json) {
      throw new CliError(
        '--wizard asks questions, which --json cannot answer.',
        'Pass the options as flags: fastrnm ./photos --prefix holiday --json --yes',
      );
    }
    if (values.undo) {
      throw new CliError(
        '--wizard and --undo do different things.',
        'Undoing takes no naming options: fastrnm ./photos --undo',
      );
    }
    if (values.random) {
      throw new CliError(
        '--wizard and --random contradict each other.',
        'The wizard builds a numbered sequence; --random replaces the numbers with tokens.',
      );
    }
  }

  let { dir: source, explicit } = await resolveSource(sourceInput);

  if (values.undo) {
    return runUndo(source, { json, yes: values.yes });
  }

  // Checked before the wizard runs: an unknown mode given as a flag would
  // otherwise be offered as an answer and only rejected five questions later.
  if (values.sort !== undefined && !SORT_MODES.includes(values.sort)) {
    throw new CliError(
      `unknown sort mode "${values.sort}".`,
      `Valid values: ${SORT_MODES.join(', ')}.`,
    );
  }

  // The wizard only collects options: it fills in the same values the flags
  // would have set and the run continues through the usual path, preview and
  // confirmation included.
  if (values.wizard) {
    const prompter = createPrompter();
    let answers;
    try {
      answers = await runWizard({
        ask: prompter.ask,
        defaults: {
          dir: sourceInput,
          prefix: values.prefix,
          pad: parseInteger(values.pad, '--pad'),
          separator: values.separator ?? '_',
          sort: values.sort ?? DEFAULT_SORT,
        },
      });
    } finally {
      prompter.close();
    }

    if (answers === null) {
      process.stdout.write('\nNothing has been changed.\n');
      return 0;
    }

    ({ dir: source, explicit } = answers.folder);
    values.prefix = answers.prefix;
    values.pad = answers.pad === undefined ? undefined : String(answers.pad);
    values.separator = answers.separator;
    values.sort = answers.sort;

    process.stdout.write(`\n${color.gray(`Same run as: ${formatCommand(answers)}`)}\n`);
  }

  // --- option validation ------------------------------------------------
  const separator = values.separator ?? '_';
  const start = parseInteger(values.start, '--start') ?? 1;
  const step = parseInteger(values.step, '--step') ?? 1;
  const pad = parseInteger(values.pad, '--pad');
  const sort = values.sort ?? 'name';

  if (values.move && !values.output) {
    throw new CliError('--move only makes sense together with --output.');
  }
  if (values.flatten && !values.output) {
    throw new CliError('--flatten only makes sense together with --output.');
  }
  if (values.flatten && !values.recursive) {
    throw new CliError('--flatten only makes sense together with --recursive.');
  }
  if (values['restart-per-folder'] && !values.recursive) {
    throw new CliError('--restart-per-folder only makes sense together with --recursive.');
  }
  if (values['restart-per-folder'] && values.flatten) {
    throw new CliError(
      '--restart-per-folder and --flatten contradict each other.',
      'Restarting the numbering in every folder and then merging them into one guarantees duplicate names.',
    );
  }

  const randomLength = parseInteger(values['random-length'], '--random-length') ?? DEFAULT_TOKEN_LENGTH;

  if (values.random) {
    const numbering = ['start', 'step', 'pad'].filter((flag) => values[flag] !== undefined);
    if (numbering.length > 0) {
      throw new CliError(
        `--random cannot be combined with ${numbering.map((flag) => `--${flag}`).join(' or ')}.`,
        'Random names have no sequence. Use --random-length to change their length.',
      );
    }
    if (randomLength < 1 || randomLength > MAX_TOKEN_LENGTH) {
      throw new CliError(
        `--random-length must be between 1 and ${MAX_TOKEN_LENGTH}, got ${randomLength}.`,
      );
    }
  } else if (values['random-length'] !== undefined) {
    throw new CliError('--random-length only makes sense together with --random.');
  }

  const checks = [
    validateAffix(values.prefix, { label: 'prefix' }),
    validateAffix(values.suffix, { label: 'suffix' }),
    validateSeparator(separator),
    validateNumbering({ start, step, pad }),
  ];
  const errors = checks.flatMap((check) => check.errors);
  const warnings = checks.flatMap((check) => check.warnings);

  if (errors.length > 0) {
    if (json) {
      printJson({ ok: false, errors });
      return 1;
    }
    for (const error of errors) printError(error.message, error.hint);
    return 1;
  }
  if (warnings.length > 0 && !json) printWarnings(warnings);

  // --- destination ------------------------------------------------------
  const destination = await resolveDestination(values.output, {
    source,
    recursive: values.recursive,
  });

  const mode = destination.inPlace
    ? MODES.RENAME
    : values.move
      ? MODES.MOVE
      : MODES.COPY;

  if (destination.mustCreate && !values['create-dir'] && !dryRun) {
    if (json) {
      throw new CliError(
        `the destination "${destination.dir}" does not exist.`,
        'Re-run with --create-dir.',
      );
    }
    const create =
      values.yes ||
      (await confirm(`The folder "${displayPath(destination.dir)}" does not exist. Create it?`, {
        defaultYes: true,
      }));
    if (!create) {
      process.stdout.write('Nothing has been changed.\n');
      return 0;
    }
  }

  // --- collect ----------------------------------------------------------
  const { files, skipped } = await collectFiles(source, {
    recursive: values.recursive,
    includeHidden: values['include-hidden'],
    extensions: parseExtensions(values.ext),
    match: buildMatcher(values.match),
    exclude: buildMatcher(values.exclude),
    skipDirs: destination.dir && !destination.inPlace ? [destination.dir] : [],
  });

  if (files.length === 0) {
    const reasons = describeSkipped(skipped);
    throw new CliError(
      `no files to rename in "${displayPath(source)}".`,
      reasons ? `Skipped: ${reasons}.` : 'The folder is empty.',
    );
  }

  // Links are the surprising one: they look like files in every file manager.
  if (skipped.symlinks > 0 && !json) {
    printWarnings([
      `${skipped.symlinks} symbolic link${skipped.symlinks === 1 ? '' : 's'} skipped; only regular files are renamed.`,
    ]);
  }

  if (values.random && !fitsBatch(files.length, randomLength)) {
    throw new CliError(
      `--random-length ${randomLength} cannot safely name ${files.length} files.`,
      `Use --random-length ${suggestLength(files.length)} or more.`,
    );
  }

  if (sort === 'created' && !json && files.every((file) => !file.birthtimeMs)) {
    printWarnings([
      'this filesystem does not record creation dates; ordering by modification date instead.',
    ]);
  }

  if (sort === 'exif') {
    // Only JPEG carries a capture date, so opening anything else is a syscall
    // spent to learn nothing -- and it would pad the warning with files that
    // were never going to have one.
    const photos = files.filter((file) => JPEG_EXTENSION.test(file.ext));
    const withoutDate = photos.length > 0 ? await attachExifDates(photos) : 0;

    if (!json && photos.length === 0) {
      printWarnings(['no JPEG files here; ordering by modification date instead.']);
    } else if (!json && withoutDate > 0) {
      printWarnings([
        `${withoutDate} of ${photos.length} JPEG file(s) have no EXIF capture date; ` +
          'they are ordered by their modification date instead.',
      ]);
    }
  }

  let ordered = sortFiles(files, { sort, reverse: values.reverse });
  if (values.interactive) {
    ordered = await reorder(ordered);
    if (ordered === null) {
      process.stdout.write('Nothing has been changed.\n');
      return 0;
    }
  }

  // --- plan -------------------------------------------------------------
  const { operations, padding } = buildPlan(ordered, {
    sourceDir: source,
    destination: destination.inPlace ? null : destination.dir,
    prefix: values.prefix ?? '',
    suffix: values.suffix ?? '',
    separator,
    start,
    step,
    pad,
    flatten: values.flatten,
    restartPerFolder: values['restart-per-folder'],
    keepName: values['keep-name'],
    nextToken: values.random ? createTokenGenerator({ length: randomLength }) : null,
  });

  const existing = await existingTargets(operations);
  // Files of the batch are not obstacles to themselves.
  for (const op of operations) existing.delete(op.from);

  const { errors: conflicts, needsTwoPhase } = detectCollisions(operations, {
    existing,
    force: values.force,
  });

  // Applying overwrites the undo log, so a previous run that was never undone
  // is about to become unrecoverable. Say so before it happens.
  const previous = await pendingUndo(
    logDirectory({ mode, source, destination: destination.dir }),
  );

  const statuses = new Map();
  for (const [index, message] of conflicts) statuses.set(index, { status: 'error', message });
  for (const op of operations) {
    if (op.unchanged && !statuses.has(op.index)) {
      statuses.set(op.index, { status: 'warning', message: 'name unchanged' });
    }
  }

  const unchanged = operations.filter((op) => op.unchanged).length;
  const pending = operations.length - unchanged;

  if (json) {
    const payload = {
      ok: conflicts.size === 0,
      mode,
      dryRun,
      source,
      destination: destination.inPlace ? null : destination.dir,
      padding,
      pendingUndo: previous,
      operations: operations.map((op) => ({
        from: op.from,
        to: op.to,
        error: conflicts.get(op.index) ?? null,
      })),
    };
    if (conflicts.size > 0) {
      printJson({ ...payload, applied: false });
      return 1;
    }
    if (dryRun) {
      printJson({ ...payload, applied: false });
      return 0;
    }
    if (!values.yes) {
      throw new CliError(
        '--json requires --yes to apply changes.',
        'Add --dry-run to preview, or --yes to confirm.',
      );
    }
  } else {
    process.stdout.write(
      `\n${color.bold(displayPath(source))}${
        destination.inPlace ? '' : `  ${color.gray('->')}  ${color.bold(displayPath(destination.dir))}`
      }\n\n`,
    );
    printPreview(operations, statuses, { limit: PREVIEW_LIMIT });
    if (previous) printWarnings([pendingUndoWarning(previous)]);
  }

  if (conflicts.size > 0) {
    if (!json) {
      process.stderr.write('\n');
      printError(
        `${conflicts.size} collision${conflicts.size === 1 ? '' : 's'} detected. Nothing has been changed.`,
        'Use a different prefix or --start, or pass --force to overwrite.',
      );
    }
    return 1;
  }

  if (pending === 0) {
    if (!json) process.stdout.write('\nEvery file already has its target name. Nothing to do.\n');
    return 0;
  }

  if (dryRun) {
    if (!json) {
      process.stdout.write(
        `\n${pending} file${pending === 1 ? '' : 's'}. Dry run: nothing has been changed.\n`,
      );
    }
    return 0;
  }

  // --- pre-flight checks ------------------------------------------------
  if (destination.mustCreate) await createDirectory(destination.dir);
  await assertWritable(destination.inPlace ? source : destination.dir);
  if (mode !== MODES.RENAME) await assertWritable(source);

  let sameFilesystem = true;
  if (mode === MODES.MOVE) {
    sameFilesystem = await isSameFilesystem(source, destination.dir);
    if (!sameFilesystem && !json) {
      printWarnings([
        'source and destination are on different filesystems: files will be copied and then deleted, which is slower.',
      ]);
    }
  }

  if (mode === MODES.COPY || (mode === MODES.MOVE && !sameFilesystem)) {
    const needed = totalSize(operations);
    const available = await freeSpace(destination.dir);
    if (available !== null && available < needed) {
      throw new CliError(
        `not enough free space in "${displayPath(destination.dir)}": ${formatBytes(needed)} needed, ${formatBytes(available)} available.`,
      );
    }
  }

  if (destination.exists && destination.existingEntries.length > 0 && !json) {
    printWarnings([
      `the destination folder already contains ${destination.existingEntries.length} entr${
        destination.existingEntries.length === 1 ? 'y' : 'ies'
      }.`,
    ]);
  }

  // --- confirmation -----------------------------------------------------
  // Renaming the folder you happen to be standing in is the most expensive
  // mistake this tool can make, so the implicit current folder always asks,
  // even with --yes.
  const mustAsk = !explicit || !values.yes;
  if (mustAsk && !json) {
    const verb = mode === MODES.COPY ? 'Copy' : mode === MODES.MOVE ? 'Move' : 'Rename';
    const where = explicit ? '' : ` in the current folder (${color.bold(displayPath(source))})`;
    const ok = await confirm(
      `\n${verb} ${pending} file${pending === 1 ? '' : 's'}${where}?`,
      { defaultYes: false },
    );
    if (!ok) {
      process.stdout.write('Nothing has been changed.\n');
      return 0;
    }
  } else if (mustAsk && json) {
    throw new CliError(
      'the current folder always requires confirmation, which --json cannot provide.',
      'Pass the folder explicitly, for example: fastrnm ./photos --json --yes',
    );
  }

  // --- apply ------------------------------------------------------------
  const progress = createProgressReporter(pending, { json });
  let applied;
  try {
    ({ applied } = await applyPlan(operations, {
      mode,
      needsTwoPhase,
      force: values.force,
      sameFilesystem,
      onProgress: progress ? (op, done) => progress.report(op, done) : undefined,
    }));
  } catch (error) {
    progress?.clear();
    if (error instanceof ApplyError) {
      const hint = error.rolledBack
        ? 'Every applied change has been rolled back; nothing was left half done.'
        : 'The rollback could not be completed. Check the folder before running again.';
      if (json) {
        printJson({
          ok: false,
          applied: false,
          rolledBack: error.rolledBack,
          error: error.message,
          hint,
        });
      } else {
        printError(`the operation failed: ${error.message}`, hint);
      }
      return 1;
    }
    throw error;
  }

  progress?.clear();

  const logDir = logDirectory({ mode, source, destination: destination.dir });
  let logFile = null;
  try {
    logFile = await writeLog(logDir, {
      mode,
      source,
      destination: destination.inPlace ? null : destination.dir,
      operations: applied,
    });
  } catch (error) {
    printWarnings([`could not write the undo log: ${error.message}`]);
  }

  if (json) {
    printJson({
      ok: true,
      applied: true,
      mode,
      source,
      destination: destination.inPlace ? null : destination.dir,
      count: applied.length,
      log: logFile,
      operations: applied,
    });
  } else {
    printSummary({ processed: applied.length, skipped: unchanged, mode, dryRun: false });
    if (mode === MODES.COPY) {
      process.stdout.write('The originals have not been modified.\n');
    }
    if (logFile) {
      process.stdout.write(
        color.gray(`Undo with: fastrnm ${displayPath(logDir)} --undo\n`),
      );
    }
  }

  return 0;
}

async function main() {
  try {
    const code = await run(process.argv.slice(2));
    process.exitCode = code;
  } catch (error) {
    const expected =
      error instanceof CliError || error instanceof PathError || error instanceof UndoError;
    const message = expected ? error.message : (error?.message ?? String(error));
    const hint = expected ? error.hint : undefined;

    if (jsonMode) {
      printJson({ ok: false, applied: false, error: message, hint: hint ?? null });
    } else {
      printError(message, hint);
    }
    process.exitCode = 1;
  }
}

await main();
