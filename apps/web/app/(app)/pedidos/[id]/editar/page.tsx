'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { FirebaseError } from 'firebase/app';
import { setDoc } from 'firebase/firestore';
import {
  Alert,
  Anchor,
  Button,
  Group,
  Select,
  Skeleton,
  Stack,
  TextInput,
  Title,
} from '@mantine/core';
import { PageHeader } from '@delfrance/ui';
import { useDocSnapshot } from '@delfrance/data/hooks';
import {
  ESTADO_PEDIDO_LABELS,
  type EstadoPedido,
  type ItemDoPedido,
  type Pedido,
  estadoPedidoSchema,
} from '@delfrance/schemas';
import { pedidoCollection } from '@/lib/data/pedidoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { ItensEditor } from '../../_components/ItensEditor';

const estadoOptions = estadoPedidoSchema.options.map((value) => ({
  value,
  label: ESTADO_PEDIDO_LABELS[value],
}));

/**
 * Re-group a flat list of items back into the
 * `Map<produtoUid, ItemDoPedido[]>` shape Pedido stores. Items without
 * a produtoUid bind to the literal key 'NONE' (matching the Flutter
 * convention).
 */
function regroupItens(items: ItemDoPedido[]): Pedido['itens'] {
  const out: Pedido['itens'] = {};
  for (const item of items) {
    const key = item.produtoUid && item.produtoUid !== '' ? item.produtoUid : 'NONE';
    (out[key] ??= []).push(item);
  }
  return out;
}

export default function EditarPedidoPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  const docRef = useMemo(
    () => pedidoCollection.docRef(getFirebaseFirestore(), {}, params.id),
    [params.id],
  );

  const { data, loading, error } = useDocSnapshot(docRef);

  const [numero, setNumero] = useState<string>('');
  const [estado, setEstado] = useState<EstadoPedido | null>(null);
  const [itens, setItens] = useState<ItemDoPedido[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Initialise local state once when the doc first resolves. Subsequent
  // remote changes don't clobber local edits — the user must reload to
  // pick them up. (Concurrent-edit conflict resolution is out of scope
  // for this slice.)
  const seeded = itens !== null;
  useEffect(() => {
    if (seeded || !data) return;
    setNumero(data.data.numero ?? '');
    setEstado(data.data.estado);
    const flat = Object.entries(data.data.itens).flatMap(([, list]) => list);
    flat.sort((a, b) => a.ordem - b.ordem);
    setItens(flat);
  }, [data, seeded]);

  async function handleSave() {
    if (!estado || !itens) return;
    setSaving(true);
    setSaveError(null);
    try {
      await setDoc(
        docRef,
        {
          numero: numero || null,
          estado,
          itens: regroupItens(itens),
        },
        { merge: true },
      );
      router.replace(`/pedidos/${params.id}`);
    } catch (err) {
      if (err instanceof FirebaseError) {
        setSaveError(err.message);
      } else {
        throw err;
      }
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Stack>
        <Skeleton height={32} width={240} />
        <Skeleton height={400} />
      </Stack>
    );
  }
  if (error) return <Alert color="red">{error.message}</Alert>;
  if (!data) return <Alert color="yellow">Pedido não encontrado.</Alert>;

  return (
    <Stack>
      <PageHeader
        title="Editar pedido"
        actions={
          <Anchor component={Link} href={`/pedidos/${params.id}`} size="sm">
            Cancelar
          </Anchor>
        }
      />

      <Group grow>
        <TextInput
          label="Número"
          value={numero}
          onChange={(e) => setNumero(e.currentTarget.value)}
        />
        <Select
          label="Status"
          data={estadoOptions}
          value={estado}
          onChange={(v) => setEstado(v as EstadoPedido | null)}
          searchable
        />
      </Group>

      <Title order={4}>Itens</Title>
      {itens && (
        <ItensEditor initial={itens} onChange={(next) => setItens(next)} />
      )}

      {saveError && <Alert color="red">{saveError}</Alert>}

      <Group justify="flex-end">
        <Button component={Link} href={`/pedidos/${params.id}`} variant="subtle">
          Cancelar
        </Button>
        <Button onClick={handleSave} loading={saving}>
          Salvar alterações
        </Button>
      </Group>
    </Stack>
  );
}
