'use client';

import { Accordion, Alert, Badge, Code, Group, Stack, Text, TextInput } from '@mantine/core';
import { ESTADO_FRETE_LABELS, INTEGRACAO_FRETE, INTEGRACAO_FRETE_LABELS } from '@delfrance/schemas';
import { formatReais } from '@delfrance/core/money';
import { epochToPickerString } from '@delfrance/ui';
import type { FreteInicialFormState } from '../../types';
import { MercadoLivreRastrearAction } from '../../MercadoLivreRastrearAction';

function labelOf(map: Record<string, string>, key: string | null | undefined): string {
  return key ? (map[key] ?? key) : '—';
}

/**
 * Read-only rendering for freight the Frete tab does not edit, in two variants:
 *
 * - `'marketplace'` (the default) — marketplace-managed freight (Mercado Livre,
 *   Shopee, Amazon, Magalu): the importer owns these fields, and the whole tab
 *   is locked with them;
 * - `'roteado'` — a pedido still on its conta's Loja Integrada doc, a ROUTER
 *   with no carrier yet (master plan step 15): the carrier comes from the
 *   conta's Mapeamento do Frete through the `/pedidos` routing action, so the
 *   panel points there. Only this BODY is read-only: the tab's header and
 *   integração picker follow the estado lock (`FreteTab`).
 */
export function MarketplaceReadOnly({
  frete,
  tipo,
  pedidoId,
  variante = 'marketplace',
}: {
  frete: FreteInicialFormState;
  tipo: string;
  pedidoId?: string;
  variante?: 'marketplace' | 'roteado';
}) {
  const ro = (label: string, value: string | null | undefined) => (
    <TextInput label={label} value={value ?? '—'} readOnly disabled style={{ flex: 1 }} />
  );

  return (
    <Stack gap="sm">
      {variante === 'roteado' ? (
        <Alert color="blue" variant="light">
          O frete deste pedido segue o Mapeamento do Frete da conta Loja Integrada. Use
          &quot;Definir transportadora&quot; na lista de pedidos.
        </Alert>
      ) : (
        <Alert color="blue" variant="light">
          Frete gerenciado pelo marketplace (
          {labelOf(INTEGRACAO_FRETE_LABELS as Record<string, string>, tipo)}). Os campos são
          atualizados pelo importador de pedidos e não podem ser editados aqui.
        </Alert>
      )}

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
        {frete.externalOptionIntegracao === INTEGRACAO_FRETE.mercadoLivre && (
          <MercadoLivreRastrearAction pedidoId={pedidoId} shipmentId={frete.externalId} />
        )}
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
