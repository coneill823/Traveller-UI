import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RulePack } from '../src/shared/rulepack';
import { blankSpec, catalogue, defaultPart, entryState, evaluateDesign, fuelTonsFor, hardpointsFor, isBuildable, matchingStock, plantTonsFor, specFromStock, yardAt, yardIssues } from '../src/shared/rules/ship';
import type { DesignPart, Ship, ShipDesign, ShipSpec } from '../src/shared/types';
import { eventually, HAS_CORE_RULES, loadCorePack, setTable, type Table } from './helpers';

describe.skipIf(!HAS_CORE_RULES)('ship design from the core pack', () => {
  const pack = HAS_CORE_RULES ? loadCorePack() : ({ packs: [] } as RulePack);
  const rules = pack.ships!;
  const stock = (id: string) => specFromStock(rules.designs.find((d) => d.id === id)!);
  const report = (id: string) => evaluateDesign(rules, stock(id));
  const codes = (spec: ShipSpec, level?: string) =>
    evaluateDesign(rules, spec)
      .issues.filter((i) => !level || i.level === level)
      .map((i) => i.code);

  it('rebuilds the scout exactly as printed', () => {
    const r = report('scout');
    const line = (label: string) => r.lines.find((l) => l.label.startsWith(label))!;
    expect(line('100-ton hull').cost).toBe(6_000_000);
    expect(line('Crystaliron')).toMatchObject({ tons: 5, cost: 1_200_000 });
    expect(line('Manoeuvre')).toMatchObject({ tons: 2, cost: 4_000_000, detail: 'Thrust 2' });
    expect(line('Jump drive')).toMatchObject({ tons: 10, cost: 15_000_000 });
    expect(line('Power plant')).toMatchObject({ tons: 4, cost: 4_000_000, output: 60 });
    expect(line('Fuel tanks')).toMatchObject({ tons: 23, detail: 'J-2, 12 weeks of operation' });
    expect(line('Bridge')).toMatchObject({ tons: 10, cost: 500_000 });
    expect(line('Computer/5bis').cost).toBe(45_000);
    expect(line('Docking space')).toMatchObject({ tons: 5, cost: 1_250_000 });
    expect(line('Probe drones')).toMatchObject({ tons: 2, cost: 1_000_000 });
    expect(r.cargo).toBe(12);
    expect(r.hullPoints).toBe(40);
    expect(r.purchase).toBe(36_940_500);
    expect(r.discountPct).toBe(10);
    expect(r.power).toMatchObject({ output: 60, basic: 20, mdrive: 20, jdrive: 20 });
    expect(r.crew.map((c) => c.role)).toEqual(['pilot', 'astrogator', 'engineer', 'gunner']);
    expect(r.hardpoints).toEqual({ total: 1, used: 1, firm: false });
    expect(r.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(r.buildDays).toBe(37);
  });

  // Designs whose printed price equals the sum of their printed parts.
  const consistent = ['scout', 'seeker', 'freeTrader', 'farTrader', 'safari', 'sdb', 'yacht', 'closeEscort', 'labShip', 'patrolCorvette', 'subsidisedMerchant', 'subsidisedLiner', 'lightFighter', 'launch', 'shipsBoat', 'slowBoat', 'slowPinnace', 'modularCutter', 'passengerShuttle'];
  it.each(consistent)('prices the %s as the book does', (id) => {
    const design = rules.designs.find((d) => d.id === id)!;
    const r = report(id);
    expect(r.purchase).toBe(design.listed!.cost);
    expect(r.hullPoints).toBe(design.listed!.hull);
  });

  it('leaves the printed cargo space in every stock design that adds up', () => {
    const off: string[] = [];
    for (const design of rules.designs) {
      const r = evaluateDesign(rules, specFromStock(design));
      if (Math.abs(r.cargo - (design.listed?.cargo ?? r.cargo)) > 0.001) off.push(`${design.id}: ${r.cargo} vs ${design.listed?.cargo}`);
      expect(r.issues.filter((i) => i.level === 'error').map((i) => `${design.id}: ${i.text}`)).toEqual([]);
      expect(r.lines.every((l) => l.known)).toBe(true);
    }
    // Known slips in the printed tables: the survey scout's drive, two small craft that do not add up, and the SDB's rounded armour.
    expect(off.map((o) => o.split(':')[0]).sort()).toEqual(['modularCutter', 'sdb', 'shuttle', 'surveyScout']);
  });

  it('works out crews, quarters and running costs', () => {
    const trader = report('freeTrader');
    expect(trader.crew.map((c) => `${c.count} ${c.role}`)).toEqual(['1 pilot', '1 astrogator', '1 engineer', '1 medic', '1 steward']);
    expect(trader.payroll).toBe(6000 + 5000 + 4000 + 4000 + 2000);
    expect(trader.quarters).toMatchObject({ staterooms: 10, lowBerths: 20 });
    expect(trader.maintenance).toBe(3861);
    expect(report('closeEscort').crew.find((c) => c.role === 'engineer')!.count).toBe(4);
    expect(report('closeEscort').fuel).toMatchObject({ parsecs: 3, weeks: 8 });
    expect(report('pinnace').crew.map((c) => c.role)).toEqual(['pilot']);
    // Carried craft are left out of maintenance.
    const yacht = report('yacht');
    expect(yacht.maintenance).toBe(Math.round((67_007_000 - 250_000 - 7_272_000 - 155_000) / 12000));
  });

  it('gives small craft firmpoints and ships hardpoints', () => {
    expect(hardpointsFor(rules, 10)).toEqual({ total: 1, firm: true });
    expect(hardpointsFor(rules, 50)).toEqual({ total: 2, firm: true });
    expect(hardpointsFor(rules, 95)).toEqual({ total: 3, firm: true });
    expect(hardpointsFor(rules, 100)).toEqual({ total: 1, firm: false });
    expect(hardpointsFor(rules, 799)).toEqual({ total: 7, firm: false });
  });

  it('says what a bare hull still needs', () => {
    const spec = blankSpec(rules, 200, 12);
    const r = evaluateDesign(rules, spec);
    expect(r.missing).toEqual(['plant', 'bridge', 'computer', 'mdrive']);
    expect(isBuildable(r)).toBe(false);
    expect(r.cargo).toBe(200);
    const palette = catalogue(rules, spec);
    const needed = palette.filter((e) => entryState(rules, spec, r, e).needed).map((e) => e.kind);
    expect(new Set(needed)).toEqual(new Set(['plant', 'bridge', 'computer', 'mdrive']));
  });

  it('flags parts that do not fit', () => {
    const add = (spec: ShipSpec, part: Omit<DesignPart, 'id'>): ShipSpec => ({ ...spec, parts: [...spec.parts, { ...part, id: `x${spec.parts.length}` }] });
    const trader = stock('freeTrader');
    expect(codes(add(trader, { kind: 'fitting', key: 'stateroom', qty: 30 }), 'error')).toEqual(['tonnage']);
    expect(codes(add(trader, { kind: 'jdrive', rating: 2 }), 'error')).toContain('drive-dup');
    expect(codes(add(trader, { kind: 'mount', key: 'turret3', qty: 3, weapons: [] }), 'error')).toContain('hardpoints');
    expect(codes(add(trader, { kind: 'mount', key: 'turret1', weapons: ['beam', 'beam'] }), 'error')).toContain('mount-slots');
    expect(codes(add(trader, { kind: 'mount', key: 'turret2', weapons: ['particle'] }), 'error')).toContain('mount-weapon');
    expect(codes(add(trader, { kind: 'software', key: 'fire4' }), 'error')).toContain('software-bandwidth');
    expect(codes(add(trader, { kind: 'computer', key: 'c35' }), 'error')).toContain('tl');
    expect(codes({ ...trader, hull: { ...trader.hull, config: 'dispersed' } }, 'error')).toContain('armour-config');
    // Jump Control/2 only runs on a Computer/5 with the jump specialisation.
    const far = stock('farTrader');
    const plain = { ...far, parts: far.parts.map((p) => (p.kind === 'computer' ? { ...p, options: [] } : p)) };
    expect(codes(plain, 'error')).toContain('software-bandwidth');
    // Crystaliron tops out at 13 points or the tech level.
    const armoured = { ...trader, parts: trader.parts.map((p) => (p.kind === 'armour' ? { ...p, rating: 13 } : p)) };
    expect(codes(armoured, 'error')).toContain('armour-max');
    // Small craft cannot jump, and their firmpoints take only light mounts.
    const boat = stock('shipsBoat');
    expect(codes(add(boat, { kind: 'jdrive', rating: 1 }), 'error')).toContain('jump-small');
    expect(codes(add(boat, { kind: 'mount', key: 'turret2', weapons: [] }), 'error')).toContain('mount-firmpoint');
    const big = { ...boat, hull: { ...boat.hull, tons: 60 }, parts: boat.parts.map((p) => (p.kind === 'bridge' ? { ...p, key: 'cockpit' } : p)) };
    expect(codes(big, 'error')).toContain('cockpit-size');
  });

  it('warns about power and fuel shortfalls', () => {
    const trader = stock('freeTrader');
    const starved = { ...trader, parts: trader.parts.map((p) => (p.kind === 'plant' ? { ...p, tons: 3 } : p)) };
    expect(codes(starved)).toContain('power-thrust');
    const dry = { ...trader, parts: trader.parts.map((p) => (p.kind === 'fuel' ? { ...p, tons: 10 } : p)) };
    expect(codes(dry)).toContain('fuel-jump');
    const noSoftware = { ...trader, parts: trader.parts.filter((p) => p.kind !== 'software') };
    expect(evaluateDesign(rules, noSoftware).missing).toContain('software');
    const r = evaluateDesign(rules, trader);
    expect(fuelTonsFor(rules, r)).toBe(21);
    expect(fuelTonsFor(rules, r, 8)).toBe(22);
    expect(plantTonsFor(rules, r, 'fusion12')).toBe(5);
  });

  it('loses the standard design discount as soon as a stock design is changed', () => {
    const scout = stock('scout');
    expect(matchingStock(rules, scout)?.id).toBe('scout');
    // Re-ordering parts along the hull is not a design change.
    expect(matchingStock(rules, { ...scout, parts: [...scout.parts].reverse() })?.id).toBe('scout');
    const changed = { ...scout, parts: scout.parts.map((p) => (p.kind === 'fitting' && p.key === 'stateroom' ? { ...p, qty: 3 } : p)) };
    expect(matchingStock(rules, changed)).toBeUndefined();
    const r = evaluateDesign(rules, changed);
    expect(r.discountPct).toBe(0);
    expect(r.cargo).toBe(16);
  });

  it('sizes new parts to suit the design', () => {
    let spec = blankSpec(rules, 200, 12);
    const put = (kind: DesignPart['kind'], key?: string, patch: Partial<DesignPart> = {}) => {
      const part = { ...defaultPart(rules, spec, evaluateDesign(rules, spec), { kind, key }), ...patch };
      spec = { ...spec, parts: [...spec.parts, part] };
      return part;
    };
    put('mdrive', undefined, { rating: 2 });
    put('jdrive', undefined, { rating: 1 });
    expect(put('plant', 'fusion12').tons).toBe(6); // basic 40 + thrust 40 = 80 Power
    expect(put('fuel').tons).toBe(21);
    put('bridge', 'bridge');
    put('computer', 'c5');
    put('software', 'jump1');
    expect(evaluateDesign(rules, spec).issues.filter((i) => i.level !== 'info').map((i) => i.code)).toEqual(['quarters']);
    put('fitting', 'stateroom', { qty: 3 });
    const r = evaluateDesign(rules, spec);
    expect(r.issues.filter((i) => i.level !== 'info')).toEqual([]);
    expect(isBuildable(r)).toBe(true);
    expect(r.cargo).toBe(200 - 4 - 10 - 6 - 21 - 10 - 12);
  });

  it('knows what each class of starport can build', () => {
    const world = pack.world;
    const far = report('farTrader');
    const boat = report('shipsBoat');
    const a = yardAt(rules, world, 'A788899-C');
    expect(a).toMatchObject({ starport: 'A', tl: 12 });
    expect(yardIssues(far, a)).toEqual([]);
    expect(yardIssues(far, yardAt(rules, world, 'B788899-C')).map((i) => i.code)).toEqual(['yard-jump']);
    expect(yardIssues(far, yardAt(rules, world, 'C788899-C')).map((i) => i.code)).toEqual(['yard-class', 'yard-jump']);
    expect(yardIssues(boat, yardAt(rules, world, 'C788899-C'))).toEqual([]);
    expect(yardIssues(boat, yardAt(rules, world, 'D788899-C')).map((i) => i.code)).toEqual(['yard-none']);
    // A TL9 yard cannot make a TL12 power plant or a jump-2 drive.
    const low = yardIssues(far, yardAt(rules, world, 'A788899-9')).map((i) => i.text);
    expect(low.some((t) => t.startsWith('Jump drive needs a TL11 shipyard'))).toBe(true);
    expect(low.some((t) => t.startsWith('Power plant needs a TL12 shipyard'))).toBe(true);
    const palette = catalogue(rules, stock('farTrader'));
    const fusion15 = palette.find((e) => e.key === 'fusion15')!;
    expect(entryState(rules, stock('farTrader'), far, fusion15).blocked).toBe('Needs TL15');
    const turret = palette.find((e) => e.key === 'turret1')!;
    expect(entryState(rules, stock('farTrader'), far, turret, 6).blocked).toBe('Needs a TL7 shipyard');
  });
});

describe.skipIf(!HAS_CORE_RULES)('the shipyard on the server', () => {
  let table: Table;
  let ann: Awaited<ReturnType<Table['join']>>;
  let bob: Awaited<ReturnType<Table['join']>>;
  let forge: string;
  let backwater: string;
  let account: string;

  beforeAll(async () => {
    table = await setTable();
    ann = await table.join('Ann');
    bob = await table.join('Bob');
    const sectorId = (await table.gm.act('sector.create', { name: 'Kestrel Reach', x: 0, y: 0 })).id;
    forge = (await table.gm.act('system.create', { sectorId, hex: '0101', name: 'Forge', uwp: 'A7879A9-C' })).id;
    backwater = (await table.gm.act('system.create', { sectorId, hex: '0102', name: 'Backwater', uwp: 'C566675-7' })).id;
    account = (await table.gm.act('ship.create', { name: 'Borrowed Time', tons: 200, funds: 80_000_000 })).id;
    await table.gm.act('party.moveTo', { systemId: backwater });
  });
  afterAll(async () => {
    await table.close();
  });

  it('keeps a draft private until its author shares it', async () => {
    const id = (await ann.client.act('design.create', { stock: 'farTrader', name: 'Second Chance' })).id;
    await eventually(() => expect(ann.client.get<ShipDesign>(id)).toMatchObject({ name: 'Second Chance', status: 'draft', ownerId: ann.id }));
    expect(table.gm.get<ShipDesign>(id)?.spec.parts.length).toBe(14);
    expect(bob.client.get(id)).toBeUndefined();
    await expect(bob.client.act('design.update', { id, name: 'Mine now' })).rejects.toThrow();
    await ann.client.act('design.share', { id, shared: true });
    await eventually(() => expect(bob.client.get<ShipDesign>(id)?.name).toBe('Second Chance'));
    await expect(bob.client.act('design.update', { id, name: 'Mine now' })).rejects.toThrow(/whoever drew up/);
    await ann.client.act('design.share', { id, shared: false });
    await eventually(() => expect(bob.client.get(id)).toBeUndefined());
    await ann.client.act('design.delete', { id });
    await eventually(() => expect(table.gm.get(id)).toBeUndefined());
  });

  it('takes a design from draft to sign-off to a ship in the yard', async () => {
    const id = (await ann.client.act('design.create', { stock: 'farTrader', name: 'Second Chance' })).id;
    await eventually(() => expect(ann.client.get<ShipDesign>(id)).toBeDefined());
    // Ann swaps four low berths for a turret; the change costs the standard-design discount.
    const spec = structuredClone(ann.client.get<ShipDesign>(id)!.spec);
    spec.parts = spec.parts.map((p) => (p.key === 'lowBerth' ? { ...p, qty: 2 } : p));
    spec.parts.push({ id: 'turret', kind: 'mount', key: 'turret2', weapons: ['pulse', 'sandcaster'] });
    await ann.client.act('design.update', { id, spec });
    await expect(ann.client.act('design.build', { id, payerId: account })).rejects.toThrow(/not signed off/);

    await ann.client.act('design.propose', { id });
    await eventually(() => expect(bob.client.get<ShipDesign>(id)).toMatchObject({ status: 'proposed', approvals: [ann.id] }));
    await bob.client.act('design.approve', { id });
    await eventually(() => expect(ann.client.get<ShipDesign>(id)?.status).toBe('approved'));

    // Changing a design that was signed off sends it back to the party.
    await ann.client.act('design.update', { id, spec: { ...spec, parts: [...spec.parts, { id: 'bay', kind: 'fitting', key: 'medicalBay', qty: 1 }] } });
    await eventually(() => expect(bob.client.get<ShipDesign>(id)).toMatchObject({ status: 'proposed', approvals: [ann.id] }));
    await bob.client.act('design.approve', { id });
    await eventually(() => expect(ann.client.get<ShipDesign>(id)?.status).toBe('approved'));

    // A class C port with TL7 cannot build a TL12 starship; the class A yard at Forge can.
    await expect(ann.client.act('design.build', { id, payerId: account })).rejects.toThrow(/Backwater cannot build it/);
    await table.gm.act('party.moveTo', { systemId: forge });
    const built = await ann.client.act('design.build', { id, payerId: account, name: 'Second Chance' });
    const rules = loadCorePack().ships!;
    const report = evaluateDesign(rules, ann.client.get<ShipDesign>(id)!.spec);
    expect(report.discountPct).toBe(0);
    expect(built).toMatchObject({ price: report.purchase, days: report.buildDays });
    await eventually(() => {
      expect(bob.client.get<ShipDesign>(id)).toMatchObject({ status: 'built', shipId: built.shipId, built: { price: report.purchase, systemId: forge } });
      const ship = bob.client.get<Ship>(built.shipId)!;
      expect(ship).toMatchObject({ name: 'Second Chance', party: true, tons: 200, jump: 2, thrust: 1, hullMax: 80, hull: 80, armour: 2, staterooms: 10, lowBerths: 2, fuelCapacity: 41, fuel: 41, designId: id });
      expect(ship.cargo).toBe(report.cargo);
      expect(ship.construction).toMatchObject({ systemId: forge });
      expect(ship.spec?.parts.length).toBe(16);
      expect(bob.client.get<Ship>(account)!.funds).toBe(80_000_000 - report.purchase);
    });
    await expect(ann.client.act('design.update', { id, name: 'Too late' })).rejects.toThrow(/has been built/);
  });

  it('lets the GM sign off for the table, and refits an existing ship for the difference', async () => {
    const shipId = table.gm.all('ship').find((s) => s.name === 'Second Chance')!.id;
    await table.gm.act('ship.update', { id: shipId, ops: [{ op: 'del', path: ['construction'] }, { op: 'set', path: ['hull'], value: 70 }, { op: 'set', path: ['funds'], value: 5_000_000 }] });
    const id = (await bob.client.act('design.create', { refitOf: shipId })).id;
    await eventually(() => expect(bob.client.get<ShipDesign>(id)).toMatchObject({ refitOf: shipId, status: 'draft' }));
    const spec = structuredClone(bob.client.get<ShipDesign>(id)!.spec);
    spec.parts = spec.parts.map((p) => (p.kind === 'sensors' ? { ...p, key: 'military' } : p));
    await bob.client.act('design.update', { id, spec });
    await bob.client.act('design.propose', { id });
    await table.gm.act('design.approve', { id });
    await eventually(() => expect(bob.client.get<ShipDesign>(id)?.status).toBe('approved'));
    const built = await bob.client.act('design.build', { id, payerId: shipId });
    // Military sensors cost MCr4.1 against MCr3 for the civilian suite.
    expect(built).toMatchObject({ shipId, price: 1_100_000, days: 2 });
    await eventually(() => {
      const ship = ann.client.get<Ship>(shipId)!;
      expect(ship.funds).toBe(3_900_000);
      expect(ship.hull).toBe(70);
      expect(ship.cargo).toBe(evaluateDesign(loadCorePack().ships!, spec).cargo);
      expect(ship.spec?.parts.find((p) => p.kind === 'sensors')?.key).toBe('military');
    });
  });

  it('refuses designs that cannot fly and malformed outlines', async () => {
    const id = (await ann.client.act('design.create', { tons: 100, tl: 9 })).id;
    await ann.client.act('design.propose', { id });
    await table.gm.act('design.approve', { id });
    await expect(ann.client.act('design.build', { id, payerId: account })).rejects.toThrow(/cannot be built as drawn/);
    const spec = structuredClone(table.gm.get<ShipDesign>(id)!.spec);
    await expect(ann.client.act('design.update', { id, spec: { ...spec, outline: { kind: 'path', d: 'M0 0 <script>', viewBox: [0, 0, 10, 10] } } })).rejects.toThrow(/not valid SVG path/);
    await expect(ann.client.act('design.update', { id, spec: { ...spec, outline: { kind: 'image', url: 'https://example.com/x.png' } } })).rejects.toThrow(/uploaded to this server/);
    await ann.client.act('design.update', { id, spec: { ...spec, outline: { kind: 'path', d: 'M0 0 L10 0 L5 8 Z', viewBox: [0, 0, 10, 10], name: 'Dart' } } });
    await eventually(() => expect(bob.client.get<ShipDesign>(id)?.spec.outline).toMatchObject({ kind: 'path', name: 'Dart' }));
    // The GM can lay down anything, anywhere, at any price.
    const forced = await table.gm.act('design.build', { id, force: true, price: 0, instant: true, systemId: backwater });
    expect(forced).toMatchObject({ days: 0, price: 0 });
    await eventually(() => expect(ann.client.get<Ship>(forced.shipId)).toMatchObject({ tons: 100, location: { systemId: backwater } }));
    expect(ann.client.get<Ship>(forced.shipId)!.construction).toBeUndefined();
  });
});
