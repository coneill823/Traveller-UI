import { describe, expect, it } from 'vitest';
import { basicHullPoints, catalogue, defaultPart, entryState, evaluateDesign, shipFigures } from '../src/shared/rules/ship';
import type { DesignPart, ShipSpec } from '../src/shared/types';
import { testShipRules } from './fixtures/shipRules';

/** The design engine against made-up rules: none of these numbers come from a rulebook. */
describe('ship design engine', () => {
  const rules = testShipRules();
  let next = 0;
  const part = (p: Omit<DesignPart, 'id'>): DesignPart => ({ id: `t${++next}`, ...p });
  const design = (tons: number, config: string, parts: Omit<DesignPart, 'id'>[] = [], extra: Partial<ShipSpec> & { options?: string[] } = {}): ShipSpec => {
    const { options, ...rest } = extra;
    return { tl: 7, hull: { tons, config, ...(options ? { options } : {}) }, parts: parts.map(part), ...rest };
  };
  const run = (spec: ShipSpec) => evaluateDesign(rules, spec);
  const line = (spec: ShipSpec, label: string) => {
    const found = run(spec).lines.find((l) => l.label.startsWith(label));
    if (!found) throw new Error(`no line starting "${label}"`);
    return found;
  };
  /** Issue codes, leaving out the reminders that a bare test hull has no plant, bridge or computer. */
  const codes = (spec: ShipSpec, level?: string) =>
    run(spec)
      .issues.filter((i) => (!level || i.level === level) && !i.code.startsWith('missing-'))
      .map((i) => i.code);

  describe('hull and armour', () => {
    it('sizes armour by hull shape and by how small the hull is', () => {
      expect(line(design(100, 'wing', [{ kind: 'armour', key: 'plate', rating: 2 }]), 'Plate')).toMatchObject({ tons: 3, cost: 40_000 });
      expect(line(design(10, 'box', [{ kind: 'armour', key: 'foam', rating: 3 }], { tl: 8 }), 'Foam')).toMatchObject({ tons: 1.8, cost: 900 });
    });

    it('limits armour by tech level, and lets a warship frame carry double', () => {
      expect(codes(design(100, 'box', [{ kind: 'armour', key: 'foam', rating: 10 }], { tl: 8 }), 'error')).toEqual([]);
      expect(codes(design(100, 'box', [{ kind: 'armour', key: 'foam', rating: 11 }], { tl: 8 }), 'error')).toEqual(['armour-max']);
      expect(codes(design(2000, 'box', [{ kind: 'armour', key: 'plate', rating: 8 }], { options: ['warship'] }), 'error')).toEqual([]);
      expect(codes(design(2000, 'box', [{ kind: 'armour', key: 'plate', rating: 9 }], { options: ['warship'] }), 'error')).toEqual(['armour-max']);
    });

    it('gives very large hulls more Hull points for their size', () => {
      expect(basicHullPoints(rules, 1000)).toBe(250);
      expect(basicHullPoints(rules, 10_000)).toBe(5000);
      expect(run(design(100, 'box', [], { options: ['tough'] })).hullPoints).toBe(37);
    });

    it('builds into only part of a hollowed-out rock', () => {
      const r = run(design(1000, 'rock'));
      expect(r.lines[0]).toMatchObject({ tons: 250, cost: 100_000 });
      expect(r.cargo).toBe(750);
      expect(r.hullPoints).toBe(500);
      expect(r.armour).toBe(3);
      expect(codes(design(1000, 'rock', [], { options: ['tough'] }), 'error')).toContain('hull-plain');
    });

    it('checks which hull types go together and on what size of hull', () => {
      expect(codes(design(100, 'box', [], { options: ['tough', 'flimsy'] }), 'error')).toEqual(['option-clash']);
      expect(codes(design(1000, 'box', [], { options: ['warship'] }), 'error')).toEqual(['option-hull']);
      expect(codes(design(600, 'box', [], { options: ['weightless'] }), 'error')).toEqual(['option-hull']);
      expect(run(design(400, 'box', [], { options: ['weightless'] })).power.basic).toBe(20);
      expect(codes(design(100, 'box', [], { options: ['nonsense'] }), 'warn')).toContain('unknown-option');
    });
  });

  describe('drives', () => {
    it('fits a station-keeping drive of rating 0', () => {
      const spec = design(200, 'box', [{ kind: 'mdrive', rating: 0 }]);
      expect(line(spec, 'Manoeuvre')).toMatchObject({ tons: 1, cost: 1000, tl: 5, detail: 'Thrust 0' });
      expect(run(spec)).toMatchObject({ thrust: 0, power: { mdrive: 10 } });
    });

    it('works out what a drive sized for another tonnage delivers on this hull', () => {
      const spec = design(200, 'box', [{ kind: 'mdrive', rating: 3, tons: 300 }]);
      const drive = line(spec, 'Manoeuvre');
      expect(drive.tons).toBe(9);
      expect(drive.detail).toBe('Thrust 3, Thrust 4 on this hull, sized for 300 tons');
      expect(run(spec)).toMatchObject({ thrust: 4, power: { mdrive: 80 } });
    });

    it('halves the thrust of a hidden drive', () => {
      const spec = design(200, 'box', [{ kind: 'mdrive', rating: 4, options: ['hidden'] }]);
      expect(line(spec, 'Manoeuvre')).toMatchObject({ tons: 16, cost: 16_000 });
      expect(run(spec).thrust).toBe(2);
    });

    it('burns fuel by the hour in a reaction drive, which needs no power', () => {
      const spec = design(200, 'box', [
        { kind: 'rdrive', rating: 2 },
        { kind: 'plant', key: 'reactor', tons: 5 },
        { kind: 'fuel', tons: 50 },
      ]);
      const r = run(spec);
      expect(line(spec, 'Reaction')).toMatchObject({ tons: 8, cost: 800, power: 0 });
      expect(r.reaction).toEqual({ thrust: 2, fuelPerHour: 20, hours: 2.4 });
      expect(r.power.mdrive).toBe(0);
      expect(r.missing).not.toContain('mdrive');
      expect(shipFigures(r).thrust).toBe(2);
      expect(line(spec, 'Fuel').detail).toBe('200 weeks of operation, 2.4 hours of reaction thrust');
      expect(run(design(200, 'box', [{ kind: 'rdrive', rating: 0 }])).reaction.fuelPerHour).toBe(1);
    });

    it('counts a reaction drive beside a manoeuvre drive separately', () => {
      const r = run(design(200, 'box', [{ kind: 'mdrive', rating: 1 }, { kind: 'rdrive', rating: 3 }]));
      expect(r.thrust).toBe(1);
      expect(r.reaction.thrust).toBe(3);
      expect(shipFigures(r).thrust).toBe(1);
    });
  });

  describe('prototype and advanced components', () => {
    it('adds up size changes, prices from the standard size and shifts the tech level', () => {
      const spec = design(200, 'box', [{ kind: 'jdrive', rating: 2, grade: 'superb', mods: ['compact', 'sipping'] }], { tl: 9 });
      expect(line(spec, 'Jump')).toMatchObject({ tons: 9.6, cost: 96_000, tl: 9, detail: 'Jump-2, Superb: compact, sipping' });
      expect(run(spec).fuel.perParsec).toBe(18);
      const rough = design(200, 'box', [{ kind: 'mdrive', rating: 2, grade: 'rough', mods: ['bulky', 'bulky'] }]);
      expect(line(rough, 'Manoeuvre')).toMatchObject({ tons: 12, cost: 12_000, tl: 5, detail: 'Thrust 2, Rough: bulky x2' });
    });

    it('changes the power a drive draws', () => {
      const spec = design(200, 'box', [{ kind: 'mdrive', rating: 2, grade: 'cheap', mods: ['greedy'] }]);
      expect(run(spec).power.mdrive).toBe(80);
      expect(line(spec, 'Manoeuvre').cost).toBe(2000);
    });

    it('rounds up the extra output of a better power plant', () => {
      const spec = design(200, 'box', [{ kind: 'plant', key: 'reactor', tons: 10, grade: 'superb', mods: ['hot'] }], { tl: 8 });
      expect(line(spec, 'Power plant')).toMatchObject({ tons: 10, output: 125, cost: 40_000, tl: 8 });
    });

    it('holds the choices to what the grade allows', () => {
      const drive = (grade: string | undefined, mods: string[]) => design(200, 'box', [{ kind: 'mdrive', rating: 1, ...(grade ? { grade } : {}), mods }], { tl: 12 });
      expect(codes(drive('fine', ['compact', 'thrifty']), 'error')).toEqual(['custom-slots']);
      expect(codes(drive(undefined, ['compact']), 'error')).toEqual(['custom-grade']);
      expect(codes(drive('fine', ['bulky']), 'error')).toEqual(['custom-kind']);
      expect(codes(drive('superb', ['compact']), 'info')).toContain('custom-slots');
      expect(codes(drive('superb', ['compact', 'thrifty']))).not.toContain('custom-slots');
      expect(codes(drive('fine', ['sipping']), 'warn')).toContain('custom-unknown');
    });

    it('improves the weapons in a turret, and the whole of a heavier mount', () => {
      const turret = design(200, 'box', [{ kind: 'mount', key: 'cupola', weapons: ['zap', 'zap'], grade: 'fine', mods: ['thrifty'] }]);
      expect(line(turret, 'Cupola')).toMatchObject({ tons: 1, cost: 900, power: 4, tl: 6 });
      expect(codes(design(200, 'box', [{ kind: 'mount', key: 'cupola', weapons: ['zap'], grade: 'fine', mods: ['compact'] }]), 'error')).toEqual(['custom-turret']);
      const heavy = design(200, 'box', [{ kind: 'mount', key: 'casemate', weapons: ['thump'], grade: 'fine', mods: ['compact'] }]);
      expect(line(heavy, 'Casemate')).toMatchObject({ tons: 3.2, cost: 2000 });
    });

    it('applies to screens but not to ordinary fittings', () => {
      const ward = design(200, 'box', [{ kind: 'fitting', key: 'ward', grade: 'fine', mods: ['compact'] }], { tl: 8 });
      expect(line(ward, 'Ward')).toMatchObject({ tons: 4, cost: 2000, tl: 8 });
      expect(codes(design(200, 'box', [{ kind: 'fitting', key: 'cabin', grade: 'fine' }]), 'warn')).toContain('custom-unknown');
    });
  });

  describe('power and fuel', () => {
    it('feeds a plant that has its own appetite for fuel', () => {
      const r = run(design(200, 'box', [{ kind: 'plant', key: 'burner', tons: 10 }, { kind: 'fuel', tons: 60 }]));
      expect(r.power.output).toBe(40);
      expect(r.fuel).toMatchObject({ perPeriod: 60, weeks: 4 });
    });

    it('refuses to jump on a plant that cannot deliver the burst', () => {
      const parts: Omit<DesignPart, 'id'>[] = [{ kind: 'jdrive', rating: 1 }, { kind: 'plant', key: 'burner', tons: 10 }];
      expect(codes(design(200, 'box', parts), 'error')).toContain('plant-jump');
      expect(codes(design(200, 'box', [...parts, { kind: 'plant', key: 'reactor', tons: 2 }]), 'error')).not.toContain('plant-jump');
    });

    it('stores fuel in tanks that take more room', () => {
      const spec = design(200, 'box', [{ kind: 'fuel', tons: 30, options: ['sponge'] }]);
      expect(line(spec, 'Fuel')).toMatchObject({ tons: 60, cost: 1500, tl: 7 });
      expect(run(spec).fuel.tons).toBe(30);
    });

    it('keeps solar power and batteries apart from the plant', () => {
      const r = run(design(400, 'box', [{ kind: 'plant', key: 'reactor', tons: 4 }, { kind: 'fitting', key: 'cells', tons: 3 }, { kind: 'fitting', key: 'sails', tons: 5 }]));
      expect(r.power).toMatchObject({ output: 40, aux: 10, stored: 90 });
    });
  });

  describe('bridge and electronics', () => {
    it('grows the bridge beyond the end of the table', () => {
      expect(line(design(30_000, 'box', [{ kind: 'bridge', key: 'bridge' }]), 'Bridge')).toMatchObject({ tons: 40, cost: 300_000 });
    });

    it('prices and sizes bridge options', () => {
      expect(line(design(2000, 'box', [{ kind: 'bridge', key: 'bridge', options: ['flag'] }]), 'Bridge')).toMatchObject({ tons: 38, cost: 25_000 });
      expect(codes(design(1000, 'box', [{ kind: 'bridge', key: 'bridge', options: ['flag'] }]), 'error')).toContain('option-hull');
      expect(line(design(500, 'box', [{ kind: 'bridge', key: 'bridge', options: ['lifeboat'] }]), 'Bridge')).toMatchObject({ tons: 20, cost: 10_000 });
      expect(line(design(500, 'box', [{ kind: 'bridge', key: 'bridge', options: ['snug'] }]), 'Bridge')).toMatchObject({ tons: 4, cost: 2500 });
    });

    it('runs jump software on a computer core whatever its size', () => {
      const spec = design(200, 'box', [{ kind: 'jdrive', rating: 2 }, { kind: 'computer', key: 'vault' }, { kind: 'software', key: 'hop2' }], { tl: 8 });
      expect(codes(spec, 'error')).not.toContain('software-bandwidth');
      expect(line(spec, 'Hop/2')).toMatchObject({ cost: 0, detail: 'Included with the computer core' });
      expect(codes(design(200, 'box', [{ kind: 'jdrive', rating: 2 }, { kind: 'computer', key: 'vault' }], { tl: 8 }))).not.toContain('software-jump');
      expect(codes(design(200, 'box', [{ kind: 'computer', key: 'large', options: ['j'] }, { kind: 'software', key: 'hop2' }]), 'error')).toContain('software-bandwidth');
    });

    it('allows a primary computer and a lesser backup, and no more', () => {
      const three = design(200, 'box', [{ kind: 'computer', key: 'large' }, { kind: 'computer', key: 'small' }, { kind: 'computer', key: 'small' }]);
      expect(codes(three, 'error')).toContain('computer-max');
      expect(codes(design(200, 'box', [{ kind: 'computer', key: 'large' }, { kind: 'computer', key: 'large' }]), 'warn')).toContain('computer-backup');
      expect(run(three).computer?.name).toBe('Model 2');
    });

    it('scales a sensor suite fitted with an array', () => {
      expect(line(design(200, 'box', [{ kind: 'sensors', key: 'scope', options: ['boom'] }]), 'Scope')).toMatchObject({ tons: 6, cost: 1200, power: 4, tl: 7 });
    });
  });

  describe('weapons', () => {
    it('counts the hardpoints a large mount takes', () => {
      expect(run(design(400, 'box', [{ kind: 'mount', key: 'gallery', weapons: ['boom'] }])).hardpoints).toEqual({ total: 4, used: 4, firm: false });
      expect(codes(design(400, 'box', [{ kind: 'mount', key: 'gallery', weapons: ['boom'] }, { kind: 'mount', key: 'cupola', weapons: [] }]), 'error')).toEqual(['hardpoints']);
      const yard = design(400, 'box', [{ kind: 'mount', key: 'cupola', weapons: [] }]);
      const entry = catalogue(rules, yard).find((e) => e.key === 'gallery')!;
      expect(entryState(rules, yard, run(yard), entry).blocked).toBe('Needs 4 free hardpoints');
    });

    it('fits heavy weapons to a small craft at a price in firmpoints, tonnage and range', () => {
      const boat = design(60, 'box', [{ kind: 'mount', key: 'casemate', weapons: ['thump'] }]);
      expect(line(boat, 'Casemate')).toMatchObject({ tons: 6, power: 5, hardpoints: 3 });
      expect(codes(boat, 'error')).toEqual([]);
      expect(codes(design(60, 'box', [{ kind: 'mount', key: 'cupola', qty: 2, weapons: [] }]), 'error')).toEqual(['firmpoint-turrets']);
      expect(codes(design(60, 'box', [{ kind: 'mount', key: 'pintle', weapons: ['zap', 'zap'] }]), 'error')).toEqual(['mount-slots']);
    });

    it('prices mount options and checks what they fit', () => {
      expect(line(design(200, 'box', [{ kind: 'mount', key: 'cupola', weapons: [], options: ['shutter'] }]), 'Cupola')).toMatchObject({ tons: 2, cost: 125, tl: 6 });
      expect(codes(design(200, 'box', [{ kind: 'mount', key: 'casemate', weapons: ['thump'], options: ['shutter'] }]), 'error')).toEqual(['option-fit']);
    });

    it('sizes a spinal mount from its weapon', () => {
      const keel = (tons: number, rating: number, options?: string[]) => design(tons, 'box', [{ kind: 'mount', key: 'keel', weapons: ['lance'], rating, ...(options ? { options } : {}) }], { tl: 8 });
      expect(line(keel(2000, 2), 'Keel')).toMatchObject({ tons: 400, cost: 20_000, power: 200, hardpoints: 4, tl: 7, detail: 'Lance, 2x base size, 4D' });
      expect(line(keel(2000, 2, ['ahead']), 'Keel')).toMatchObject({ tons: 200, cost: 40_000, hardpoints: 2, tl: 8 });
      expect(codes(keel(5000, 5), 'error')).toEqual(['spinal-max']);
      expect(codes(keel(700, 2), 'error')).toEqual(['spinal-hull']);
      const fresh = defaultPart(rules, keel(2000, 1), run(keel(2000, 1)), { kind: 'mount', key: 'keel' });
      expect(fresh).toMatchObject({ rating: 1, weapons: ['lance'] });
    });
  });

  describe('fittings', () => {
    it('sizes a fitting from what it serves', () => {
      const spec = design(400, 'box', [{ kind: 'fitting', key: 'catapult', rating: 10, qty: 2 }, { kind: 'fitting', key: 'sling', rating: 80 }]);
      expect(line(spec, 'Catapult')).toMatchObject({ tons: 100, cost: 1000, power: 100, detail: 'x2, each for 10 ton craft' });
      expect(line(spec, 'Cargo sling')).toMatchObject({ tons: 0, cost: 160 });
      expect(defaultPart(rules, spec, run(spec), { kind: 'fitting', key: 'catapult' }).rating).toBe(10);
    });

    it('charges a share of the hull cost for what is done to the hull', () => {
      expect(line(design(400, 'box', [{ kind: 'fitting', key: 'swapBay', rating: 100 }]), 'Swap bays')).toMatchObject({ tons: 0, cost: 100_000 });
      expect(codes(design(400, 'box', [{ kind: 'fitting', key: 'swapBay', rating: 300 }]), 'error')).toEqual(['fitting-max']);
      const deep = design(400, 'box', [{ kind: 'fitting', key: 'deepHull' }]);
      expect(line(deep, 'Deep hull')).toMatchObject({ tons: 40, cost: 1_600_000 });
      expect(run(deep).armour).toBe(2);
    });

    it('sizes a fitting from the power plant wherever it sits in the list', () => {
      const spec = design(400, 'box', [{ kind: 'fitting', key: 'spare' }, { kind: 'plant', key: 'reactor', tons: 10 }]);
      expect(line(spec, 'Standby')).toMatchObject({ tons: 2, cost: 2000 });
      expect(run(spec).cargo).toBe(388);
    });

    it('sizes a share of the hull with a fixed part and a floor', () => {
      expect(line(design(400, 'box', [{ kind: 'fitting', key: 'funnel' }]), 'Funnel').tons).toBe(7);
      expect(line(design(100, 'box', [{ kind: 'fitting', key: 'funnel' }]), 'Funnel').tons).toBe(6);
    });

    it('limits coverage, and keeps apart what cannot be combined', () => {
      expect(codes(design(400, 'box', [{ kind: 'fitting', key: 'skin', qty: 120 }]), 'error')).toEqual(['fitting-max']);
      const both = design(400, 'box', [{ kind: 'fitting', key: 'skin', qty: 10 }, { kind: 'fitting', key: 'shadow' }]);
      expect(codes(both, 'error')).toEqual(['fitting-clash', 'fitting-clash']);
      expect(run(both).power.aux).toBe(5);
      const skinned = design(400, 'box', [{ kind: 'fitting', key: 'skin', qty: 10 }]);
      const shadow = catalogue(rules, skinned).find((e) => e.key === 'shadow')!;
      expect(entryState(rules, skinned, run(skinned), shadow).blocked).toBe('Not with sun skin');
    });

    it('holds fittings to the hulls they are made for', () => {
      expect(codes(design(100, 'box', [{ kind: 'fitting', key: 'flak' }]), 'error')).toEqual(['fitting-hull']);
      expect(codes(design(6000, 'box', [{ kind: 'fitting', key: 'desk' }]), 'error')).toEqual(['fitting-hull']);
      const small = design(100, 'box');
      const flak = catalogue(rules, small).find((e) => e.key === 'flak')!;
      expect(entryState(rules, small, run(small), flak).blocked).toBe('Hulls over 199 tons only');
      expect(run(design(400, 'box', [{ kind: 'fitting', key: 'flak', qty: 2 }])).hardpoints.used).toBe(2);
    });
  });

  describe('crew', () => {
    const fitted: Omit<DesignPart, 'id'>[] = [
      { kind: 'mdrive', rating: 2 },
      { kind: 'jdrive', rating: 1 },
      { kind: 'plant', key: 'reactor', tons: 30 },
      { kind: 'mount', key: 'cupola', qty: 3, weapons: [] },
      { kind: 'mount', key: 'casemate', weapons: ['thump'] },
      { kind: 'fitting', key: 'ward' },
      { kind: 'fitting', key: 'cabin', qty: 20 },
      { kind: 'craft', name: 'Boat', cost: 100, rating: 2 },
    ];
    const roster = (spec: ShipSpec) => run(spec).crew.map((c) => `${c.count} ${c.role}`);

    it('crews a commercial ship', () => {
      const r = run(design(1000, 'box', fitted));
      expect(r.crewing).toBe('commercial');
      expect(roster(design(1000, 'box', fitted))).toEqual(['1 captain', '3 pilot', '1 astrogator', '4 engineer', '1 maintenance', '5 gunner', '1 steward', '1 medic']);
      expect(r.crewCount).toBe(17);
    });

    it('crews the same ship as a warship', () => {
      const spec = design(1000, 'box', fitted, { crewing: 'military' });
      expect(roster(spec)).toEqual(['1 captain', '4 pilot', '1 astrogator', '4 engineer', '2 maintenance', '11 gunner', '1 administrator', '1 medic', '5 officer']);
      expect(run(spec).crewing).toBe('military');
    });

    it('needs fewer hands for its size on a large ship', () => {
      const big = run(design(6000, 'box', [{ kind: 'mdrive', rating: 1 }], { crewing: 'military' }));
      const of = (role: string) => big.crew.find((c) => c.role === role)?.count ?? 0;
      expect(of('maintenance')).toBe(7);
      expect(of('administrator')).toBe(4);
      expect(of('sensorOperator')).toBe(1);
      expect(of('engineer')).toBe(2);
    });

    it('mans a gallery to military standards whoever owns the ship', () => {
      const r = run(design(1000, 'box', [{ kind: 'mount', key: 'gallery', weapons: ['boom'] }]));
      expect(r.crew.find((c) => c.role === 'gunner')?.count).toBe(5);
    });

    it('counts troops in bunks apart from the crew', () => {
      expect(run(design(1000, 'box', [{ kind: 'fitting', key: 'bunks', qty: 12 }])).troops).toBe(12);
    });
  });

  it('builds faster in a higher-tech yard', () => {
    expect(run(design(1000, 'box', [], { tl: 7 })).buildDays).toBe(10);
    expect(run(design(1000, 'box', [], { tl: 8 })).buildDays).toBe(5);
  });

  it('offers a reaction drive in the catalogue', () => {
    const spec = design(200, 'box', [{ kind: 'rdrive', rating: 1 }]);
    const entry = catalogue(rules, spec).find((e) => e.kind === 'rdrive')!;
    expect(entry.name).toBe('Reaction drive');
    expect(entryState(rules, spec, run(spec), entry).blocked).toBe('Already fitted');
  });
});
