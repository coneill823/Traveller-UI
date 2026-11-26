import { describe, expect, it } from 'vitest';
import type { RulePack } from '../src/shared/rulepack';
import { evaluateDesign, specFromStock } from '../src/shared/rules/ship';
import { HAS_CORE_RULES, hasPack, loadPacks } from './helpers';

const BOOKS = ['mgt2-ships-smallcraft', 'mgt2-ships-adventure', 'mgt2-ships-traders'];
const HAS_PACKS = HAS_CORE_RULES && hasPack('mgt2-highguard') && BOOKS.every(hasPack);

/** The ship catalogues, layered over the core and naval packs. Skipped where they are not installed. */
describe.skipIf(!HAS_PACKS)('stock designs from the ship catalogues', () => {
  const pack = HAS_PACKS ? loadPacks('mgt2-core', 'mgt2-highguard', ...BOOKS) : ({ packs: [] } as RulePack);
  const rules = pack.ships!;
  const report = (id: string) => evaluateDesign(rules, specFromStock(rules.designs.find((d) => d.id === id)!));

  it('gives every design an id of its own', () => {
    const ids = rules.designs.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(250);
  });

  it('builds every design without breaking a rule', () => {
    for (const d of rules.designs) {
      const r = evaluateDesign(rules, specFromStock(d));
      expect(r.issues.filter((i) => i.level === 'error').map((i) => `${d.id}: ${i.text}`)).toEqual([]);
      expect(r.lines.filter((l) => !l.known).map((l) => `${d.id}: ${l.label}`)).toEqual([]);
    }
  });

  it('matches the printed price of every listing that adds up', () => {
    const sound = rules.designs.filter((d) => d.listed && !d.note);
    expect(sound.length).toBeGreaterThan(130);
    for (const d of sound) {
      const r = evaluateDesign(rules, specFromStock(d));
      expect(Math.abs(r.purchase - d.listed!.cost), `${d.id} price`).toBeLessThanOrEqual(100);
      if (d.listed!.hull !== undefined) expect(r.hullPoints, `${d.id} hull`).toBe(d.listed!.hull);
      // the catalogues round the hold down to a tidy figure
      if (d.listed!.cargo !== undefined) expect(r.cargo - d.listed!.cargo, `${d.id} cargo`).toBeGreaterThan(-0.011);
    }
  });

  it('lets small craft carry only the fuel their plant burns', () => {
    const fighter = report('ultralightFighter');
    expect(fighter.fuel).toMatchObject({ tons: 1, perPeriod: 0.1, weeks: 40 });
    expect(report('freeTrader').fuel.perPeriod).toBe(1);
  });

  it('adds lasers in bays and the burst laser', () => {
    const names = rules.weapons.map((w) => w.name);
    for (const name of ['Burst laser', 'Small pulse laser bay', 'Large beam laser bay']) expect(names).toContain(name);
  });
});
