import { headers } from 'next/headers';

/**
 * A waiting page that checks again by itself (M11 review, founder decision 2026-11-10): the pay
 * page waiting for MoMo or a card, the card return page, and a receipt whose PDF is being made.
 *
 * A meta refresh reloaded the whole page on a timer, which WCAG 2.2.1 counts as a time limit the
 * person cannot turn off (axe `meta-refresh`). Instead a small script, carrying the request's
 * nonce, fetches `href` every `seconds`:
 *
 * - **still waiting:** it updates only the "Check now" link and this status text, so nothing moves
 *   under the person's finger or focus;
 * - **anything else:** it puts the new page's content in place, with its title and address, and
 *   moves focus to its heading, so a screen reader reads the outcome.
 *
 * Without JavaScript nothing checks by itself: the status says so, and "Check now" (the page's
 * own link, marked `data-recheck-link`) loads the page again.
 *
 * The script changes the status text as the page loads, before React hydrates it, so the span
 * says that text may differ (`suppressHydrationWarning`); otherwise React would throw (#418),
 * render the page again and drop the change. The script looks every element up afresh at each
 * check, so it never works on one React has replaced, and checks only once the page has loaded.
 */
export async function Recheck({ href, seconds }: { href: string; seconds: number }) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <>
      <span data-recheck={href} data-recheck-seconds={seconds} suppressHydrationWarning>
        Use Check now to see whether anything has changed.
      </span>
      <script nonce={nonce} dangerouslySetInnerHTML={{ __html: RECHECK_SCRIPT }} />
    </>
  );
}

/** The script: plain ES5 for old phone browsers, and no other file to download. */
export const RECHECK_SCRIPT = `(function () {
  function region() { return document.querySelector('[data-recheck]'); }
  var first = region();
  if (!first || !document.querySelector('main') || !window.fetch || !window.DOMParser) return;
  var href = first.getAttribute('data-recheck');
  var seconds = Number(first.getAttribute('data-recheck-seconds')) || 10;
  function said() { return 'This page checks again every ' + seconds + ' seconds.'; }
  function tell() {
    var now = region();
    if (now && now.textContent !== said()) now.textContent = said();
  }
  tell();
  function later() { setTimeout(check, seconds * 1000); }
  function check() {
    fetch(href, { credentials: 'omit', cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error(String(response.status));
        return response.text().then(function (html) { return { url: response.url, html: html }; });
      })
      .then(function (got) {
        var page = new DOMParser().parseFromString(got.html, 'text/html');
        var next = page.querySelector('main');
        var main = document.querySelector('main');
        if (!next || !main) throw new Error('no main');
        var still = next.querySelector('[data-recheck]');
        if (still) {
          href = still.getAttribute('data-recheck') || href;
          seconds = Number(still.getAttribute('data-recheck-seconds')) || seconds;
          var link = main.querySelector('[data-recheck-link]');
          if (link) link.setAttribute('href', href);
          tell();
          return later();
        }
        while (main.firstChild) main.removeChild(main.firstChild);
        for (var i = 0; i < next.childNodes.length; i += 1)
          main.appendChild(document.importNode(next.childNodes[i], true));
        if (page.title) document.title = page.title;
        try { window.history.replaceState(null, '', got.url); } catch (e) {}
        var heading = main.querySelector('h1');
        if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus(); }
      })
      .catch(later);
  }
  // Checks start once the page has loaded (Next.js's scripts, and so React's hydration, run before
  // the load event), so a new page is never put in place under a hydration still under way.
  function start() { setTimeout(later, 500); }
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start);
})();`;
