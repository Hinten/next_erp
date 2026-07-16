'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ActionIcon, Badge, Group, Select, Stack, Tooltip } from '@mantine/core';
import { IconUser, IconX } from '@tabler/icons-react';
import { getDocs } from 'firebase/firestore';
import { buildQuery, limit, orderByField } from '@delfrance/data';
import { CONVERSA_ORDENS, ORDEM_LABELS, type ConversaOrdem } from '@/lib/chat/conversaConstraints';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import type { ConversaFiltersState } from '../_hooks/useConversaFilters';
import { EtiquetaPicker } from './EtiquetaPicker';
import { ClientePickerModal } from './ClientePickerModal';

interface IntegracaoOption {
  value: string;
  label: string;
}

async function loadIntegracoes(): Promise<IntegracaoOption[]> {
  const db = getFirebaseFirestore();
  const snap = await getDocs(
    buildQuery(integracaoCollection.ref(db, {}), [orderByField('nome', 'asc'), limit(50)]),
  );
  return snap.docs.map((d) => ({ value: d.id, label: d.data().nome }));
}

/**
 * Inbox filter row: ordering, integração, etiqueta, and cliente. All values
 * live in the URL via `useConversaFilters`; this component only renders the
 * controls and delegates to the setters.
 */
export function FiltersBar({ filters }: { filters: ConversaFiltersState }) {
  const [clienteModal, setClienteModal] = useState(false);
  // The cliente picker only stores the resolved ref in the URL; keep the picked
  // name in memory for the chip label (falls back to a generic label on reload).
  const [clienteNome, setClienteNome] = useState<string | null>(null);

  const { data: integracoes } = useQuery({
    queryKey: ['inboxIntegracoes'],
    queryFn: loadIntegracoes,
    staleTime: 5 * 60_000,
  });

  const ordemData = useMemo(
    () => CONVERSA_ORDENS.map((o) => ({ value: o, label: ORDEM_LABELS[o] })),
    [],
  );

  const clienteLabel = filters.clienteRef ? (clienteNome ?? 'Cliente selecionado') : null;

  return (
    <Stack gap="xs">
      <Group gap="xs" grow>
        <Select
          size="xs"
          label="Ordenar"
          data={ordemData}
          value={filters.ordem}
          onChange={(v) => v && filters.setOrdem(v as ConversaOrdem)}
          allowDeselect={false}
          comboboxProps={{ withinPortal: true }}
        />
        <Select
          size="xs"
          label="Integração"
          placeholder="Todas"
          data={integracoes ?? []}
          value={filters.integracaoId}
          onChange={(v) => filters.setIntegracao(v)}
          clearable
          searchable
          comboboxProps={{ withinPortal: true }}
        />
      </Group>

      <Group gap="xs" justify="space-between" wrap="nowrap">
        <EtiquetaPicker value={filters.etiqueta} onChange={filters.setEtiqueta} />
        {clienteLabel ? (
          <Badge
            size="lg"
            variant="light"
            rightSection={
              <ActionIcon
                size="xs"
                variant="transparent"
                aria-label="Remover filtro de cliente"
                onClick={() => {
                  filters.setCliente(null);
                  setClienteNome(null);
                }}
              >
                <IconX size={12} />
              </ActionIcon>
            }
          >
            {clienteLabel}
          </Badge>
        ) : (
          <Tooltip label="Filtrar por cliente" withArrow>
            <ActionIcon
              variant="subtle"
              aria-label="Filtrar por cliente"
              onClick={() => setClienteModal(true)}
            >
              <IconUser size={18} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>

      <ClientePickerModal
        opened={clienteModal}
        onClose={() => setClienteModal(false)}
        onSelect={(ref, nome) => {
          filters.setCliente(ref);
          setClienteNome(nome);
        }}
      />
    </Stack>
  );
}
