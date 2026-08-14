'use client';

import { Stack, Title } from '@mantine/core';

import { ConfigIaPanel } from './_components/ConfigIaPanel';

/**
 * `/configuracoes/ia` — settings for the AI agents.
 *
 * No `RequirePerm` here: `configuracoes/layout.tsx` already wraps every child in
 * `RequirePerm bit={PERM.configuracoes.read}`, and a second guard would mean two
 * redirects racing. The write gate is inside the panel
 * (`usePermission(PERM.integracao.write)`).
 *
 * One agent exists today. When a second arrives this becomes a list or a set of
 * tabs; a single panel is not worth that scaffolding yet.
 */
export default function ConfiguracoesIaPage() {
  return (
    <Stack>
      <Title order={2}>Inteligência artificial</Title>
      <ConfigIaPanel />
    </Stack>
  );
}
