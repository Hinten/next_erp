import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  redirects() {
    return Promise.resolve([
      { source: '/termosdeuso', destination: '/termos-de-uso', permanent: true },
      { source: '/termo-de-uso', destination: '/termos-de-uso', permanent: true },
      { source: '/politicadeprivacidade', destination: '/politica-privacidade', permanent: true },
    ]);
  },
};

export default config;
