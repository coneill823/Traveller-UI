import { describe, expect, it } from 'vitest';
import type { RulePack } from '../src/shared/rulepack';
import { catalogue, evaluateDesign, specFromStock } from '../src/shared/rules/ship';
import { HAS_CORE_RULES, hasPack, loadPacks } from './helpers';

const HAS_PACK = HAS_CORE_RULES && hasPack('mgt2-highguard');

/** The naval construction rules, layered over the core pack. Skipped where that pack is not installed. */
describe.skipIf(!HAS_PACK)('ship design with the High Guard pack', () => {
  const pack = HAS_PACK ? loadPacks('mgt2-core', 'mgt2-highguard') : ({ packs: [] } as RulePack);
  const rules = pack.ships!;
  const design = (id: string) => rules.designs.find((d) => d.id === id)!;
  const report = (id: string) => evaluateDesign(rules, specFromStock(design(id)));
  const fromBook = () => rules.designs.filter((d) => d.source === 'High Guard');

  it('builds every listed ship without breaking a rule', () => {
    expect(fromBook().length).toBeGreaterThan(50);
    for (const d of fromBook()) {
      const r = evaluateDesign(rules, specFromStock(d));
      expect(r.issues.filter((i) => i.level === 'error').map((i) => `${d.id}: ${i.text}`)).toEqual([]);
      expect(r.lines.filter((l) => !l.known).map((l) => `${d.id}: ${l.label}`)).toEqual([]);
    }
  });

  it('reproduces the printed figures of every listing that adds up', () => {
    const sound = fromBook().filter((d) => !d.note);
    expect(sound.length).toBeGreaterThanOrEqual(30);
    for (const d of sound) {
      const r = evaluateDesign(rules, specFromStock(d));
      expect(Math.abs(r.purchase - d.listed!.cost), `${d.id} price`).toBeLessThanOrEqual(100);
      if (d.listed!.hull !== undefined) expect(r.hullPoints, `${d.id} hull`).toBe(d.listed!.hull);
      if (d.listed!.cargo !== undefined) expect(Math.abs(r.cargo - d.listed!.cargo), `${d.id} cargo`).toBeLessThan(0.011);
    }
  });

  it('prices a destroyer to the credit', () => {
    const r = report('miduAgashaam');
    expect(r.cost).toBe(2_056_260_000);
    expect(r).toMatchObject({ hullPoints: 1320, armour: 4, thrust: 6, jump: 4, cargo: 52.8 });
    expect(r.power).toMatchObject({ output: 3540, basic: 600, jdrive: 1200 });
    expect(r.crewing).toBe('military');
  });

  it('sizes armour for small and awkward hulls', () => {
    const fighter = report('ultralightFighter');
    expect(fighter.lines.find((l) => l.kind === 'armour')).toMatchObject({ tons: 1.08, cost: 216_000 });
    expect(fighter.cargo).toBe(0.06);
    const escort = report('closeEscort');
    expect(escort.lines.find((l) => l.kind === 'armour')).toMatchObject({ tons: 14.4, cost: 7_200_000 });
  });

  it('builds a monitor into a buffered planetoid', () => {
    const r = report('planetoidMonitor');
    expect(r.lines[0]).toMatchObject({ tons: 17_500, cost: 200_000_000 });
    expect(r.armour).toBe(15);
    expect(r.hullPoints).toBe(37_500);
    expect(r.jump).toBe(0);
  });

  it('fits a spinal mount ahead of its tech level', () => {
    const spinal = report('kokirrak').lines.find((l) => l.label.startsWith('Spinal'))!;
    expect(spinal).toMatchObject({ tons: 30_000, cost: 13_000_000_000, hardpoints: 300 });
  });

  it('replaces the core book designs with the fuller listings', () => {
    expect(design('freeTrader').source).toBe('High Guard');
    expect(report('freeTrader').lines.find((l) => l.kind === 'armour')?.tons).toBe(6);
    // a core design with no counterpart still builds under the fuller rules
    expect(report('gig').issues.filter((i) => i.level === 'error')).toEqual([]);
  });

  it('offers the new parts in the catalogue', () => {
    const entries = catalogue(rules, specFromStock(design('patrolCorvette')));
    const names = entries.map((e) => e.name);
    for (const name of ['Reaction drive', 'Small bay', 'Spinal mount', 'Meson screen', 'Titanium steel armour', 'Core/40']) expect(names).toContain(name);
    expect(entries.find((e) => e.key === 'crystaliron')?.figures).toBe('6 t · MCr1.2 per point');
  });
});
