/**
 * Builds the `current -> new` map. Pure functions, no disk access: that makes
 * --dry-run trivial (build the plan and stop) and keeps testing easy.
 */

import path from 'node:path';

/** Number of digits needed to write `value`. */
export function digits(value) {
  return String(Math.max(0, Math.trunc(value))).length;
}

/**
 * Automatic padding: enough digits for the highest number of the sequence, so
 * alphabetical order never breaks without the user having to think about it.
 */
export function autoPadding({ count, start, step }) {
  if (count <= 0) return 1;
  return digits(start + step * (count - 1));
}

/**
 * Builds a single target name. `token` replaces the sequence number when the
 * names are random.
 */
export function buildName({
  prefix = '',
  stem = '',
  suffix = '',
  separator = '_',
  number,
  pad,
  token,
  ext = '',
}) {
  const core = token ?? String(number).padStart(pad, '0');
  const parts = [prefix, stem, core, suffix].filter(
    (part) => part !== '' && part !== undefined,
  );
  return parts.join(separator) + ext;
}

/**
 * @param {Array} files sorted files from collect/sort
 * @param {object} options
 * @param {string} options.sourceDir absolute source folder
 * @param {string|null} [options.destination] absolute destination, null for in-place
 * @param {string} [options.prefix]
 * @param {string} [options.suffix]
 * @param {string} [options.separator]
 * @param {number} [options.start]
 * @param {number} [options.step]
 * @param {number} [options.pad] explicit padding, omit for automatic
 * @param {boolean} [options.flatten] with recursive + destination, one flat folder
 * @param {boolean} [options.restartPerFolder] restart numbering on every folder
 * @param {boolean} [options.keepName] keep the original name before the number
 * @param {(() => string)|null} [options.nextToken] when set, names are random
 *   tokens from this generator instead of a sequence
 * @returns {{operations: Array, padding: number}}
 */
export function buildPlan(files, options) {
  const {
    sourceDir,
    destination = null,
    prefix = '',
    suffix = '',
    separator = '_',
    start = 1,
    step = 1,
    pad,
    flatten = false,
    restartPerFolder = false,
    keepName = false,
    nextToken = null,
  } = options;

  const targetRoot = destination ?? sourceDir;
  const groups = new Map();

  for (const file of files) {
    const key = restartPerFolder ? file.relativeDir : '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file);
  }

  const globalPadding = pad ?? autoPadding({ count: files.length, start, step });
  const operations = [];
  let index = 0;

  for (const group of groups.values()) {
    const groupPadding = pad ?? (restartPerFolder
      ? autoPadding({ count: group.length, start, step })
      : globalPadding);

    for (const [position, file] of group.entries()) {
      const number = start + position * step;
      const toName = buildName({
        prefix,
        stem: keepName ? file.stem : '',
        suffix,
        separator,
        number,
        pad: groupPadding,
        token: nextToken ? nextToken() : undefined,
        ext: file.ext,
      });

      const relativeDir = destination && flatten ? '' : file.relativeDir;
      const to = path.join(targetRoot, relativeDir, toName);

      operations.push({
        index,
        number,
        from: file.path,
        to,
        fromName: file.name,
        toName,
        fromDisplay: path.join(file.relativeDir, file.name),
        toDisplay: path.join(relativeDir, toName),
        relativeDir,
        size: file.size,
        unchanged: file.path === to,
      });
      index += 1;
    }
  }

  return { operations, padding: pad ?? globalPadding };
}

/** Total size in bytes of the planned operations. */
export function totalSize(operations) {
  return operations.reduce((sum, op) => sum + (op.size ?? 0), 0);
}
