# Building the Android APK

PG Management ships as **one APK that runs on both phones and tablets**. There
is no separate tablet build and no device setting to choose: the client picks
its layout from the width it is given, so the same installed app shows a bottom
tab bar on a phone and a sidebar with two-pane views on a tablet, and switches
between them live when the device is rotated or put into a split-screen window.

---

## Quickest route: let GitHub build it

If you do not have the Android SDK installed, the repository builds the APK for
you and attaches it to the run as a download.

1. Open the repository's **Actions** tab.
2. Choose **Build PG Management APK** in the left-hand list.
3. Click **Run workflow**, set **API address** to wherever your API is reachable
   from the device, and run it.
4. When it finishes, open the run and download the **pg-management-apk**
   artifact from the bottom of the summary page. It unzips to the APK.

The workflow builds a **debug** APK by default. That is signed with Android's
standard debug key, so it installs straight away — which is what you want for
testing. Choosing **release** produces a signed release APK, but only if the
repository has the signing secrets below; without them the workflow falls back
to the debug build rather than handing you an unsigned APK that cannot install.

| Secret | Contents |
|---|---|
| `PG_KEYSTORE_BASE64` | The `.jks` keystore, base64-encoded (`base64 -w0 release.jks`) |
| `PG_KEYSTORE_PASSWORD` | Keystore password |
| `PG_KEYSTORE_ALIAS` | Key alias |
| `PG_KEY_PASSWORD` | Key password |

Add them under **Settings → Secrets and variables → Actions**. See step 4.1
below for creating the keystore in the first place.

To install the downloaded APK:

```bash
adb install -r app-debug.apk
```

Or copy the file to the device and open it — Android will ask you to allow
installation from that source.

---

## What you need

| Tool | Version | Notes |
|---|---|---|
| Node.js | 20 or newer | Builds the web client |
| JDK | 21 | Bundled with recent Android Studio |
| Android SDK | Platform 35, Build-Tools 35 | Via Android Studio or `sdkmanager` |
| Gradle | Provided by `./gradlew` | Do not install separately |

Set `ANDROID_HOME` (or create `android/local.properties` with
`sdk.dir=/path/to/Android/sdk`). Android Studio does this for you.

Install the SDK packages without Studio:

```bash
sdkmanager "platforms;android-35" "build-tools;35.0.0" "platform-tools"
```

---

## 1. Point the app at your API

The APK contains **no database credentials**. It holds only the address of the
PG Management API, and talks to PostgreSQL exclusively through it.

Set the address at build time:

```bash
# pg-management/web/.env.production
NEXT_PUBLIC_API_BASE_URL=https://api.your-pg-domain.com
```

The address can also be changed on the device, under **Server settings** on the
sign-in screen — useful for pointing one build at staging without rebuilding.

> Release builds refuse plain HTTP. The API must be served over HTTPS with a
> certificate Android trusts. Debug builds allow cleartext to `localhost`,
> `10.0.2.2` (the emulator's view of your machine) and private LAN ranges.

---

## 2. Build the web client and sync it into the Android project

From `pg-management/`:

```bash
npm install
npm run build:web        # Next.js static export -> web/out
npx cap sync android     # copies web/out into the APK and updates plugins
```

`npm run android:sync` does both in one step.

Re-run this after **every** change to the web client. Gradle packages whatever
is in `android/app/src/main/assets/public`, so skipping the sync silently ships
the previous build.

---

## 3. Debug APK — for testing

```bash
cd android
./gradlew assembleDebug
```

Output:

```
android/app/build/outputs/apk/debug/app-debug.apk
```

Install it on a connected device or emulator:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

The debug build uses the application id `com.pgmanagement.app.debug`, so it
installs **alongside** a release build — handy for comparing the two on one
device.

One command from the workspace root, doing the web build, the sync and the APK:

```bash
npm run android:debug
```

---

## 4. Release APK — signed, for distribution

### 4.1 Create a keystore, once

```bash
keytool -genkeypair -v \
  -keystore pg-management-release.jks \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias pg-management
```

Keep the `.jks` file and its passwords safe and backed up. Android will only
accept an update to an installed app if it is signed with **the same key** —
lose it and existing installations cannot be upgraded, only uninstalled and
replaced.

### 4.2 Give Gradle the credentials

Either create `android/keystore.properties` (git-ignored — copy
`keystore.properties.example`):

```properties
storeFile=/absolute/path/to/pg-management-release.jks
storePassword=your-keystore-password
keyAlias=pg-management
keyPassword=your-key-password
```

…or set environment variables, which is what CI should do:

```bash
export PG_KEYSTORE_PATH=/absolute/path/to/pg-management-release.jks
export PG_KEYSTORE_PASSWORD=…
export PG_KEYSTORE_ALIAS=pg-management
export PG_KEY_PASSWORD=…
```

The properties file wins when both are present.

### 4.3 Build

```bash
npm run build:web
npx cap sync android
cd android
./gradlew assembleRelease
```

Output:

```
android/app/build/outputs/apk/release/app-release.apk
```

Or, from the workspace root: `npm run android:release`.

If no credentials are found the release build still assembles, but produces
`app-release-unsigned.apk` and logs a warning. An unsigned APK **cannot be
installed**.

### 4.4 Verify the signature before distributing

```bash
# Signed, and with which schemes
apksigner verify --verbose --print-certs app/build/outputs/apk/release/app-release.apk

# Fingerprint — record this; it must never change between releases
keytool -list -v -keystore pg-management-release.jks -alias pg-management
```

---

## 5. Play Store bundle

Google Play takes an `.aab`, not an APK:

```bash
npm run android:bundle
# android/app/build/outputs/bundle/release/app-release.aab
```

The build deliberately disables ABI, density and language splits, so a bundle
still yields one artefact that serves every device.

---

## 6. Releasing an update

Raise both fields in `android/app/build.gradle` before each release:

```gradle
versionCode 2          // must increase on every release
versionName "1.0.1"    // what users see
```

Android refuses to install an update whose `versionCode` is not higher than the
installed one.

---

## Testing on phones and tablets

The layout changes at these widths. Worth checking at least one of each:

| Width | Device | Expected |
|---|---|---|
| ~320dp | Small phone | Bottom tabs, one column, stacked cards |
| ~390dp | Standard phone | Bottom tabs, one column |
| ~430dp | Large phone | Bottom tabs, wider cards, paired form fields |
| ~768dp | Small tablet (portrait) | Sidebar, two-pane master-detail |
| ~1024dp+ | Large tablet (landscape) | Sidebar, wide grids, full tables |

Rotate the device and put the app into split-screen on a tablet: the activity is
`resizeableActivity` and handles its own configuration changes, so the running
UI re-lays out rather than restarting.

---

## Troubleshooting

**The app shows a blank white screen.**
The web assets were not synced. Run `npm run build:web && npx cap sync android`
and rebuild.

**"Cannot reach the server" on the sign-in screen.**
The device cannot reach the API address. On an emulator, `localhost` is the
emulator itself — use `10.0.2.2` for your machine. On a physical device, use the
LAN IP and make sure the API is listening on `0.0.0.0`, not just loopback. In a
release build the address must be HTTPS.

**`SDK location not found`.**
Set `ANDROID_HOME` or create `android/local.properties` with `sdk.dir=…`.

**`Could not resolve com.android.tools.build:gradle`.**
The build needs access to Google's Maven repository (`dl.google.com`). Check the
network or proxy.

**The release APK will not install.**
It is probably unsigned — see step 4.2 — or a build with the same application id
and a *different* signing key is already installed. Uninstall it first.

**Release works but debug does not, or vice versa.**
The two use different network policies. Debug allows cleartext to localhost and
private ranges; release requires HTTPS everywhere.
