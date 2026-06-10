import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // Type-check `<Link href>` / `router.push` against the real route tree.
  typedRoutes: true,
  // Emit client source maps only when the e2e CI workflows ask for them
  // (E2E_SOURCEMAPS=true), so Playwright traces of the production build show
  // readable app-side stack traces. Real App Hosting deploys leave it unset.
  productionBrowserSourceMaps: process.env.E2E_SOURCEMAPS === 'true',
  // apps/web is client-first; transpile workspace packages.
  transpilePackages: [
    '@delfrance/auth',
    '@delfrance/core',
    '@delfrance/data',
    '@delfrance/schemas',
    '@delfrance/ui',
  ],
  experimental: {
    // Mantine v9 + Next 16: tree-shake @mantine/* on the bits we do render
    // server-side (root layout shell only).
    optimizePackageImports: ['@mantine/core', '@mantine/hooks', '@mantine/dates'],
  },
};

export default config;
