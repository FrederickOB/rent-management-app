# Accessibility: WCAG 2.2 AA checklist (M11, NFR-A11Y)

The tenant-facing surfaces are the links pages (`apps/links`: pay, receipt, card return, lease and notice signing, the artisan's job sheet, unsubscribe) and the tenant app (`apps/tenant`: the web build, iOS and Android). This file covers both. The staff web app is not in M11's scope (plan section 3).

## How it is checked

| Check | Tool | Where it runs |
| --- | --- | --- |
| WCAG 2.2 A and AA rules (`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`) | axe (`@axe-core/playwright` 4.14.0) | `apps/links/e2e/a11y.spec.ts` and `apps/tenant/e2e/a11y.spec.ts`, in CI's e2e job. A serious or critical violation fails. Every violation is attached to the report. |
| Roles and names of every control on the phone apps | Jest with Testing Library | `apps/tenant/__tests__/accessibility.test.tsx`: ten key screens, plus a check that the test itself catches a control with no role or no name |
| Keyboard, visible focus, target size, 200% zoom | Playwright, by hand, on 2026-11-10 | the results below |
| TalkBack and VoiceOver | real phones | `docs/device-test.md` |

**Before the e2e run (2026-11-10)** the same axe rules were run on:
- every tenant web screen, against the web build with the API answered from the Jest fixtures;
- the links job sheet, notice, lease and unsubscribe screens, rendered with their unit-test fixtures and the pages' own styles.

The pay, receipt and card return pages were first checked by the e2e spec. Its results go in the table at the end.

## The checklist

| # | Criterion (WCAG 2.2) | Links pages | Tenant app (web) | Tenant app (iOS, Android) |
| --- | --- | --- | --- | --- |
| 1 | **Keyboard** (2.1.1, 2.1.2, 2.4.3): every control is reached with Tab, in reading order, with no trap | Pass. Plain HTML forms and links; Tab reaches every control in order (job sheet 4 to 7 stops, signing 10 to 11). | Pass. Tab reaches every control on every screen (sign-in 2, home 8, a new repair 21); no trap. | Switch Access and a keyboard: device test. |
| 2 | **Visible focus** (2.4.7, 2.4.11) | Pass. The pages never remove the browser's focus ring; every focused control showed it. | Pass. React Native Web keeps the browser's ring; every focused control showed it. | Device test (TalkBack and VoiceOver draw their own focus). |
| 3 | **Targets of 24 px or more** (2.5.8) | Pass. Buttons are at least 44 px high; links inside sentences are exempt. | Pass. axe's `target-size` rule passes. The only control under 24 px is the repair form's emergency switch (40 × 20 px), which passes by the spacing exception: no other control is within 24 px of it. | Buttons are at least 44 px high (`ui.tsx`). |
| 4 | **200% zoom and reflow** (1.4.4, 1.4.10): no sideways scrolling at 320 px wide, or at 200% on a 360 px phone | Pass, **after one fix**: at 200% (180 CSS px) the job sheet's photo field scrolled sideways by 89 px. File inputs now shrink to the page (`lib/styles.ts`). | Pass. No sideways scrolling on any screen at 320 px, or at 180 px. | Large text: device test. |
| 5 | **Contrast** (1.4.3, 1.4.11) | Pass (axe `color-contrast`). | Pass (axe `color-contrast`). | Same colours as the web (`ui.tsx`). |
| 6 | **Names and roles** (1.3.1, 4.1.2, 2.5.3) | Pass. Every field has its label; headings in order; problems in `role="alert"`, results in `role="status"`. | Pass, **after two fixes** (below). | Pass. Every control on ten key screens has a role and a name (Jest); **one fix** below. |
| 7 | **Status messages** (4.1.3) | Pass. Problems and results are announced (`role="alert"` and `role="status"`). | Pass. Problems and notices use `accessibilityRole="alert"`. | Same components. |
| 8 | **Language of the page** (3.1.1) | Pass (`<html lang="en">`). | Pass (axe `html-has-lang`). | n/a |
| 9 | **Screen readers** | NVDA or VoiceOver on a desktop: not run in M11. | Not run in M11. | TalkBack and VoiceOver: device test. |

## Fixes made in M11

1. **Tenant web, the messages list:** each conversation's name was "Messages with Osu Ridge Property Managers, 2 new", which leaves out the last message and its time shown inside it (axe `label-content-name-mismatch`, serious; WCAG 2.5.3). On the web the row's name is now its own text. The phone apps keep the short name, which a passed test checks.
2. **Tenant web, the repair form:** the "Which home?" and "What kind of repair?" choices were radios with no `aria-checked` (axe `aria-required-attr`, critical). They are now radio groups, each choice says whether it is chosen, and each choice's name is its visible text with the landlord's name.
3. **Tenant app, every button:** a button working on something showed only a spinner and lost its name. It now keeps its name while busy (`ui.tsx`).
4. **Links, the job sheet:** the photo field no longer scrolls the page sideways at 200% zoom.

## Results of the e2e runs

| Date | Links (`a11y.spec.ts`) | Tenant web (`a11y.spec.ts`) | Notes |
| --- | --- | --- | --- |
| | | | |
