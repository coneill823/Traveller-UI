/**
 * Where the Chronicler vault lives. Two interchangeable backends:
 *  - a folder on this machine (the vault Chronicler has open), read and written directly;
 *  - a GitHub repository, read and written through the GitHub API.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { hashString } from '../../shared/util';

export interface WikiFile {
  /** Vault-relative path with forward slashes. */
  path: string;
  /** Version marker: changes whenever the content changes. */
  sha: string;
}

export interface WikiWrite {
  path: string;
  content: string;
}

export interface WikiBackend {
  readonly kind: 'local' | 'github';
  /** Human-readable description for the status panel. */
  readonly label: string;
  /** A marker that changes when anything in the vault changes, or null if unknown. */
  revision(): Promise<string | null>;
  list(): Promise<WikiFile[]>;
  read(file: WikiFile): Promise<string>;
  /** Writes several pages as one change. Returns the new version marker of each. */
  write(files: WikiWrite[], message: string): Promise<WikiFile[]>;
  /** Calls `onChange` when the vault may have changed. Returns a function that stops watching. */
  watch(onChange: () => void): () => void;
}

// ───────────────────────────── local folder ─────────────────────────────

export class LocalBackend implements WikiBackend {
  readonly kind = 'local' as const;
  readonly label: string;

  constructor(private dir: string) {
    this.label = `Folder ${dir}`;
  }

  async revision(): Promise<string | null> {
    return null; // cheap enough to list every time
  }

  async list(): Promise<WikiFile[]> {
    const out: WikiFile[] = [];
    const walk = async (rel: string): Promise<void> => {
      const entries = await fsp.readdir(path.join(this.dir, rel), { withFileTypes: true });
      for (const entry of entries) {
        // Skip hidden folders (.git, .obsidian…) and anything that is not a page.
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(child);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          const stat = await fsp.stat(path.join(this.dir, child));
          out.push({ path: child, sha: `${stat.size}-${Math.round(stat.mtimeMs)}` });
        }
      }
    };
    await walk('');
    return out;
  }

  async read(file: WikiFile): Promise<string> {
    return fsp.readFile(this.resolve(file.path), 'utf8');
  }

  async write(files: WikiWrite[]): Promise<WikiFile[]> {
    const out: WikiFile[] = [];
    for (const file of files) {
      const full = this.resolve(file.path);
      await fsp.mkdir(path.dirname(full), { recursive: true });
      // Write to a temporary file first so Chronicler never sees a half-written page.
      const tmp = `${full}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, file.content, 'utf8');
      await fsp.rename(tmp, full);
      const stat = await fsp.stat(full);
      out.push({ path: file.path, sha: `${stat.size}-${Math.round(stat.mtimeMs)}` });
    }
    return out;
  }

  watch(onChange: () => void): () => void {
    let timer: NodeJS.Timeout | undefined;
    const fire = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(onChange, 500);
    };
    let watcher: fs.FSWatcher | undefined;
    try {
      watcher = fs.watch(this.dir, { recursive: true }, (_event, file) => {
        if (file && !String(file).toLowerCase().endsWith('.md')) return;
        fire();
      });
      watcher.on('error', () => undefined);
    } catch {
      // Recursive watching is not available everywhere; fall back to a slow poll.
    }
    const poll = setInterval(onChange, watcher ? 5 * 60_000 : 15_000);
    return () => {
      watcher?.close();
      clearInterval(poll);
      if (timer) clearTimeout(timer);
    };
  }

  /** Resolves a vault path, refusing anything that would escape the vault folder. */
  private resolve(rel: string): string {
    const full = path.resolve(this.dir, rel);
    const root = path.resolve(this.dir);
    if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`Refusing to touch a path outside the vault: ${rel}`);
    return full;
  }
}

// ───────────────────────────── GitHub repository ─────────────────────────────

export interface GitHubOptions {
  /** "owner/name" */
  repo: string;
  branch: string;
  token?: string;
  pollSeconds: number;
  /** Override for tests. */
  apiBase?: string;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class GitHubBackend implements WikiBackend {
  readonly kind = 'github' as const;
  readonly label: string;
  private api: string;

  constructor(private opts: GitHubOptions) {
    this.api = (opts.apiBase ?? 'https://api.github.com').replace(/\/$/, '');
    this.label = `GitHub ${opts.repo} (${opts.branch})`;
  }

  private async call<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.api}/repos/${this.opts.repo}${url}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'traveller-ui',
        ...(this.opts.token ? { Authorization: `Bearer ${this.opts.token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      let message = `GitHub answered ${res.status}`;
      if (res.status === 401) message = 'GitHub rejected the access token (401). Check WIKI_TOKEN.';
      else if (res.status === 403) message = 'GitHub refused the request (403). The token may lack "Contents: read and write" on the wiki repository, or the rate limit was hit.';
      else if (res.status === 404) {
        // GitHub answers "not found" for a private repository it will not show, so say which case this is
        message = this.opts.token
          ? `GitHub could not find ${this.opts.repo} or its "${this.opts.branch}" branch (404). The access token was accepted but cannot see that repository: on GitHub, give the token access to ${this.opts.repo} with "Contents: read and write". If the token already has that, check WIKI_REPO and WIKI_BRANCH.`
          : `GitHub could not find ${this.opts.repo} or its "${this.opts.branch}" branch (404). No access token is set, and without one GitHub shows only public repositories: put a token that can see ${this.opts.repo} in WIKI_TOKEN. If the repository is public, check WIKI_REPO and WIKI_BRANCH.`;
      }
      else if (detail) message += `: ${detail.slice(0, 200)}`;
      throw new GitHubError(message, res.status);
    }
    return (await res.json()) as T;
  }

  private encodeBranch(): string {
    return this.opts.branch.split('/').map(encodeURIComponent).join('/');
  }

  private async head(): Promise<string> {
    const ref = await this.call<{ object: { sha: string } }>('GET', `/git/ref/heads/${this.encodeBranch()}`);
    return ref.object.sha;
  }

  async revision(): Promise<string | null> {
    return this.head();
  }

  async list(): Promise<WikiFile[]> {
    const head = await this.head();
    const tree = await this.call<{ tree: { path: string; type: string; sha: string }[]; truncated: boolean }>('GET', `/git/trees/${head}?recursive=1`);
    if (tree.truncated) console.warn('[wiki] The repository is very large; GitHub returned a partial file list.');
    return tree.tree
      .filter((e) => e.type === 'blob' && e.path.toLowerCase().endsWith('.md') && !e.path.split('/').some((part) => part.startsWith('.')))
      .map((e) => ({ path: e.path, sha: e.sha }));
  }

  /** Every file under a folder of the repository, hidden folders included: used for rules packs kept beside the wiki. */
  async readFolder(prefix: string, extension: string): Promise<{ path: string; text: string }[]> {
    const head = await this.head();
    const tree = await this.call<{ tree: { path: string; type: string; sha: string }[] }>('GET', `/git/trees/${head}?recursive=1`);
    const wanted = tree.tree.filter((e) => e.type === 'blob' && e.path.startsWith(prefix) && e.path.toLowerCase().endsWith(extension));
    const out: { path: string; text: string }[] = [];
    for (const e of wanted) out.push({ path: e.path.slice(prefix.length), text: await this.read({ path: e.path, sha: e.sha }) });
    return out;
  }

  async read(file: WikiFile): Promise<string> {
    const blob = await this.call<{ content: string; encoding: string }>('GET', `/git/blobs/${file.sha}`);
    return blob.encoding === 'base64' ? Buffer.from(blob.content, 'base64').toString('utf8') : blob.content;
  }

  async write(files: WikiWrite[], message: string): Promise<WikiFile[]> {
    if (files.length === 0) return [];
    if (!this.opts.token) throw new GitHubError('Writing to the wiki needs an access token. Set WIKI_TOKEN.', 401);
    // All pages go into a single commit. If someone else pushed in the meantime, rebuild on top and retry.
    for (let attempt = 0; ; attempt++) {
      const head = await this.head();
      const commit = await this.call<{ tree: { sha: string } }>('GET', `/git/commits/${head}`);
      const tree = await this.call<{ sha: string; tree: { path: string; sha: string }[] }>('POST', '/git/trees', {
        base_tree: commit.tree.sha,
        tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
      });
      const next = await this.call<{ sha: string }>('POST', '/git/commits', { message, tree: tree.sha, parents: [head] });
      try {
        await this.call('PATCH', `/git/refs/heads/${this.encodeBranch()}`, { sha: next.sha, force: false });
      } catch (err) {
        if (err instanceof GitHubError && err.status === 422 && attempt < 3) continue;
        throw err;
      }
      const bySha = new Map(tree.tree.map((e) => [e.path, e.sha]));
      // The tree response lists only top-level entries, so compute blob ids for nested files ourselves.
      return files.map((f) => ({ path: f.path, sha: bySha.get(f.path) ?? gitBlobSha(f.content) }));
    }
  }

  watch(onChange: () => void): () => void {
    const timer = setInterval(onChange, Math.max(15, this.opts.pollSeconds) * 1000);
    return () => clearInterval(timer);
  }
}

/** The id git gives a blob with this content. */
export function gitBlobSha(content: string): string {
  const data = Buffer.from(content, 'utf8');
  return crypto.createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
}

export function contentHash(content: string): string {
  return `${content.length}:${hashString(content)}`;
}
