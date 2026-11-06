/**
 * The frozen document's HTML, made safe to put in the page (M7 review, LT 3). The API renders it
 * from our own templates with every field escaped, and the page's policy already blocks scripts,
 * styles, frames and plugins it did not sign. This removes what the policy does not stop, and
 * anything a document never needs, as a second line of defence:
 *
 * - elements dropped with their content: script, style, iframe, frame, frameset, object, embed,
 *   noscript, template, svg, math, textarea, select, button;
 * - tags dropped, their text kept: meta (a refresh would take the reader elsewhere), base, link,
 *   form, input, option, label;
 * - event-handler attributes (`on…`), `style`, `srcdoc`, `formaction`, `action` and
 *   `http-equiv`;
 * - `href`, `src`, `xlink:href` and `action` values that are not http(s), mailto, tel, a page
 *   anchor or a relative path.
 *
 * It repeats until nothing changes, so a tag rebuilt from the pieces of a removed one goes too.
 */
const WITH_CONTENT = [
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'noscript',
  'template',
  'svg',
  'math',
  'textarea',
  'select',
  'button',
];
const TAGS_ONLY = ['meta', 'base', 'link', 'form', 'input', 'option', 'label'];
const DROPPED_ATTRIBUTES = /^(on[a-z0-9_-]*|style|srcdoc|formaction|action|http-equiv)$/i;
const URL_ATTRIBUTES = /^(href|src|xlink:href)$/i;
const ALLOWED_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);
const NAMED: Readonly<Record<string, string>> = {
  colon: ':',
  tab: '\t',
  newline: '\n',
  amp: '&',
  sol: '/',
  lpar: '(',
  rpar: ')',
};

/** A character from its code point; nothing for one no character has. */
function character(code: number): string {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

/** A URL as the browser will read it: entities decoded, spaces and control characters gone. */
function asBrowserReads(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_m, hex: string) => character(parseInt(hex, 16)))
    .replace(/&#([0-9]+);?/g, (_m, dec: string) => character(Number(dec)))
    .replace(/&([a-z]+);?/gi, (_m, name: string) => NAMED[name.toLowerCase()] ?? '')
    .split('')
    .filter((c) => c.charCodeAt(0) > 0x20 && c.charCodeAt(0) !== 0x7f)
    .join('');
}

/** Only web, mail and phone links, page anchors and relative paths. */
function safeUrl(raw: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(asBrowserReads(raw));
  return !scheme || ALLOWED_SCHEMES.has(scheme[1]!.toLowerCase());
}

const withContent = new RegExp(
  `<(${WITH_CONTENT.join('|')})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>|<(${WITH_CONTENT.join('|')})\\b[^>]*\\/?>`,
  'gi',
);
const closingWithContent = new RegExp(`<\\/(${WITH_CONTENT.join('|')})\\s*>`, 'gi');
const tagsOnly = new RegExp(`<\\/?(${TAGS_ONLY.join('|')})\\b[^>]*>`, 'gi');
const comments = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[\s\S]*?\?>/g;
const openingTag = /<([a-z][a-z0-9-]*)(\s[^<>]*?)?(\/?)>/gi;
const attribute = /([^\s"'<>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

function cleanAttributes(raw: string): string {
  const kept: string[] = [];
  for (const [, name = '', value] of raw.matchAll(attribute)) {
    if (DROPPED_ATTRIBUTES.test(name)) continue;
    if (URL_ATTRIBUTES.test(name) && !safeUrl((value ?? '').replace(/^["']|["']$/g, ''))) continue;
    kept.push(value === undefined ? name : `${name}=${value}`);
  }
  return kept.length > 0 ? ` ${kept.join(' ')}` : '';
}

function once(html: string): string {
  return html
    .replace(comments, '')
    .replace(withContent, '')
    .replace(closingWithContent, '')
    .replace(tagsOnly, '')
    .replace(
      openingTag,
      (_tag, name: string, attributes: string | undefined, selfClosing: string) =>
        `<${name}${attributes ? cleanAttributes(attributes) : ''}${selfClosing ? ' /' : ''}>`,
    );
}

export function sanitiseDocumentHtml(html: string | null): string {
  let current = html ?? '';
  for (let pass = 0; pass < 5; pass += 1) {
    const next = once(current);
    if (next === current) return next;
    current = next;
  }
  // Still changing after five passes: something is built to slip through. Show it as text.
  return current.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
