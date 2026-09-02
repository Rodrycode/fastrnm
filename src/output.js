/**
 * Terminal output: colors, preview table and summaries.
 * Colors are plain ANSI codes, no dependency. They are disabled when the
 * stream is not a TTY, when NO_COLOR is set or when --json is used.
 */

const ESC = '\u001B';

const CODES = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  blue: `${ESC}[34m`,
  cyan: `${ESC}[36m`,
  gray: `${ESC}[90m`,
};

let colorEnabled =
  process.env.NO_COLOR === undefined &&
  process.env.FORCE_COLOR !== '0' &&
  Boolean(process.stdout.isTTY);

export function setColorEnabled(value) {
  colorEnabled = Boolean(value);
}

function paint(code) {
  return (text) => (colorEnabled ? `${code}${text}${CODES.reset}` : String(text));
}

export const color = {
  bold: paint(CODES.bold),
  dim: paint(CODES.dim),
  red: paint(CODES.red),
  green: paint(CODES.green),
  yellow: paint(CODES.yellow),
  blue: paint(CODES.blue),
  cyan: paint(CODES.cyan),
  gray: paint(CODES.gray),
};

const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

/** Visible width of a string once ANSI codes are stripped. */
function width(text) {
  return String(text).replace(ANSI_PATTERN, '').length;
}

function padEnd(text, size) {
  const diff = size - width(text);
  return diff > 0 ? text + ' '.repeat(diff) : text;
}

export const ARROW = '→';
export const OK = '✓';
export const FAIL = '✗';
export const WARN = '!';

/**
 * Prints the `current -> new` table.
 * @param {Array} operations plan operations
 * @param {Map<number, {status: string, message?: string}>} statuses keyed by operation index
 */
export function printPreview(operations, statuses = new Map(), { limit = 0 } = {}) {
  if (operations.length === 0) return;
  const shown = limit > 0 && operations.length > limit ? operations.slice(0, limit) : operations;
  const fromWidth = Math.max(...shown.map((op) => op.fromDisplay.length));

  for (const [position, op] of shown.entries()) {
    const state = statuses.get(op.index ?? position) ?? { status: 'ok' };
    const from = padEnd(op.fromDisplay, fromWidth);
    let to = op.toDisplay;
    let mark = '';

    if (state.status === 'error') {
      to = color.red(to);
      mark = `  ${color.red(`${FAIL} ${state.message ?? 'error'}`)}`;
    } else if (state.status === 'warning') {
      to = color.yellow(to);
      mark = `  ${color.yellow(`${WARN} ${state.message ?? 'warning'}`)}`;
    } else {
      to = color.green(to);
      mark = `  ${color.green(OK)}`;
    }

    process.stdout.write(`  ${color.dim(from)}  ${color.gray(ARROW)}  ${to}${mark}\n`);
  }

  if (shown.length < operations.length) {
    const rest = operations.length - shown.length;
    process.stdout.write(color.gray(`  ... and ${rest} more file${rest === 1 ? '' : 's'}\n`));
  }
}

export function printWarnings(warnings) {
  for (const warning of warnings) {
    process.stderr.write(`${color.yellow('Warning:')} ${warning}\n`);
  }
}

export function printError(message, hint) {
  process.stderr.write(`${color.red('Error:')} ${message}\n`);
  if (hint) process.stderr.write(`${color.gray(hint)}\n`);
}

export function printSummary({ processed, skipped = 0, failed = 0, mode, dryRun, verb }) {
  const action = verb ?? (mode === 'copy' ? 'copied' : mode === 'move' ? 'moved' : 'renamed');
  const parts = [
    `${processed} file${processed === 1 ? '' : 's'} ${dryRun ? 'to be ' : ''}${action}`,
  ];
  if (skipped) parts.push(`${skipped} skipped`);
  if (failed) parts.push(color.red(`${failed} failed`));
  process.stdout.write(`\n${parts.join(', ')}.\n`);
}

export function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
