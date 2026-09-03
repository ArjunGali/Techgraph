/** @type {import('next').NextConfig} */
const nextConfig = {
  // Capacitor serves the built app from the device filesystem, so the whole
  // client is pre-rendered to static files. There is no Node server in the
  // APK — the app talks to the PG Management API over HTTPS.
  output: 'export',
  images: { unoptimized: true },
  // Static hosting inside the WebView resolves /tenants to /tenants/index.html.
  trailingSlash: true,
  reactStrictMode: true,
};

export default nextConfig;
