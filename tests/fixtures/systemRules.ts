import type { StarRow, SystemRules } from '../../src/shared/rulepack';

const LETTERS = 'OBAFGKM';
const CLASSES = ['Ia', 'Ib', 'II', 'III', 'IV', 'V', 'VI'];

/** One row per type at subtypes 0 and 5, and a last one at M9, from a made-up curve. */
function rows(value: (step: number, cls: number) => number | null): StarRow[] {
  const out: StarRow[] = [];
  LETTERS.split('').forEach((letter, i) => {
    out.push({ type: `${letter}0`, v: CLASSES.map((_, c) => value(i * 2, c)) });
    out.push({ type: `${letter}5`, v: CLASSES.map((_, c) => value(i * 2 + 1, c)) });
  });
  out.push({ type: 'M9', v: CLASSES.map((_, c) => value(14, c)) });
  return out;
}

/**
 * Rules for building star systems, invented for the tests. The tables follow simple made-up curves
 * and the formulas are plain; none of it is taken from a rulebook.
 */
export function testSystemRules(): SystemRules {
  return {
    // each orbit half as far again as the one before
    orbits: Array.from({ length: 21 }, (_, n) => (n === 0 ? 0 : Math.round(0.3 * 1.5 ** (n - 1) * 1000) / 1000)),
    classes: CLASSES,
    starTables: {
      types: {
        type: ['Special', 'M', 'M', 'K', 'K', 'K', 'G', 'G', 'G', 'F', 'Hot'],
        hot: ['A', 'A', 'A', 'A', 'A', 'A', 'A', 'B', 'B', 'B', 'O'],
        special: ['Class VI', 'Class VI', 'Class IV', 'Class IV', 'Class IV', 'Class III', 'Class III', 'Class III', 'Giants', 'Giants', 'Giants'],
        unusual: ['Peculiar', 'BD', 'BD', 'BD', 'D', 'D', 'D', 'Class IV', 'Class III', 'Giants', 'Giants'],
        giants: ['Class III', 'Class III', 'Class III', 'Class III', 'Class III', 'Class II', 'Class II', 'Class II', 'Class Ib', 'Class Ib', 'Class Ia'],
        peculiar: ['Black Hole', 'Neutron Star', 'Neutron Star', 'Pulsar', 'Pulsar', 'Protostar', 'Protostar', 'Nebula', 'Nebula', 'Anomaly', 'Anomaly'],
      },
      subtype: { numeric: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 5], mPrimary: [9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 5] },
      temperature: [...LETTERS.split('').flatMap((letter, i) => [{ type: `${letter}0`, k: 40000 - i * 5600 }, { type: `${letter}5`, k: 40000 - i * 5600 - 2800 }]), { type: 'M9', k: 2500 }],
      // brighter classes are heavier and larger; subgiants stop at the cool end
      mass: rows((step, cls) => (cls === 4 && step > 11 ? null : Math.round((20 / (1 + step) + (5 - cls) * 0.3 + 0.1) * 100) / 100)),
      diameter: rows((step, cls) => (cls === 4 && step > 11 ? null : Math.round((8 / (1 + step * 0.7) + Math.max(0, 5 - cls) ** 2 * 6 + 0.1) * 100) / 100)),
      mao: rows((step, cls) => (cls === 4 && step > 11 ? null : Math.round((0.02 + Math.max(0, 5 - cls) * 0.9) * 100) / 100)),
      brownDwarfs: [
        { type: 'L0', mass: 0.07, k: 2000, diameter: 0.1 },
        { type: 'T0', mass: 0.04, k: 1000, diameter: 0.1 },
        { type: 'Y0', mass: 0.01, k: 400, diameter: 0.1 },
      ],
      whiteDwarfCooling: [
        { gyr: 0, k: 50000 },
        { gyr: 1, k: 10000 },
        { gyr: 10, k: 4000 },
      ],
    },
    limits: {
      IV: { mAdd: 4, remap: { O: 'B' }, coolest: 'K4', subtractAbove: { type: 'K', above: 4, by: 5 }, fallback: 'V' },
      VI: { remap: { F: 'G', A: 'B' } },
      proto: { remap: { O: 'A' } },
    },
    nonPrimary: {
      secondary: ['Other', 'Random', 'Random', 'Lesser', 'Lesser', 'Lesser', 'Sibling', 'Sibling', 'Sibling', 'Twin', 'Twin'],
      companion: ['Other', 'Random', 'Lesser', 'Lesser', 'Sibling', 'Sibling', 'Sibling', 'Twin', 'Twin', 'Twin', 'Twin'],
      postStellar: ['Other', 'Other', 'Random', 'Random', 'Random', 'Lesser', 'Lesser', 'Lesser', 'Twin', 'Twin', 'Twin'],
      other: ['D', 'D', 'D', 'D', 'D', 'BD', 'BD', 'BD', 'BD', 'BD', 'BD'],
    },
    knownPlaces: { binary: ['companion', 'close', 'near', 'near', 'far', 'again'], multiple: ['companion', 'close', 'near', 'far', 'same', 'far'] },
    eccentricity: [
      { max: 6, value: '1D/500' },
      { max: 9, value: '0.02 + 1D/100' },
      { max: 99, value: '0.1 + 2D/40' },
    ],
    quantities: {
      gasGiants: [{ max: 5, n: 1 }, { max: 9, n: 2 }, { max: 99, n: 3 }],
      belts: [{ max: 8, n: 1 }, { max: 99, n: 2 }],
      emptyOrbits: [{ max: 10, n: 0 }, { max: 99, n: 1 }],
      anomalousOrbits: [{ max: 10, n: 0 }, { max: 99, n: 1 }],
    },
    anomalies: [
      { max: 6, kind: 'random', eccDm: 1 },
      { max: 9, kind: 'inclined', eccDm: 1 },
      { max: 11, kind: 'retrograde', eccDm: 2 },
      { max: 99, kind: 'trojan', eccDm: 0 },
    ],
    zones: [
      { raw: 2, deviation: 1.2, name: 'Frozen' },
      { raw: 4, deviation: 0.6, name: 'Cold' },
      { raw: 7, deviation: 0, name: 'Temperate' },
      { raw: 10, deviation: -0.6, name: 'Hot' },
      { raw: 12, deviation: -1.2, name: 'Boiling' },
    ],
    sizes: {
      terrestrial: [{ max: 3, roll: '1D' }, { max: 6, roll: '2D' }],
      gasGiant: [
        { max: 3, code: 'GS', name: 'Small gas giant', diameter: 'D3+2', mass: '10 x 1D' },
        { max: 99, code: 'GL', name: 'Large gas giant', diameter: '1D+8', mass: '100 x 2D', heavyFrom: 1100, heavy: '1000 + 10 x 1D' },
      ],
      moonCount: [
        { sizes: [1, 2, 3, 4], roll: '1D-4', dice: 1 },
        { sizes: [5, 6, 7, 8, 9, 10, 11, 12], roll: '2D-7', dice: 2 },
        { code: 'GS', roll: '2D-5', dice: 2 },
        { code: 'GL', roll: '3D-5', dice: 3 },
      ],
      moon: [{ max: 3, size: 'S' }, { max: 5, roll: 'D3-1' }, { max: 6, roll: 'P-1-1D', giant: true }],
      giantMoon: [{ max: 4, roll: '1D' }, { max: 6, roll: '2D+4', giantAt: 15 }],
    },
    dm: {
      starPresence: [{ when: 'class >= 1 and class <= 5', dm: 1 }, { when: 'type == 6', dm: -1 }],
      nonPrimary: [{ when: 'class == 4', dm: -1 }],
      eccentricity: [{ when: 'star', dm: 2 }, { when: 'extraStars > 0', dm: 1, times: 'extraStars' }],
      gasGiants: [{ when: 'stars >= 3', dm: -1 }, { when: 'dead > 0', dm: -1, times: 'dead' }],
      belts: [{ when: 'gasGiants >= 1', dm: 1 }],
      terrestrials: [{ when: 'dead > 0', dm: -1, times: 'dead' }],
      baseline: [{ when: 'companion', dm: -1 }, { when: 'worlds < 5', dm: -3 }, { when: 'worlds > 12', dm: 1 }, { when: 'secondaries > 0', dm: -1, times: 'secondaries' }],
      gasGiantSize: [{ when: 'type == 6', dm: -1 }],
      deadSystem: [{ when: 'bh', dm: -3 }],
      temperatureByAtmosphere: [{ when: 'atm <= 3', dm: -2 }, { when: 'atm >= 8', dm: 1 }],
    },
    f: {
      classRollDm: 1,
      variance: '(2D-7) / 50',
      luminosity: 'DIA^2 x (T / 6000)^4',
      'mass.BD': '0.01 + 1D/100',
      'mass.D': '0.4 + 1D/10',
      'mass.NS': '1.2 + 1D/10',
      'mass.BH': '3 + 1D',
      'mass.BH.six': 'D3',
      'peculiar.blackHole': '1D >= 5',
      isGiant: 'class >= 1 and class <= 4',
      'diameter.D': '0.01',
      'diameter.NS': '0.00002',
      'diameter.BH': '0.00001 x M',
      'diameter.proto': '1 + 1D/10',
      whiteDwarfMass: 0.7,
      'mao.BD': 0.01,
      'mao.dead': 0.005,
      lifespan: '12 / M^2',
      smallStarBelow: 1,
      'age.small': '1D + 1D/10',
      'age.fraction': '1D / 7',
      'age.minimum': 0.02,
      'age.minimumBelowMass': 5,
      subgiant: 'L / 10',
      giant: 'L / 20',
      progenitor: '3 x M',
      'progenitor.min.BH': 15,
      'age.pulsar': '0.01 x 1D',
      'age.proto': '0.001 x 1D',
      primordial: 'age < 0.05 or type == 0',
      universe: 13,
      starPresent: '2D + DM >= 9',
      'orbit.close': 'max(0.5, 1D - 2)',
      'orbit.near': '1D + 4',
      'orbit.far': '1D + 10',
      'orbit.companion': '1D / 20',
      'orbit.giantCompanion': '1D x MAO',
      'orbit.variance': 'd10/10 - 0.5',
      sibling: 'D3',
      period: 'sqrt(AU^3 / M)',
      gasGiantsExist: '2D <= 8',
      'gasGiantsExist.dead': '2D <= 4',
      beltsExist: '2D + DM >= 9',
      terrestrials: '2D - 3',
      'terrestrials.dead': '1D - 3',
      'terrestrials.few': 'D3 + 1',
      'terrestrials.fewBelow': 2,
      'terrestrials.more': 'D3 - 1',
      maxTerrestrials: 12,
      deadSystemExists: 'natural + DM >= 7',
      maxOrbit: 18,
      companionExclusion: '0.6 + E',
      maoCounts: 0.3,
      secondaryExclusion: 1,
      'secondaryExclusion.eccentric': 0.2,
      'secondaryExclusion.veryEccentric': 0.5,
      secondaryReach: 3,
      hzco: 'sqrt(L)',
      hzBreadth: 1,
      baselineNumber: '2D + DM - 3',
      'baselineOrbit.zone': 'HZCO + (2D-7)/20',
      'baselineOrbit.zoneLow': 'HZCO + (2D-7)/200',
      'baselineOrbit.cold': 'max(HZCO, MAO) - N + 1D/10',
      'baselineOrbit.coldLow': 'MIN - N/10 + 1D/100',
      'baselineOrbit.hot': 'HZCO - N + W + (2D-7)/10',
      'baselineOrbit.hotLow': 'HZCO + (W - N) / 10',
      'baselineOrbit.hotFloor': 'max(HZCO - 0.1, MAO + W x 0.01)',
      'baselineOrbit.nudge': '1D / 20',
      'climate.frozen': 2,
      'climate.cold': 4,
      'climate.temperate': 7,
      'climate.hot': 10,
      'climate.boiling': 12,
      'mainworld.inZone': 'size > 0 and atm >= 5 and atm <= 8 and raw > 2 and raw < 12',
      spread: '(B - MAO) / max(1, N)',
      maxSpread: 'A / (S + T)',
      secondarySpread: '(OUT - MAO) / (S + 1)',
      slotVariance: '(2D-7) x SPREAD / 20',
      'anomaly.orbit': '1D + d10/10',
      'anomaly.inclination': '1D x 10',
      terrestrialSize: '1D',
      gasGiantSize: '1D + DM',
      moonSize: '1D',
      giantMoonSize: '1D',
      twinCheck: '2D',
      'twin.close': 'R <= 3',
      'twin.equal': 'R >= 11',
    },
  };
}
