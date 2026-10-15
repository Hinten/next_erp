'use client';

import { Anchor, Group } from '@mantine/core';
import { resolvePortalUrl } from '@/lib/legal/portalUrl';

export function LegalLinks() {
  const baseUrl = resolvePortalUrl(process.env.NEXT_PUBLIC_PORTAL_URL, process.env.NODE_ENV);
  if (!baseUrl) return null;

  return (
    <Group component="nav" aria-label="Governança" justify="center" gap="md" mt="lg">
      <Anchor href={`${baseUrl}/termos-de-uso`} size="sm" target="_blank" rel="noopener noreferrer">
        Termos de Uso
      </Anchor>
      <Anchor
        href={`${baseUrl}/politica-privacidade`}
        size="sm"
        target="_blank"
        rel="noopener noreferrer"
      >
        Política de Privacidade
      </Anchor>
    </Group>
  );
}
