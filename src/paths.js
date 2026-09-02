/**
 * Resolution and validation of the source and destination folders.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export class PathError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'PathError';
    this.hint = hint;
  }
}

/** Expands a leading `~` to the user home directory. */
export function expandHome(input) {
  const value = String(input);
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

/** Expands `~`, resolves relative segments and returns an absolute path. */
export function resolvePath(input, cwd = process.cwd()) {
  return path.resolve(cwd, expandHome(input));
}

/** True when `child` is the same path as `parent` or lives inside it. */
export function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Filenames are compared without case on macOS and Windows. */
const CASE_INSENSITIVE_PATHS = process.platform === 'darwin' || process.platform === 'win32';

/** Absolute path in the form used to compare two locations on this platform. */
function comparablePath(target) {
  const resolved = path.resolve(target);
  return CASE_INSENSITIVE_PATHS ? resolved.toLowerCase() : resolved;
}

/** True when both paths point to the same directory entry. */
export function isSamePath(a, b) {
  if (comparablePath(a) === comparablePath(b)) return true;
  try {
    const statA = fs.statSync(a);
    const statB = fs.statSync(b);
    // FAT32 and exFAT report inode 0 for every entry -- a USB stick or an SD
    // card on Windows. Without a real file id, two unrelated folders would
    // look identical here and a copy would silently become an in-place
    // rename, destroying the originals the user meant to keep.
    if (!statA.ino || !statB.ino) return false;
    return statA.dev === statB.dev && statA.ino === statB.ino;
  } catch {
    return false;
  }
}

async function canAccess(target, mode) {
  try {
    await fsp.access(target, mode);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves and validates the source folder.
 * @returns {Promise<{dir: string, explicit: boolean}>}
 */
export async function resolveSource(input, { cwd = process.cwd() } = {}) {
  const explicit = input !== undefined && input !== null && input !== '';
  const dir = resolvePath(explicit ? input : '.', cwd);

  let stats;
  try {
    stats = await fsp.stat(dir);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new PathError(`the folder "${dir}" does not exist.`, 'Check the path and try again.');
    }
    if (error.code === 'EACCES') {
      throw new PathError(`no permission to read "${dir}".`);
    }
    throw new PathError(`cannot read "${dir}": ${error.message}`);
  }

  if (!stats.isDirectory()) {
    throw new PathError(
      `"${dir}" is a file, not a folder.`,
      'Pass the folder that contains the files you want to rename.',
    );
  }

  if (!(await canAccess(dir, fs.constants.R_OK | fs.constants.X_OK))) {
    throw new PathError(`no permission to read "${dir}".`);
  }

  return { dir, explicit };
}

/**
 * Resolves and validates the destination folder.
 *
 * @param {string|undefined} input value of --output
 * @param {object} options
 * @returns {Promise<{dir: string|null, inPlace: boolean, exists: boolean, existingEntries: string[], mustCreate: boolean}>}
 */
export async function resolveDestination(input, { source, recursive = false, cwd = process.cwd() } = {}) {
  if (input === undefined || input === null || input === '') {
    return { dir: null, inPlace: true, exists: true, existingEntries: [], mustCreate: false };
  }

  const dir = resolvePath(input, cwd);

  // Destination equal to source is just an in-place rename, not a copy.
  if (dir === source || isSamePath(dir, source)) {
    return { dir: source, inPlace: true, exists: true, existingEntries: [], mustCreate: false };
  }

  if (recursive && isInside(dir, source)) {
    throw new PathError(
      `the destination "${dir}" is inside the source folder and --recursive is enabled.`,
      'The tool would keep processing its own output. Choose a destination outside the source folder.',
    );
  }

  let stats = null;
  try {
    stats = await fsp.stat(dir);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new PathError(`cannot read "${dir}": ${error.message}`);
    }
  }

  if (stats && !stats.isDirectory()) {
    throw new PathError(`the destination "${dir}" exists and is a file, not a folder.`);
  }

  if (!stats) {
    const parent = path.dirname(dir);
    if (!(await canAccess(parent, fs.constants.W_OK))) {
      throw new PathError(
        `cannot create "${dir}": no write permission on "${parent}".`,
      );
    }
    return { dir, inPlace: false, exists: false, existingEntries: [], mustCreate: true };
  }

  if (!(await canAccess(dir, fs.constants.W_OK))) {
    throw new PathError(`no write permission on the destination "${dir}".`);
  }

  const existingEntries = await fsp.readdir(dir);
  return { dir, inPlace: false, exists: true, existingEntries, mustCreate: false };
}

/** Creates the destination folder, recursively. */
export async function createDirectory(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

/** Checks that the process can write in `dir`. */
export async function assertWritable(dir) {
  if (!(await canAccess(dir, fs.constants.W_OK))) {
    throw new PathError(
      `no write permission on "${dir}".`,
      'Renaming requires write access to the folder that contains the files.',
    );
  }
}

/** True when both paths live on the same filesystem (so rename is instant). */
export async function isSameFilesystem(a, b) {
  try {
    const [statA, statB] = await Promise.all([fsp.stat(a), fsp.stat(b)]);
    return statA.dev === statB.dev;
  } catch {
    return false;
  }
}

/**
 * Free space available at `dir`, in bytes. Returns null when it cannot be
 * determined (older Node, unsupported filesystem).
 */
export async function freeSpace(dir) {
  if (typeof fsp.statfs !== 'function') return null;
  try {
    const stats = await fsp.statfs(dir);
    return Number(stats.bsize) * Number(stats.bavail);
  } catch {
    return null;
  }
}

/** Path shown to the user: relative when short, absolute otherwise. */
export function displayPath(target, base = process.cwd()) {
  const relative = path.relative(base, target);
  if (relative === '') return '.';
  if (!relative.startsWith('..') && relative.length < target.length) {
    return `.${path.sep}${relative}`;
  }
  const home = os.homedir();
  if (target.startsWith(home + path.sep)) return `~${target.slice(home.length)}`;
  return target;
}
