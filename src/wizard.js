/**
 * Guided mode: the handful of questions that cover an everyday rename.
 *
 * The wizard only *collects* options. It produces the same values the flags
 * would have produced and hands them back to the normal pipeline, so the
 * preview, the collision check and the undo log behave identically whether the
 * run was typed or answered.
 *
 * Nothing here writes to the terminal directly: every prompt is built as text
 * and handed to the injected `ask`, which keeps the flow testable without a
 * TTY and keeps all the readline handling in one place.
 */

import os from 'node:os';
import path from 'node:path';

import { color, FAIL } from './output.js';
import { displayPath, resolveSource } from './paths.js';
import { SORT_MODES } from './sort.js';
import { MAX_PAD, validateAffix, validateSeparator } from './validate.js';

/** Order the wizard proposes when the answer is left blank. */
export const DEFAULT_SORT = 'created';

/** The word that means "no separator at all", since blank keeps the default. */
export const NO_SEPARATOR = 'none';

/**
 * Sort modes as the wizard lists them: the default first, then the rest.
 * Answers may be the mode name or its position in this list.
 */
export const SORT_CHOICES = [
  { mode: 'created', label: 'creation date, oldest first' },
  { mode: 'name', label: 'name, natural order (file2 before file10)' },
  { mode: 'date', label: 'modification date, oldest first' },
  { mode: 'exif', label: 'capture date read from the photo' },
  { mode: 'size', label: 'file size, smallest first' },
];

/** Answers are `{value}` when accepted and `{error, hint}` when they are not. */

export function parsePrefix(answer, { fallback } = {}) {
  const text = String(answer).trim();
  if (text === '') return { value: fallback };

  const { errors } = validateAffix(text, { label: 'prefix' });
  if (errors.length > 0) return { error: errors[0].message, hint: errors[0].hint };
  return { value: text };
}

export function parsePad(answer, { fallback } = {}) {
  const text = String(answer).trim();
  if (text === '') return { value: fallback };

  if (!/^-?\d+$/.test(text)) {
    return {
      error: `"${text}" is not a whole number.`,
      hint: 'Enter how many digits the numbers should have, or leave blank for automatic.',
    };
  }
  const pad = Number.parseInt(text, 10);
  if (pad < 0) return { error: 'the padding cannot be negative.' };
  if (pad > MAX_PAD) {
    return { error: `a padding of ${pad} digits is unreasonably large (max ${MAX_PAD}).` };
  }
  return { value: pad };
}

export function parseSeparator(answer, { fallback = '_' } = {}) {
  const text = String(answer).trim();
  if (text === '') return { value: fallback };
  if (text.toLowerCase() === NO_SEPARATOR) return { value: '' };

  const { errors } = validateSeparator(text);
  if (errors.length > 0) return { error: errors[0].message, hint: errors[0].hint };
  return { value: text };
}

export function parseSort(answer, { fallback = DEFAULT_SORT } = {}) {
  const text = String(answer).trim().toLowerCase();
  if (text === '') return { value: fallback };

  if (/^\d+$/.test(text)) {
    const choice = SORT_CHOICES[Number.parseInt(text, 10) - 1];
    if (!choice) {
      return {
        error: `there is no option ${text}.`,
        hint: `Choose a number between 1 and ${SORT_CHOICES.length}, or type the name.`,
      };
    }
    return { value: choice.mode };
  }

  if (!SORT_MODES.includes(text)) {
    return {
      error: `unknown order "${String(answer).trim()}".`,
      hint: `Valid values: ${SORT_MODES.join(', ')}.`,
    };
  }
  return { value: text };
}

/** A folder as it is worth showing back to the user: `~` instead of the home. */
function homeRelative(dir) {
  const home = os.homedir();
  return dir === home || dir.startsWith(home + path.sep) ? `~${dir.slice(home.length)}` : dir;
}

/** Quotes a value for the "equivalent command" line when it needs it. */
function quote(value) {
  return value === '' || /\s/.test(value) ? `"${value}"` : value;
}

/**
 * The command that would have produced the same run, printed after the
 * questions so the flags are learnt by using the wizard once.
 */
export function formatCommand({ folder, prefix, pad, separator, sort }) {
  const parts = ['fastrnm'];
  // The implicit current folder is left out on purpose: spelling it as "."
  // would print a command that no longer asks for confirmation.
  if (folder.explicit) parts.push(quote(displayPath(folder.dir)));
  if (prefix !== undefined && prefix !== '') parts.push('--prefix', quote(prefix));
  if (pad !== undefined) parts.push('--pad', String(pad));
  if (separator !== '_') parts.push('--separator', quote(separator));
  if (sort !== 'name') parts.push('--sort', sort);
  return parts.join(' ');
}

function prompt({ step, total, question, hint, choices = [] }) {
  // Everything under the question lines up with its text, past the "1/5  ".
  const indent = ' '.repeat(7);
  const lines = ['', `  ${color.cyan(`${step}/${total}`)}  ${color.bold(question)}`];
  for (const choice of choices) lines.push(`${indent}${color.gray(choice)}`);
  if (hint) lines.push(`${indent}${color.gray(hint)}`);
  lines.push(`${indent}> `);
  return lines.join('\n');
}

/** Prepends the rejection of the previous answer to the next prompt. */
function withError(text, error) {
  if (!error) return text;
  const lines = [`\n  ${color.red(`${FAIL} ${error.error}`)}`];
  if (error.hint) lines.push(`  ${color.gray(error.hint)}`);
  return lines.join('\n') + text;
}

/**
 * Asks one question until the answer is accepted. A wrong answer is worth a
 * correction, not the loss of the four answers already given.
 * @returns {Promise<object|null>} the parsed result, or null when cancelled
 */
async function askUntilValid(ask, text, parse) {
  let error = null;
  for (;;) {
    const answer = await ask(withError(text, error));
    // Ctrl+D or a closed stdin: no answer means no run.
    if (answer === null || answer === undefined) return null;
    const result = await parse(answer);
    if (result.error === undefined) return result;
    error = result;
  }
}

/**
 * The questions, in order. Keeping them as data rather than as a run of
 * copy-pasted blocks is what makes the "n/5" numbering impossible to get
 * wrong, and adding a question a one entry change.
 */
const QUESTIONS = [
  {
    key: 'folder',
    question: 'Which folder holds the files to rename?',
    hint: (defaults, cwd) =>
      defaults.dir
        ? `Leave blank for ${quote(defaults.dir)}.`
        : `Leave blank for the current folder (${homeRelative(cwd)}).`,
    async parse(answer, defaults, cwd) {
      const text = String(answer).trim();
      try {
        const { dir, explicit } = await resolveSource(text === '' ? defaults.dir : text, { cwd });
        return { value: { dir, explicit } };
      } catch (error) {
        return { error: error.message, hint: error.hint };
      }
    },
  },
  {
    key: 'prefix',
    question: 'Which prefix should the renamed files have?',
    hint: (defaults) =>
      defaults.prefix === undefined
        ? 'Leave blank for none, or type it without a separator (holiday).'
        : `Leave blank to keep "${defaults.prefix}".`,
    parse: (answer, defaults) => parsePrefix(answer, { fallback: defaults.prefix }),
  },
  {
    key: 'pad',
    question: 'How many digits should the numbers have?',
    hint: (defaults) =>
      defaults.pad === undefined
        ? 'Leave blank for automatic (3 digits for 100 files), or enter a number.'
        : `Leave blank to keep ${defaults.pad}.`,
    parse: (answer, defaults) => parsePad(answer, { fallback: defaults.pad }),
  },
  {
    key: 'separator',
    question: 'Which separator should go between the parts?',
    hint: (defaults) =>
      `Leave blank for "${defaults.separator ?? '_'}", or type "${NO_SEPARATOR}" for no separator.`,
    parse: (answer, defaults) =>
      parseSeparator(answer, { fallback: defaults.separator ?? '_' }),
  },
  {
    key: 'sort',
    question: 'In which order should the files be numbered?',
    choices: SORT_CHOICES.map(
      (choice, index) => `${index + 1}) ${choice.mode.padEnd(8)} ${choice.label}`,
    ),
    hint: (defaults) => `Leave blank for ${defaults.sort ?? DEFAULT_SORT}.`,
    parse: (answer, defaults) => parseSort(answer, { fallback: defaults.sort ?? DEFAULT_SORT }),
  },
];

/**
 * Runs the guided mode.
 *
 * @param {object} options
 * @param {(question: string) => Promise<string|null>} options.ask reads one
 *   answer; returns null when the user cancels
 * @param {object} [options.defaults] values already given as flags, offered as
 *   the answer for blank
 * @param {string} [options.cwd]
 * @returns {Promise<{folder: {dir: string, explicit: boolean}, prefix: string|undefined,
 *   pad: number|undefined, separator: string, sort: string}|null>} null when cancelled
 */
export async function runWizard({ ask, defaults = {}, cwd = process.cwd() } = {}) {
  const answers = {};

  for (const [index, question] of QUESTIONS.entries()) {
    const text = prompt({
      step: index + 1,
      total: QUESTIONS.length,
      question: question.question,
      hint: question.hint(defaults, cwd),
      choices: question.choices,
    });

    const result = await askUntilValid(ask, text, (answer) =>
      question.parse(answer, defaults, cwd),
    );
    if (result === null) return null;
    answers[question.key] = result.value;
  }

  return answers;
}
