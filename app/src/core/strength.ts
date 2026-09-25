// Pattern-aware password strength estimate (zxcvbn-style, much smaller).
// Finds the cheapest way an attacker could describe the password — common passwords,
// dictionary words (incl. l33t), keyboard runs, sequences, repeats, years/dates — and
// charges brute-force cost only for what's left. Output is guess-entropy in bits.

import { WORDS } from "./wordlist";

// Most common passwords and base words (English + Polish), ordered roughly by frequency.
const COMMON = `123456 password 123456789 12345678 12345 qwerty 1234567 111111 123123 abc123 1234 password1 iloveyou
1q2w3e4r 000000 qwerty123 zaq12wsx dragon sunshine princess letmein 654321 monkey 27653 1qaz2wsx 123321 qwertyuiop
superman asdfghjkl trustno1 welcome admin passw0rd login master hello freedom whatever qazwsx 666666 555555 7777777
888888 121212 football baseball shadow michael jesus ninja mustang access starwars charlie batman secret summer winter
spring autumn flower soccer hockey killer pokemon cheese computer internet samsung google apple facebook liverpool
arsenal chelsea london poland polska haslo haslo1 kochanie misiek bartek kasia marcin mateusz agnieszka damian kacper
qwe123 asdfgh zxcvbnm asdf zxcv 1q2w3e marlena martyna natalia karolina magda monika zuzia zuzanna kamil kamila tomek
piotrek pawel krzysiek lukasz michal wojtek grzegorz dominik adrian patryk kubus kotek piesek myszka slonko skarbie
kocham polska1 legia lech wisla barcelona realmadrid manchester united love lovely angel baby family forever friends
jordan harley hunter ranger buster thomas robert daniel andrew joshua george jessica ashley amanda jennifer matthew
anthony william michelle nicole daniela sophie charlotte oliver jack harry jacob mother father sister brother
dog cat tiger lion bear eagle wolf dolphin horse orange banana cherry chocolate coffee pepper cookie sugar honey
money dollar euro pound bitcoin cash gold silver diamond king queen prince boss god devil heaven hell star moon sun
sky blue red green black white purple yellow pink silver secret1 test test123 testing guest user default changeme
temp temporary pass pass123 password123 password12 password2 abcd abcdef abcd1234 aaaaaa 11111111 00000000 999999
123qwe 1qazxsw2 q1w2e3r4 qwer1234 1234qwer asdf1234 iloveu iloveyou1 lovelove letmein1 welcome1 hello123 admin123
root toor pa55word p4ssword mypassword mypass private office work home house garden summer1 football1 monkey1`.split(/\s+/).filter(Boolean);

const KEYBOARD_ROWS = ["1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm", "qazwsxedcrfvtgbyhnujmikolp", "1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p", "zaq12wsxcde3", "0987654321", "poiuytrewq", "lkjhgfdsa", "mnbvcxz"];

type Dict = Map<string, number>; // word -> bits
let DICT: Dict | null = null;
function dict(): Dict {
  if (DICT) return DICT;
  const d: Dict = new Map();
  COMMON.forEach((w, i) => d.set(w, Math.log2(i + 2)));
  const eff = Math.log2(WORDS.length);
  for (const w of WORDS) if (w.length >= 3 && !d.has(w)) d.set(w, eff);
  DICT = d;
  return d;
}

const LEET: Record<string, string> = { "0": "o", "1": "i", "!": "i", "3": "e", "4": "a", "@": "a", "5": "s", "$": "s", "7": "t", "+": "t", "8": "b", "9": "g", "|": "l" };
const deleet = (s: string) => s.replace(/[0134@5$7+89!|]/g, c => LEET[c] ?? c);

function charBits(c: string): number {
  if (/[a-z]/.test(c)) return Math.log2(26);
  if (/[A-Z]/.test(c)) return Math.log2(26) + 0.5;
  if (/[0-9]/.test(c)) return Math.log2(10);
  if (c === " ") return Math.log2(33);
  return Math.log2(33);
}

interface Match { start: number; end: number; bits: number; kind: string }

function findMatches(pw: string, userWords: Dict): Match[] {
  const out: Match[] = [];
  const lower = pw.toLowerCase();
  const d = dict();
  const n = pw.length;
  // dictionary + user-supplied words, plain and l33t
  for (let i = 0; i < n; i++) {
    for (let j = i + 3; j <= Math.min(n, i + 24); j++) {
      const sub = lower.slice(i, j);
      const raw = pw.slice(i, j);
      const caps = raw !== sub ? (raw === sub[0].toUpperCase() + sub.slice(1) || raw === sub.toUpperCase() ? 1 : Math.min(j - i, 3)) : 0;
      const hit = userWords.get(sub) ?? d.get(sub);
      if (hit != null) out.push({ start: i, end: j, bits: hit + caps, kind: "dictionary" });
      const dl = deleet(sub);
      if (dl !== sub) {
        const h2 = userWords.get(dl) ?? d.get(dl);
        if (h2 != null) out.push({ start: i, end: j, bits: h2 + caps + 1, kind: "dictionary" });
      }
    }
  }
  // keyboard runs and alphabetic/numeric sequences (either direction), length >= 3
  const runs = [...KEYBOARD_ROWS, "abcdefghijklmnopqrstuvwxyz", "zyxwvutsrqponmlkjihgfedcba"];
  for (let i = 0; i < n; i++) {
    for (let j = i + 3; j <= n; j++) {
      const sub = lower.slice(i, j);
      if (runs.some(r => r.includes(sub))) out.push({ start: i, end: j, bits: Math.log2(runs.length * 26) + Math.log2(j - i), kind: "sequence" });
      else break;
    }
  }
  // repeats: same char or repeated chunk
  for (let i = 0; i < n; i++) {
    let j = i + 1;
    while (j < n && pw[j] === pw[i]) j++;
    if (j - i >= 3) out.push({ start: i, end: j, bits: charBits(pw[i]) + Math.log2(j - i), kind: "repeat" });
    for (let len = 2; len <= 6 && i + len * 2 <= n; len++) {
      const chunk = pw.slice(i, i + len);
      let k = i + len;
      while (pw.slice(k, k + len) === chunk) k += len;
      if (k - i >= len * 2) out.push({ start: i, end: k, bits: len * 4 + Math.log2((k - i) / len), kind: "repeat" });
    }
  }
  // years 1900-2039 and dd/mm style dates
  for (const m of pw.matchAll(/(19\d\d|20[0-3]\d)/g)) out.push({ start: m.index!, end: m.index! + 4, bits: Math.log2(140), kind: "year" });
  for (const m of pw.matchAll(/(\d{1,2})[./-]?(\d{1,2})[./-]?(\d{2}|\d{4})/g)) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if ((a >= 1 && a <= 31 && b >= 1 && b <= 12) || (a >= 1 && a <= 12 && b >= 1 && b <= 31)) out.push({ start: m.index!, end: m.index! + m[0].length, bits: Math.log2(365 * 100), kind: "date" });
  }
  return out;
}

export interface Strength { bits: number; score: 0 | 1 | 2 | 3 | 4; label: string; warning: string }

export const STRENGTH_LABELS = ["Very weak", "Weak", "Fair", "Good", "Strong"] as const;

export function estimate(password: string, userInputs: string[] = []): Strength {
  if (!password) return { bits: 0, score: 0, label: "", warning: "" };
  const user: Dict = new Map();
  for (const u of userInputs) for (const part of u.toLowerCase().split(/[^a-z0-9ąćęłńóśźż]+/)) if (part.length >= 3) user.set(part, 1);
  const matches = findMatches(password, user);
  const n = password.length;
  // DP: best[i] = cheapest description of password[0..i)
  const best = new Array<number>(n + 1).fill(Infinity);
  const segs = new Array<number>(n + 1).fill(0);
  const via = new Array<string>(n + 1).fill("");
  best[0] = 0;
  const byEnd = new Map<number, Match[]>();
  for (const m of matches) { const l = byEnd.get(m.end) ?? []; l.push(m); byEnd.set(m.end, l); }
  for (let i = 1; i <= n; i++) {
    const brute = best[i - 1] + charBits(password[i - 1]);
    best[i] = brute; segs[i] = segs[i - 1] + (via[i - 1] === "brute" ? 0 : 1); via[i] = "brute";
    for (const m of byEnd.get(i) ?? []) {
      const c = best[m.start] + m.bits;
      if (c < best[i]) { best[i] = c; segs[i] = segs[m.start] + 1; via[i] = m.kind; }
    }
  }
  const bits = Math.max(0, best[n] + Math.log2(Math.max(1, segs[n])));
  const score = (bits < 28 ? 0 : bits < 36 ? 1 : bits < 50 ? 2 : bits < 64 ? 3 : 4) as Strength["score"];
  const kinds = new Set(matches.filter(m => m.end - m.start >= Math.min(4, n)).map(m => m.kind));
  let warning = "";
  if (score <= 2) {
    if (COMMON.includes(password.toLowerCase().replace(/[^a-z0-9]/g, "")) || COMMON.includes(deleet(password.toLowerCase()))) warning = "This is one of the most common passwords.";
    else if (kinds.has("dictionary")) warning = "Common words and names are easy to guess, even with numbers or symbols added.";
    else if (kinds.has("sequence")) warning = "Keyboard patterns and sequences like 1234 or qwerty are easy to guess.";
    else if (kinds.has("repeat")) warning = "Repeated characters add little strength.";
    else if (kinds.has("year") || kinds.has("date")) warning = "Dates and years are easy to guess.";
    else if (n < 12) warning = "Use at least 12 characters, or a few random words.";
  }
  return { bits: Math.round(bits), score, label: STRENGTH_LABELS[score], warning };
}

/** Master password floor: roughly 2^45 guesses × 600k PBKDF2 rounds each. */
export const MASTER_MIN_BITS = 45;
