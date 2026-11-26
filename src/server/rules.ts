/** Loads rules packs from disk and layers them into the single pack the engines use. */
import fs from 'node:fs';
import path from 'node:path';
import { EMPTY_PACK, mergePacks, type PackMeta, type RulePack } from '../shared/rulepack';

export class RulesService {
  pack: RulePack = EMPTY_PACK;
  private serialised = JSON.stringify(EMPTY_PACK);

  private dirs: string[];

  /** Packs are read from each folder in turn; later ones layer over earlier ones. */
  constructor(dirs: string | string[]) {
    this.dirs = Array.isArray(dirs) ? dirs : [dirs];
    this.reload();
  }

  reload(): void {
    let pack: RulePack = { packs: [] };
    for (const dir of this.dirs) {
      if (!fs.existsSync(dir)) continue;
      const folders = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
      for (const folder of folders) {
        const full = path.join(dir, folder);
        const metaFile = path.join(full, 'pack.json');
        if (!fs.existsSync(metaFile)) continue;
        try {
          const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as PackMeta;
          const sections: Record<string, unknown> = {};
          for (const file of fs.readdirSync(full).sort()) {
            if (!file.endsWith('.json') || file === 'pack.json') continue;
            sections[path.basename(file, '.json')] = JSON.parse(fs.readFileSync(path.join(full, file), 'utf8'));
          }
          pack = mergePacks(pack, { packs: [], ...sections } as RulePack);
          pack.packs = [...pack.packs, { ...meta, id: meta.id ?? folder }];
        } catch (err) {
          console.error(`[rules] Skipping pack "${folder}": ${(err as Error).message}`);
        }
      }
    }
    this.pack = pack;
    this.serialised = JSON.stringify(pack);
    if (pack.packs.length === 0) {
      console.warn(`[rules] No rules packs found in ${this.dirs.join(' or ')}. The app will run, but rule tables (world data, trade, ship parts) will be empty.`);
    } else {
      console.log(`[rules] Loaded ${pack.packs.map((p) => p.name).join(', ')}`);
    }
  }

  json(): string {
    return this.serialised;
  }

  packNames(): string[] {
    return this.pack.packs.map((p) => p.name);
  }
}
