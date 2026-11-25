import { describe, expect, it } from 'vitest';
import { buildPage, pageTags, pageTitle, parsePage, safeFileName, splitSections, updateFrontmatter } from '../src/shared/markdown';

describe('wiki page parsing', () => {
  it('reads the infobox and splits the body into sections', () => {
    const page = parsePage(
      ['---', 'title: Ardent', 'hex: "0103"', 'tags: [system, hub]', '---', 'A busy port.', '', '## History', 'Founded 900.', '', '### The Collapse', 'Bad times.', '', '## History', 'A second heading with the same name.'].join('\n'),
    );
    expect(page.frontmatterOk).toBe(true);
    expect(page.frontmatter).toMatchObject({ title: 'Ardent', hex: '0103' });
    expect(pageTags(page.frontmatter)).toEqual(['system', 'hub']);
    expect(page.sections.map((s) => [s.id, s.level, s.heading])).toEqual([
      ['_intro', 0, ''],
      ['history', 2, 'History'],
      ['the-collapse', 3, 'The Collapse'],
      ['history-2', 2, 'History'],
    ]);
    expect(page.sections[0].body).toBe('A busy port.');
    expect(page.sections[1].body).toBe('Founded 900.');
  });

  it('locks GM sections together with everything nested under them', () => {
    const s = splitSections(['# Ardent', 'Public.', '## GM Notes', 'Secret.', '### Ambush plan', 'Also secret.', '## Culture', 'Public again.', '## Referee only', 'Secret.'].join('\n'));
    expect(s.map((x) => [x.heading, x.locked])).toEqual([
      ['Ardent', false],
      ['GM Notes', true],
      ['Ambush plan', true],
      ['Culture', false],
      ['Referee only', true],
    ]);
  });

  it('does not treat # inside code fences as headings, and tolerates CRLF and a missing infobox', () => {
    const s = splitSections('Intro\r\n\r\n```\r\n# not a heading\r\n```\r\n\r\n## Real\r\nText');
    expect(s.map((x) => x.id)).toEqual(['_intro', 'real']);
    expect(s[0].body).toContain('# not a heading');
    // The repository's first test page has text before a "---" block, which is not an infobox.
    const odd = parsePage('Hello\n---\ntags: [add, your, tags]\n---\n');
    expect(odd.frontmatter).toEqual({});
    expect(odd.body.startsWith('Hello')).toBe(true);
  });

  it('survives a broken infobox without losing the body', () => {
    const page = parsePage('---\ntitle: [unclosed\n---\nBody text');
    expect(page.frontmatterOk).toBe(false);
    expect(page.frontmatter).toEqual({});
    expect(page.sections[0].body).toBe('Body text');
  });

  it('titles a page from its infobox or its file name', () => {
    expect(pageTitle('Atlas/Reach/Ardent.md', {})).toBe('Ardent');
    expect(pageTitle('Atlas/Reach/Ardent.md', { title: 'Ardent Prime' })).toBe('Ardent Prime');
  });
});

describe('wiki page writing', () => {
  it('quotes values YAML would otherwise turn into numbers', () => {
    const text = buildPage({ title: 'Ardent', hex: '0103', pbg: '703', uwp: 'A646930-D' });
    expect(text).toContain('hex: "0103"');
    expect(text).toContain('pbg: "703"');
    expect(parsePage(text).frontmatter).toEqual({ title: 'Ardent', hex: '0103', pbg: '703', uwp: 'A646930-D' });
  });

  it('updates managed keys and leaves comments, other keys and the body alone', () => {
    const original = ['---', '# my own comment', 'title: Ardent', 'ruler: Duke Varr   # do not touch', 'uwp: A646930-D', 'bases: NS', '---', '', 'Body with ||a spoiler||.', '', '## Notes', 'Mine.', ''].join('\n');
    const next = updateFrontmatter(original, { uwp: 'B646930-D', hex: '0103' }, ['bases']);
    expect(next).toContain('# my own comment');
    // Inline comments survive (the YAML writer only tidies the spacing before them).
    expect(next).toMatch(/ruler: Duke Varr +# do not touch/);
    expect(next).toContain('uwp: B646930-D');
    expect(next).toContain('hex: "0103"');
    expect(next).not.toContain('bases:');
    expect(next.endsWith('\nBody with ||a spoiler||.\n\n## Notes\nMine.\n')).toBe(true);
    // Applying the same update again changes nothing.
    expect(updateFrontmatter(next, { uwp: 'B646930-D', hex: '0103' }, ['bases'])).toBe(next);
  });

  it('adds an infobox to a page that has none and refuses to rewrite one it cannot read', () => {
    expect(updateFrontmatter('Just text.\n', { ref: 'sys_1' })).toBe('---\nref: sys_1\n---\n\nJust text.\n');
    const broken = '---\ntitle: [unclosed\n---\nBody';
    expect(updateFrontmatter(broken, { ref: 'sys_1' })).toBe(broken);
  });

  it('makes file names safe on every platform', () => {
    expect(safeFileName('Hask\'s World: "The Pit"?')).toBe("Hask's World The Pit");
    expect(safeFileName('CON')).toBe('CON_');
    expect(safeFileName('trailing dots...  ')).toBe('trailing dots');
    expect(safeFileName('///')).toBe('Untitled');
  });
});
