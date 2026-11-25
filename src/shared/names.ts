/**
 * Placeholder name generator for homebrew worlds. Names are built from syllable sets in a few
 * loose "language" styles so neighbouring worlds can sound related. The GM is expected to rename
 * anything that matters.
 */
import type { Rng } from './util';

interface Style {
  onsets: string[];
  nuclei: string[];
  codas: string[];
  /** Typical syllable counts, picked uniformly. */
  lengths: number[];
  suffixes?: string[];
}

const STYLES: Record<string, Style> = {
  frontier: {
    onsets: ['b', 'br', 'c', 'cr', 'd', 'dr', 'f', 'g', 'gr', 'h', 'k', 'l', 'm', 'n', 'p', 'r', 's', 'st', 't', 'tr', 'v', 'w', ''],
    nuclei: ['a', 'e', 'i', 'o', 'u', 'ae', 'ai', 'ea', 'ou'],
    codas: ['', '', 'n', 'r', 's', 'l', 'm', 'th', 'nd', 'rn', 'x'],
    lengths: [2, 2, 3],
    suffixes: ['', '', '', ' Reach', ' Station', "'s Rest", ' Landing', ' Prime'],
  },
  sibilant: {
    onsets: ['s', 'sh', 'z', 'zh', 'th', 'v', 'l', 'y', 'ss', 'h', 'x', ''],
    nuclei: ['a', 'i', 'e', 'ia', 'ei', 'u', 'aa'],
    codas: ['', '', 's', 'sh', 'l', 'n', 'th', 'z'],
    lengths: [2, 3, 3],
  },
  guttural: {
    onsets: ['k', 'g', 'kh', 'gr', 'kr', 'd', 't', 'r', 'v', 'z', 'dz', 'gh'],
    nuclei: ['a', 'o', 'u', 'oe', 'ae', 'ou'],
    codas: ['', 'k', 'g', 'r', 'rg', 'rk', 'z', 'n', 'ng'],
    lengths: [1, 2, 2, 3],
  },
  liquid: {
    onsets: ['l', 'm', 'n', 'r', 'v', 'w', 'y', 'el', 'il', 'al', ''],
    nuclei: ['a', 'e', 'i', 'o', 'ia', 'ie', 'ea', 'ue'],
    codas: ['', '', 'l', 'n', 'r', 'th', 'lle', 'nne'],
    lengths: [2, 3, 3, 4],
  },
};

export const NAME_STYLES = Object.keys(STYLES);

function pick<T>(list: T[], rng: Rng): T {
  return list[Math.floor(rng() * list.length)];
}

export function generateName(rng: Rng, styleName?: string): string {
  const style = STYLES[styleName ?? ''] ?? STYLES[pick(NAME_STYLES, rng)];
  const count = pick(style.lengths, rng);
  let name = '';
  for (let i = 0; i < count; i++) {
    const onset = pick(style.onsets, rng);
    const nucleus = pick(style.nuclei, rng);
    // Codas mid-word make names hard to say; keep them mostly for the last syllable.
    const coda = i === count - 1 || rng() < 0.25 ? pick(style.codas, rng) : '';
    name += onset + nucleus + coda;
  }
  name = name.replace(/(.)\1\1+/g, '$1$1');
  if (name.length < 3) name += pick(style.nuclei, rng) + pick(['n', 'r', 's'], rng);
  name = name[0].toUpperCase() + name.slice(1);
  if (style.suffixes && rng() < 0.18) name += pick(style.suffixes, rng);
  return name;
}

/** Generates `count` distinct names, avoiding any in `taken`. */
export function generateNames(count: number, rng: Rng, styleName?: string, taken: Set<string> = new Set()): string[] {
  const out: string[] = [];
  let guard = 0;
  while (out.length < count && guard++ < count * 50) {
    const name = generateName(rng, styleName);
    if (taken.has(name.toLowerCase())) continue;
    taken.add(name.toLowerCase());
    out.push(name);
  }
  while (out.length < count) out.push(`Unnamed ${out.length + 1}`);
  return out;
}
