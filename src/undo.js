/**
 * Undo support: reads the log written by the last run and reverts it.
 * Only the last run is kept -- a full history is not worth the complexity for
 * this use case.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { LOG_FILENAME } from './collect.js';
import { MODES } from './apply.js';

export class UndoError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'UndoError';
    this.hint = hint;
  }
}

export function logPath(directory) {
  return path.join(directory, LOG_FILENAME);
}

/** Reads and validates the undo log of a folder. */
export async function readLog(directory) {
  const target = logPath(directory);
  let raw;
  try {
    raw = await fsp.readFile(target, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new UndoError(
        `no rename log found in "${directory}".`,
        'Undo only works right after a run made by this tool. In copy mode the log lives in the destination folder; in move mode, in the source folder.',
      );
    }
    throw new UndoError(`cannot read the log: ${error.message}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new UndoError(`the log in "${directory}" is corrupted and cannot be read.`);
  }

  if (!Array.isArray(data.operations) || data.operations.length === 0) {
    throw new UndoError(`the log in "${directory}" contains no operations.`);
  }

  return data;
}

async function exists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks the state of every logged operation before reverting anything.
 * @returns {Promise<{ready: Array, skipped: Array<{operation: object, reason: string}>}>}
 */
export async function inspectLog(log) {
  const ready = [];
  const skipped = [];

  for (const operation of log.operations) {
    if (!(await exists(operation.to))) {
      skipped.push({ operation, reason: 'the renamed file no longer exists' });
      continue;
    }
    if (log.mode !== MODES.COPY && (await exists(operation.from))) {
      skipped.push({ operation, reason: 'the original name is taken again' });
      continue;
    }
    ready.push(operation);
  }

  return { ready, skipped };
}

/**
 * Reverts the given operations.
 * - in place: renames back
 * - copy: deletes the copies (the originals were never touched)
 * - move: moves the files back to the source folder
 * @returns {Promise<{reverted: Array, failed: Array<{operation: object, reason: string}>}>}
 */
export async function revert(operations, { mode }) {
  const reverted = [];
  const failed = [];

  for (const operation of [...operations].reverse()) {
    try {
      if (mode === MODES.COPY) {
        await fsp.rm(operation.to, { force: true });
      } else {
        await fsp.mkdir(path.dirname(operation.from), { recursive: true });
        await fsp.rename(operation.to, operation.from);
      }
      reverted.push(operation);
    } catch (error) {
      failed.push({ operation, reason: error.message });
    }
  }

  return { reverted, failed };
}

/**
 * Summary of a previous run that has not been undone yet, or null when there
 * is nothing left to lose: no log, an unreadable one, or one whose files are
 * no longer where it says they are.
 *
 * Applying a new run overwrites the log, so this is what makes that loss
 * visible before it happens instead of after.
 */
export async function pendingUndo(directory) {
  let log;
  try {
    log = await readLog(directory);
  } catch {
    return null;
  }

  const { ready } = await inspectLog(log);
  if (ready.length === 0) return null;

  return {
    timestamp: log.timestamp,
    mode: log.mode,
    count: ready.length,
    samples: ready.slice(0, 3).map((operation) => path.basename(operation.from)),
  };
}

/** Removes the log once it has been fully applied. */
export async function removeLog(directory) {
  await fsp.rm(logPath(directory), { force: true });
}
