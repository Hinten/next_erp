'use client';

import { useState } from 'react';
import { Group, ScrollArea, Stack, Text, UnstyledButton } from '@mantine/core';
import type { Firestore } from 'firebase/firestore';
import type { NFeHttpClient } from '@delfrance/integrations-nfe/http-provider';
import type { FreightHttpClient } from '@delfrance/integrations-freight-br/http-client';
import type { MercadoLivreClient } from '@/lib/mercado-livre/client';
import type { CheckoutDanfeFormat } from '@/lib/checkout/nfeFlow';
import { useOutrosCheckouts, type OutroCheckoutRow } from './useOutrosCheckouts';
import { OutroCheckoutModal } from './OutroCheckoutModal';

export interface OutrosCheckoutsPaneProps {
  db: Firestore;
  /** current operator uid; `null` while logged out / unresolved. */
  uid: string | null;
  nfeClient: NFeHttpClient | null;
  freightClient: FreightHttpClient | null;
  mercadoLivreClient: MercadoLivreClient | null;
  formatoDanfe: CheckoutDanfeFormat;
  formatoEtiqueta: 'pdf' | 'zpl2';
}

/**
 * The "Outros Checkouts" list: the operator's most-recent checkouts across all
 * pedidos, each row a reprint entry point. Each row is keyed by its checkout doc
 * id (NEVER the array index) so a live-stream re-order can't rebind a mounted
 * row to a different checkout — the legacy wrong-label bug. Clicking a row
 * captures its FROZEN view-model into state (not an index) and opens the reprint
 * modal, so the modal's target survives any subsequent re-order of `rows`.
 */
export function OutrosCheckoutsPane({
  db,
  uid,
  nfeClient,
  freightClient,
  mercadoLivreClient,
  formatoDanfe,
  formatoEtiqueta,
}: OutrosCheckoutsPaneProps) {
  const { rows, loading } = useOutrosCheckouts(db, uid);
  const [selected, setSelected] = useState<OutroCheckoutRow | null>(null);

  return (
    <>
      {loading ? (
        <Text size="xs" c="dimmed">
          Carregando…
        </Text>
      ) : rows.length === 0 ? (
        <Text size="xs" c="dimmed">
          Nenhum checkout recente.
        </Text>
      ) : (
        <ScrollArea.Autosize mah={240} type="hover">
          <Stack gap={2}>
            {rows.map((row) => (
              <UnstyledButton
                // Composite key: a collection-group query can surface the same
                // checkout doc id under different pedidos, so key by the globally
                // unique (pedidoId, checkoutId) pair — never the leaf id alone.
                key={`${row.pedidoId}:${row.checkoutId}`}
                onClick={() => setSelected(row)}
                px="xs"
                py={4}
                style={{ borderRadius: 6 }}
              >
                <Group justify="space-between" wrap="nowrap" gap="xs">
                  <Text size="sm" truncate="end">
                    {row.numero ?? row.pedidoId}
                  </Text>
                  <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                    {row.timestampMs != null
                      ? new Date(row.timestampMs).toLocaleDateString('pt-BR')
                      : ''}
                  </Text>
                </Group>
              </UnstyledButton>
            ))}
          </Stack>
        </ScrollArea.Autosize>
      )}

      <OutroCheckoutModal
        row={selected}
        onClose={() => setSelected(null)}
        db={db}
        nfeClient={nfeClient}
        freightClient={freightClient}
        mercadoLivreClient={mercadoLivreClient}
        formatoDanfe={formatoDanfe}
        formatoEtiqueta={formatoEtiqueta}
      />
    </>
  );
}
