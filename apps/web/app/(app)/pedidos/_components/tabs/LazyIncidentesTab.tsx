'use client';

import dynamic from 'next/dynamic';
import { Group, Loader } from '@mantine/core';

import type { IncidentesTabProps } from './IncidentesTab';

/**
 * Code-split boundary for the pedido Incidentes tab.
 *
 * PedidoForm renders this component only after the operator opens the tab for
 * the first time. Keeping the activation latch in the parent is load-bearing:
 * this module can stay mounted afterwards, preserving the editor, its Firestore
 * listener and its save-time flush registration while another tab is active.
 */
const IncidentesTabContent = dynamic(
  () => import('./IncidentesTab').then((module) => module.IncidentesTab),
  {
    ssr: false,
    loading: () => (
      <Group justify="center" py="xl" aria-label="Carregando incidentes">
        <Loader size="sm" />
      </Group>
    ),
  },
);

export function LazyIncidentesTab(props: IncidentesTabProps) {
  return <IncidentesTabContent {...props} />;
}
