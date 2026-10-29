# ADR-010: Tenant app in Expo for iOS, Android and web

- **Status:** Accepted, 2026-10-28 (decision D4, chosen by the founder). It replaces the playbook's default of a PWA instead of a native app in the MVP.

## Context

The PRD's MVP screen inventory includes a "tenant mobile app and web". Its NFRs say tenant pages stay under 1 MB and load within 3 seconds on 3G, devices run Android 8 and above or iOS 15 and above, and tenant flows tolerate weak data. Most tenants will start from WhatsApp. The founder's team already ships Expo apps. Messaging costs are a named commercial risk.

## Decision

- **One Expo app** in `apps/tenant`, built with Expo Router for iOS, Android and web. It covers the PRD's tenant screens: sign-in by phone code; home (balance, paid-until, next due); pay; payment history and receipts; lease and documents; repair request and tracking; notices to sign; messages; profile.
- **Sign-in** with Better Auth's Expo client and phone one-time codes (ADR-011). Tokens live in secure storage.
- **Push** through Expo Notifications (FCM and APNs). It is the cheapest channel for app users and comes first in the channel order for reminders and receipts, before WhatsApp and SMS.
- **Offline:** cache balance, paid-until, receipts and lease for offline viewing; queue repair requests with photos, video or voice notes, and upload them when back online.
- **One implementation for no-login pages.** Paying and signing stay in `apps/links` (Next.js), opened from the app in an in-app browser. Tenants without the app use the same pages from WhatsApp, SMS or email.
- **Releases:** EAS Build and Submit for store builds; EAS Update for JavaScript-only fixes.
- **Budgets, enforced in CI from M4b:**
    - the Expo web build's first load is at most 1 MB;
    - each key native screen's API payload is at most 100 KB;
    - the Android download stays small enough for low-storage phones, with the size target set in M1 after a baseline build.

## Consequences

- Native push and offline support make the app useful for repeat tenants, and push lowers messaging costs.
- New external dependencies: Apple and Google developer accounts, store listings and review times. Your company publishes one tenant app in both stores, with each landlord's branding inside it (OQ-25, decided 2026-10-28). Store review adds delay to native releases; OTA updates cover most fixes.
- Two front-end stacks (Next.js and Expo) share `packages/contracts` and design tokens.
- Expo SDK 58 supports iOS 16.4 and above, not the PRD's original iOS 15; SDK 55 was the last for iOS 15. The founder chose SDK 58 on 2026-10-28 (OQ-26). Tenants on older iPhones use the web build, pay links or WhatsApp, and the PRD's device requirement now says iOS 16.4. Android 8 is within the SDK's minimum (Android 7).
- The caretaker field app and owner app (Phase 2) can reuse this foundation.

## Alternatives considered

- **PWA only** (the playbook's default). No stores and a tiny footprint, but weaker push on iOS and weaker offline storage.
- **Separate native apps per platform.** Best platform fit, at roughly double the cost.

## Revisit when

- Store review or download size measurably hurts adoption in the pilot.
- Expo web cannot meet the 1 MB budget (fall back to serving tenant web pages from `apps/links`).
