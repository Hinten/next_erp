'use client';

import dynamic from 'next/dynamic';
import { Group, Loader } from '@mantine/core';

import type { LinkPagamentoTabProps } from './LinkPagamentoTab';

/**
 * Code-split boundary for the pedido Link Pgto tab.
 *
 * PedidoForm renders this component only after the operator opens the tab for
 * the first time. Keeping the activation latch in the parent is load-bearing:
 * this module can stay mounted afterwards, preserving a half-typed vaquinha, its
 * Firestore listeners and the retry ids of a create that never got an answer
 * while another tab is active.
 */
const LinkPagamentoTabContent = dynamic(
  () => import('./LinkPagamentoTab').then((module) => module.LinkPagamentoTab),
  {
    ssr: false,
    loading: () => (
      <Group justify="center" py="xl" aria-label="Carregando links de pagamento">
        <Loader size="sm" />
      </Group>
    ),
  },
);

export function LazyLinkPagamentoTab(props: LinkPagamentoTabProps) {
  return <LinkPagamentoTabContent {...props} />;
}
