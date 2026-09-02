/**
 * Collision detection. Runs before touching anything: either the whole batch
 * is applied or nothing is. Partial renames are never acceptable.
 */

import { isReservedName } from './validate.js';

const CASE_INSENSITIVE_DEFAULT = process.platform === 'darwin' || process.platform === 'win32';

/**
 * @param {Array} operations plan operations
 * @param {object} options
 * @param {Set<string>} [options.existing] absolute paths that already exist on disk
 * @param {boolean} [options.force] allow overwriting existing files
 * @param {boolean} [options.caseInsensitive]
 * @returns {{errors: Map<number, string>, conflicts: number, needsTwoPhase: boolean}}
 */
export function detectCollisions(operations, options = {}) {
  const {
    existing = new Set(),
    force = false,
    caseInsensitive = CASE_INSENSITIVE_DEFAULT,
  } = options;

  const errors = new Map();
  const sources = new Set(operations.map((op) => op.from));
  const byTarget = new Map();

  const key = (value) => (caseInsensitive ? value.toLowerCase() : value);

  // 1. Two files of the batch resolving to the same target.
  for (const op of operations) {
    const targetKey = key(op.to);
    if (!byTarget.has(targetKey)) byTarget.set(targetKey, []);
    byTarget.get(targetKey).push(op);
  }

  for (const group of byTarget.values()) {
    if (group.length < 2) continue;
    for (const op of group) {
      errors.set(op.index, `duplicate target "${op.toName}"`);
    }
  }

  let needsTwoPhase = false;

  for (const op of operations) {
    if (op.unchanged) continue;

    // 2. The target is the current name of another file of the batch: this is
    //    a swap or a rotation, solvable with a two phase rename.
    if (sources.has(op.to)) {
      needsTwoPhase = true;
      continue;
    }

    // 3. The target already exists on disk and is not part of the batch.
    if (existing.has(op.to) && !errors.has(op.index)) {
      if (!force) errors.set(op.index, 'already exists');
    }

    // 4. The generated name itself is unusable.
    if (!errors.has(op.index) && isReservedName(op.toName)) {
      errors.set(op.index, `"${op.toName}" is a reserved system name`);
    }
  }

  return { errors, conflicts: errors.size, needsTwoPhase };
}
