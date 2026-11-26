/** Character actions: creating sheets, rolling checks and attacks from them, taking and healing damage. */
import type { RulePack } from '../../shared/rulepack';
import { applyDamage, attackDm, checkDm, defaultChar, hasTrait, isMelee, parseDamage, rollWeaponDamage, traitValue, type DamageResult } from '../../shared/rules/character';
import { loadedWeapon } from '../../shared/rules/gear';
import type { CharKey, Character, CharScore, Id } from '../../shared/types';
import { newId } from '../../shared/util';
import { applyPreset, checkAudience, makeRoll, rollOptions } from './core';
import type { Tx } from '../state';
import { action, ActionError, check, type ActionCtx } from './registry';

const CHAR_KEYS: readonly CharKey[] = ['STR', 'DEX', 'END', 'INT', 'EDU', 'SOC', 'PSI'];

/** The character, if the caller may act for it: its owner or the GM. */
function controlled(ctx: ActionCtx, id: unknown): Character {
  const c = ctx.tx.need('character', check.id(id, 'id'));
  if (ctx.me.role !== 'gm' && !(c.kind === 'pc' && c.ownerId === ctx.me.playerId)) throw new ActionError('That is not your character');
  return c;
}

function actorName(c: Character): string {
  return c.name ?? (c.kind === 'creature' ? 'Creature' : 'Unnamed');
}

action('character.create', (ctx, p) => {
  const kind = check.oneOf(p.kind ?? 'pc', 'kind', ['pc', 'npc', 'creature'] as const);
  let ownerId: Id | undefined;
  if (ctx.me.role === 'gm') {
    if (p.ownerId) {
      const owner = ctx.tx.need('player', check.id(p.ownerId, 'ownerId'));
      ownerId = owner.id;
    }
  } else {
    if (kind !== 'pc') throw new ActionError('Players can only create their own characters');
    ownerId = ctx.me.playerId;
  }
  const rules = ctx.services.rules.pack.characters;
  const speciesId = check.optStr(p.species, 'species', { max: 40 }) ?? 'Human';
  const species = rules?.species.find((s) => s.name.toLowerCase() === speciesId.toLowerCase() || s.id === speciesId.toLowerCase());
  const chars: Partial<Record<CharKey, CharScore>> = {};
  for (const key of ['STR', 'DEX', 'END', 'INT', 'EDU', 'SOC'] as CharKey[]) {
    const given = p.chars?.[key];
    const score = given === undefined ? 7 : check.int(given, `chars.${key}`, { min: 0, max: 30 });
    chars[key] = { value: score, max: score };
  }
  const character = ctx.tx.create('character', {
    kind,
    ownerId,
    name: check.optStr(p.name, 'name', { max: 80 }),
    title: check.optStr(p.title, 'title', { max: 120 }),
    species: species?.name ?? speciesId,
    chars,
    skills: {},
    weapons: (species?.weapons ?? []).map((w) => ({ id: newId('wpn'), name: w.name, skill: w.skill, damage: w.damage, range: w.range })),
    armour: [],
    credits: 0,
    traits: species?.traits.map((t) => `${t.name}: ${t.note}`) ?? [],
    careers: [],
    conditions: [],
    movement: species?.movement ?? ctx.services.rules.pack.combat?.movement ?? 6,
  });
  if (kind !== 'pc' && p.reveal) applyPreset(ctx.tx, character.id, check.str(p.reveal.preset, 'reveal.preset', { max: 20 }), checkAudience(ctx.tx, p.reveal.audience, 'reveal.audience'));
  return { id: character.id };
});

action('character.check', (ctx, p) => {
  const c = controlled(ctx, p.id);
  const pack = ctx.services.rules.pack;
  const skill = check.optStr(p.skill, 'skill', { max: 80 });
  let char = p.char === undefined || p.char === null ? undefined : check.oneOf(p.char, 'char', CHAR_KEYS);
  if (!char && skill) char = defaultChar(skill, pack);
  if (!char && !skill) throw new ActionError('Choose a characteristic or a skill to roll');
  const extra = p.dm === undefined ? 0 : check.int(p.dm, 'dm', { min: -20, max: 20 });
  const { dm, parts } = checkDm(c, { char, skill, extra }, pack);
  const target = p.target === undefined || p.target === null ? (pack.tasks?.defaultTarget ?? 8) : check.int(p.target, 'target', { min: 0, max: 40 });
  const label = check.optStr(p.label, 'label', { max: 120 }) ?? [skill, char].filter(Boolean).join(' · ');
  const roll = makeRoll(ctx, { label, dm, target, actor: actorName(c), kind: p.initiative ? 'initiative' : 'check', characterId: c.id, breakdown: parts, ...rollOptions(p) });
  return { id: roll.id, dice: roll.dice, total: roll.total, effect: roll.effect, dm };
});

action('character.attack', (ctx, p) => {
  const c = controlled(ctx, p.id);
  const pack = ctx.services.rules.pack;
  const carried = c.weapons?.find((w) => w.id === p.weaponId);
  if (!carried) throw new ActionError('That weapon is no longer on the sheet');
  // special ammunition changes what the weapon does
  const weapon = loadedWeapon(carried, pack.gear);
  const mods: Record<string, number> = {};
  for (const [id, count] of Object.entries(check.obj(p.mods ?? {}, 'mods'))) mods[id] = check.int(count, `mods.${id}`, { min: 0, max: 10 });
  const fire = check.oneOf(p.fire ?? 'single', 'fire', ['single', 'burst', 'auto'] as const);
  const auto = traitValue(weapon.traits, 'Auto');
  if (fire !== 'single' && !auto) throw new ActionError('That weapon cannot fire bursts');
  // Burst and full-auto fire cannot benefit from aiming.
  if (fire !== 'single') delete mods.aim;
  const { dm, parts } = attackDm(
    c,
    weapon,
    {
      band: check.optStr(p.band, 'band', { max: 20 }),
      mods,
      extra: p.dm === undefined ? 0 : check.int(p.dm, 'dm', { min: -20, max: 20 }),
      char: p.char === undefined || p.char === null ? undefined : check.oneOf(p.char, 'char', CHAR_KEYS),
    },
    pack,
  );
  const target = pack.combat?.attackTarget ?? 8;
  const shots = fire === 'burst' ? auto : fire === 'auto' ? auto * 3 : isMelee(weapon) ? 0 : 1;
  if (typeof weapon.ammo === 'number' && shots > 0) {
    if (weapon.ammo < shots) throw new ActionError(weapon.ammo === 0 ? `${weapon.name} is empty. Reload first.` : `Only ${weapon.ammo} round${weapon.ammo === 1 ? '' : 's'} left: not enough for that.`);
    ctx.tx.update<Character>(c.id, (draft) => {
      const w = draft.weapons!.find((x) => x.id === weapon.id)!;
      w.ammo = (w.ammo ?? 0) - shots;
    });
  }
  const label = `Attack: ${weapon.name}${weapon.load ? ` [${weapon.load.name}]` : ''}${fire === 'burst' ? ' (burst)' : fire === 'auto' ? ' (full auto)' : ''}`;
  const roll = makeRoll(ctx, { label, dm, target, actor: actorName(c), kind: 'attack', characterId: c.id, breakdown: parts, ...rollOptions(p) });
  return { id: roll.id, dice: roll.dice, total: roll.total, effect: roll.effect, hit: (roll.effect ?? -1) >= 0, dm, damageDice: parseDamage(weapon.damage)?.dice ?? 0 };
});

action('character.weaponDamage', (ctx, p) => {
  const c = controlled(ctx, p.id);
  const pack = ctx.services.rules.pack;
  const carried = c.weapons?.find((w) => w.id === p.weaponId);
  if (!carried) throw new ActionError('That weapon is no longer on the sheet');
  const weapon = loadedWeapon(carried, pack.gear);
  const spec = parseDamage(weapon.damage);
  if (!spec) throw new ActionError(`${weapon.name} has no damage dice to roll`);
  const opts = rollOptions({ to: p.to, manual: p.manual }, spec.dice);
  const result = rollWeaponDamage(c, weapon, { effect: p.effect === undefined ? 0 : check.int(p.effect, 'effect', { min: -20, max: 40 }), burst: !!p.burst, manual: opts.manual }, pack)!;
  const roll = makeRoll(ctx, {
    label: `Damage: ${weapon.name}${weapon.load ? ` [${weapon.load.name}]` : ''}`,
    dm: result.mod,
    manual: opts.manual,
    fixedDice: result.dice,
    total: result.total,
    actor: actorName(c),
    kind: 'damage',
    characterId: c.id,
    breakdown: result.parts,
    detail: result.notes.join(' · ') || undefined,
    secret: opts.secret,
  });
  return { id: roll.id, total: result.total, ap: result.ap, stun: hasTrait(weapon.traits, 'Stun'), notes: result.notes };
});

action('character.reload', (ctx, p) => {
  const c = controlled(ctx, p.id);
  ctx.tx.update<Character>(c.id, (draft) => {
    const w = draft.weapons?.find((x) => x.id === p.weaponId);
    if (!w) throw new ActionError('That weapon is no longer on the sheet');
    if (typeof w.magazine === 'number') w.ammo = w.magazine;
  });
});

/** Takes damage off a character's sheet (armour first) and marks them down if it drops them. */
export function inflictDamage(tx: Tx, c: Character, amount: number, opts: Parameters<typeof applyDamage>[2], pack: RulePack): DamageResult {
  const result = applyDamage(c, amount, opts, pack);
  tx.update<Character>(c.id, (draft) => {
    draft.chars = result.chars;
    const conditions = new Set((draft.conditions ?? []).filter((x) => x !== 'Unconscious' && x !== 'Dead'));
    if (result.status === 'unconscious') conditions.add('Unconscious');
    if (result.status === 'dead') conditions.add('Dead');
    draft.conditions = [...conditions];
  });
  return result;
}

action('character.damage', (ctx, p) => {
  const c = controlled(ctx, p.id);
  const amount = check.int(p.amount, 'amount', { min: 0, max: 100000 });
  const result = inflictDamage(
    ctx.tx,
    c,
    amount,
    {
      armour: p.armour !== false,
      ap: p.ap === undefined ? 0 : check.int(p.ap, 'ap', { min: 0, max: 100 }),
      laser: !!p.laser,
      stun: !!p.stun,
      prefer: p.prefer === undefined || p.prefer === null ? undefined : check.oneOf(p.prefer, 'prefer', ['STR', 'DEX'] as const),
      effect: p.effect === undefined ? undefined : check.int(p.effect, 'effect', { min: -20, max: 40 }),
    },
    ctx.services.rules.pack,
  );
  return { taken: result.taken, absorbed: result.absorbed, status: result.status, stunnedRounds: result.stunnedRounds };
});

action('character.heal', (ctx, p) => {
  const c = controlled(ctx, p.id);
  const amount = p.full ? Infinity : check.int(p.amount, 'amount', { min: 0, max: 1000 });
  let left = amount;
  ctx.tx.update<Character>(c.id, (draft) => {
    // Healing restores in the reverse order damage is taken: STR and DEX first, END last.
    for (const key of (p.char ? [check.oneOf(p.char, 'char', CHAR_KEYS)] : (['STR', 'DEX', 'END'] as CharKey[]))) {
      const score = draft.chars?.[key];
      if (!score) continue;
      const gain = Math.min(left, score.max - score.value);
      score.value += gain;
      left -= gain;
    }
    const down = (['STR', 'DEX'] as CharKey[]).some((k) => draft.chars?.[k] && draft.chars[k]!.value === 0);
    if (!down) draft.conditions = (draft.conditions ?? []).filter((x) => x !== 'Unconscious' && x !== 'Dead');
  });
});
