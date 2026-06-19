'use client';

import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Group,
  Modal,
  Select,
  Skeleton,
  Stack,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { FirebaseError } from 'firebase/app';
import {
  ORIGEM_INCIDENTE_LABELS,
  TIPO_INCIDENTE,
  TIPO_INCIDENTE_LABELS,
  type Incidente,
  type OrigemIncidente,
  type TipoIncidente,
} from '@delfrance/schemas';
import { buildQuery, orderByField } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { deleteIncidente, saveIncidente } from '@delfrance/data/pedido';
import { incidenteCollection } from '@/lib/data/incidenteCollection';
import { createClientPedidoPort } from '@/lib/pedidos/clientPort';
import { getFirebaseFirestore } from '@/lib/firebase/client';

const tipoOptions = (Object.entries(TIPO_INCIDENTE_LABELS) as [string, string][]).map(
  ([value, label]) => ({ value, label }),
);
const origemOptions = [
  { value: '', label: '(nenhuma)' },
  ...(Object.entries(ORIGEM_INCIDENTE_LABELS) as [string, string][]).map(([value, label]) => ({
    value,
    label,
  })),
];

function formatMicros(micros: number | null | undefined): string {
  if (micros == null) return '—';
  return new Date(Math.round(micros / 1000)).toLocaleString('pt-BR');
}

interface IncidenteForm {
  tipo: string;
  origem: string;
  motivo: string;
  comentarios: string;
}
const EMPTY_FORM: IncidenteForm = {
  tipo: TIPO_INCIDENTE.devolucao,
  origem: '',
  motivo: '',
  comentarios: '',
};

export interface IncidentesTabProps {
  disabled?: boolean;
  /** Absent in create mode — there is no subcollection yet. */
  pedidoId?: string;
}

export function IncidentesTab({ disabled, pedidoId }: IncidentesTabProps) {
  if (!pedidoId) {
    return (
      <Text c="dimmed" size="sm">
        Salve o pedido para registrar incidentes.
      </Text>
    );
  }
  return <IncidentesManager pedidoId={pedidoId} disabled={disabled} />;
}

function IncidentesManager({ pedidoId, disabled }: { pedidoId: string; disabled?: boolean }) {
  const q = useMemo(() => {
    const base = incidenteCollection.ref(getFirebaseFirestore(), { pedidoId });
    return buildQuery(base, [orderByField('timestamp', 'desc')]);
  }, [pedidoId]);
  const { data, loading, error } = useSnapshot<Incidente>(q);

  // null = form closed; { id: null } = adding; { id, base } = editing an existing doc.
  const [editing, setEditing] = useState<{ id: string | null; base: Incidente | null } | null>(
    null,
  );
  const [form, setForm] = useState<IncidenteForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  function openAdd() {
    setForm(EMPTY_FORM);
    setEditing({ id: null, base: null });
    setSaveError(null);
  }
  function openEdit(id: string, incidente: Incidente) {
    setForm({
      tipo: incidente.tipo,
      origem: incidente.origem != null ? String(incidente.origem) : '',
      motivo: incidente.motivoDoIncidente ?? '',
      comentarios: incidente.comentarios ?? '',
    });
    setEditing({ id, base: incidente });
    setSaveError(null);
  }

  async function handleSave() {
    if (!editing) return;
    setSaving(true);
    setSaveError(null);
    // Spread the existing doc on edit so externalId / resolução / timestamp survive.
    const incidente: Record<string, unknown> = {
      ...(editing.base ?? {}),
      tipo: form.tipo as TipoIncidente,
      origem: form.origem === '' ? null : (Number(form.origem) as OrigemIncidente),
      motivoDoIncidente: form.motivo.trim() === '' ? null : form.motivo,
      comentarios: form.comentarios.trim() === '' ? null : form.comentarios,
    };
    try {
      await saveIncidente(createClientPedidoPort(getFirebaseFirestore()), {
        pedidoId,
        incidenteId: editing.id,
        incidente,
      });
      setEditing(null);
    } catch (err) {
      if (err instanceof FirebaseError) {
        setSaveError(err.message);
        return;
      }
      throw err;
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteIncidente(createClientPedidoPort(getFirebaseFirestore()), {
        pedidoId,
        incidenteId: deleteTarget,
      });
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Stack>
      <Group justify="space-between" align="center">
        <Title order={3}>Incidentes</Title>
        {!editing && (
          <Button size="xs" onClick={openAdd} disabled={disabled}>
            + Adicionar incidente
          </Button>
        )}
      </Group>

      {editing && (
        <Card withBorder>
          <Stack gap="sm">
            <Text fw={500}>{editing.id ? 'Editar incidente' : 'Novo incidente'}</Text>
            <Group grow align="flex-start">
              <Select
                label="Tipo"
                data={tipoOptions}
                value={form.tipo}
                onChange={(v) => v && setForm((f) => ({ ...f, tipo: v }))}
                allowDeselect={false}
                disabled={disabled}
              />
              <Select
                label="Origem"
                data={origemOptions}
                value={form.origem}
                onChange={(v) => setForm((f) => ({ ...f, origem: v ?? '' }))}
                disabled={disabled}
              />
            </Group>
            <Textarea
              label="Motivo"
              maxLength={2000}
              value={form.motivo}
              onChange={(e) => setForm((f) => ({ ...f, motivo: e.currentTarget.value }))}
              disabled={disabled}
              autosize
              minRows={2}
            />
            <Textarea
              label="Comentários"
              maxLength={2000}
              value={form.comentarios}
              onChange={(e) => setForm((f) => ({ ...f, comentarios: e.currentTarget.value }))}
              disabled={disabled}
              autosize
              minRows={2}
            />
            {saveError && <Alert color="red">{saveError}</Alert>}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setEditing(null)} disabled={saving}>
                Cancelar
              </Button>
              <Button onClick={handleSave} loading={saving} disabled={disabled}>
                Salvar
              </Button>
            </Group>
          </Stack>
        </Card>
      )}

      {error && <Alert color="red">{error.message}</Alert>}
      {loading && <Skeleton height={64} />}
      {!loading && data && data.length === 0 && (
        <Text c="dimmed" size="sm">
          Nenhum incidente registrado neste pedido.
        </Text>
      )}
      {!loading &&
        data?.map(({ id, data: inc }) => (
          <Card key={id} withBorder>
            <Group justify="space-between" align="flex-start">
              <Stack gap={2}>
                <Text fw={500}>{TIPO_INCIDENTE_LABELS[inc.tipo] ?? inc.tipo}</Text>
                <Text size="xs" c="dimmed">
                  {inc.origem != null ? ORIGEM_INCIDENTE_LABELS[inc.origem] : 'Sem origem'} ·{' '}
                  {formatMicros(inc.timestamp)}
                </Text>
                {inc.motivoDoIncidente && <Text size="sm">{inc.motivoDoIncidente}</Text>}
                {inc.comentarios && (
                  <Text size="sm" c="dimmed">
                    {inc.comentarios}
                  </Text>
                )}
              </Stack>
              <Group gap="xs">
                <Button
                  size="xs"
                  variant="light"
                  onClick={() => openEdit(id, inc)}
                  disabled={disabled}
                >
                  Editar
                </Button>
                <Button
                  size="xs"
                  variant="light"
                  color="red"
                  onClick={() => setDeleteTarget(id)}
                  disabled={disabled}
                >
                  Excluir
                </Button>
              </Group>
            </Group>
          </Card>
        ))}

      <Modal
        opened={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Excluir incidente"
        centered
      >
        <Stack>
          <Text>Tem certeza que deseja excluir este incidente?</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancelar
            </Button>
            <Button color="red" onClick={handleDelete} loading={deleting}>
              Excluir
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
