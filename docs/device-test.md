# Device test: the tenant app on real phones (M11 decision 11, NFR-DEV)

A script for two real phones: **an Android phone on Android 8 or 9**, and **an iPhone on iOS 16 or 17**. Cameras, the microphone, push and the screen readers behave differently on hardware, so the emulator runs can't replace this. Results go in the tables at the end, with the phone model, its OS version and the date.

The emulator and simulator runs (Android 8 emulator, iOS 16.4 simulator) use the same script. Their results are recorded separately.

## 1. Before you start

### What you need

- **The stack,** with the seed (`pnpm db:seed`), reachable from the phones **over HTTPS**. Release builds refuse plain HTTP: Android 9 and later block it, and so does iOS. Use a tunnel to the local API, or the M12 staging address. Plain HTTP works only in debug builds, and in Android 8 release builds.
- **A tenant with a phone on record:** a test tenant whose phone number you can read codes for.
  - The fake SMS provider sends no real SMS. Read the sign-in and signing codes at `<fake-providers>/messages?channel=sms&to=<E.164 number>`, or in Mailpit for email.
  - The tenant needs a lease with something due and one payment made, for history and receipts.
- **A notice** issued to that tenant (staff app: Notices, then New notice), and **a repair** of theirs marked Work done, for the confirm step.
- **For push (section 3.9):** an EAS project. Run `eas init` in `apps/tenant`, which writes `extra.eas.projectId` to `app.json`, then rebuild. Without a project, the app says that notifications are not available on this build, and push is skipped.

### Builds

**Android, a local release build** (no EAS account needed). In `apps/tenant`:

```
npx expo prebuild --platform android --clean    # writes android/ afresh, which git ignores
cd android
EXPO_PUBLIC_API_URL=https://<api address> NODE_ENV=production \
  JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
  ANDROID_HOME="$HOME/Library/Android/sdk" ./gradlew assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
```

- The release APK is signed with the debug key, which is fine for testing and not for a store.
- The first build downloads Gradle 9.4, Android platform 37, NDK 27.1 and the Maven libraries, a few gigabytes in all.
- Never commit `android/` or `ios/`.
- **Record the APK's size** for the app-size budget (decision 11): `ls -l app/build/outputs/apk/release/`.

**iPhone:**
- A local release build needs an Apple developer account for signing: `npx expo run:ios --configuration Release --device`.
- Or use an EAS internal-distribution build: `eas build --profile preview --platform ios`.

## 2. Settings on each phone

- Set the phone's text size to its default for sections 3.1 to 3.10.
- Section 3.11 sets it to the largest size.
- Note the screen size. A 5-inch screen (360 × 640 dp) is the smallest the product supports.

## 3. The script

Each step has an expected result. Mark it **pass**, **fail** (with what happened) or **n/a** in the tables.

### 3.1 Install and first launch
1. Install and open the app. **Expected:** the sign-in screen, with "Phone number" and "Send code".
2. Rotate the phone. **Expected:** the app stays in portrait.

### 3.2 Sign-in (AD-06)
1. Enter the tenant's number in its local form (`024 412 3456`). Tap Send code. **Expected:** the code step.
2. Enter a wrong code. **Expected:** "That code is not right, or it has expired."
3. Enter the right code. **Expected:** Home, "Hello, <name>", with each landlord's tenancies in a box of their own.
4. Sign in, then kill the app (swipe it away from the recent apps) and open it again. **Expected:** still signed in, on Home, with no new code asked for.
   - Only a real phone shows this. Until M11 the app never kept its session on a phone: the session cookie's name did not match what the app looked for (`cookiePrefix`, fixed on 2026-11-10).
5. Open Profile. **Expected:** this phone is listed under Devices.
   - If the list cannot load, the screen says so and offers "Load devices again". It never shows an empty list.

### 3.3 Pay (BC-04)
1. On Home, tap Pay rent. **Expected:** the pay page opens in the in-app browser, with the amount due.
2. Choose MTN MoMo and pay. Approve the charge with the fake provider's test control. **Expected:**
   - the pay page thanks you;
   - after closing the browser, Home shows the new balance and paid-until date.

### 3.4 History and receipts (BC-06)
1. Open Payments and receipts. **Expected:** the payment, with its receipt number.
2. Tap Download the receipt. **Expected:** the receipt PDF opens.

### 3.5 Notices (LN-04)
1. Open To sign. **Expected:** the notice, with "Signing acknowledges receipt, not agreement".
2. Tap Read and acknowledge. Sign with the code. **Expected:** the signed acknowledgement; To sign no longer asks.

### 3.6 Repairs with the camera, video and a voice note (MI-01)
1. Repairs, then Report a repair. Choose a kind and describe the problem.
2. Take a photo. **Expected:** the camera permission is asked once, in the app's words; the photo is listed.
3. Record a video. **Expected:**
   - the camera opens in video mode (on Android, the video camera, not the photo camera);
   - a clip of a few seconds is listed with its length.
4. Record a voice note of about 10 seconds. **Expected:** the microphone permission is asked once; the note is listed with its length.
5. Record a voice note and let it run past 3 minutes. **Expected:** it stops by itself at 3:00, is listed, and the app says it stopped.
6. Choose a photo from the library. **Expected:** listed.
7. Send. **Expected:** "Your request is MT-…". Under Repairs, the request shows its files and opens each one.
8. **Confirm work done:** on the repair marked Work done, tap "Confirm the work is done". **Expected:** it closes.

### 3.7 Offline (NFR-OFFLINE)
1. Turn on airplane mode. Open the app. **Expected:** Home shows the last figures fetched, with "You are offline" and the time.
2. Still offline, report a repair with a photo and send. **Expected:** "saved on this phone … it will be sent when you are back online".
3. Close the app fully, then turn airplane mode off and open the app. **Expected:**
   - within a minute the request is sent by itself, once;
   - the staff board has one job with the photo.

### 3.8 Messages (CM-05)
1. Open Messages, then a landlord. Send a message, then one with a photo. **Expected:** both show Sent.
2. Offline, send a message. **Expected:** Not sent, with Try again. Back online, Try again sends it once.

### 3.9 Push (needs an EAS project)
1. On Home, turn on notifications. **Expected:** the OS permission prompt, then "On" in Profile.
2. Close the app. Have staff send the tenant a message. **Expected:** a notification arrives.
3. Tap it. **Expected:** the conversation opens.
4. Sign out. **Expected:** no further notifications for this tenant.

### 3.10 A 5-inch screen
1. On a 5-inch phone, or with display size set to the largest, open each screen: Home, the tenancy, Payments, Messages, a conversation, Repairs, a new repair, To sign, Profile. **Expected:**
   - nothing is cut off or overlaps;
   - every button can be reached by scrolling.

### 3.11 Large text (WCAG 1.4.4)
1. Set the system text size to the largest. Repeat 3.10. **Expected:** text grows; nothing is cut off.

### 3.12 TalkBack (Android) and VoiceOver (iPhone) (NFR-A11Y)
1. Turn the screen reader on. Sign in using it only. **Expected:** each field and button is announced with its name and role ("Phone number, edit box"; "Send code, button").
2. On Home, swipe through. **Expected:**
   - each landlord's box is announced;
   - Pay rent, Messages, Repairs and Payments are buttons with their names;
   - "Waiting for you" and "new messages" are announced.
3. On the repair form:
   - each kind of repair is a radio button that says whether it is selected;
   - the emergency switch says on or off;
   - "Take a photo" and "Record a video" are buttons;
   - while sending, the button keeps its name.
4. A problem (send the repair form empty). **Expected:** the problem is announced.

### 3.13 Sign out (TL-12)
1. Profile, Sign out. **Expected:** the sign-in screen. Sign in as another tenant on the same phone: nothing of the first tenant shows, offline included.

## 4. Results

### Android (model, Android version, date): ______________

| Step | Result | Notes |
| --- | --- | --- |
| 3.1 Install and first launch | | |
| 3.2 Sign-in | | |
| 3.3 Pay | | |
| 3.4 History and receipts | | |
| 3.5 Notices | | |
| 3.6 Repairs: photo, video, voice note, auto-stop, library, confirm | | |
| 3.7 Offline | | |
| 3.8 Messages | | |
| 3.9 Push | | |
| 3.10 5-inch screen | | |
| 3.11 Large text | | |
| 3.12 TalkBack | | |
| 3.13 Sign out | | |
| Release APK size | | |

### iPhone (model, iOS version, date): ______________

| Step | Result | Notes |
| --- | --- | --- |
| 3.1 Install and first launch | | |
| 3.2 Sign-in | | |
| 3.3 Pay | | |
| 3.4 History and receipts | | |
| 3.5 Notices | | |
| 3.6 Repairs: photo, video, voice note, auto-stop, library, confirm | | |
| 3.7 Offline | | |
| 3.8 Messages | | |
| 3.9 Push | | |
| 3.10 5-inch screen | | |
| 3.11 Large text | | |
| 3.12 VoiceOver | | |
| 3.13 Sign out | | |

### Emulator and simulator runs

| Run | Date | Result | Notes |
| --- | --- | --- | --- |
| Android 8 emulator | | | |
| iOS 16.4 simulator | | | |

## 5. Known before the test (from the build, 2026-11-10)

- **Dark mode on Android:** prebuild warns that `userInterfaceStyle: automatic` needs `expo-system-ui` on Android, which is not installed. Android follows the light theme until it is added. The founder decided on 2026-11-10 to add it with the first store build (EAS), and to test it on a real phone then.
- **App size budget (founder, 2026-11-10):** the arm64-v8a release APK stays within 35 MB (32.8 MB on 2026-11-10). A build over it is flagged here, with the reason.
- **Android permissions, removed on 2026-11-10:**
  - **What was asked for:** the first release manifest asked for `SYSTEM_ALERT_WINDOW`, which only React Native's development menu uses, and `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, with expo-audio's background playback service. Both draw store-review questions.
  - **Why it isn't needed:** the app plays no audio. Voice notes are recorded with the app open and opened through links, so it needs neither.
  - **The change, in `app.json`:**
    - `android.blockedPermissions` removes both permissions;
    - expo-audio's `enableBackgroundPlayback: false` drops its playback service, its `FOREGROUND_SERVICE` permission, and iOS's background audio mode.
  - **Rebuild after the change:** use `prebuild --clean`, as in section 1, so an old `android/` keeps nothing of it. The first local build started before the change (see the builds below).
- **The local Android builds, 2026-11-10:**
  - **The first build:** all four architectures, 51 minutes with the downloads.
    - `app-release.apk` is 94,614,694 bytes (94.6 MB). The native libraries are 83.3 MB of it, stored uncompressed: x86 23.1 MB, x86_64 22.7 MB, arm64-v8a 22.2 MB and armeabi-v7a 15.3 MB.
    - The part every architecture shares is 10.2 MB: code 4.0 MB, the JavaScript bundle 3.7 MB, resources 2.3 MB.
    - It was prebuilt before the permission change, so it still asked for both permissions.
  - **The second build:** prebuilt again, arm64-v8a only (`./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a`), 8 minutes.
    - `app-release.apk` is 32,789,911 bytes (32.8 MB). That is close to what one phone downloads from a store's per-architecture split; store sizes need an EAS build.
    - Its manifest has neither `SYSTEM_ALERT_WINDOW` nor `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, nor `FOREGROUND_SERVICE` or expo-audio's playback service.
  - **`prebuild` without `--clean`** also wrote `android/` afresh and deleted the earlier build's outputs.
- **Minimum versions:** React Native 0.88 supports Android 7 (API 24) and up, which covers Android 8. iOS 16.4 is the app's minimum (ADR-010).
