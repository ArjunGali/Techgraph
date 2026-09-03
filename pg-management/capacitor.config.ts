import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor packaging.
 *
 * The Next.js client is exported to static files and served from the device
 * filesystem inside the APK, so the app opens like any other installed
 * application — no browser, no URL to type. It reaches PostgreSQL only through
 * the PG Management API over HTTPS; no database credential is ever compiled
 * into the package.
 *
 * One APK covers phones and tablets. There is no per-device configuration
 * here because there is nothing to configure: the client lays itself out from
 * the width it is given.
 */
const config: CapacitorConfig = {
  appId: 'com.pgmanagement.app',
  appName: 'PG Management',
  webDir: 'web/out',

  android: {
    // Release builds are minified; keep the mapping useful for crash reports.
    buildOptions: {
      keystorePath: process.env.PG_KEYSTORE_PATH,
      keystoreAlias: process.env.PG_KEYSTORE_ALIAS,
    },
    // The API is reached over HTTPS in production. Cleartext is enabled only
    // for the debug build, via the debug manifest, so a developer can point
    // the app at a local server.
    allowMixedContent: false,
  },

  server: {
    // Serving from https://localhost rather than file:// gives the WebView a
    // proper secure origin, so localStorage and fetch behave as they do on the
    // web and the app can call an HTTPS API without mixed-content problems.
    androidScheme: 'https',
  },

  plugins: {
    StatusBar: {
      // The shell already pads for the status bar, so the app draws behind it.
      overlaysWebView: false,
      style: 'DEFAULT',
    },
    Keyboard: {
      // Forms stay visible above the keyboard instead of being covered.
      resize: 'native',
      resizeOnFullScreen: true,
    },
  },
};

export default config;
