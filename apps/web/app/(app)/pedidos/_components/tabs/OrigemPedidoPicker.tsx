'use client';

import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Group,
  Modal,
  ScrollArea,
  Skeleton,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useQuery } from '@tanstack/react-query';
import { type DocumentReference, type Firestore, getDoc } from 'firebase/firestore';
import { buildQuery, limit, orderByField, whereOp } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { ESTADO_PEDIDO_LABELS, type Pedido } from '@delfrance/schemas';
import { pedidoCollection } from '@/lib/data/pedidoCollection';
import { clienteQueryKey, readClienteByRef } from '../rowReadPrefetch';
import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import { isReturnableOrigin } from './devolucaoForm';

/** Firestore prefix-range upper sentinel (sorts above any string with the prefix). */
const PREFIX_MAX = String.fromCharCode(0xffff);

const brl = (n: number): string =>
  n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function formatMicros(micros: number | null | undefined): string {
  if (micros == null) return '—';
  return new Date(Math.round(micros / 1000)).toLocaleDateString('pt-BR');
}

export interface PickedOrigem {
  id: string;
  data: Pedido;
}

export interface OrigemPedidoPickerProps {
  db: Firestore;
  opened: boolean;
  onClose: () => void;
  /** Current pedido id + already-added origin ids — hidden from the list. */
  excludeIds: ReadonlySet<string>;
  onPick: (picked: PickedOrigem) => void;
}

export function OrigemPedidoPicker({
  db,
  opened,
  onClose,
  excludeIds,
  onPick,
}: OrigemPedidoPickerProps) {
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Adicionar pedido para devolução"
      size="lg"
      centered
    >
      {/* Stop inner events bubbling to the ancestor pedido <form> — React events
          cross the modal portal (issue #231). Mount conditionally so each open
          starts fresh. */}
      {opened && (
        <div onSubmit={(e) => e.stopPropagation()}>
          <OrigemPedidoList db={db} excludeIds={excludeIds} onPick={onPick} onClose={onClose} />
        </div>
      )}
    </Modal>
  );
}

function OrigemPedidoList({
  db,
  excludeIds,
  onPick,
  onClose,
}: {
  db: Firestore;
  excludeIds: ReadonlySet<string>;
  onPick: (picked: PickedOrigem) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const [debounced] = useDebouncedValue(search.trim(), 250);

  // Index-free: a plain `numero desc` list, or a single-field `numero` prefix
  // query while searching. Eligibility (ehSaida + podeTrocar + exclude) is
  // filtered client-side on the ≤50 returned rows.
  const q = useMemo(() => {
    const base = pedidoCollection.ref(db, {});
    if (debounced !== '') {
      return buildQuery(base, [
        orderByField('numero', 'asc'),
        whereOp('numero', '>=', debounced),
        whereOp('numero', '<=', `${debounced}${PREFIX_MAX}`),
        limit(20),
      ]);
    }
    return buildQuery(base, [orderByField('numero', 'desc'), limit(50)]);
  }, [db, debounced]);

  const { data, loading, error } = useSnapshot<Pedido>(q);

  const rows = useMemo(
    () => (data ?? []).filter((r) => isReturnableOrigin(r.data, r.id, excludeIds)),
    [data, excludeIds],
  );

  return (
    <Stack>
      <TextInput
        label="Buscar por número"
        placeholder="Número do pedido…"
        value={search}
        onChange={(e) => {
          const value = e.currentTarget.value;
          setSearch(value);
        }}
      />
      {error && (
        <Text c="red" size="sm">
          {error.message}
        </Text>
      )}
      {loading && <Skeleton height={48} />}
      {!loading && rows.length === 0 && (
        <Text c="dimmed" size="sm">
          Nenhum pedido devolvível encontrado.
        </Text>
      )}
      <ScrollArea.Autosize mah={360}>
        <Stack gap="xs">
          {rows.map((r) => (
            <Group
              key={r.id}
              justify="space-between"
              wrap="nowrap"
              p="xs"
              style={{ border: '1px solid var(--mantine-color-gray-3)', borderRadius: 6 }}
            >
              <Stack gap={2}>
                <Group gap="xs">
                  <Text fw={500}>{r.data.numero ?? r.id}</Text>
                  <Badge variant="light" size="sm">
                    {ESTADO_PEDIDO_LABELS[r.data.estado] ?? r.data.estado}
                  </Badge>
                </Group>
                <Group gap={6}>
                  <ClienteName db={db} outerRef={r.data.clientePedidoOuterRef} />
                  <Text size="xs" c="dimmed">
                    · {brl(r.data.valorCobrado ?? 0)} · {formatMicros(r.data.timestamp)}
                  </Text>
                </Group>
              </Stack>
              <Button
                size="xs"
                aria-label={`Adicionar ${r.data.numero ?? r.id}`}
                onClick={() => onPick({ id: r.id, data: r.data })}
              >
                Adicionar
              </Button>
            </Group>
          ))}
        </Stack>
      </ScrollArea.Autosize>
      <Group justify="flex-end">
        <Button variant="default" onClick={onClose}>
          Fechar
        </Button>
      </Group>
    </Stack>
  );
}

/** The cliente's name for an order's `clientePedidoOuterRef` (deref + cached read). */
function ClienteName({ db, outerRef }: { db: Firestore; outerRef: unknown }) {
  const ref = useMemo(
    () => dereferenceOuterRef(db, outerRef),
    [db, outerRef],
  ) as DocumentReference<{ nome?: string | null }> | null;
  const path = ref?.path ?? null;

  const { data } = useQuery({
    // Shares this cache key with `ClienteCell` and the /pedidos page-level
    // batch, so it must share their reader too — see `readClienteByRef`.
    queryKey: clienteQueryKey(path ?? ''),
    queryFn: async () => (ref ? readClienteByRef<{ nome?: string | null }>(db, ref) : null),
    enabled: !!ref,
    staleTime: 5 * 60 * 1000,
  });

  return (
    <Text size="xs" c="dimmed">
      {data?.nome ?? 'Anônimo'}
    </Text>
  );
}
