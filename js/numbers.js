// numbers.js — turn whatever the speech recognizer (or keypad) gives us into an integer.
//
// The Web Speech API is wildly inconsistent for spoken numbers from kids: it may
// return "54", "fifty four", "fifty-four", or a mishear like "for" (four) or
// "to" (two). This module normalizes all of that into a single integer so the
// drill can compare against the expected answer. Range we care about: 0..144 (12×12).

const ONES = {
  zero: 0, oh: 0, o: 0, nil: 0,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};

const TENS = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

// Common recognizer mishears for a young voice. Conservative on purpose — we only
// map words that are almost never anything else in a "say a number" context.
// This only affects AUTO-ACCEPT: a heard word is taken as a number only when it
// equals the expected answer, so extra mappings can't cause a wrong answer to be
// marked wrong — they just rescue more correct answers. Safe to be generous.
const HOMOPHONES = {
  zero: 'zero', hero: 'zero', ziro: 'zero',
  one: 'one', won: 'one', wan: 'one', juan: 'one',
  two: 'two', to: 'two', too: 'two', tu: 'two', dew: 'two', do: 'two',
  three: 'three', free: 'three', tree: 'three', thee: 'three', thri: 'three',
  four: 'four', for: 'four', fore: 'four', thor: 'four', faux: 'four', floor: 'four', far: 'four',
  five: 'five', fife: 'five', hive: 'five', v: 'five',
  six: 'six', sex: 'six', sicks: 'six', sick: 'six', sics: 'six',
  seven: 'seven',
  eight: 'eight', ate: 'eight', hate: 'eight', ait: 'eight',
  nine: 'nine', nein: 'nine', nighn: 'nine', night: 'nine',
  ten: 'ten', tan: 'ten', tin: 'ten', den: 'ten',
  eleven: 'eleven',
  twelve: 'twelve', twelfth: 'twelve', shelve: 'twelve',
  fiddy: 'fifty', fifty: 'fifty',
  thirdy: 'thirty', thirty: 'thirty',
  thirdteen: 'thirteen', thirteen: 'thirteen',
  fourty: 'forty', forty: 'forty',
};

/**
 * Parse a spoken/typed string into the first plausible integer it contains.
 * Returns a Number, or null if nothing number-like is found.
 */
export function parseNumber(raw) {
  if (raw == null) return null;
  let text = String(raw).toLowerCase().trim();
  if (!text) return null;

  // Normalize separators and filler words.
  text = text
    .replace(/[-–—]/g, ' ')      // fifty-four -> fifty four
    .replace(/[.,!?]/g, ' ')
    .replace(/\band\b/g, ' ')     // "one hundred and four"
    .replace(/\s+/g, ' ')
    .trim();

  // Fast path: a bare digit run anywhere ("the answer is 54").
  const digit = text.match(/\d{1,3}/);
  if (digit) {
    const n = parseInt(digit[0], 10);
    if (!Number.isNaN(n)) return n;
  }

  // Word path: walk tokens accumulating a numeric value.
  const tokens = text.split(' ').map((t) => HOMOPHONES[t] || t);

  let total = null;     // committed value
  let current = null;   // value being assembled
  let sawNumberWord = false;

  for (const tok of tokens) {
    if (tok in ONES) {
      current = (current || 0) + ONES[tok];
      sawNumberWord = true;
    } else if (tok in TENS) {
      current = (current || 0) + TENS[tok];
      sawNumberWord = true;
    } else if (tok === 'hundred' || tok === 'hundreds') {
      current = (current || 1) * 100;
      sawNumberWord = true;
    } else if (sawNumberWord && current !== null) {
      // Non-number token ends the current run.
      total = (total || 0) + current;
      current = null;
      // keep scanning in case a digit appears later, but we already have a value
      break;
    }
  }
  if (current !== null) total = (total || 0) + current;

  return sawNumberWord ? total : null;
}

/**
 * Given a recognizer transcript, return every distinct candidate integer found,
 * best-guess first. Useful because the recognizer often returns a phrase like
 * "is it fifty four" where only one token sequence is the real answer.
 */
export function extractCandidates(raw) {
  const out = [];
  const seen = new Set();
  const push = (n) => {
    if (n !== null && !seen.has(n)) { seen.add(n); out.push(n); }
  };

  const text = String(raw || '').toLowerCase();

  // Whole-string parse first (handles "fifty four" → 54).
  push(parseNumber(text));

  // Then each standalone digit run.
  for (const m of text.matchAll(/\d{1,3}/g)) push(parseInt(m[0], 10));

  // Only if nothing parsed yet, fall back to word-by-word (catches a lone number
  // buried in filler). We deliberately DON'T decompose a compound that already
  // parsed — otherwise "twenty four" would also yield 20 and 4, which causes
  // false matches against the current or the next question.
  if (out.length === 0) {
    for (const word of text.split(/\s+/)) push(parseNumber(word));
  }

  return out;
}
