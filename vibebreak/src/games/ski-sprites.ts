import { defineSprite, type Sprite } from '../ui/sprite.js';

/**
 * Art for Ski Survival. Pure data: the game decides what to draw where, and
 * the slope generator reads only the hitboxes and footprints.
 *
 * Every sprite is anchored at the middle of its bottom row (its footing on
 * the slope) unless noted. The skier travels up the screen, so it is seen
 * from behind: straight skis are vertical, carving skis lean into the turn.
 *
 * Colour roles (resolved by the game's palette): pine, snow, trunk, rock,
 * stone, snowman, ramp, mogul, chasm, lip, gold, token, cocoa, skier, air,
 * crash, spark, drift.
 */

const TREE_TINTS = { '*': 'snow', '.': 'snow', '^': 'snow', '|': 'trunk', _: 'pine' };

/**
 * A tree with its sway frames for gusts: the canopy (all rows above the
 * bottom two) shifts one column with the wind. Frames are padded by a column
 * on each side so the anchor stays put.
 */
function tree(name: string, rows: string[], hitbox: Sprite['hitbox'], compact: string[]): Sprite {
  const lean = (dir: -1 | 0 | 1) =>
    rows.map((r, i) => {
      const canopy = i < rows.length - 2;
      const shift = canopy ? dir : 0;
      return (' '.repeat(1 + shift) + r + ' '.repeat(1 - shift));
    });
  const [l, r] = [rows[rows.length - 1].search(/\S/), rows[rows.length - 1].trimEnd().length - 1];
  return defineSprite(name, {
    frames: [lean(0), lean(-1), lean(1)],
    anchor: { x: 1 + Math.floor((l + r) / 2), y: rows.length - 1 },
    tint: 'pine',
    tints: TREE_TINTS,
    hitbox,
    compact,
  });
}

/* ----------------------------------------------------------------- trees */

/** Hitbox for a 1-wide trunk under a 3-wide solid core of the lowest boughs. */
const TRUNK_AND_CORE = [{ dx: 0, dy: 0, w: 1 }, { dx: -1, dy: -1, w: 3 }];

export const TREES = {
  /** Snow-covered pine, the common tree. */
  pine: tree('pine', [
    '   ^   ',
    '  /*\\  ',
    ' /*.*\\ ',
    '/_*_*_\\',
    '   |   ',
  ], TRUNK_AND_CORE, [' ^ ', '/*\\', ' | ']),

  /** Dense evergreen: layered boughs and a thick trunk. */
  evergreen: tree('evergreen', [
    '    ^    ',
    '   /*\\   ',
    '  //*\\\\  ',
    ' ///*\\\\\\ ',
    '////*\\\\\\\\',
    '   |_|   ',
  ], [{ dx: -1, dy: 0, w: 3 }, { dx: -1, dy: -1, w: 3 }], [' ^ ', '/*\\', '|_|']),

  /** Windblown mountain pine: crooked crown swept to the right. */
  windblown: tree('windblown', [
    '     _/\\  ',
    '  __/**\\  ',
    ' /*****\\_ ',
    '/_*_*_*__\\',
    '   /**\\   ',
    '    ||    ',
  ], [{ dx: 0, dy: 0, w: 2 }, { dx: -1, dy: -1, w: 4 }], [' /\\ ', '/**\\', ' || ']),

  /** Tall, slim spruce. */
  spruce: tree('spruce', [
    '  ^  ',
    ' /*\\ ',
    ' /*\\ ',
    '/*.*\\',
    '/_*_\\',
    '  |  ',
  ], TRUNK_AND_CORE, [' ^ ', '/*\\', ' | ']),

  /** Young sapling: small and quick to pass. */
  sapling: tree('sapling', [
    ' ^ ',
    '/*\\',
    ' | ',
  ], [{ dx: 0, dy: 0, w: 1 }, { dx: 0, dy: -1, w: 1 }], [' ^ ', '/*\\', ' | ']),
};

export type TreeVariant = keyof typeof TREES;
/** Relative odds when the generator plants a tree. */
export const TREE_WEIGHTS: Array<[TreeVariant, number]> = [
  ['pine', 5], ['evergreen', 3], ['windblown', 2], ['spruce', 3], ['sapling', 2],
];

/* ------------------------------------------------------------- obstacles */

export const ROCKS = {
  stone: defineSprite('stone', {
    frames: [' _._ ', '(___)'],
    tint: 'rock',
    tints: { '.': 'stone' },
    hitbox: [{ dx: -1, dy: 0, w: 3 }],
    compact: ['(_)'],
  }),
  boulder: defineSprite('boulder', {
    frames: ['  .--.  ', ' / .  \\_', '(______/)'],
    anchor: { x: 4, y: 2 },
    tint: 'rock',
    tints: { '.': 'stone' },
    hitbox: [{ dx: -2, dy: 0, w: 5 }],
    compact: ['/^^\\', '(___)'],
    compactAnchor: { x: 2, y: 1 },
  }),
};
export type RockVariant = keyof typeof ROCKS;

export const SNOWMAN = defineSprite('snowman', {
  frames: [
    ['  _H_  ', ' (o.o) ', '/( : )\\', ' (___) '],
    ['  _H_  ', ' (o.o) ', '\\( : )/', ' (___) '],
  ],
  tint: 'snowman',
  tints: { H: 'stone', _: 'stone', o: 'stone', '/': 'trunk', '\\': 'trunk' },
  hitbox: [{ dx: -1, dy: 0, w: 3 }, { dx: -1, dy: -1, w: 3 }],
  compact: ['(o)', '(:)', '(_)'],
});

export const RAMP = defineSprite('ramp', {
  frames: [' .^^^. ', '/_____\\'],
  tint: 'ramp',
  hitbox: [{ dx: -2, dy: 0, w: 5 }],
  compact: ['/^^^\\'],
});

export const MOGUL = defineSprite('mogul', {
  frames: ['_/^\\_'],
  tint: 'mogul',
  hitbox: [{ dx: -1, dy: 0, w: 3 }],
  solid: false,
});

export const CREVASSE_MIN = 5;
export const CREVASSE_MAX = 10;
/** Crevasses of every length, anchored at their left end. Lip row is harmless. */
export const CREVASSES: Record<number, Sprite> = {};
for (let len = CREVASSE_MIN; len <= CREVASSE_MAX; len++) {
  const lip = '.' + '-~'.repeat(len).slice(0, len - 2) + '.';
  CREVASSES[len] = defineSprite(`crevasse${len}`, {
    frames: [lip, '\\' + 'V'.repeat(len - 2) + '/'],
    anchor: { x: 0, y: 1 },
    tint: 'chasm',
    tints: { '.': 'lip', '-': 'lip', '~': 'lip' },
    hitbox: [{ dx: 0, dy: 0, w: len }],
  });
}

/* ---------------------------------------------------------- collectibles */

export const TOKEN = defineSprite('token', {
  frames: [['(*)'], ['{*}']],
  tint: 'token',
  hitbox: [{ dx: -1, dy: 0, w: 3 }],
});

export const GOLD = defineSprite('gold', {
  frames: [['[$]'], ['<$>']],
  tint: 'gold',
  hitbox: [{ dx: -1, dy: 0, w: 3 }],
});

export const COCOA = defineSprite('cocoa', {
  frames: [[' ~  ', '[_]D'], [' (  ', '[_]D']],
  anchor: { x: 1, y: 1 },
  tint: 'cocoa',
  tints: { '~': 'drift', '(': 'drift' },
  hitbox: [{ dx: -1, dy: 0, w: 3 }],
});

/* ------------------------------------------------------------ decoration */

/** A wind-blown snowdrift: harmless, flat, and low-key on purpose. */
export const DRIFT = defineSprite('drift', {
  frames: ['_.-~~-._'],
  tint: 'drift',
  solid: false,
});

/* ----------------------------------------------------------------- skier */

/** All poses share a 5-column frame anchored at the middle of the skis. */
export const SKIER = {
  straight: defineSprite('skier-straight', {
    frames: ['  o  ', ' /|\\ ', ' / \\ ', ' | | '],
    tint: 'skier',
  }),
  left: defineSprite('skier-left', {
    frames: [' o   ', '/|\\  ', '\\ \\  ', ' \\ \\ '],
    anchor: { x: 2, y: 3 },
    tint: 'skier',
  }),
  right: defineSprite('skier-right', {
    frames: ['   o ', '  /|\\', '  / /', ' / / '],
    anchor: { x: 2, y: 3 },
    tint: 'skier',
  }),
  tuck: defineSprite('skier-tuck', {
    frames: ['  _o ', ' /_\\ ', ' | | '],
    tint: 'skier',
  }),
  /** Snowplough: ski tips together, tails apart. */
  brake: defineSprite('skier-brake', {
    frames: ['  o  ', ' (|) ', ' / \\ ', '/   \\'],
    tint: 'skier',
  }),
  /** Airborne: arms up. Drawn above a shadow. */
  air: defineSprite('skier-air', {
    frames: [' \\o/ ', '  |  ', ' / \\ ', ' | | '],
    tint: 'air',
  }),
  /** The Spin trick: skis rotate through a full turn. */
  spin: defineSprite('skier-spin', {
    frames: [
      ['  o  ', ' /|\\ ', ' / \\ ', ' | | '],
      ['  o  ', ' -|\\ ', '  |\\ ', ' / / '],
      ['  o  ', ' -|- ', '  |  ', '====='],
      ['  o  ', ' /|- ', ' /|  ', ' \\ \\ '],
    ],
    anchor: { x: 2, y: 3 },
    tint: 'air',
  }),
  /** The Grab trick: knees up, hands on the skis. */
  grab: defineSprite('skier-grab', {
    frames: ['  o  ', ' <|> ', ' (_) ', ' | | '],
    tint: 'air',
  }),
  /** Wipeout: a burst of limbs and snow. */
  crash: defineSprite('skier-crash', {
    frames: [
      [' \\|/ ', '-(o)-', ' /|\\ '],
      [" .'. ", "'(o)'", " '.' "],
    ],
    anchor: { x: 2, y: 2 },
    tint: 'crash',
  }),
  /** Falling into a crevasse. */
  fall: defineSprite('skier-fall', {
    frames: [[' \\o/ ', '  |  '], ['  o  ', ' \\|/ ']],
    anchor: { x: 2, y: 1 },
    tint: 'crash',
  }),
};
export type SkierPose = keyof typeof SKIER;

/** The skier's ground shadow while airborne. */
export const SHADOW = defineSprite('shadow', { frames: ["'-'"], tint: 'drift' });

/* --------------------------------------------------------------- effects */

/** Sparkle when a collectible is picked up (one frame per ~150ms). */
export const SPARKLE = defineSprite('sparkle', {
  frames: [
    [' | ', '-*-', ' | '],
    ['\\ /', ' * ', '/ \\'],
    ["' '", '   ', ". ."],
  ],
  anchor: { x: 1, y: 1 },
  tint: 'spark',
  solid: false,
});

/** Snow thrown up when the skier hits something. */
export const PUFF = defineSprite('puff', {
  frames: [
    ['  .  ', ' .*. ', '  .  '],
    [' . . ', '* . *', " ' ' "],
    ["'   '", '     ', ".   ."],
  ],
  anchor: { x: 2, y: 1 },
  tint: 'snow',
  solid: false,
});

/** Every sprite, for tests and tooling. */
export const ALL_SPRITES: Sprite[] = [
  ...Object.values(TREES), ...Object.values(ROCKS), SNOWMAN, RAMP, MOGUL, ...Object.values(CREVASSES),
  TOKEN, GOLD, COCOA, DRIFT, ...Object.values(SKIER), SHADOW, SPARKLE, PUFF,
];
