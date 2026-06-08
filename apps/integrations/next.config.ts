import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // No client-side React tree here, but Next still wants this for the
  // build pipeline. Workspace packages need transpilation.
  transpilePackages: [
    '@delfrance/auth',
    '@delfrance/data',
    '@delfrance/logger',
    '@delfrance/schemas',
  ],
  // pino is Node-only and resolves its own internals at runtime — keep it out
  // of the server bundle so Turbopack doesn't try to trace/bundle it.
  serverExternalPackages: ['pino'],
};

export default config;
