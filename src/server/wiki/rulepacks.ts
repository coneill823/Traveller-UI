/**
 * Rules packs kept with the wiki. The code repository can be public while the tables transcribed
 * from rulebooks stay in the campaign's private vault, under `.traveller-ui/rulepacks/<pack>/`.
 * A local vault is read in place; a vault on GitHub is copied into the data folder at start-up.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config';
import { GitHubBackend, type WikiBackend } from './backend';

export const VAULT_RULEPACKS = '.traveller-ui/rulepacks';
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function vaultRulepackDir(config: Config, injected?: WikiBackend): Promise<string | undefined> {
  if (config.wiki.dir) {
    const dir = path.join(config.wiki.dir, VAULT_RULEPACKS);
    return fs.existsSync(dir) ? dir : undefined;
  }
  const backend = injected instanceof GitHubBackend ? injected : !injected && config.wiki.repo ? new GitHubBackend({ repo: config.wiki.repo, branch: config.wiki.branch, token: config.wiki.token, pollSeconds: config.wiki.pollSeconds }) : undefined;
  if (!backend) return undefined;
  const cache = path.join(config.dataDir, 'rulepacks-wiki');
  try {
    const files = await backend.readFolder(`${VAULT_RULEPACKS}/`, '.json');
    // Only <pack>/<file>.json, with plain names: nothing from the repository can write outside the cache.
    const safe = files.filter((f) => {
      const parts = f.path.split('/');
      return parts.length === 2 && parts.every((part) => SAFE_NAME.test(part));
    });
    fs.rmSync(cache, { recursive: true, force: true });
    for (const f of safe) {
      const target = path.join(cache, f.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.text);
    }
    if (safe.length) console.log(`[rules] Fetched ${safe.length} rules pack file${safe.length === 1 ? '' : 's'} from the wiki repository`);
  } catch (err) {
    console.warn(`[rules] Could not fetch rules packs from the wiki repository: ${(err as Error).message}${fs.existsSync(cache) ? ' Using the copy from last time.' : ''}`);
  }
  return fs.existsSync(cache) ? cache : undefined;
}
