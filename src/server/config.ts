import fs from 'node:fs';
import path from 'node:path';

export interface WikiConfig {
  /** Path to a local Chronicler vault folder. Takes priority over the GitHub settings. */
  dir?: string;
  /** "owner/name" of the GitHub repository holding the vault. */
  repo?: string;
  branch: string;
  token?: string;
  /** How often to check GitHub for new commits. */
  pollSeconds: number;
  /** Folder inside the vault where the app writes generated pages. */
  atlasFolder: string;
}

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  rulepackDir: string;
  webDir: string;
  /** Pre-set GM passphrase, so the first-run setup screen can be skipped. */
  gmPassword?: string;
  wiki: WikiConfig;
}

function loadDotEnv(): void {
  const file = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(file)) return;
  try {
    process.loadEnvFile(file);
  } catch (err) {
    console.warn(`[config] Could not read .env: ${(err as Error).message}`);
  }
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

export function loadConfig(): Config {
  loadDotEnv();
  const root = process.cwd();
  return {
    port: Number(env('PORT') ?? 8787),
    host: env('HOST') ?? '0.0.0.0',
    dataDir: path.resolve(root, env('DATA_DIR') ?? 'data'),
    rulepackDir: path.resolve(root, env('RULEPACK_DIR') ?? 'rulepacks'),
    webDir: path.resolve(root, env('WEB_DIR') ?? 'dist/web'),
    gmPassword: env('GM_PASSWORD'),
    wiki: {
      dir: env('WIKI_DIR') ? path.resolve(root, env('WIKI_DIR')!) : undefined,
      repo: env('WIKI_REPO'),
      branch: env('WIKI_BRANCH') ?? 'main',
      token: env('WIKI_TOKEN') ?? env('GITHUB_TOKEN'),
      pollSeconds: Number(env('WIKI_POLL_SECONDS') ?? 60),
      atlasFolder: env('WIKI_ATLAS_FOLDER') ?? 'Atlas',
    },
  };
}
