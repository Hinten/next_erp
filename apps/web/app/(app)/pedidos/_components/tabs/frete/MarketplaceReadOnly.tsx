'use client';

import { Accordion, Alert, Badge, Code, Group, Stack, Text, TextInput } from '@mantine/core';
import { ESTADO_FRETE_LABELS, INTEGRACAO_FRETE_LABELS } from '@delfrance/schemas';
import { formatReais } from '@delfrance/core/money';
import { epochToPickerString } from '@delfrance/ui';
import type { FreteInicialFormState } from '../../types';

function labelOf(map: Record<string, string>, key: string | null | undefined): string {
  return key ? (map[key] ?? key) : '—';
}

/**
 * Read-only rendering for marketplace-managed freight (Mercado Livre,
 * Shopee, Amazon, Magalu, Loja Integrada). The importer owns these fields;
 * editing happens on the marketplace / legacy app. See the
 * freight-integrations skill for the `mapa` routing that lands marketplace
 * shipping options here.
 */
export function MarketplaceReadOnly({
  frete,
  tipo,
}: {
  frete: FreteInicialFormState;
  tipo: string;
}) {
  const ro = (label: string, value: string | null | undefined) => (
    <TextInput label={label} value={value ?? '—'} readOnly disabled style={{ flex: 1 }} />
  );

  return (
    <Stack gap="sm">
      <Alert color="blue" variant="light">
        Frete gerenciado pelo marketplace (
        {labelOf(INTEGRACAO_FRETE_LABELS as Record<string, string>, tipo)}). Os campos são
        atualizados pelo importador de pedidos e não podem ser editados aqui.
      </Alert>

      <Group align="center" gap="xs">
        <Text size="sm" fw={500}>
          Status do frete:
        </Text>
        <Badge variant="light">
          {labelOf(ESTADO_FRETE_LABELS as Record<string, string>, frete.estado)}
        </Badge>
      </Group>

      <Group gap="xs" grow align="end">
        {ro('ID externo', frete.externalId)}
        {ro('Opção externa (ID)', frete.externalOptionId)}
        {ro(
          'Integração da opção externa',
          frete.externalOptionIntegracao
            ? labelOf(
                INTEGRACAO_FRETE_LABELS as Record<string, string>,
                frete.externalOptionIntegracao,
              )
            : null,
        )}
      </Group>

      <Group gap="xs" grow align="end">
        {ro('Código de rastreio', frete.codRastreio)}
        {ro('Valor cobrado', frete.valorCobrado != null ? formatReais(frete.valorCobrado) : null)}
        {ro('Previsão de entrega', epochToPickerString(frete.dataPrevisaoEntrega, 'us'))}
        {ro('Data de entrega', epochToPickerString(frete.dataEntrega, 'us'))}
      </Group>

      {frete.externalOptionData && (
        <Accordion variant="contained">
          <Accordion.Item value="externalOptionData">
            <Accordion.Control>Dados da opção externa (JSON)</Accordion.Control>
            <Accordion.Panel>
              <Code block>{JSON.stringify(frete.externalOptionData, null, 2)}</Code>
            </Accordion.Panel>
          </Accordion.Item>
        </Accordion>
      )}
    </Stack>
  );
}
