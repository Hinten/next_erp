import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  integrations: [
    starlight({
      title: 'Delfrance',
      description: 'Open-source ERP — Next.js rewrite docs.',
      defaultLocale: 'pt-br',
      locales: {
        'pt-br': { label: 'Português', lang: 'pt-BR' },
        en: { label: 'English' },
      },
      sidebar: [
        {
          label: 'Getting started',
          items: [
            { label: 'Overview', link: '/getting-started/overview/' },
            { label: 'Local setup', link: '/getting-started/local-setup/' },
            { label: 'Running tests', link: '/getting-started/running-tests/' },
          ],
        },
        {
          label: 'Architecture',
          items: [{ autogenerate: { directory: 'architecture' } }],
        },
        {
          label: 'Architecture decisions',
          items: [{ autogenerate: { directory: 'adr' } }],
        },
        {
          label: 'Guides',
          items: [{ autogenerate: { directory: 'guides' } }],
        },
      ],
    }),
  ],
});
