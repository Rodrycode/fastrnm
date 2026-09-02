/**
 * Sorting strategies for the collected files.
 *
 * Natural order is the default because the filesystem order puts `file10`
 * before `file2`, which produces meaningless numbering.
 */

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Natural comparison: `file2` comes before `file10`. */
export function naturalCompare(a, b) {
  return collator.compare(String(a), String(b));
}

export const SORT_MODES = ['name', 'date', 'created', 'exif', 'size'];

const COMPARATORS = {
  name: (a, b) => naturalCompare(a.name, b.name),
  date: (a, b) => a.mtimeMs - b.mtimeMs,
  // Files with no capture date fall back to their modification date, so a
  // folder that mixes photos and other files still sorts sensibly.
  exif: (a, b) => (a.exifMs ?? a.mtimeMs) - (b.exifMs ?? b.mtimeMs),
  // Not every filesystem records a creation date; where it is missing Node
  // reports zero, and the modification date is the closest honest answer.
  created: (a, b) => (a.birthtimeMs || a.mtimeMs) - (b.birthtimeMs || b.mtimeMs),
  size: (a, b) => a.size - b.size,
};

/**
 * Returns a new array sorted according to `mode`.
 * Files are always grouped by folder first, so recursive runs stay readable.
 * Ties fall back to natural order by name for a stable, predictable result.
 */
export function sortFiles(files, { sort = 'name', reverse = false } = {}) {
  const comparator = COMPARATORS[sort];
  if (!comparator) throw new Error(`unknown sort mode: ${sort}`);

  const sorted = [...files].sort((a, b) => {
    const byDir = naturalCompare(a.relativeDir, b.relativeDir);
    if (byDir !== 0) return byDir;
    const primary = comparator(a, b);
    if (primary !== 0) return primary;
    return naturalCompare(a.name, b.name);
  });

  if (reverse) {
    // Reverse inside each folder group, not across groups.
    const groups = new Map();
    for (const file of sorted) {
      if (!groups.has(file.relativeDir)) groups.set(file.relativeDir, []);
      groups.get(file.relativeDir).push(file);
    }
    return [...groups.values()].flatMap((group) => group.reverse());
  }

  return sorted;
}

/**
 * Applies a manual order given as a list of 1-based positions, the way
 * --interactive collects it. Positions the user did not mention keep their
 * relative order at the end, and repeats are ignored.
 *
 * @param {Array} files
 * @param {string} answer raw input, e.g. "3,1,2" or "3 1 2"
 * @returns {Array} the reordered files
 * @throws {RangeError} when a position is not a number within range
 */
export function applyManualOrder(files, answer) {
  const text = String(answer).trim();
  if (text === '') return [...files];

  const wanted = text
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((item) => Number.parseInt(item, 10));

  if (wanted.some((n) => !Number.isInteger(n) || n < 1 || n > files.length)) {
    throw new RangeError(`the order must only contain numbers between 1 and ${files.length}.`);
  }

  const seen = new Set();
  const reordered = [];
  for (const position of wanted) {
    if (seen.has(position)) continue;
    seen.add(position);
    reordered.push(files[position - 1]);
  }
  for (const [index, file] of files.entries()) {
    if (!seen.has(index + 1)) reordered.push(file);
  }
  return reordered;
}
