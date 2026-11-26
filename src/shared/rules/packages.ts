/**
 * Quick-creation packages: what taking one does to a character. The packages and every figure for
 * applying them (how far skills stack, the age reached) come from the rules pack; none are held here.
 */
import { evaluate } from '../dicex';
import type { CharacterPackage, PackageRules } from '../rulepack';
import type { Character, CharKey, CharScore } from '../types';
import type { Rng } from '../util';

/** True when a package names a skill loosely ("Science (any)", "Electronics (comms or computers)") and the player must settle it. */
export function needsChoice(skill: string): boolean {
  return /\bany\b|\banother\b|\bsuitable\b|\sor\s/i.test(skill);
}

export interface PackageOutcome {
  chars: Partial<Record<CharKey, CharScore>>;
  skills: Record<string, number>;
  credits: number;
  age?: number;
  career?: { name: string; terms: number; rank?: string };
  /** A line for the character's notes on what else came with the package. */
  note?: string;
}

/**
 * The character as it stands after taking a package. `choices` gives the skill actually taken for each
 * loosely named one; a loose name left unsettled goes on the sheet as written, to be put right later.
 */
export function applyPackage(character: Character, pkg: CharacterPackage, rules: PackageRules | undefined, choices: Record<string, string> = {}, rng: Rng = Math.random): PackageOutcome {
  const chars: Partial<Record<CharKey, CharScore>> = {};
  for (const [key, score] of Object.entries(character.chars ?? {})) if (score) chars[key] = { ...score };
  for (const [key, change] of Object.entries(pkg.mods ?? {})) {
    const score = chars[key];
    if (!score || !change) continue;
    let max = score.max + change;
    if (rules?.charMin !== undefined) max = Math.max(rules.charMin, max);
    if (rules?.charMax !== undefined) max = Math.min(rules.charMax, max);
    // an unhurt characteristic moves whole; a hurt one keeps its hurt
    const hurt = score.max - score.value;
    chars[key] = { ...score, max, value: Math.max(0, max - hurt) };
  }

  const skills: Record<string, number> = { ...(character.skills ?? {}) };
  for (const [listed, level] of Object.entries(pkg.skills)) {
    const name = (choices[listed] ?? '').trim() || listed;
    const had = skills[name];
    let now = had === undefined ? level : had + level;
    if (rules?.skillCap !== undefined) now = Math.min(Math.max(rules.skillCap, had ?? 0), now);
    skills[name] = now;
  }

  const out: PackageOutcome = { chars, skills, credits: (character.credits ?? 0) + (pkg.credits ?? 0) };
  if (pkg.kind === 'background') {
    if (rules?.backgroundAge !== undefined && (character.age ?? 0) < rules.backgroundAge) out.age = rules.backgroundAge;
  } else {
    const years = rules?.careerYears ? Math.max(0, Math.round(evaluate(rules.careerYears, rng))) : 0;
    if (years && character.age !== undefined) out.age = character.age + years;
    out.career = { name: pkg.name, terms: rules?.termYears ? Math.max(1, Math.round(years / rules.termYears)) : 1, ...(pkg.rank ? { rank: pkg.rank } : {}) };
  }
  if (pkg.benefits?.length) out.note = `From the ${pkg.name} ${pkg.kind === 'background' ? 'background' : 'career'}: ${pkg.benefits.join('; ')}.`;
  return out;
}
