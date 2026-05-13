import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'export',
  reactStrictMode: true,
  // Static export is hosted on Firebase Hosting (classic, CDN-only).
  // No Mantine, no workspace UI deps — keep bundle minimal for embedability.
  images: { unoptimized: true },
};

export default config;
