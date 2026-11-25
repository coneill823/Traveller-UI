/** Renders markdown from notes and wiki pages, with Chronicler's [[wikilinks]] and ||spoilers||. */
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useMemo } from 'react';
import { navigate } from '../router';
import { useType } from '../store';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const pages = useType('wikiPage');
  const html = useMemo(() => {
    const byTitle = new Map(pages.map((p) => [p.title.toLowerCase(), p.id]));
    let src = text
      // Embedded images and page inserts are Chronicler features the app does not reproduce.
      .replace(/!\[\[([^\]]+)\]\]/g, (_m, file: string) => `*[image: ${file.split('|')[0]}]*`)
      .replace(/\{\{insert:\s*([^}|]+)[^}]*\}\}/g, (_m, name: string) => `[[${name.trim()}]]`)
      .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\\?\|([^\]]+))?\]\]/g, (_m, target: string, label?: string) => {
        const id = byTitle.get(target.trim().toLowerCase());
        const shown = escapeHtml((label ?? target).trim());
        return id ? `<a class="wikilink" href="/library/${id}">${shown}</a>` : `<span class="wikilink missing" title="No page available">${shown}</span>`;
      })
      .replace(/\|\|([\s\S]+?)\|\|/g, (_m, inner: string) => `<span class="spoiler" title="Hidden from players">${escapeHtml(inner)}</span>`);
    src = marked.parse(src, { async: false, gfm: true, breaks: false }) as string;
    return DOMPurify.sanitize(src, { ADD_ATTR: ['target'] });
  }, [text, pages]);

  return (
    <div
      className={`md ${className ?? ''}`}
      // Sanitised above. Internal links are routed in-app instead of reloading the page.
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a');
        if (!a) return;
        const href = a.getAttribute('href') ?? '';
        if (href.startsWith('/')) {
          e.preventDefault();
          navigate(href);
        } else {
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noreferrer noopener');
        }
      }}
    />
  );
}
