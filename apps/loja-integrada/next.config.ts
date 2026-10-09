import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // No client-side React tree here, but Next still wants this for the
  // build pipeline. Workspace packages need transpilation; none is imported yet.
  transpilePackages: [],
};

export default config;
