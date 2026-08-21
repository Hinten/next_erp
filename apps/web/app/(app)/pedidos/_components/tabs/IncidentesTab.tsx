'use client';

import { useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Divider,
  Group,
  Modal,
  Select,
  Skeleton,
  Stack,
  Switch,
  Text,
  Textarea,
  Title,
} from '@mantine/core';
import { DateTimePicker } from '@mantine/dates';
import { FirebaseError } from 'firebase/app';
import {
  ORIGEM_INCIDENTE,
  ORIGEM_INCIDENTE_LABELS,
  TIPO_INCIDENTE_LABELS,
  TIPO_RESOLUCAO_LABELS,
  type Incidente,
} from '@delfrance/schemas';
import { epochToPickerString, pickerStringToEpoch } from '@delfrance/ui';
import { buildQuery, orderByField } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { deleteIncidente, saveIncidente } from '@delfrance/data/pedido';
import { nowMicros } from '@delfrance/core/datetime';
import { incidenteCollection } from '@/lib/data/incidenteCollection';
import { createClientPedidoPort } from '@/lib/pedidos/clientPort';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { CurrencyInput } from '@/app/(app)/produtos/_components/CurrencyInput';
import {
  EMPTY_INCIDENTE_FORM,
  formFromIncidente,
  incidenteDataFromForm,
  isResolucaoLocked,
  validateIncidenteForm,
  type IncidenteFormState,
} from './incidenteForm';
import { ReclamacaoMlPanel } from '../ReclamacaoMlPanel';

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
const resolucaoTipoOptions = (Object.entries(TIPO_RESOLUCAO_LABELS) as [string, string][]).map(
  ([value, label]) => ({ value, label }),
);

function formatMicros(micros: number | null | undefined): string {
  if (micros == null) return '—';
  return new Date(Math.round(micros / 1000)).toLocaleString('pt-BR');
}

export interface IncidentesTabProps {
  disabled?: boolean;
  /** Absent in create mode — there is no subcollection yet. */
  pedidoId?: string;
  /**
   * The ML account this pedido came through, when it came through one.
   *
   * ⚠️ Required to reach the claim on ML. Absent for a pedido with no ML
   * integração, which is why the panel is conditional rather than always shown.
   */
  integracaoId?: string | null;
}

/**
 * Whether this incidente is a Mercado Livre claim we can query.
 *
 * ⚠️ BOTH halves matter. `origem` alone would match an incidente a human typed
 * and tagged Mercado Livre; `externalId` alone would match any origem that
 * happens to store a number. A claim id is numeric — `claimIdNumerico` in the
 * backend rejects anything else — so a non-numeric `externalId` is legacy data,
 * not a claim.
 */
function claimIdDoIncidente(inc: {
  origem?: number | null;
  externalId?: string | null;
}): number | null {
  if (inc.origem !== ORIGEM_INCIDENTE.pedidoMercadoLivre) return null;
  const raw = (inc.externalId ?? '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function IncidentesTab({ disabled, pedidoId, integracaoId }: IncidentesTabProps) {
  if (!pedidoId) {
    return (
      <Text c="dimmed" size="sm">
        Salve o pedido para registrar incidentes.
      </Text>
    );
  }
  return <IncidentesManager pedidoId={pedidoId} disabled={disabled} integracaoId={integracaoId} />;
}

function IncidentesManager({
  pedidoId,
  disabled,
  integracaoId,
}: {
  pedidoId: string;
  disabled?: boolean;
  integracaoId?: string | null;
}) {
  const q = useMemo(() => {
    const base = incidenteCollection.ref(getFirebaseFirestore(), { pedidoId });
    return buildQuery(base, [orderByField('timestamp', 'desc')]);
  }, [pedidoId]);
  const { data, loading, error } = useSnapshot<Incidente>(q);

  // null = form closed; { id: null } = adding; { id, base } = editing an existing doc.
  const [editing, setEditing] = useState<{ id: string | null; base: Incidente | null } | null>(
    null,
  );
  const [form, setForm] = useState<IncidenteFormState>(EMPTY_INCIDENTE_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // The resolução is read-only once its return shipping is in progress (legacy
  // `bloquear`); the frete sub-editor itself is deferred (see incidenteForm.ts).
  const resolucaoLocked = isResolucaoLocked(editing?.base ?? null);
  const hasFrete = (editing?.base?.resolucao?.frete ?? null) != null;

  function openAdd() {
    setForm(EMPTY_INCIDENTE_FORM);
    setEditing({ id: null, base: null });
    setSaveError(null);
  }
  function openEdit(id: string, incidente: Incidente) {
    setForm(formFromIncidente(incidente));
    setEditing({ id, base: incidente });
    setSaveError(null);
  }

  function toggleResolucao(on: boolean) {
    // Default the date to now the first time a resolução is enabled (legacy
    // `DateTime.now()` default).
    setForm((f) => ({
      ...f,
      registrarResolucao: on,
      resData: on ? (f.resData ?? nowMicros()) : f.resData,
    }));
  }

  async function handleSave() {
    if (!editing) return;
    const validationError = validateIncidenteForm(form);
    if (validationError) {
      setSaveError(validationError);
      return;
    }
    setSaving(true);
    setSaveError(null);
    const incidente = incidenteDataFromForm(form, editing.base, nowMicros());
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

  const resFieldsDisabled = disabled || resolucaoLocked;

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
              onChange={(e) => {
                // Read the value eagerly: React nulls `currentTarget` after the
                // dispatch, and dev StrictMode re-invokes the updater later, so
                // reading it inside `setForm((f) => …)` throws `currentTarget is
                // null`. The const keeps the updater pure.
                const value = e.currentTarget.value;
                setForm((f) => ({ ...f, motivo: value }));
              }}
              disabled={disabled}
              autosize
              minRows={2}
            />
            <Textarea
              label="Comentários"
              maxLength={2000}
              value={form.comentarios}
              onChange={(e) => {
                const value = e.currentTarget.value;
                setForm((f) => ({ ...f, comentarios: value }));
              }}
              disabled={disabled}
              autosize
              minRows={2}
            />

            <Divider my="xs" label="Resolução" labelPosition="left" />
            <Group justify="space-between" align="center">
              <Switch
                label="Registrar resolução"
                checked={form.registrarResolucao}
                onChange={(e) => toggleResolucao(e.currentTarget.checked)}
                disabled={resFieldsDisabled}
              />
              {resolucaoLocked && (
                <Badge color="orange" variant="light">
                  Bloqueada — frete em andamento
                </Badge>
              )}
            </Group>

            {form.registrarResolucao && (
              <Stack gap="sm">
                <Group grow align="flex-start">
                  <Select
                    label="Tipo de resolução"
                    placeholder="Selecione"
                    data={resolucaoTipoOptions}
                    value={form.resTipo}
                    onChange={(v) => setForm((f) => ({ ...f, resTipo: v ?? '' }))}
                    disabled={resFieldsDisabled}
                    withAsterisk
                    // Surface the requirement as soon as "Registrar resolução" is on,
                    // not only at Save (validateIncidenteForm still blocks the save).
                    error={form.resTipo === '' ? 'Selecione o tipo de resolução.' : undefined}
                  />
                  <DateTimePicker
                    label="Data da resolução"
                    value={epochToPickerString(form.resData, 'us')}
                    onChange={(v) =>
                      setForm((f) => ({ ...f, resData: pickerStringToEpoch(v, 'us') }))
                    }
                    valueFormat="DD/MM/YYYY HH:mm"
                    clearable
                    disabled={resFieldsDisabled}
                  />
                </Group>
                <CurrencyInput
                  label="Despesa da resolução"
                  value={form.resValor}
                  onChange={(n) => setForm((f) => ({ ...f, resValor: n }))}
                  disabled={resFieldsDisabled}
                />
                <Textarea
                  label="Comentários sobre a resolução"
                  maxLength={2000}
                  value={form.resComentarios}
                  onChange={(e) => {
                    const value = e.currentTarget.value;
                    setForm((f) => ({ ...f, resComentarios: value }));
                  }}
                  disabled={resFieldsDisabled}
                  autosize
                  minRows={2}
                />
                {hasFrete && (
                  <Text size="xs" c="dimmed">
                    Esta resolução possui um frete de devolução. A edição do frete da resolução
                    ainda não foi portada; o registro existente é preservado.
                  </Text>
                )}
              </Stack>
            )}

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
                <Group gap="xs">
                  <Text fw={500}>{TIPO_INCIDENTE_LABELS[inc.tipo] ?? inc.tipo}</Text>
                  {inc.resolucao && (
                    <Badge color="green" variant="light">
                      {TIPO_RESOLUCAO_LABELS[inc.resolucao.tipo] ?? 'Resolvido'}
                    </Badge>
                  )}
                </Group>
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
                {/* ⚠️ The ML claim id was stored but never rendered, so an
                    imported incidente was indistinguishable from a hand-typed
                    one. It is also the key the panel below queries on. */}
                {inc.externalId && (
                  <Text size="xs" c="dimmed">
                    ML #{inc.externalId}
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
            {(() => {
              const claimId = claimIdDoIncidente(inc);
              return claimId != null && integracaoId ? (
                <ReclamacaoMlPanel claimId={claimId} integracaoId={integracaoId} />
              ) : null;
            })()}
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
