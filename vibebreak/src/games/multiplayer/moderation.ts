/**
 * Minimal, local, transparent moderation for player text.
 *
 * - Slurs are always masked and make a custom prompt pack entry invalid.
 * - Common profanity is masked only when the host keeps the family filter on.
 *
 * Word lists cannot catch everything; the host also has a veto key that
 * removes any answer from voting. Matching works on a "folded" copy of each
 * word (lower case, common leetspeak undone, punctuation removed, stretched
 * letters collapsed) so "f.u.c.k" or "sh1t" are caught. Short or ambiguous
 * terms only match whole words (plus plural/verb endings) to avoid the
 * Scunthorpe problem ("spicy", "cockpit", "fire retardant" stay clean).
 */

interface WordList {
  /** Matched anywhere inside a word. */
  sub: string[];
  /** Matched as the whole word, optionally with a common suffix; "=word" allows only a plural "s". */
  word: string[];
}

const SLURS: WordList = {
  sub: ['nigger', 'nigga', 'faggot'],
  word: ['=fag', 'retard', 'tranny', '=kike', '=chink', '=spic', 'wetback', 'raghead', '=gook', '=dyke'],
};
const PROFANITY: WordList = {
  sub: ['fuck', 'shit', 'motherfuck'],
  word: ['bitch', 'cunt', 'asshole', 'bastard', '=dick', '=cock', 'pussy', 'whore', 'slut', 'wank', 'twat', 'bollocks', '=prick'],
};

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '!': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's', '7': 't', '+': 't' };
const SUFFIX = /^(s|es|ed|er|ers|ing)?$/;

function fold(word: string): string {
  let out = '';
  for (const ch of word.toLowerCase()) {
    const c = LEET[ch] ?? ch;
    if (/[a-z]/.test(c)) out += c;
  }
  return out;
}

function matches(word: string, list: WordList): boolean {
  const f = fold(word);
  if (!f) return false;
  // Also try with doubled letters collapsed ("fuuuck" -> "fuck", "shiit" -> "shit").
  for (const v of new Set([f, f.replace(/(.)\1+/g, '$1')])) {
    if (list.sub.some((w) => v.includes(w))) return true;
    if (list.word.some((w) => (w.startsWith('=') ? v === w.slice(1) || v === w.slice(1) + 's' : v.startsWith(w) && SUFFIX.test(v.slice(w.length))))) return true;
  }
  return false;
}

/** True if the text contains a slur (any filter level). */
export function containsSlur(text: string): boolean {
  return text.split(/\s+/).some((w) => matches(w, SLURS));
}

export function containsProfanity(text: string): boolean {
  return text.split(/\s+/).some((w) => matches(w, PROFANITY));
}

/** Mask offending words with asterisks. Slurs always; profanity when `family` is on. */
export function maskText(text: string, family: boolean): { text: string; masked: boolean } {
  let masked = false;
  const out = text.split(' ').map((w) => {
    if (matches(w, SLURS) || (family && matches(w, PROFANITY))) {
      masked = true;
      return '*'.repeat(Math.max(3, Math.min(8, [...w].length)));
    }
    return w;
  });
  return { text: out.join(' '), masked };
}
