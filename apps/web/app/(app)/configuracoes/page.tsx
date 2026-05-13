'use client';

import { Card, Stack, Text, Title } from '@mantine/core';
import { PERM } from '@delfrance/auth';
import { RequirePerm } from '@/lib/auth';
import { useGrupoEconomico } from '@/lib/data/useGrupoEconomico';

export default function ConfiguracoesPage() {
  return (
    <RequirePerm bit={PERM.configuracoes.read} redirectTo="/inicio">
      <ConfiguracoesContent />
    </RequirePerm>
  );
}

function ConfiguracoesContent() {
  const { data, loading } = useGrupoEconomico();
  return (
    <Stack>
      <Title order={2}>Configurações</Title>
      <Card withBorder>
        <Stack gap="xs">
          <Text fw={600}>Grupo econômico</Text>
          {loading ? (
            <Text c="dimmed">Carregando…</Text>
          ) : data ? (
            <>
              <Text>{data.data.nome}</Text>
              <Text size="sm" c="dimmed">
                {data.data.users.length} usuário(s) · {data.data.databases.length} database(s)
              </Text>
            </>
          ) : (
            <Text c="dimmed">Nenhum grupo econômico vinculado.</Text>
          )}
        </Stack>
      </Card>
    </Stack>
  );
}
