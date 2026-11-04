'use client';

import { List, Stack, Text } from '@mantine/core';

/**
 * Naming the account is what makes the run reviewable before it starts — the
 * operator sees exactly which conta a minutes-long job will touch, not just a
 * count. Both actions cap the selection at one, so this normally renders a
 * single name; it stays list-shaped because the ledger below it is.
 */
export function ContasSelecionadas({
  contas,
}: {
  contas: readonly { id: string; nome: string }[];
}) {
  return (
    <Stack gap={2}>
      <Text size="sm" fw={500}>
        {contas.length === 1 ? '1 conta selecionada' : `${contas.length} contas selecionadas`}
      </Text>
      <List size="sm" withPadding>
        {contas.map((conta) => (
          <List.Item key={conta.id}>{conta.nome}</List.Item>
        ))}
      </List>
    </Stack>
  );
}
