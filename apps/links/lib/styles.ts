/**
 * The whole stylesheet. The root layout inlines it with the request's nonce, which saves the
 * round trip a linked file would cost on 3G. System fonts only, so nothing else downloads.
 */
export const baseStyles = `
:root { color-scheme: light dark; --text: #1b1b1b; --background: #ffffff; }
@media (prefers-color-scheme: dark) { :root { --text: #f1f1f1; --background: #141414; } }
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--background);
  color: var(--text);
  font: 1.0625rem/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
}
main { max-width: 36rem; margin: 0 auto; padding: 2rem 1rem; overflow-wrap: break-word; }
h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 1rem; }
p { margin: 0 0 1rem; }
`;
