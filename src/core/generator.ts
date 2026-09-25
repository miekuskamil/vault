// Password and passphrase generation with unbiased randomness.

import { randomInt } from "./bytes";
import { WORDS } from "./wordlist";

export interface PasswordOptions { length: number; upper: boolean; lower: boolean; digits: boolean; symbols: boolean }
export interface PassphraseOptions { words: number; separator: string; capitalize: boolean; addNumber: boolean }

// Ambiguous characters (I, l, O, 0, 1) left out so passwords can be read off a screen.
const SETS = {
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  lower: "abcdefghijkmnpqrstuvwxyz",
  digits: "23456789",
  symbols: "!@#$%^&*-_=+?",
};

export const DEFAULT_PASSWORD: PasswordOptions = { length: 20, upper: true, lower: true, digits: true, symbols: true };
export const DEFAULT_PASSPHRASE: PassphraseOptions = { words: 5, separator: "-", capitalize: true, addNumber: true };

function pick(s: string): string { return s[randomInt(s.length)]; }

export function generatePassword(opts: PasswordOptions = DEFAULT_PASSWORD): string {
  const chosen = (Object.keys(SETS) as (keyof typeof SETS)[]).filter(k => opts[k]);
  const sets = chosen.length ? chosen.map(k => SETS[k]) : [SETS.lower, SETS.digits];
  const length = Math.max(Math.min(Math.round(opts.length), 128), sets.length, 4);
  const all = sets.join("");
  const chars = sets.map(pick); // at least one from every chosen set
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) { const j = randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join("");
}

export function generatePassphrase(opts: PassphraseOptions = DEFAULT_PASSPHRASE): string {
  const n = Math.max(3, Math.min(Math.round(opts.words), 12));
  const words = Array.from({ length: n }, () => WORDS[randomInt(WORDS.length)]).map(w => (opts.capitalize ? w[0].toUpperCase() + w.slice(1) : w));
  if (opts.addNumber) { const i = randomInt(n); words[i] = words[i] + randomInt(10); }
  return words.join(opts.separator);
}

/** Entropy of the generator's output (not the estimator's view). */
export function passwordEntropy(opts: PasswordOptions): number {
  const size = (Object.keys(SETS) as (keyof typeof SETS)[]).filter(k => opts[k]).reduce((s, k) => s + SETS[k].length, 0) || SETS.lower.length + SETS.digits.length;
  return Math.round(opts.length * Math.log2(size));
}
export function passphraseEntropy(opts: PassphraseOptions): number {
  return Math.round(opts.words * Math.log2(WORDS.length) + (opts.addNumber ? Math.log2(10 * opts.words) : 0));
}
