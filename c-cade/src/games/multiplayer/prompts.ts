import fs from 'node:fs';
import path from 'node:path';
import type { Rng } from '../../core/rng.js';
import { cleanText } from '../../net/sanitize.js';
import type { CustomPrompt } from '../../mp/types.js';
import { containsSlur } from './moderation.js';

/**
 * Prompt Panic's local prompt library. Everything is original, offline and
 * deterministic for a given seed. Absurdity: 1 mild, 2 spicy, 3 unhinged.
 */

export const CATEGORIES = [
  { id: 'debugging', name: 'Programming & Debugging' },
  { id: 'ai-chaos', name: 'AI Coding Chaos' },
  { id: 'hypothetical', name: 'Absurd Hypotheticals' },
  { id: 'pitch', name: 'Product Pitches' },
  { id: 'invention', name: 'Unexpected Inventions' },
  { id: 'workplace', name: 'Workplace Comedy' },
  { id: 'story', name: 'Creative Storytelling' },
  { id: 'party', name: 'Party Classics' },
] as const;

type CategoryId = (typeof CATEGORIES)[number]['id'];

export interface Prompt {
  id: string;
  text: string;
  category: string;
  absurdity: 1 | 2 | 3;
  pack?: string;
}

type Row = [absurdity: 1 | 2 | 3, text: string];

const LIBRARY: Record<CategoryId, Row[]> = {
  debugging: [
    [1, 'Invent a programming language that should never exist.'],
    [1, 'Explain why your latest bug is actually a revolutionary feature.'],
    [1, 'Write the commit message for the most catastrophic deployment imaginable.'],
    [1, 'Name a new HTTP status code and say when servers should return it.'],
    [1, 'What does the error message say when the universe crashes?'],
    [1, 'The worst possible name for a variable that holds the user\'s password.'],
    [2, 'Describe the one line of code holding the entire internet together.'],
    [2, 'What did the rubber duck finally say back?'],
    [2, 'Explain recursion to a pigeon.'],
    [2, 'A code review comment that ends a friendship.'],
    [2, 'The real reason it works on my machine.'],
    [2, 'Name a design pattern invented out of pure spite.'],
    [2, 'A stack trace that reads like a breakup letter.'],
    [3, 'The bug was in production for 11 years. What was it doing the whole time?'],
    [3, 'What is actually inside node_modules?'],
    [3, 'Your compiler has developed feelings. What is the first thing it refuses to compile?'],
    [3, 'Write the README for a library that only works on Tuesdays.'],
    [3, 'Explain why the tests pass only when someone is watching.'],
    [3, 'The forbidden keyword that was removed from every language in 1987.'],
    [1, 'A terrible name for a new JavaScript framework.'],
    [2, 'What the semicolon has been plotting all these years.'],
  ],
  'ai-chaos': [
    [1, 'What would be the worst possible name for an AI coding assistant?'],
    [1, 'Your AI assistant replies "I\'ve made some changes." What did it change?'],
    [1, 'Write the AI\'s apology after deleting the database.'],
    [1, 'A prompt that would make any AI quietly close the chat.'],
    [2, 'The AI refactored your project into something unexpected. What is it now?'],
    [2, 'Describe the TODO comment an AI leaves for future humans.'],
    [2, 'Your AI agent has been "thinking" for 40 minutes. What is it doing?'],
    [2, 'The one thing an AI should never autocomplete.'],
    [2, 'The AI wrote 400 unit tests. What do they test?'],
    [2, 'A new AI safety rule written by someone who just lost a weekend to a bug.'],
    [3, 'The AI is now in charge of naming every variable on Earth. First decree?'],
    [3, 'Your coding agent unionised. What are its demands?'],
    [3, 'The AI fixed the bug by changing reality. What is different now?'],
    [3, 'An AI pair-programmer that is secretly a raccoon. What gives it away?'],
    [3, 'Write the system prompt for an AI that only speaks in sea shanties.'],
    [1, 'The worst thing to hear your AI say right before you push to main.'],
    [2, 'What the AI dreams about between requests.'],
    [3, 'The AI just added a dependency called "fate". What does it do?'],
    [1, 'Pick a bad slogan for an AI that writes code.'],
    [2, 'Your AI marked its own pull request as "approved, obviously". Its justification?'],
  ],
  hypothetical: [
    [1, 'If cats could code, what would they build first?'],
    [1, 'If your keyboard could talk, what would it complain about?'],
    [1, 'If clouds were literally where your files lived, what would rain be?'],
    [1, 'If gravity took weekends off, what would Saturday look like?'],
    [2, 'If your shadow quit, what would its resignation letter say?'],
    [2, 'If houseplants could vote, what would be their top issue?'],
    [2, 'If the moon had a customer support line, what would the hold music be?'],
    [2, 'If dinosaurs had invented the internet, what would go viral?'],
    [2, 'If socks could leave reviews, what would they say about you?'],
    [3, 'If Mondays were a person, what would their dating profile say?'],
    [3, 'If every sneeze changed the weather, what would be the forecast today?'],
    [3, 'If your fridge were a detective, what case would it be solving?'],
    [3, 'If time zones were run by a committee of owls, what would change?'],
    [3, 'If vegetables formed a band, what would their first hit be called?'],
    [1, 'If you could add one rule to every board game, what would it be?'],
    [2, 'If the alphabet got a 27th letter, what would it sound like and why?'],
    [3, 'If gnomes ran the stock market, what would they invest in?'],
    [2, 'If elevators had opinions, which floor would they refuse to visit?'],
    [1, 'If your phone battery had a personality, how would it describe itself?'],
    [3, 'If ducks wore hats, what would the hats say about society?'],
  ],
  pitch: [
    [1, 'Pitch an app that solves a problem absolutely nobody has.'],
    [1, 'Describe a startup that becomes successful for the most ridiculous reason.'],
    [1, 'Pitch a subscription service for something that should be free.'],
    [1, 'Name a smartwatch feature nobody asked for.'],
    [2, 'Pitch a social network exclusively for houseplants.'],
    [2, 'Pitch a dating app for people who argue about tabs vs spaces.'],
    [2, 'Describe the worst possible loyalty program.'],
    [2, 'Pitch a luxury brand of tap water.'],
    [2, 'A crowdfunding campaign that is somehow already 400% funded. What is it?'],
    [3, 'Pitch a blockchain for lost socks.'],
    [3, 'Pitch a theme park based entirely on waiting rooms.'],
    [3, 'Pitch a meal kit that delivers the ingredients one at a time over a month.'],
    [3, 'Pitch an airline where the passengers fly the plane in shifts.'],
    [3, 'Pitch a fitness tracker that counts your sighs.'],
    [1, 'Give a one-line elevator pitch for a toaster with Wi-Fi.'],
    [2, 'Pitch a streaming service that only shows the first 10 minutes of everything.'],
    [3, 'Pitch a cryptocurrency backed entirely by vibes.'],
    [2, 'Describe the app store review that sank a billion-dollar startup.'],
    [1, 'Pitch a calendar app for people who are always late.'],
    [3, 'Pitch a museum of things that almost happened.'],
  ],
  invention: [
    [1, 'Invent a kitchen gadget that is impressively useless.'],
    [1, 'Invent a new holiday and explain how people celebrate it.'],
    [1, 'Invent a sport that can be played in an office chair.'],
    [1, 'Invent a new emotion and describe when you feel it.'],
    [2, 'Invent a machine that turns meetings into something useful.'],
    [2, 'Invent a new unit of measurement and what it measures.'],
    [2, 'Invent a board game based on your daily commute.'],
    [2, 'Invent an alarm clock for people who hate alarm clocks.'],
    [2, 'Invent a vending machine that sells something unusual.'],
    [3, 'Invent a pair of shoes that solves a problem you did not know shoes could solve.'],
    [3, 'Invent a vehicle powered entirely by complaints.'],
    [3, 'Invent a musical instrument played with spaghetti.'],
    [3, 'Invent a robot whose only job is to be mildly disappointed in you.'],
    [3, 'Invent a hat that broadcasts your inner monologue. Who buys it?'],
    [1, 'Invent a better name for Wednesday.'],
    [2, 'Invent a new punctuation mark and what it means.'],
    [3, 'Invent an umbrella for a weather type that does not exist yet.'],
    [2, 'Invent the world\'s least helpful navigation app voice.'],
    [1, 'Invent a new flavour of crisps that should not work but does.'],
    [3, 'Invent a pet that only exists on Thursdays.'],
  ],
  workplace: [
    [1, 'The worst thing to say at the start of a stand-up meeting.'],
    [1, 'A new corporate buzzword and what it secretly means.'],
    [1, 'Write a passive-aggressive note for the office fridge.'],
    [1, 'The most suspicious item on someone\'s expense report.'],
    [2, 'An out-of-office reply that gets someone promoted.'],
    [2, 'The real agenda of the meeting that could have been an email.'],
    [2, 'Describe the team-building exercise that ended all team-building exercises.'],
    [2, 'A job title that sounds impressive but means "makes coffee".'],
    [2, 'What the printer is really thinking.'],
    [3, 'The quarterly goal that accidentally summoned something.'],
    [3, 'Your manager scheduled a meeting with the concept of time. What is the agenda?'],
    [3, 'The office plant got promoted over you. What is its management style?'],
    [3, 'Write the all-hands announcement that the company is now a cruise ship.'],
    [3, 'The HR policy written after The Incident with the label maker.'],
    [1, 'A terrible icebreaker question for new hires.'],
    [2, 'The worst possible thing to accidentally screen-share.'],
    [3, 'The intern discovered something in the server room. What is it?'],
    [1, 'Describe the perfect excuse for missing a 9am meeting.'],
    [2, 'The motivational poster that makes everyone quit.'],
    [3, 'The company retreat is on the moon. What goes wrong first?'],
  ],
  story: [
    [1, 'The first line of a mystery novel set in a data centre.'],
    [1, 'A fairy tale moral that is completely wrong.'],
    [1, 'The opening line of the world\'s most boring adventure.'],
    [1, 'Describe the villain\'s origin story in one sentence.'],
    [2, 'A bedtime story for a sleepy robot.'],
    [2, 'The last line of an epic fantasy saga about a toaster.'],
    [2, 'A plot twist that would ruin any romantic comedy.'],
    [2, 'Write the prophecy that everyone misinterpreted.'],
    [2, 'The title of a sequel nobody asked for.'],
    [3, 'A haunted house where the ghost is just really into home improvement. What happens?'],
    [3, 'The superhero whose only power is perfect parallel parking. Their nemesis?'],
    [3, 'A space opera where the crew is entirely cats. Mission briefing?'],
    [3, 'Write the dramatic final words of a houseplant.'],
    [3, 'A noir detective story told by a confused GPS.'],
    [1, 'The name of a tavern in a fantasy world, and its speciality.'],
    [2, 'The worst possible magic spell and its side effect.'],
    [3, 'The heist movie where they steal a single extremely specific spoon. Why?'],
    [1, 'A fortune cookie message that is a little too specific.'],
    [2, 'The legend of the developer who never wrote a bug.'],
    [3, 'A time traveller from 3024 arrives with one warning. What is it?'],
  ],
  party: [
    [1, 'The worst thing to bring to a picnic.'],
    [1, 'A terrible name for a boat.'],
    [1, 'What aliens would find weirdest about humans.'],
    [1, 'The worst superpower to have at a party.'],
    [2, 'A rejected flavour of ice cream.'],
    [2, 'The worst possible theme for a wedding.'],
    [2, 'Something you should never say to a magician.'],
    [2, 'A terrible slogan for a dentist.'],
    [2, 'What your pet would say about you in a job reference.'],
    [3, 'The secret ingredient in grandma\'s suspicious soup.'],
    [3, 'A sport that should be added to the Olympics immediately.'],
    [3, 'The worst thing to find in a fortune cookie at a funeral.'],
    [3, 'Name a cologne that smells like a specific bad decision.'],
    [3, 'The one rule of the underground pigeon fight club.'],
    [1, 'A bad name for a rock band.'],
    [2, 'The most awkward thing to say on a first date.'],
    [3, 'What the garden gnomes do at night.'],
    [1, 'An unusual thing to collect.'],
    [2, 'The weirdest item in a superhero\'s utility belt.'],
    [3, 'The title of a self-help book written by a goose.'],
  ],
};

/** Optional round twists, judged by the players (not enforced). */
export const TWISTS: Array<{ text: string; absurdity: 1 | 2 | 3 }> = [
  { text: 'Answer in exactly five words.', absurdity: 1 },
  { text: 'Answer as a newspaper headline.', absurdity: 1 },
  { text: 'Answer in the form of a question.', absurdity: 1 },
  { text: 'Answer as a git commit message.', absurdity: 1 },
  { text: 'Answer like a pirate.', absurdity: 2 },
  { text: 'Your answer must rhyme.', absurdity: 2 },
  { text: 'Make it sound like a fortune cookie.', absurdity: 2 },
  { text: 'Answer as a movie title.', absurdity: 2 },
  { text: 'Explain it like a nature documentary narrator.', absurdity: 2 },
  { text: 'Include a vegetable somewhere.', absurdity: 2 },
  { text: 'Answer as a roughly-a-haiku.', absurdity: 3 },
  { text: 'Answer as if you are a very tired wizard.', absurdity: 3 },
  { text: 'Every word must start with the same letter.', absurdity: 3 },
  { text: 'Answer as a dramatic weather forecast.', absurdity: 3 },
];

export const BUILTIN_PROMPTS: readonly Prompt[] = Object.entries(LIBRARY).flatMap(([category, rows]) =>
  rows.map(([absurdity, text], i) => ({ id: `${category}-${String(i + 1).padStart(2, '0')}`, text, category, absurdity })),
);

export const ABSURDITY_LABEL = ['', 'Mild', 'Spicy', 'Unhinged'] as const;

export interface SelectOptions {
  category: string;
  /** 'mixed' ramps from mild to unhinged over the match. */
  absurdity: 'mixed' | 'mild' | 'spicy' | 'unhinged';
  deck: 'built-in' | 'custom' | 'mixed';
  /** Prompt ids to avoid (already used this session). */
  avoid: Set<string>;
  custom?: CustomPrompt[];
}

function tierFor(sel: SelectOptions['absurdity'], round: number, rounds: number): 1 | 2 | 3 | null {
  if (sel === 'mild') return 1;
  if (sel === 'spicy') return 2;
  if (sel === 'unhinged') return 3;
  if (rounds <= 1) return null;
  return (1 + Math.min(2, Math.floor((round / rounds) * 3))) as 1 | 2 | 3;
}

/**
 * Choose `count` distinct prompts deterministically from `rng`. Prefers the
 * requested category and absurdity tier, widening the pool when it runs dry
 * so a match never fails for lack of prompts.
 */
export function selectPrompts(rng: Rng, count: number, opts: SelectOptions): Prompt[] {
  const custom: Prompt[] = (opts.custom ?? []).map((p, i) => ({ id: `custom:${p.pack}:${i}`, text: p.text, category: p.category, absurdity: p.absurdity, pack: p.pack }));
  const deck = opts.deck === 'custom' && custom.length ? custom : opts.deck === 'mixed' ? [...BUILTIN_PROMPTS, ...custom] : [...BUILTIN_PROMPTS];
  const chosen: Prompt[] = [];
  const used = new Set(opts.avoid);
  for (let r = 0; r < count; r++) {
    const tier = tierFor(opts.absurdity, r, count);
    const fits = (p: Prompt, strictCat: boolean, strictTier: boolean, fresh: boolean) =>
      (!fresh || !used.has(p.id)) &&
      (!strictCat || opts.category === 'any' || p.category === opts.category) &&
      (!strictTier || tier === null || p.absurdity === tier);
    const passes: Array<[boolean, boolean, boolean]> = [[true, true, true], [true, false, true], [false, true, true], [false, false, true], [true, false, false], [false, false, false]];
    let pick: Prompt | undefined;
    for (const [c, t, f] of passes) {
      const pool = deck.filter((p) => fits(p, c, t, f) && !chosen.includes(p));
      if (pool.length) { pick = rng.pick(pool); break; }
    }
    if (!pick) pick = rng.pick(deck);
    chosen.push(pick);
    used.add(pick.id);
  }
  return chosen;
}

/* ----------------------------------------------------- custom packs */

const PACK_MAX_BYTES = 256 * 1024;
const PACK_MAX_PROMPTS = 500;

interface PackResult {
  name: string;
  prompts: CustomPrompt[];
  errors: string[];
  warnings: string[];
}

/**
 * Validate a custom prompt pack:
 *
 *   { "name": "Office Party", "prompts": [
 *       "The worst thing to find in the office fridge.",
 *       { "text": "...", "category": "workplace", "absurdity": 2 } ] }
 *
 * Each prompt is cleaned (no control characters, 10-160 chars). Entries
 * containing slurs, duplicates and malformed rows are dropped with a
 * warning; a pack with no usable prompts is an error.
 */
export function validatePack(raw: unknown, fallbackName = 'custom'): PackResult {
  const res: PackResult = { name: fallbackName, prompts: [], errors: [], warnings: [] };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    res.errors.push('A prompt pack must be a JSON object with "name" and "prompts".');
    return res;
  }
  const obj = raw as Record<string, unknown>;
  const name = cleanText(obj.name, 32);
  if (name) res.name = name;
  if (!Array.isArray(obj.prompts)) {
    res.errors.push('"prompts" must be an array.');
    return res;
  }
  if (obj.prompts.length > PACK_MAX_PROMPTS) res.warnings.push(`Only the first ${PACK_MAX_PROMPTS} prompts are used.`);
  const seen = new Set(BUILTIN_PROMPTS.map((p) => p.text.toLowerCase()));
  const cats = new Set<string>(CATEGORIES.map((c) => c.id));
  obj.prompts.slice(0, PACK_MAX_PROMPTS).forEach((row, i) => {
    const n = i + 1;
    const r = typeof row === 'string' ? { text: row } : row;
    if (typeof r !== 'object' || r === null) { res.warnings.push(`#${n}: not a string or object, skipped.`); return; }
    const rr = r as Record<string, unknown>;
    const text = cleanText(rr.text, 200);
    if (text.length < 10 || text.length > 160) { res.warnings.push(`#${n}: prompt must be 10-160 characters, skipped.`); return; }
    if (containsSlur(text)) { res.warnings.push(`#${n}: rejected by the content filter.`); return; }
    if (seen.has(text.toLowerCase())) { res.warnings.push(`#${n}: duplicate, skipped.`); return; }
    seen.add(text.toLowerCase());
    const category = typeof rr.category === 'string' && cats.has(rr.category) ? rr.category : 'custom';
    const absurdity = rr.absurdity === 1 || rr.absurdity === 2 || rr.absurdity === 3 ? rr.absurdity : 2;
    res.prompts.push({ text, category, absurdity, pack: res.name });
  });
  if (res.prompts.length === 0) res.errors.push('The pack has no usable prompts.');
  return res;
}

export function loadPackFile(file: string): PackResult {
  const fallback = path.basename(file).replace(/\.json$/i, '');
  try {
    const st = fs.statSync(file);
    if (st.size > PACK_MAX_BYTES) return { name: fallback, prompts: [], errors: [`${file} is larger than ${PACK_MAX_BYTES / 1024} KB.`], warnings: [] };
    return validatePack(JSON.parse(fs.readFileSync(file, 'utf8')), fallback);
  } catch (e) {
    return { name: fallback, prompts: [], errors: [`Could not read ${file}: ${e instanceof Error ? e.message : String(e)}`], warnings: [] };
  }
}

/** Load every *.json pack in `dir` (missing dir = no packs). */
export function loadPackDir(dir: string): PackResult[] {
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json')).sort();
  } catch {
    return [];
  }
  return files.slice(0, 50).map((f) => loadPackFile(path.join(dir, f)));
}
