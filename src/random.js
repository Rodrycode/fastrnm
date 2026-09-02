/**
 * Random name tokens.
 *
 * The alphabet is lowercase on purpose: macOS and Windows compare filenames
 * without case, so a mixed case alphabet would let `aB3k` and `Ab3K` count as
 * the same name and abort an otherwise valid run -- at random, and only on
 * those platforms. Digits and lowercase letters keep every generated name
 * unambiguous everywhere.
 */

import { randomInt } from 'node:crypto';

export const DEFAULT_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
export const DEFAULT_TOKEN_LENGTH = 8;
export const MAX_TOKEN_LENGTH = 64;

/** How many distinct tokens a given length can produce. */
export function tokenSpace(length, alphabet = DEFAULT_ALPHABET) {
  return alphabet.length ** length;
}

/**
 * True when `length` leaves enough room to name `count` files comfortably.
 * The margin matters: as the space fills up, random generation spends most of
 * its time hitting names it has already used.
 */
export function fitsBatch(count, length, alphabet = DEFAULT_ALPHABET) {
  return tokenSpace(length, alphabet) >= count * 10;
}

/** Shortest length that can name `count` files comfortably. */
export function suggestLength(count, alphabet = DEFAULT_ALPHABET) {
  for (let length = 1; length <= MAX_TOKEN_LENGTH; length += 1) {
    if (fitsBatch(count, length, alphabet)) return length;
  }
  return MAX_TOKEN_LENGTH;
}

/**
 * Builds a generator of unique random tokens. Uniqueness is enforced rather
 * than left to probability: a batch that aborts once every few hundred runs
 * because two names happened to match would be worse than no feature at all.
 *
 * @param {object} [options]
 * @param {number} [options.length]
 * @param {string} [options.alphabet]
 * @param {(max: number) => number} [options.random] injectable for tests
 * @returns {() => string}
 */
export function createTokenGenerator({
  length = DEFAULT_TOKEN_LENGTH,
  alphabet = DEFAULT_ALPHABET,
  random = (max) => randomInt(max),
} = {}) {
  const used = new Set();

  return function nextToken() {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      let token = '';
      for (let index = 0; index < length; index += 1) {
        token += alphabet[random(alphabet.length)];
      }
      if (used.has(token)) continue;
      used.add(token);
      return token;
    }
    throw new Error(
      `could not generate a unique name of ${length} character(s) after 1000 attempts`,
    );
  };
}
