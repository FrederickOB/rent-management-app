/**
 * The whole stylesheet. The root layout inlines it with the request's nonce, which saves the
 * round trip a linked file would cost on 3G. System fonts only, so nothing else downloads.
 */
export const baseStyles = `
:root {
  color-scheme: light dark;
  --text: #1b1b1b; --muted: #5b5b5b; --background: #ffffff; --panel: #f3f4f6; --line: #d1d5db;
  --accent: #0f766e; --accent-text: #ffffff; --danger: #b42318; --ok: #067647;
}
@media (prefers-color-scheme: dark) {
  :root {
    --text: #f1f1f1; --muted: #b5b5b5; --background: #141414; --panel: #222222; --line: #3f3f46;
    --accent: #2dd4bf; --accent-text: #0b1f1d; --danger: #f97066; --ok: #47cd89;
  }
}
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
h2 { font-size: 1.2rem; line-height: 1.3; margin: 1.75rem 0 0.75rem; }
h3 { font-size: 1.05rem; margin: 1.25rem 0 0.5rem; }
p { margin: 0 0 1rem; }
a { color: var(--accent); }
.muted, .small { color: var(--muted); font-size: 0.9375rem; }
.panel { background: var(--panel); border-radius: 0.5rem; padding: 1rem; margin: 0 0 1.25rem; }
.notice { border-left: 0.25rem solid var(--accent); }
.problem { border-left: 0.25rem solid var(--danger); }
.done { border-left: 0.25rem solid var(--ok); }
.hash { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.8125rem; word-break: break-all; }
ul.signers { list-style: none; padding: 0; margin: 0 0 1rem; }
ul.signers li { display: flex; justify-content: space-between; gap: 0.75rem; padding: 0.5rem 0; border-bottom: 1px solid var(--line); }
.status { white-space: nowrap; color: var(--muted); }
.status.signed { color: var(--ok); }
.document { border: 1px solid var(--line); border-radius: 0.5rem; padding: 1rem; margin: 0 0 1rem; }
.document h1 { font-size: 1.35rem; }
.document table { width: 100%; border-collapse: collapse; margin: 0 0 1rem; }
.document th, .document td { text-align: left; vertical-align: top; padding: 0.375rem 0.25rem; border-bottom: 1px solid var(--line); }
.document th { width: 40%; }
form { margin: 0 0 1rem; }
label { display: block; font-weight: 600; margin: 0 0 0.375rem; }
input[type="text"], input[type="tel"], textarea {
  display: block; width: 100%; font: inherit; color: inherit; background: var(--background);
  border: 1px solid var(--line); border-radius: 0.375rem; padding: 0.625rem 0.75rem; margin: 0 0 1rem;
}
input.code { font-size: 1.5rem; letter-spacing: 0.3em; max-width: 12rem; }
.check { display: flex; gap: 0.625rem; align-items: flex-start; font-weight: 400; margin: 0 0 1rem; }
.check input { margin-top: 0.3rem; width: 1.25rem; height: 1.25rem; flex: none; }
button, .button {
  display: inline-block; font: inherit; font-weight: 600; border: 0; border-radius: 0.375rem;
  padding: 0.75rem 1.25rem; min-height: 2.75rem; background: var(--accent); color: var(--accent-text);
  text-decoration: none; cursor: pointer;
}
button.secondary, .button.secondary { background: var(--panel); color: var(--text); border: 1px solid var(--line); }
button:disabled { opacity: 0.6; }
.pad { margin: 0 0 1rem; }
.pad canvas { display: block; width: 100%; height: 10rem; background: #ffffff; border: 1px dashed var(--line); border-radius: 0.375rem; touch-action: none; }
.pad .row { display: flex; justify-content: space-between; align-items: center; margin-top: 0.5rem; }
.contact { margin: 1.5rem 0 0; }
.panel h2.label { font-size: 0.9375rem; font-weight: 600; color: var(--muted); margin: 0 0 0.25rem; }
.amount { font-size: 2rem; font-weight: 700; line-height: 1.2; margin: 0 0 0.5rem; }
dl.facts { margin: 1rem 0 0; }
dl.facts div { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 0 0.75rem; padding: 0.375rem 0; border-top: 1px solid var(--line); }
dl.facts dt { color: var(--muted); }
dl.facts dd { margin: 0; font-weight: 600; text-align: right; }
fieldset { border: 0; padding: 0; margin: 0 0 1rem; min-width: 0; }
legend { font-weight: 600; padding: 0; margin: 0 0 0.5rem; }
.check input[type="radio"] { margin-top: 0.15rem; }
.hint { margin-top: -0.5rem; }
.instructions { white-space: pre-line; }
`;
