'use client';

import { useCallback, useMemo, useState } from 'react';
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
import { epochToPickerString, pickerStringToEpoch, useServerTruthSeed } from '@delfrance/ui';
import { buildQuery, orderByField } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { deleteIncidente, saveIncidente } from '@delfrance/data/pedido';
import { nowMicros } from '@delfrance/core/datetime';
import { valuesEqual } from '@delfrance/core/equality';
import { incidenteCollection } from '@/lib/data/incidenteCollection';
import { createClientPedidoPort } from '@/lib/pedidos/clientPort';
import { createClientIncidentePort } from '@/lib/pedidos/incidentePort';
import {
  IncidenteConflictError,
  IncidenteMissingError,
  saveIncidenteEdit,
} from '@/lib/pedidos/saveIncidenteEdit';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { CurrencyInput } from '@/app/(app)/produtos/_components/CurrencyInput';
import {
  EMPTY_INCIDENTE_FORM,
  formFromIncidente,
  incidenteDataFromForm,
  isResolucaoLocked,
  validateIncidenteForm,
  type CampoAutoralIncidente,
  type IncidenteFormState,
} from './incidenteForm';
import { IncidenteConflictModal } from './IncidenteConflictModal';
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
  const { data, loading, error, fromCache } = useSnapshot<Incidente>(q);

  // null = form closed; { id: null } = adding; { id, base } = editing an existing doc.
  // `base` is the CONCURRENCY BASELINE — the version the operator has actually
  // reviewed — not "the row as it will be saved". Everything the save reads off
  // the document comes from `live` below.
  const [editing, setEditing] = useState<{ id: string | null; base: Incidente | null } | null>(
    null,
  );
  const [form, setForm] = useState<IncidenteFormState>(EMPTY_INCIDENTE_FORM);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [conflict, setConflict] = useState<{
    /** The version the operator reviewed. Null only on the create path, which never conflicts. */
    baseline: Incidente | null;
    current: Incidente;
    campos: CampoAutoralIncidente[];
    bloqueouAgora: boolean;
  } | null>(null);

  // Read off `editing` once: an optional chain inside a dependency array reads
  // as the whole object to the React Compiler, which then skips the component.
  const editingId = editing?.id ?? null;
  const editingBase = editing?.base ?? null;

  /**
   * The row being edited AS IT IS NOW, not as it was when `Editar` was clicked.
   *
   * `useSnapshot` keeps `data` live but `editing.base` is captured once, and
   * every read off that capture goes stale the moment anyone else writes the
   * document — which is routine here: the Mercado Livre claims webhook merges
   * `resolucao` / `claimStatus` / `claimStage` / `entregue` onto this very doc,
   * and a second operator tab edits the same fields (#1250).
   *
   * `null` while adding (`editing.id === null`) and when the row has been
   * DELETED under the open form, which the save has to refuse rather than
   * re-create.
   */
  const live = useMemo(
    () => (editingId ? (data?.find((r) => r.id === editingId)?.data ?? null) : null),
    [data, editingId],
  );
  const rowDeleted = editingId !== null && !loading && live === null;

  // The resolução is read-only once its return shipping is in progress (legacy
  // `bloquear`); the frete sub-editor itself is deferred (see incidenteForm.ts).
  // Derived from `live`, so the lock ARMS while the form is open — the fields go
  // read-only under the operator with their typed text intact, and the guarded
  // save refuses rather than dropping their resolução edits silently.
  const resolucaoLocked = isResolucaoLocked(live);
  const hasFrete = (live?.resolucao?.frete ?? null) != null;

  // "Dirty" for the re-seed below: the form no longer matches the baseline it
  // was seeded from. Structural (`valuesEqual`) — `formFromIncidente` returns a
  // fresh object every call, so an identity check would report dirty always and
  // the server-truth correction would never run.
  const baselineDiffers = useMemo(
    () => editingBase != null && !valuesEqual(form, formFromIncidente(editingBase)),
    [form, editingBase],
  );
  const seedFromServerTruth = useCallback(() => {
    if (!live || editingId === null) return;
    setEditing({ id: editingId, base: live });
    setForm(formFromIncidente(live));
  }, [live, editingId]);

  /**
   * Paint the first snapshot, then correct to server truth once — the contract
   * `ObjectView` follows, wired here because this form is hand-written.
   *
   * Load-bearing rather than polish: `openEdit` fires on a row that may have
   * come from the IndexedDB cache, so without this the first SERVER emission
   * would differ from the captured baseline and read as a concurrent edit —
   * popping a conflict modal on a document nobody touched (#972). The form and
   * the baseline are re-seeded in the SAME callback for exactly that reason;
   * correcting one while the other held the cached copy is what caused it.
   */
  useServerTruthSeed({
    id: editingId ?? undefined,
    fromCache,
    isDirty: baselineDiffers,
    onSeed: seedFromServerTruth,
  });

  function openAdd() {
    setForm(EMPTY_INCIDENTE_FORM);
    setEditing({ id: null, base: null });
    setSaveError(null);
    setConflict(null);
  }
  function openEdit(id: string, incidente: Incidente) {
    setForm(formFromIncidente(incidente));
    setEditing({ id, base: incidente });
    setSaveError(null);
    setConflict(null);
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

  /**
   * Write the edits.
   *
   * CREATE (`editing.id === null`) keeps the whole-document converter `set`:
   * it mints the id, stamps `timestamp`, and there is no stored document to
   * regress. UPDATE goes through the guarded path — authored keys only, inside
   * a transaction that re-reads the doc (see `saveIncidenteEdit`).
   *
   * `baseline` is the version the operator reviewed. `handleForceSave` passes
   * the one they just read in the conflict modal instead, so an override never
   * clobbers an edit nobody has seen.
   */
  async function commitIncidente(baseline: Incidente | null): Promise<boolean> {
    if (!editing) return false;
    const incidenteId = editing.id;
    // ⚠️ No fallback to a baseline-less update. Without a baseline there is
    // nothing to compare, and a save that cannot be guarded must not happen —
    // falling through to `incidenteDataFromForm(form, null, …)` here would
    // write an EMPTY document over a real one. `openEdit` always sets `base`,
    // so this is a bug guard, not a path.
    if (incidenteId !== null && baseline === null) {
      setSaveError('Ainda carregando a versão mais recente do incidente — tente novamente.');
      return false;
    }
    setSaving(true);
    setSaveError(null);
    try {
      if (incidenteId === null || baseline === null) {
        // CREATE: the op mints the id and stamps `timestamp`, and there is no
        // stored document for the whole-document `set` to regress.
        await saveIncidente(createClientPedidoPort(getFirebaseFirestore()), {
          pedidoId,
          incidenteId: null,
          incidente: incidenteDataFromForm(form, null, nowMicros()),
        });
      } else {
        await saveIncidenteEdit(
          createClientIncidentePort(getFirebaseFirestore(), pedidoId, incidenteId),
          { form, baseline },
        );
      }
      setConflict(null);
      setEditing(null);
      return true;
    } catch (err) {
      if (err instanceof IncidenteConflictError) {
        // Changed remotely on a field this save writes → let the operator review
        // the diff and decide. Never a silent overwrite (tier 3).
        setConflict({
          baseline,
          current: err.current,
          campos: err.campos,
          bloqueouAgora: err.bloqueouAgora,
        });
        return false;
      }
      if (err instanceof IncidenteMissingError) {
        setConflict(null);
        setSaveError(err.message);
        return false;
      }
      if (err instanceof FirebaseError) {
        setSaveError(err.message);
        return false;
      }
      throw err;
    } finally {
      setSaving(false);
    }
  }

  async function handleSave() {
    if (!editing) return;
    if (rowDeleted) {
      setSaveError(new IncidenteMissingError().message);
      return;
    }
    const validationError = validateIncidenteForm(form);
    if (validationError) {
      setSaveError(validationError);
      return;
    }
    await commitIncidente(editing.base);
  }

  /**
   * "Salvar mesmo assim": override the version the operator JUST reviewed by
   * re-baselining on it, not by force-writing. If the doc changed AGAIN since
   * the modal opened, the guard re-trips and the newer diff replaces it.
   */
  async function handleForceSave() {
    if (!conflict) return;
    await commitIncidente(conflict.current);
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
                disabled={resFieldsDisabled}
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
              disabled={resFieldsDisabled}
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
              disabled={resFieldsDisabled}
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

            {rowDeleted && (
              <Alert color="red">
                Este incidente foi excluído por outra pessoa enquanto você o editava. Salvar iria
                recriá-lo.
              </Alert>
            )}
            {saveError && <Alert color="red">{saveError}</Alert>}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setEditing(null)} disabled={saving}>
                Cancelar
              </Button>
              <Button onClick={handleSave} loading={saving} disabled={disabled || rowDeleted}>
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
                    one. It is also the key the panel below queries on.

                    ⚠️ The "ML #" prefix uses the SAME predicate as the panel —
                    `claimIdDoIncidente` — not `externalId` alone. Keying on the
                    id by itself is exactly what that function's own comment
                    rejects ("would match any origem that happens to store a
                    number"), and it would label a `site`/`troca`/`devolucao`
                    incidente as Mercado Livre. A mislabelled id is worse than an
                    unlabelled one, and the legacy export is read-tolerant
                    territory (root `CLAUDE.md` rule 8). */}
                {claimIdDoIncidente(inc) != null ? (
                  <Text size="xs" c="dimmed">
                    ML #{inc.externalId}
                  </Text>
                ) : (
                  inc.externalId && (
                    <Text size="xs" c="dimmed">
                      Ref. externa: {inc.externalId}
                    </Text>
                  )
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

      <IncidenteConflictModal
        opened={conflict !== null}
        campos={conflict?.campos ?? []}
        baseline={conflict?.baseline ?? null}
        current={conflict?.current ?? null}
        bloqueouAgora={conflict?.bloqueouAgora ?? false}
        saving={saving}
        onForceSave={handleForceSave}
        onCancel={() => setConflict(null)}
      />

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
