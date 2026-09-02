/**
 * Applies the plan: rename in place, copy to another folder or move.
 * Everything is applied or nothing is: on failure the already applied
 * operations are rolled back before reporting the error.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { LOG_FILENAME, TEMP_PREFIX } from './collect.js';

export const MODES = { RENAME: 'rename', COPY: 'copy', MOVE: 'move' };

export class ApplyError extends Error {
  constructor(message, { rolledBack = false, cause } = {}) {
    super(message);
    this.name = 'ApplyError';
    this.rolledBack = rolledBack;
    this.cause = cause;
  }
}

function temporaryPath(target) {
  return path.join(path.dirname(target), `${TEMP_PREFIX}${randomUUID()}`);
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function copyFile(from, to, force) {
  await ensureDir(path.dirname(to));
  const flags = force ? 0 : fs.constants.COPYFILE_EXCL;
  await fsp.copyFile(from, to, flags);
  // Keep the original timestamps so date based sorting still makes sense.
  try {
    const stats = await fsp.stat(from);
    await fsp.utimes(to, stats.atime, stats.mtime);
  } catch {
    // Timestamps are a nicety, never a reason to fail the operation.
  }
}

/**
 * @param {Array} operations
 * @param {object} options
 * @param {'rename'|'copy'|'move'} options.mode
 * @param {boolean} [options.needsTwoPhase]
 * @param {boolean} [options.force]
 * @param {boolean} [options.sameFilesystem] only relevant for move
 * @param {(op: object, done: number, total: number) => void} [options.onProgress]
 * @returns {Promise<{applied: Array<{from: string, to: string}>}>}
 */
export async function applyPlan(operations, options) {
  const {
    mode,
    needsTwoPhase = false,
    force = false,
    sameFilesystem = true,
    onProgress,
  } = options;

  const pending = operations.filter((op) => !op.unchanged);
  const applied = [];
  /** Undo steps in reverse order, run when something fails halfway. */
  const rollback = [];

  const progress = (op) => {
    if (onProgress) onProgress(op, applied.length, pending.length);
  };

  try {
    if (mode === MODES.RENAME && needsTwoPhase) {
      // Swaps and rotations (a -> b, b -> a) need temporary names.
      const staged = [];
      for (const op of pending) {
        const temp = temporaryPath(op.to);
        await fsp.rename(op.from, temp);
        rollback.push(() => fsp.rename(temp, op.from));
        staged.push({ op, temp });
      }
      for (const { op, temp } of staged) {
        await ensureDir(path.dirname(op.to));
        await fsp.rename(temp, op.to);
        rollback.push(() => fsp.rename(op.to, temp));
        applied.push({ from: op.from, to: op.to });
        progress(op);
      }
      return { applied };
    }

    for (const op of pending) {
      if (mode === MODES.RENAME) {
        await ensureDir(path.dirname(op.to));
        if (!force) await assertMissing(op.to);
        await fsp.rename(op.from, op.to);
        rollback.push(() => fsp.rename(op.to, op.from));
      } else if (mode === MODES.COPY) {
        await copyFile(op.from, op.to, force);
        rollback.push(() => fsp.rm(op.to, { force: true }));
      } else if (mode === MODES.MOVE) {
        await ensureDir(path.dirname(op.to));
        if (!force) await assertMissing(op.to);
        if (sameFilesystem) {
          await fsp.rename(op.from, op.to);
          rollback.push(() => fsp.rename(op.to, op.from));
        } else {
          await copyFile(op.from, op.to, force);
          await fsp.unlink(op.from);
          rollback.push(async () => {
            await copyFile(op.to, op.from, true);
            await fsp.rm(op.to, { force: true });
          });
        }
      } else {
        throw new Error(`unknown mode: ${mode}`);
      }

      applied.push({ from: op.from, to: op.to });
      progress(op);
    }

    return { applied };
  } catch (error) {
    let rolledBack = true;
    for (const step of rollback.reverse()) {
      try {
        await step();
      } catch {
        rolledBack = false;
      }
    }
    throw new ApplyError(error.message, { rolledBack, cause: error });
  }
}

async function assertMissing(target) {
  try {
    await fsp.access(target);
  } catch {
    return;
  }
  throw new Error(`"${path.basename(target)}" already exists`);
}

/**
 * Writes the undo log. In copy mode it lives in the destination folder, which
 * is where the created files are; otherwise in the source folder.
 */
export async function writeLog(directory, data) {
  const target = path.join(directory, LOG_FILENAME);
  const payload = {
    version: 1,
    timestamp: new Date().toISOString(),
    ...data,
  };
  await fsp.writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return target;
}

/** Folder where the undo log must be written for a given mode. */
export function logDirectory({ mode, source, destination }) {
  return mode === MODES.COPY && destination ? destination : source;
}
