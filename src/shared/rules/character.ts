/**
 * Character rules engine: characteristic modifiers, skill levels (including specialities and the
 * unskilled penalty), check and attack modifiers, damage dice and damage allocation.
 * Numbers come from the rules pack.
 */
import type { CombatRules, RulePack, SkillDef, TaskRules } from '../rulepack';
import type { CharKey, Character, CharacterWeapon, CharScore } from '../types';
import { rollDice, sum, type Rng } from '../util';

const FALLBACK_DM = [
  { max: 0, dm: -3 },
  { max: 2, dm: -2 },
  { max: 5, dm: -1 },
  { max: 8, dm: 0 },
  { max: 11, dm: 1 },
  { max: 14, dm: 2 },
  { max: 99, dm: 3 },
];

/** Dice modifier for a characteristic score. */
export function charDm(score: number | undefined, tasks?: TaskRules): number {
  if (score === undefined) return 0;
  const table = tasks?.characteristicDm ?? FALLBACK_DM;
  return (table.find((row) => score <= row.max) ?? table[table.length - 1]).dm;
}

/** Splits "Pilot (spacecraft)" into its skill and speciality. */
export function splitSkill(name: string): { base: string; speciality?: string } {
  const m = /^(.+?)\s*\((.+)\)\s*$/.exec(name.trim());
  return m ? { base: m[1].trim(), speciality: m[2].trim() } : { base: name.trim() };
}

export function joinSkill(base: string, speciality?: string): string {
  return speciality ? `${base} (${speciality})` : base;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * A character's level in a skill, or null when they are unskilled.
 * Having any level in a skill (or one of its specialities) gives level 0 in all its specialities;
 * a speciality's own level applies only to that speciality.
 */
export function skillLevel(skills: Record<string, number> | undefined, name: string): number | null {
  if (!skills) return null;
  const want = splitSkill(name);
  let best: number | null = null;
  for (const [key, level] of Object.entries(skills)) {
    const have = splitSkill(key);
    if (!same(have.base, want.base)) continue;
    if (!want.speciality) {
      // Asking for the bare skill: the best of the bare level and any speciality.
      best = Math.max(best ?? 0, level);
    } else if (have.speciality && same(have.speciality, want.speciality)) {
      best = Math.max(best ?? 0, level);
    } else {
      best = Math.max(best ?? 0, 0);
    }
  }
  return best;
}

/** DM for attempting a skill the character does not have, after Jack-of-all-Trades. */
export function unskilledDm(skills: Record<string, number> | undefined, pack: RulePack): number {
  const base = pack.tasks?.unskilledDm ?? -3;
  const jackName = pack.characters?.skills.find((s) => s.special === 'jack')?.name ?? 'Jack-of-All-Trades';
  const jack = skillLevel(skills, jackName) ?? 0;
  return Math.min(0, base + Math.max(0, jack));
}

export interface DmPart {
  label: string;
  dm: number;
}

export interface CheckSpec {
  char?: CharKey;
  skill?: string;
  /** Situational modifier chosen by the roller. */
  extra?: number;
}

/** Total modifier for a check, with the parts that make it up. */
export function checkDm(character: Character, spec: CheckSpec, pack: RulePack): { dm: number; parts: DmPart[] } {
  const parts: DmPart[] = [];
  if (spec.char) {
    const score = character.chars?.[spec.char]?.value;
    parts.push({ label: `${spec.char} ${score ?? '—'}`, dm: charDm(score, pack.tasks) });
  }
  if (spec.skill) {
    const level = skillLevel(character.skills, spec.skill);
    if (level === null) parts.push({ label: `${spec.skill} (unskilled)`, dm: unskilledDm(character.skills, pack) });
    else parts.push({ label: `${spec.skill} ${level}`, dm: level });
  }
  if (spec.extra) parts.push({ label: 'Situation', dm: spec.extra });
  return { dm: parts.reduce((n, p) => n + p.dm, 0), parts };
}

/** The characteristic usually rolled with a skill. */
export function defaultChar(skillName: string, pack: RulePack): CharKey | undefined {
  const { base, speciality } = splitSkill(skillName);
  const def = pack.characters?.skills.find((s) => same(s.name, base));
  if (!def) return undefined;
  const special = speciality ? Object.entries(def.specialityChar ?? {}).find(([k]) => same(k, speciality))?.[1] : undefined;
  return (special ?? def.char) as CharKey | undefined;
}

export function findSkillDef(name: string, pack: RulePack): SkillDef | undefined {
  const { base } = splitSkill(name);
  return pack.characters?.skills.find((s) => same(s.name, base));
}

// ───────────────────────────── damage dice ─────────────────────────────

export interface DamageSpec {
  dice: number;
  mod: number;
  /** "DD" weapons multiply the total. */
  destructive: boolean;
}

/** Parses "3D", "3D-3", "1D+2", "2DD". Returns null for weapons that deal no direct damage. */
export function parseDamage(text: string | undefined): DamageSpec | null {
  if (!text) return null;
  const m = /^\s*(\d+)\s*(D{1,2})\s*([+-]\s*\d+)?\s*$/i.exec(text);
  if (!m) return null;
  return { dice: Number(m[1]), destructive: m[2].length === 2, mod: m[3] ? Number(m[3].replace(/\s+/g, '')) : 0 };
}

/** Numeric value of a trait such as "AP 3" or "Auto 2" (0 when absent). */
export function traitValue(traits: string[] | undefined, name: string): number {
  for (const t of traits ?? []) {
    const m = new RegExp(`^${name}\\s*(\\d+)?$`, 'i').exec(t.trim());
    if (m) return m[1] ? Number(m[1]) : 1;
  }
  return 0;
}

export function hasTrait(traits: string[] | undefined, name: string): boolean {
  return (traits ?? []).some((t) => new RegExp(`^${name}(\\s|$)`, 'i').test(t.trim()));
}

export function isMelee(weapon: Pick<CharacterWeapon, 'range' | 'skill'>): boolean {
  return weapon.range === 'melee' || /^melee/i.test(weapon.skill);
}

export interface AttackSpec {
  /** Range band id from the rules pack ("short", "normal", "long", "extreme"). */
  band?: string;
  /** Situational modifier ids from the rules pack, with how many times each applies. */
  mods?: Record<string, number>;
  extra?: number;
  /** Melee attackers may use STR or DEX. */
  char?: CharKey;
}

/** Modifier for an attack with a weapon. */
export function attackDm(character: Character, weapon: CharacterWeapon, spec: AttackSpec, pack: RulePack): { dm: number; parts: DmPart[]; char: CharKey } {
  const melee = isMelee(weapon);
  const char: CharKey = melee ? (spec.char === 'DEX' ? 'DEX' : spec.char === 'STR' ? 'STR' : bestOf(character, ['STR', 'DEX'], pack)) : 'DEX';
  const { parts } = checkDm(character, { char, skill: weapon.skill }, pack);
  const combat = pack.combat;
  if (!melee && spec.band && combat) {
    const band = combat.range.bands.find((b) => b.id === spec.band);
    if (band && band.dm !== 0) parts.push({ label: `${band.name} range`, dm: band.dm });
  }
  for (const [id, count] of Object.entries(spec.mods ?? {})) {
    const mod = combat?.modifiers.find((m) => m.id === id);
    if (!mod || !count) continue;
    const times = Math.max(1, Math.min(mod.stack ?? 1, count));
    parts.push({ label: times > 1 ? `${mod.name} ×${times}` : mod.name, dm: mod.dm * times });
  }
  // Heavy recoil: a penalty when the user is not strong enough.
  const strDm = charDm(character.chars?.STR?.value, pack.tasks);
  if (hasTrait(weapon.traits, 'Very Bulky') && strDm < 2) parts.push({ label: 'Very Bulky', dm: strDm - 2 });
  else if (hasTrait(weapon.traits, 'Bulky') && strDm < 1) parts.push({ label: 'Bulky', dm: strDm - 1 });
  if (spec.extra) parts.push({ label: 'Situation', dm: spec.extra });
  return { dm: parts.reduce((n, p) => n + p.dm, 0), parts, char };
}

function bestOf(character: Character, keys: CharKey[], pack: RulePack): CharKey {
  let best = keys[0];
  for (const k of keys) if (charDm(character.chars?.[k]?.value, pack.tasks) > charDm(character.chars?.[best]?.value, pack.tasks)) best = k;
  return best;
}

/** Range band for a distance in metres, following the pack's short/long/extreme rules. */
export function rangeBand(weaponRange: number | 'melee', metres: number, combat: CombatRules | undefined, scopeAimed = false): string | null {
  if (weaponRange === 'melee' || !combat) return null;
  const r = combat.range;
  if (metres > weaponRange * r.extremeMultiple) return 'out';
  if (!scopeAimed && metres > r.unscopedExtremeBeyond) return 'extreme';
  if (metres <= weaponRange * r.shortFraction) return 'short';
  if (metres <= weaponRange) return 'normal';
  if (metres <= weaponRange * r.longMultiple) return 'long';
  return 'extreme';
}

export interface DamageRoll {
  dice: number[];
  mod: number;
  total: number;
  parts: DmPart[];
  ap: number;
  notes: string[];
}

/**
 * Rolls weapon damage for a hit. `effect` is the attack's Effect; melee adds the attacker's STR DM
 * and a burst adds the weapon's Auto score.
 */
export function rollWeaponDamage(
  character: Character,
  weapon: CharacterWeapon,
  opts: { effect: number; burst?: boolean; manual?: number[] },
  pack: RulePack,
  rng: Rng = Math.random,
): DamageRoll | null {
  const spec = parseDamage(weapon.damage);
  if (!spec) return null;
  const dice = opts.manual && opts.manual.length === spec.dice ? opts.manual : rollDice(spec.dice, rng);
  const parts: DmPart[] = [];
  if (spec.mod) parts.push({ label: 'Weapon', dm: spec.mod });
  if (opts.effect) parts.push({ label: 'Effect', dm: opts.effect });
  if (isMelee(weapon) && (pack.combat?.damage.meleeAddsStrDm ?? true)) {
    const strDm = charDm(character.chars?.STR?.value, pack.tasks);
    if (strDm) parts.push({ label: 'STR', dm: strDm });
  }
  const auto = traitValue(weapon.traits, 'Auto');
  if (opts.burst && auto) parts.push({ label: `Burst (Auto ${auto})`, dm: auto });
  const mod = parts.reduce((n, p) => n + p.dm, 0);
  let total = Math.max(0, sum(dice) + mod);
  const notes: string[] = [];
  if (spec.destructive) {
    const mult = pack.combat?.damage.destructiveMultiplier ?? 10;
    total *= mult;
    notes.push(`Destructive ×${mult}`);
  }
  const ap = traitValue(weapon.traits, 'AP');
  if (ap) notes.push(`AP ${ap}`);
  const blast = traitValue(weapon.traits, 'Blast');
  if (blast) notes.push(`Blast ${blast} m`);
  if (hasTrait(weapon.traits, 'Stun')) notes.push('Stun');
  if (hasTrait(weapon.traits, 'Radiation')) notes.push('Radiation');
  return { dice, mod, total, parts, ap, notes };
}

// ───────────────────────────── taking damage ─────────────────────────────

export interface DamageResult {
  chars: Partial<Record<CharKey, CharScore>>;
  /** Damage that got past armour. */
  taken: number;
  absorbed: number;
  status: 'ok' | 'wounded' | 'unconscious' | 'dead';
  /** For stun weapons: rounds of incapacitation. */
  stunnedRounds?: number;
}

/** Total protection of the armour a character is wearing. */
export function wornProtection(character: Character, opts: { laser?: boolean } = {}): number {
  let total = 0;
  for (const a of character.armour ?? []) {
    if (!a.worn) continue;
    total += opts.laser && a.laserProtection !== undefined ? Math.max(a.protection, a.laserProtection) : a.protection;
  }
  return total;
}

/**
 * Applies damage to a character: END first, then STR or DEX (the target's choice), spilling into
 * the other once one reaches zero.
 */
export function applyDamage(
  character: Character,
  amount: number,
  opts: { armour?: boolean; ap?: number; laser?: boolean; stun?: boolean; prefer?: 'STR' | 'DEX'; effect?: number } = {},
  pack?: RulePack,
): DamageResult {
  const chars: Partial<Record<CharKey, CharScore>> = {};
  for (const [k, v] of Object.entries(character.chars ?? {})) chars[k as CharKey] = { ...(v as CharScore) };
  const protection = opts.armour === false ? 0 : Math.max(0, wornProtection(character, { laser: opts.laser }) - (opts.ap ?? 0));
  let taken = Math.max(0, amount - protection);
  // A solid hit always does at least one point.
  const minEffect = pack?.combat?.damage.minimumOnEffect ?? 6;
  if (taken === 0 && amount > 0 && (opts.effect ?? 0) >= minEffect) taken = 1;
  const absorbed = Math.max(0, amount - taken);
  const val = (k: CharKey) => chars[k]?.value ?? 0;
  const hit = (k: CharKey, n: number): number => {
    const score = chars[k];
    if (!score) return n;
    const used = Math.min(score.value, n);
    score.value -= used;
    return n - used;
  };

  let rest = hit('END', taken);
  let stunnedRounds: number | undefined;
  if (opts.stun) {
    // Stun damage only ever comes off END; the excess is time out of action.
    if (rest > 0 || val('END') === 0) stunnedRounds = Math.max(1, rest);
    rest = 0;
  } else if (rest > 0) {
    const first: CharKey = opts.prefer ?? (val('STR') >= val('DEX') ? 'STR' : 'DEX');
    const second: CharKey = first === 'STR' ? 'DEX' : 'STR';
    rest = hit(first, rest);
    if (rest > 0) rest = hit(second, rest);
  }

  const physical: CharKey[] = ['STR', 'DEX', 'END'];
  const zeros = physical.filter((k) => chars[k] && val(k) === 0).length;
  const present = physical.filter((k) => chars[k]).length;
  let status: DamageResult['status'] = 'ok';
  if (present > 0 && zeros === present) status = 'dead';
  else if (stunnedRounds !== undefined || (chars.STR && val('STR') === 0) || (chars.DEX && val('DEX') === 0)) status = 'unconscious';
  else if (physical.some((k) => chars[k] && val(k) < (chars[k]!.max ?? 0))) status = 'wounded';
  return { chars, taken, absorbed, status, stunnedRounds };
}

/** Health summary from current scores, for cards and tokens. */
export function healthStatus(character: Character): DamageResult['status'] {
  return applyDamage(character, 0, { armour: false }).status;
}

/** Kilograms a character can carry without penalty. */
export function carryLimit(character: Character): number {
  const athletics = Math.max(skillLevel(character.skills, 'Athletics (strength)') ?? 0, 0) + Math.max(skillLevel(character.skills, 'Athletics (endurance)') ?? 0, 0);
  return (character.chars?.STR?.max ?? 0) + (character.chars?.END?.max ?? 0) + athletics;
}
