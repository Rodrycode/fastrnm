/**
 * Reading and filtering the files of the source folder.
 * Directories are never renamed: only regular files are collected.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

export const LOG_FILENAME = '.fastrnm-log.json';

/** Prefix of the temporary names used while applying a two-phase rename. */
export const TEMP_PREFIX = '.fastrnm-tmp-';

/** True for the files fastrnm creates for itself, which it never renames. */
export function isOwnFile(name) {
  return name === LOG_FILENAME || name.startsWith(TEMP_PREFIX);
}

/** Compound extensions that must be kept whole (`archive.tar.gz`). */
const COMPOUND_STEMS = new Set(['tar']);

/**
 * Splits a filename into stem and extension, keeping compound extensions
 * such as `.tar.gz` together. A leading dot (hidden file) is never treated as
 * the start of an extension.
 * @returns {{stem: string, ext: string}}
 */
export function splitName(filename) {
  const leadingDots = filename.match(/^\.+/)?.[0] ?? '';
  const rest = filename.slice(leadingDots.length);
  const dot = rest.lastIndexOf('.');
  if (dot <= 0) return { stem: filename, ext: '' };

  let stem = rest.slice(0, dot);
  let ext = rest.slice(dot);

  const secondDot = stem.lastIndexOf('.');
  if (secondDot > 0 && COMPOUND_STEMS.has(stem.slice(secondDot + 1).toLowerCase())) {
    ext = stem.slice(secondDot) + ext;
    stem = stem.slice(0, secondDot);
  }

  return { stem: leadingDots + stem, ext };
}

/** Normalizes a user supplied extension list into lowercase, dot-less values. */
export function parseExtensions(value) {
  if (!value) return null;
  const list = String(value)
    .split(',')
    .map((item) => item.trim().replace(/^\./, '').toLowerCase())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

/** Converts a glob pattern into a regular expression. */
export function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '*') {
      out += '.*';
    } else if (char === '?') {
      out += '.';
    } else if ('\\^$.|+()[]{}'.includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return new RegExp(`^${out}$`, 'i');
}

/**
 * Builds a matcher from a pattern. `/.../flags` is treated as a regular
 * expression, anything else as a glob.
 */
export function buildMatcher(pattern) {
  if (!pattern) return null;
  const asRegex = String(pattern).match(/^\/(.*)\/([a-z]*)$/);
  if (asRegex) return new RegExp(asRegex[1], asRegex[2]);
  return globToRegExp(pattern);
}

function matchesExtension(ext, allowed) {
  if (!allowed) return true;
  const normalized = ext.replace(/^\./, '').toLowerCase();
  if (allowed.includes(normalized)) return true;
  // `--ext gz` should also match `.tar.gz`.
  const last = normalized.split('.').pop();
  return allowed.includes(last);
}

/**
 * Collects the candidate files.
 *
 * @param {string} dir absolute source folder
 * @param {object} options
 * @param {boolean} [options.recursive]
 * @param {boolean} [options.includeHidden]
 * @param {string[]|null} [options.extensions]
 * @param {RegExp|null} [options.match]
 * @param {RegExp|null} [options.exclude]
 * @param {string[]} [options.skipDirs] absolute directories to skip
 * @returns {Promise<{files: Array, skipped: {symlinks: number, hidden: number, extension: number, match: number, exclude: number, directories: number}}>}
 *   `skipped` counts what was left out and why, so an empty result can say
 *   something more useful than "the folder is empty".
 */
export async function collectFiles(dir, options = {}) {
  const {
    recursive = false,
    includeHidden = false,
    extensions = null,
    match = null,
    exclude = null,
    skipDirs = [],
  } = options;

  const skip = new Set(skipDirs.map((item) => path.resolve(item)));
  const files = [];
  const skipped = {
    symlinks: 0,
    hidden: 0,
    extension: 0,
    match: 0,
    exclude: 0,
    directories: 0,
  };

  async function walk(current) {
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'EACCES') return;
      throw error;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const hidden = entry.name.startsWith('.');

      if (entry.isDirectory()) {
        // Checked before counting: suggesting --recursive for a folder that
        // --recursive would skip anyway is worse than saying nothing.
        if (skip.has(path.resolve(full))) continue;
        if (hidden && !includeHidden) {
          skipped.hidden += 1;
          continue;
        }
        if (!recursive) {
          skipped.directories += 1;
          continue;
        }
        await walk(full);
        continue;
      }

      if (!entry.isFile()) {
        // Symbolic links, sockets and devices: renaming them is not what the
        // user meant, but silently dropping them is how afternoons get lost.
        if (entry.isSymbolicLink()) skipped.symlinks += 1;
        continue;
      }
      // Never sweep our own files into a batch: a leftover temporary from a
      // killed run still holds the user's data, and --include-hidden would
      // otherwise rename it to something meaningless.
      if (isOwnFile(entry.name)) continue;
      if (hidden && !includeHidden) {
        skipped.hidden += 1;
        continue;
      }
      if (match && !match.test(entry.name)) {
        skipped.match += 1;
        continue;
      }
      if (exclude && exclude.test(entry.name)) {
        skipped.exclude += 1;
        continue;
      }

      const { stem, ext } = splitName(entry.name);
      if (!matchesExtension(ext, extensions)) {
        skipped.extension += 1;
        continue;
      }

      let stats;
      try {
        stats = await fsp.stat(full);
      } catch {
        continue;
      }

      files.push({
        path: full,
        dir: current,
        relativeDir: path.relative(dir, current),
        name: entry.name,
        stem,
        ext,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        birthtimeMs: stats.birthtimeMs,
      });
    }
  }

  await walk(dir);
  return { files, skipped };
}

/** Human readable account of what was left out, or null when nothing was. */
export function describeSkipped(skipped) {
  const reasons = [];
  if (skipped.symlinks) {
    reasons.push(`${skipped.symlinks} symbolic link${skipped.symlinks === 1 ? '' : 's'}`);
  }
  if (skipped.hidden) reasons.push(`${skipped.hidden} hidden (use --include-hidden)`);
  if (skipped.extension) reasons.push(`${skipped.extension} not matching --ext`);
  if (skipped.match) reasons.push(`${skipped.match} not matching --match`);
  if (skipped.exclude) reasons.push(`${skipped.exclude} excluded by --exclude`);
  if (skipped.directories) {
    reasons.push(`${skipped.directories} subfolder${skipped.directories === 1 ? '' : 's'} (use --recursive)`);
  }
  return reasons.length > 0 ? reasons.join(', ') : null;
}
