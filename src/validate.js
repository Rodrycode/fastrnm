/**
 * Validation of the user supplied name parts (prefix, suffix, separator).
 *
 * The prefix ends up being part of a real filename, so it is validated
 * against the strictest rules of the operating systems the folder may end up
 * on -- even when running on macOS or Linux, those files often travel inside a
 * ZIP, a shared drive or a repository that is opened on Windows.
 */

/** Characters that are invalid in a filename on at least one OS. */
export const FORBIDDEN_CHARACTERS = ['/', '\\', ':', '*', '?', '"', '<', '>', '|'];

/** Reserved device names on Windows. */
export const RESERVED_NAMES = [
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
];

export const MAX_AFFIX_LENGTH = 100;

/** Digits of padding beyond which the numbering stops meaning anything. */
export const MAX_PAD = 20;

const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;
const NON_ASCII = /[^\u0020-\u007E]/;

/**
 * Returns true when `value` matches a Windows reserved device name, with or
 * without extension (`CON`, `con.txt`, `LPT1.jpg`...).
 */
export function isReservedName(value) {
  const stem = String(value).split('.')[0].trim().toUpperCase();
  return RESERVED_NAMES.includes(stem);
}

/**
 * Validates a prefix or suffix.
 * @param {string} value the affix to validate
 * @param {{label?: string, allowEmpty?: boolean}} options
 * @returns {{errors: {message: string, hint?: string}[], warnings: string[]}}
 */
export function validateAffix(value, { label = 'prefix', allowEmpty = true } = {}) {
  const errors = [];
  const warnings = [];

  if (value === undefined || value === null || value === '') {
    if (!allowEmpty) {
      errors.push({ message: `the ${label} cannot be empty.` });
    }
    return { errors, warnings };
  }

  const text = String(value);

  if (text.trim() === '') {
    errors.push({
      message: `the ${label} cannot be only whitespace.`,
      hint: `Use a real name, for example --${label} photo`,
    });
    return { errors, warnings };
  }

  const found = FORBIDDEN_CHARACTERS.filter((char) => text.includes(char));
  if (found.length > 0) {
    errors.push({
      message: `the ${label} "${text}" contains invalid characters: ${found.join(' ')}`,
      hint: `Those characters are not allowed in filenames. Try "${sanitize(text)}".`,
    });
  }

  if (CONTROL_CHARACTERS.test(text)) {
    errors.push({
      message: `the ${label} contains control characters.`,
      hint: 'Remove any tab, newline or non printable character.',
    });
  }

  if (isReservedName(text)) {
    errors.push({
      message: `the ${label} "${text}" is a reserved system name.`,
      hint: `Try a different name, for example "${text}_file".`,
    });
  }

  if (text.startsWith('.')) {
    errors.push({
      message: `the ${label} cannot start with a dot.`,
      hint: `That would make every file hidden. Try "${text.replace(/^\.+/, '')}".`,
    });
  }

  if (text.endsWith('.') || text.endsWith(' ')) {
    errors.push({
      message: `the ${label} cannot end with a dot or a space.`,
      hint: `Windows silently trims them, which causes collisions. Try "${text.replace(/[. ]+$/, '')}".`,
    });
  }

  if (text.length > MAX_AFFIX_LENGTH) {
    errors.push({
      message: `the ${label} is too long (${text.length} characters, max ${MAX_AFFIX_LENGTH}).`,
      hint: 'Very long names break on some filesystems and path limits.',
    });
  }

  if (/\s/.test(text)) {
    warnings.push(`the ${label} contains spaces; the resulting names will need quoting in scripts.`);
  }

  if (NON_ASCII.test(text)) {
    warnings.push(
      `the ${label} contains non ASCII characters; they work, but may not survive some transfers.`,
    );
  }

  return { errors, warnings };
}

/** Validates the separator between the affixes and the number. */
export function validateSeparator(separator) {
  const errors = [];
  if (separator === '') return { errors, warnings: [] };
  const found = FORBIDDEN_CHARACTERS.filter((char) => separator.includes(char));
  if (found.length > 0) {
    errors.push({
      message: `the separator "${separator}" contains invalid characters: ${found.join(' ')}`,
      hint: 'Use one of _ - . or an empty string.',
    });
  }
  if (CONTROL_CHARACTERS.test(separator)) {
    errors.push({ message: 'the separator contains control characters.' });
  }
  return { errors, warnings: [] };
}

/** Replaces every forbidden character with an underscore. */
export function sanitize(value) {
  let out = String(value);
  for (const char of FORBIDDEN_CHARACTERS) out = out.split(char).join('_');
  return out.replace(/^\.+/, '').replace(/[. ]+$/, '');
}

/** Validates the numeric options as a whole. */
export function validateNumbering({ start, step, pad }) {
  const errors = [];
  if (!Number.isInteger(start)) {
    errors.push({ message: '--start must be an integer.' });
  } else if (start < 0) {
    errors.push({ message: '--start cannot be negative.' });
  }
  if (!Number.isInteger(step)) {
    errors.push({ message: '--step must be an integer.' });
  } else if (step < 1) {
    errors.push({ message: '--step must be at least 1.' });
  }
  if (pad !== undefined) {
    if (!Number.isInteger(pad) || pad < 0) {
      errors.push({
        message: '--pad must be a positive integer (or omitted for automatic padding).',
      });
    } else if (pad > MAX_PAD) {
      errors.push({ message: `--pad is unreasonably large (max ${MAX_PAD}).` });
    }
  }
  return { errors, warnings: [] };
}
