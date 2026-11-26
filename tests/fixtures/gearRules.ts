import type { GearRules } from '../../src/shared/rulepack';

/**
 * Equipment rules invented for the tests: enough of every kind of entry to exercise the catalogue,
 * the availability sums, special versions and special ammunition. None of it is from a rulebook.
 */
export function testGearRules(): GearRules {
  return {
    weapons: [
      { id: 'slugger', name: 'Slugger', group: 'pistol', skill: 'Gun Combat (slug)', tl: 6, range: 20, damage: '3D-3', kg: 1, cost: 300, magazine: 10, magazineCost: 12, ammoClass: 'pistol' },
      { id: 'longarm-tl7', name: 'Longarm', group: 'rifle', skill: 'Gun Combat (slug)', tl: 7, range: 300, damage: '3D', kg: 4, cost: 600, magazine: 20, magazineCost: 20, traits: ['AP 2', 'Auto 2'], ammoClass: 'rifle' },
      { id: 'longarm-tl9', name: 'Longarm', group: 'rifle', skill: 'Gun Combat (slug)', tl: 9, range: 400, damage: '3D+2', kg: 3, cost: 900, magazine: 30, magazineCost: 30, traits: ['AP 4', 'Auto 3'], ammoClass: 'rifle' },
      { id: 'thumper', name: 'Thumper', group: 'heavy', skill: 'Heavy Weapons (portable)', tl: 8, range: 200, damage: '9D', kg: 9, cost: 4000, magazine: 4, magazineCost: 200, traits: ['Blast 4', 'Bulky'], ammoClass: 'heavy' },
      { id: 'beamer', name: 'Beamer', group: 'energy pistol', skill: 'Gun Combat (energy)', tl: 10, range: 30, damage: '4D', kg: 2, cost: 2500, magazine: 50, magazineCost: 500 },
      { id: 'lash', name: 'Lash', group: 'melee', skill: 'Melee (whip)', tl: 1, range: 'melee', damage: 'D3', kg: 1, cost: 15 },
      { id: 'satchel', name: 'Satchel Charge', group: 'explosive', skill: 'Explosives', tl: 6, range: 0, damage: '4D', kg: 2, cost: 150, traits: ['AP ∞', 'Blast 1,200'] },
    ],
    armour: [
      { id: 'padding', name: 'Padding', protection: 2, tl: 1, kg: 3, cost: 40, group: 'Plain' },
      { id: 'mirror', name: 'Mirror Suit', protection: 0, laserProtection: 9, versus: '+9 vs. lasers', tl: 9, kg: 1, cost: 1200, group: 'Plain' },
      { id: 'screen', name: 'Screen Belt', protection: 11, laserProtection: 0, versus: '+0 vs. lasers', tl: 14, kg: 1, cost: 250000, group: 'Plain' },
      { id: 'hardsuit', name: 'Hard Suit', protection: 9, tl: 9, rad: 60, kg: 14, cost: 11000, skill: { name: 'Vacc Suit', level: 1 }, group: 'Suits' },
      { id: 'warframe', name: 'War Frame', protection: 20, tl: 13, rad: 200, kg: 90, cost: 250000, skill: { name: 'Vacc Suit', level: 2 }, str: 4, dex: -2, slots: 12, powered: true, group: 'Suits' },
    ],
    weaponTraits: [],
    equipment: [
      { id: 'lamp', name: 'Lamp', group: 'Camping', tl: 4, kg: 1, cost: 20, effect: 'Lights a room.' },
      { id: 'radio-tl6', name: 'Radio', group: 'Signals', section: 'Sets', tl: 6, kg: 8, cost: 400, effect: 'Reaches the next valley.', electronic: true },
      { id: 'radio-tl9', name: 'Radio', group: 'Signals', section: 'Sets', tl: 9, kg: 1, cost: 250, effect: 'Reaches orbit.', electronic: true },
      { id: 'thinker', name: 'Thinker', group: 'Signals', tl: 8, kg: 2, cost: 1000, effect: 'Does sums.', electronic: 'computer' },
      { id: 'tonic', name: 'Tonic', group: 'Medicine', tl: 7, cost: 50, effect: 'Wakes you up.', kind: 'consumable' },
      { id: 'spare-heart', name: 'Spare Heart', group: 'Body', tl: 12, cost: 90000, effect: 'END +1.', kind: 'augment' },
      { id: 'tutor', name: 'Tutor/1', group: 'Signals', tl: 9, cost: 500, bandwidth: 1, kind: 'software' },
      { id: 'winch', name: 'Winch', group: 'Camping', tl: 5, kgNote: 'x2 the rope', costNote: 'Cr10 a metre' },
      { id: 'piercer', name: 'Piercer Rounds', group: 'Loads', kind: 'ammunition', tl: 5, costNote: 'x3 the magazine', ammo: { costMult: 3, weapons: ['pistol', 'rifle', 'heavy'], ap: { perDie: 1 } } },
      { id: 'sabot', name: 'Sabot Rounds', group: 'Loads', kind: 'ammunition', tl: 8, ammo: { costMult: 5, weapons: ['rifle'], rangePct: 10, damage: { perDie: -1 }, ap: { perDie: 3 } } },
      { id: 'thud', name: 'Thud Rounds', group: 'Loads', kind: 'ammunition', tl: 5, ammo: { costMult: 2, weapons: ['pistol', 'rifle'], rangePct: -25, traits: ['Stun'], strip: ['AP', 'Blast'] } },
      { id: 'burster', name: 'Burster Rounds', group: 'Loads', kind: 'ammunition', tl: 7, ammo: { costMult: 4, weapons: ['heavy'], later: { tl: 9, weapons: ['rifle'] }, damage: { dice: 1 }, ap: { mult: 2 }, blast: { mult: 2, base: 3 } } },
      { id: 'smoker', name: 'Smoker Rounds', group: 'Loads', kind: 'ammunition', tl: 4, ammo: { costMult: 1, weapons: ['heavy'], damage: { none: true }, blast: { set: 12 } } },
      { id: 'shaped', name: 'Shaped Rounds', group: 'Loads', kind: 'ammunition', tl: 6, ammo: { costMult: 8, weapons: ['heavy'], range: 50, damage: { set: '2DD' }, ap: { perDie: 2, beforeBonus: true }, blast: { perDie: 1 }, traits: ['Fire'] } },
    ],
    availability: {
      check: { skills: ['Broker', 'Streetwise'], target: 8 },
      tlAbove: [
        { min: 1, dm: -1, name: 'Above the local TL' },
        { min: 3, max: 5, dm: -2, name: 'Well above' },
        { min: 6, dm: -5, name: 'Far above' },
      ],
      starport: { A: 2, X: -3 },
      tradeCodes: [
        { codes: ['Ri', 'In'], dm: 1 },
        { codes: ['Po', 'Lt'], dm: -1 },
      ],
      population: [
        { min: 1, max: 3, dm: -2 },
        { min: 9, dm: 1 },
      ],
      options: [
        { id: 'rare', name: 'Rare', dm: -2 },
        { id: 'double', name: 'Double the price', dm: 1, priceMult: 2, excludes: ['triple'] },
        { id: 'triple', name: 'Triple the price', dm: 2, priceMult: 3, excludes: ['double'] },
      ],
      referee: { min: -2, max: 2 },
      blackMarket: {
        skills: ['Streetwise'],
        lawLevel: [
          { min: 0, max: 2, dm: 1 },
          { min: 3, max: 6, dm: 0 },
          { min: 7, dm: -2 },
        ],
        categories: [
          { id: 'mild', name: 'Frowned on', dm: 3, priceMult: 2 },
          { id: 'hot', name: 'Banned', dm: -3, priceMult: 10 },
        ],
        attention: { effect: -2, roll: '2D', results: [{ max: -4, name: 'Raid' }, { min: -3, max: 0, name: 'Questions' }, { min: 1, name: 'A glance' }] },
      },
    },
    variants: [
      { id: 'proto', name: 'Prototype', tl: -1, costMult: 4, kgMult: 2, electronic: { costMult: 20, kgMult: 10 }, availabilityDm: -2 },
      { id: 'retro', name: 'Old model', perTl: { costMult: 0.5, kgMult: 0.5 }, only: 'electronic', maxSteps: 2, computerSteps: 6 },
    ],
    quirks: ['Rattles.', 'Smokes.'],
    reference: [{ title: 'Haggling', text: 'Smile.' }],
  };
}
