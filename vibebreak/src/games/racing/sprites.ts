import { defineSprite, type Sprite } from '../../ui/sprite.js';
import { ROCKS, TREES } from '../ski-sprites.js';
import type { HazardKind, PickupKind, Scenery } from './track.js';

/**
 * Art for VibeBreak Racing, on the sprite system Ski Survival introduced.
 *
 * Cars are seen from above, nose up the screen, anchored at the middle of
 * their rear row; a car at distance d covers rows d .. d+2. Frames: 0 straight,
 * 1 leaning left, 2 leaning right, 3 drifting/spinning. `compact` is the
 * smaller, far-away look used near the top of the view (visual only: the
 * physics never sees it). Hitboxes are the body, not the wheel arches; the
 * simulation's CAR_HALF_W matches them.
 *
 * Colour roles are resolved by the renderer; each racer's body gets its own
 * colour (car0..car7), traffic is plain.
 */

function car(name: string, straight: string[], left: string[], right: string[], slide: string[], compact: string[]): Sprite {
  return defineSprite(name, {
    frames: [straight, left, right, slide],
    tint: 'body',
    tints: { '[': 'tyre', ']': 'tyre', o: 'tyre', '=': 'trim', '#': 'trim' },
    hitbox: [{ dx: -2, dy: 0, w: 5, h: 3 }],
    compact,
  });
}

export const CARS: Sprite[] = [
  car('gt',
    [' /^\\ ', '[|=|]', '[\\_/]'],
    ['/^\\  ', '[|=|]', '[\\_/]'],
    ['  /^\\', '[|=|]', '[\\_/]'],
    [' /^\\ ', '<|=|>', '[\\_/]'],
    [' ^ ', '[=]']),
  car('f1',
    ['o-^-o', ' |=| ', 'o=#=o'],
    ['o^--o', ' |=| ', 'o=#=o'],
    ['o--^o', ' |=| ', 'o=#=o'],
    ['o-^-o', '<|=|>', 'o=#=o'],
    ['o^o', 'o=o']),
  car('rally',
    [' ,=. ', '[{o}]', '[_=_]'],
    [',=.  ', '[{o}]', '[_=_]'],
    ['  ,=.', '[{o}]', '[_=_]'],
    [' ,=. ', '<{o}>', '[_=_]'],
    [' . ', '[o]']),
  car('muscle',
    [' ___ ', '[|#|]', '[=-=]'],
    ['___  ', '[|#|]', '[=-=]'],
    ['  ___', '[|#|]', '[=-=]'],
    [' ___ ', '<|#|>', '[=-=]'],
    [' _ ', '[#]']),
];

/** Highway traffic: plain, boxy and slower. */
export const TRAFFIC: Sprite[] = [
  defineSprite('sedan', { frames: [' .-. ', '|o_o|', "'---'"], tint: 'traffic', hitbox: [{ dx: -2, dy: 0, w: 5, h: 3 }], compact: ['.-.', "'-'"] }),
  defineSprite('van', { frames: [' ___ ', '|___|', '|___|'], tint: 'traffic', hitbox: [{ dx: -2, dy: 0, w: 5, h: 3 }], compact: ['_ _', '|_|'] }),
  defineSprite('truck', { frames: ['.---.', '|###|', '|_._|'], tint: 'traffic', tints: { '#': 'trim' }, hitbox: [{ dx: -2, dy: 0, w: 5, h: 3 }], compact: ['.-.', '|#|'] }),
  defineSprite('bus', { frames: ['[===]', '|o o|', '[___]'], tint: 'traffic', hitbox: [{ dx: -2, dy: 0, w: 5, h: 3 }], compact: ['[=]', '[_]'] }),
];

/** Car art for a style index: 0-3 racers, 10-13 traffic. */
export function carSprite(style: number): Sprite {
  return style >= 10 ? TRAFFIC[(style - 10) % TRAFFIC.length] : CARS[style % CARS.length];
}

export const HAZARDS: Record<HazardKind, Sprite> = {
  cone: defineSprite('cone', { frames: [' ^ ', '/_\\'], tint: 'cone', hitbox: [{ dx: -1, dy: 0, w: 3 }] }),
  oil: defineSprite('oil', { frames: ['(~~~)'], tint: 'oil', hitbox: [{ dx: -2, dy: 0, w: 5 }] }),
  pothole: defineSprite('pothole', { frames: ['\\_/'], tint: 'pothole', hitbox: [{ dx: -1, dy: 0, w: 3 }] }),
  barrel: defineSprite('barrel', { frames: ['(=)', '[#]'], tint: 'barrel', hitbox: [{ dx: -1, dy: 0, w: 3, h: 2 }] }),
};

export const PICKUPS: Record<PickupKind, Sprite> = {
  coin: defineSprite('coin', { frames: [['($)'], ['[$]']], tint: 'coin', hitbox: [{ dx: -1, dy: 0, w: 3 }] }),
  wrench: defineSprite('wrench', { frames: [['{+}'], ['<+>']], tint: 'wrench', hitbox: [{ dx: -1, dy: 0, w: 3 }] }),
};

const STAND = defineSprite('stand', { frames: ['.-------.', '|o o o o|', '|_______|'], tint: 'stand', tints: { o: 'crowd' } });
const SIGN = defineSprite('sign', { frames: ['[VIBE]', '  ||  '], tint: 'sign', tints: { '|': 'trunk' } });

/** Roadside scenery reuses Ski Survival's trees and rocks (scenery never collides). */
export const SCENERY: Record<Scenery['sprite'], Sprite> = {
  pine: TREES.pine,
  spruce: TREES.spruce,
  evergreen: TREES.evergreen,
  sapling: TREES.sapling,
  stone: ROCKS.stone,
  boulder: ROCKS.boulder,
  stand: STAND,
  sign: SIGN,
};

export const ALL_RACING_SPRITES: Sprite[] = [...CARS, ...TRAFFIC, ...Object.values(HAZARDS), ...Object.values(PICKUPS), STAND, SIGN];
