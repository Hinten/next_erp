'use client';

import { useState } from 'react';
import { Alert, Button, Group, Modal, Stack, Text, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowBackUp, IconInfoCircle } from '@tabler/icons-react';
import { FirebaseError } from 'firebase/app';
import { getDoc, getDocs, type Firestore } from 'firebase/firestore';
import {
  useForm,
  useFormContext,
  useFormState,
  type Control,
  type FieldValues,
} from 'react-hook-form';
import { ZodError } from 'zod';
import { buildQuery, limit, orderByField } from '@delfrance/data';
import { microsToDate } from '@delfrance/core/datetime';
import {
  PRODUTO_EXTRA_DATA_DOC_ID,
  produtoExtraDataSchema,
  type ImpostoProduto,
  type ProdutoExtraData,
} from '@delfrance/schemas';
import { useObjectViewSections } from '@delfrance/ui';
import {
  ModificacaoHistoryFeed,
  renderValue,
  type ListEntry,
} from '@/components/ModificacaoHistoryFeed';
import { historicoModificacoesCollection } from '@/lib/data/historicoModificacoesCollection';
import { impostoProdutoCollection } from '@/lib/data/impostoProdutoCollection';
import { operacaoCollection } from '@/lib/data/operacaoCollection';
import { produtoExtraDataCollection } from '@/lib/data/produtoExtraDataCollection';
import {
  IMPOSTO_LIMIT,
  montarLinhasImposto,
  OPERACAO_LIMIT,
  operacoesAtivas,
} from '@/lib/produtos/impostoRows';
import {
  buildDocumentRestorePrefill,
  buildRevertPrefill,
  checkDocumentRestore,
  checkRevert,
  isDocumentRestorable,
  isRevertible,
  RevertPrefillError,
  type DocumentRestoreTarget,
  type RevertPrefillBase,
  type RevertTarget,
} from '@/lib/produtos/revert';

/**
 * "Modificações" tab — the produto's unified `historicoDeModificacoes` feed with
 * per-field revert ("Restaurar") for a whitelist of safe fields, plus
 * document-level undelete ("Restaurar documento", #648) for a `delete`-kind
 * entry on the `extraData`/`imposto` subcollections (`@/lib/produtos/revert`).
 *
 * The feed itself (live page 1 + cursor tail, expand, actor rendering) lives in
 * the shared `ModificacaoHistoryFeed`, which the pedido tab reuses. This wrapper
 * owns ONLY what is produto-specific: the revert/restore paths and their
 * conflict modals. `create` entries stay display-only (nothing to revert TO),
 * and so does a `delete` entry for the produto document itself — see
 * `revert.ts`'s module doc for why that one is permanently out of scope.
 *
 * ## Restaurar STAGES, it does not write (#660)
 *
 * The old path wrote the old value straight to Firestore, and the open form was
 * never told: `useServerTruthSeed` withholds its re-seed while the form is
 * dirty, so the operator got a success toast over an unchanged screen — and the
 * next "Salvar" wrote the stale form values back over the revert.
 *
 * So the click now pre-fills the form instead: `setValue(..., shouldDirty)` on
 * the field's own key, a jump to the tab that renders it, and an inline note
 * saying nothing has been written yet. "Salvar alterações" commits it on the
 * standard path — one write, one history entry, the usual validation, and for a
 * parent's `precos` the usual re-propagation to the variation children.
 *
 * ⚠️ Everything the staging needs is read INSIDE the click handler, never from
 * an effect: this tab is not in `PRODUTO_PERSISTENT_SECTIONS`, so the jump in
 * step 4 unmounts its effects (`<Activity mode="hidden">`). Local state
 * survives that, which is what keeps the notes on screen when the operator
 * comes back.
 */

interface ConflictState {
  entryId: string;
  /** The entry's `timestamp` (µs) — the staged note is dated from it. */
  entryTimestamp: number | null;
  field: string;
  target: RevertTarget;
  currentValue: unknown;
}

/** Advisory conflict state for a document-level "Restaurar documento" (#648). */
interface DocConflictState {
  entryId: string;
  entryTimestamp: number | null;
  target: DocumentRestoreTarget;
  currentData: Record<string, unknown> | null;
}

/** A revert sitting in the form, unwritten. Keyed like `pendingKey`. */
interface StagedRevert {
  key: string;
  field: string;
  /** The entry's `timestamp` (µs), for "restaurado da modificação de …". */
  timestamp: number | null;
}

/** The produto document itself has no `subcolecao`; its subdocs name themselves. */
const SUBCOLECAO_LABELS: Record<string, string> = {
  '': 'Produto',
  extraData: 'SEO/Marketing',
  imposto: 'Imposto',
};

const dateFmt = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

/**
 * `formState.dirtyFields`, subscribed from THIS component.
 *
 * Reading `form.formState` off the object `useFormContext()` returns would
 * register the proxy subscription on whoever called `useForm` — `ObjectView` —
 * not here, so this component would only re-render when that one happened to.
 * `useFormState` subscribes locally, but it needs a control, and the context is
 * null outside an `ObjectView` (this tab renders standalone in its own unit
 * tests): the throwaway form supplies one, permanently pristine, which is the
 * right answer when there is no form to stage into anyway.
 *
 * ⚠️ Per-KEY, not the form-wide `isDirty`. `staged` only ever grows, so a
 * form-wide gate hides the notes while the form is pristine and brings every
 * one of them back the moment it goes dirty again — after a save, the next
 * unrelated edit would re-announce a revert that is already written.
 */
function useDirtyFields(control: Control<FieldValues> | undefined): Record<string, unknown> {
  const fallback = useForm<FieldValues>();
  const { dirtyFields } = useFormState({ control: control ?? fallback.control });
  return dirtyFields as Record<string, unknown>;
}

export interface ModificacoesManagerProps {
  db: Firestore;
  produtoId: string;
  /**
   * Mirrors the form's read-only state. A staged revert can only ever be
   * committed by "Salvar", which `ObjectView` hides for a viewer without write
   * permission — so offering Restaurar there is an affordance that leads
   * nowhere (the enabled-button gap noted when the tab shipped).
   */
  disabled?: boolean;
}

export function ModificacoesManager({ db, produtoId, disabled }: ModificacoesManagerProps) {
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [staged, setStaged] = useState<Record<string, StagedRevert>>({});
  // Document-level restore ("Restaurar documento", #648) — separate pending/
  // conflict state from the per-field one above; the two act on different
  // targets and can be in flight independently.
  const [docPendingId, setDocPendingId] = useState<string | null>(null);
  const [docConflict, setDocConflict] = useState<DocConflictState | null>(null);
  const [docConfirming, setDocConfirming] = useState(false);

  // Both are typed non-null by their libraries but ARE null outside their
  // providers — this component renders standalone in its own unit tests, and
  // `ObjectView` is what mounts both. Optional-chain, like every other
  // `useFormContext` call site in this app.
  const form = useFormContext();
  const sections = useObjectViewSections();
  const dirtyFields = useDirtyFields(form?.control);

  // A note survives exactly as long as its OWN key is still dirty. A save
  // resets the form to the persisted values and a manual undo restores the
  // original, and RHF drops the key from `dirtyFields` either way — so both
  // cases retire the note, and an unrelated edit afterwards does not revive it.
  // Derived rather than cleared in an effect: an effect here would not run
  // while the tab is hidden.
  const stagedVisible = Object.fromEntries(
    Object.entries(staged).filter(([, s]) => dirtyFields[s.key] != null),
  );
  const stagedCount = Object.keys(stagedVisible).length;

  /**
   * Load the transient form fields a revert has to be folded INTO.
   *
   * `extraData` and `impostos` are seeded by their own tabs, whose effects do
   * not run until the operator opens them — so on an untouched produto both are
   * still `null` here. Folding into an empty value would blank every sibling
   * field of those documents on save, so read them the same way their tabs
   * would have.
   */
  async function loadPrefillBase(subcolecao: string | null): Promise<RevertPrefillBase> {
    const base: RevertPrefillBase = {
      extraData: (form?.getValues('extraData') as ProdutoExtraData | null) ?? null,
      impostos: (form?.getValues('impostos') as ImpostoProduto[] | null) ?? null,
    };

    if (subcolecao === 'extraData' && base.extraData === null) {
      const snap = await getDoc(
        produtoExtraDataCollection.docRef(db, { produtoId }, PRODUTO_EXTRA_DATA_DOC_ID),
      );
      // A missing singleton has no siblings to lose — the schema's empty shape
      // is the honest base, and the revert supplies the one field it carries.
      base.extraData = produtoExtraDataSchema.parse(snap.data() ?? {});
    }

    if (subcolecao === 'imposto' && base.impostos === null) {
      const [operacoesSnap, impostosSnap] = await Promise.all([
        getDocs(
          buildQuery(operacaoCollection.ref(db, {}), [orderByField('nome'), limit(OPERACAO_LIMIT)]),
        ),
        getDocs(
          buildQuery(impostoProdutoCollection.ref(db, { produtoId }), [limit(IMPOSTO_LIMIT)]),
        ),
      ]);
      base.impostos = montarLinhasImposto(
        operacoesAtivas(operacoesSnap.docs.map((d) => ({ id: d.id, data: d.data() }))),
        impostosSnap.docs.map((d) => ({ id: d.id, data: d.data() })),
      );
    }

    return base;
  }

  async function finishRestaurar(
    entry: { id: string; timestamp: number | null },
    target: RevertTarget,
  ) {
    if (!form) {
      notifications.show({
        color: 'red',
        title: 'Falha ao restaurar',
        message: 'O formulário do produto não está disponível nesta tela.',
      });
      return;
    }
    const base = await loadPrefillBase(target.subcolecao);
    const { key, value } = buildRevertPrefill(target, base);

    // ⚠️ Jump BEFORE writing, not after. An inactive tab is hidden with
    // `<Activity mode="hidden">`, which unmounts every effect in it — including
    // the subscription the field's RHF `Controller` registers — and the input
    // does NOT re-sync when those effects mount again. Staging first left the
    // operator on the right tab still reading the OLD value, with the restored
    // one live in the form but invisible. `goToSection` commits synchronously,
    // so the input is mounted and subscribed by the time `setValue` runs.
    const section = sections?.sectionOfField(key);
    if (section) sections?.goToSection(section);

    // `shouldDirty` is load-bearing, not cosmetic: `ObjectView.doSave` writes
    // only the dirty keys, so without it the staged value would never reach
    // Firestore.
    form.setValue(key, value, { shouldDirty: true, shouldValidate: true });

    setStaged((prev) => ({
      ...prev,
      [`${entry.id}:${target.field}`]: {
        key,
        field: target.field,
        timestamp: entry.timestamp,
      },
    }));
    notifications.show({
      color: 'blue',
      title: 'Valor restaurado no formulário',
      message: 'Nada foi gravado ainda — clique em "Salvar alterações" para aplicar.',
    });
  }

  /**
   * The three failure surfaces a staging attempt has, shared by both entry
   * points. Returns whether it recognised the error; anything else is the
   * caller's to rethrow, so an unexpected failure still surfaces as one.
   */
  function reportRestaurarError(err: unknown): boolean {
    if (err instanceof FirebaseError) {
      notifications.show({ color: 'red', title: 'Falha ao restaurar', message: err.message });
      return true;
    }
    // The stored old value no longer fits the CURRENT schema (schema evolution,
    // or a legacy Flutter-written field outside it). It surfaced here as a
    // rejected `merge()` before; now it is the seed read's `parse`.
    if (err instanceof ZodError) {
      notifications.show({
        color: 'red',
        title: 'Falha ao restaurar',
        message: 'Não foi possível restaurar: o valor antigo é incompatível com o esquema atual.',
      });
      return true;
    }
    // The revert has no home in the form — e.g. an imposto whose operação was
    // deactivated since the entry was recorded.
    if (err instanceof RevertPrefillError) {
      notifications.show({ color: 'red', title: 'Falha ao restaurar', message: err.message });
      return true;
    }
    return false;
  }

  async function handleRestaurar(
    entry: ListEntry,
    field: string,
    change: { old: unknown; new: unknown },
  ) {
    const target: RevertTarget = {
      produtoId,
      subcolecao: entry.subcolecao,
      docId: entry.docId,
      field,
      oldValue: change.old,
      newValue: change.new,
    };
    setPendingKey(`${entry.id}:${field}`);
    try {
      // Still advisory, and MORE useful before a pre-fill than it was before a
      // write: the operator now gets to see what they would overwrite while
      // there is still nothing to undo.
      const { conflict: hasConflict, currentValue } = await checkRevert(db, target);
      if (hasConflict) {
        setConflict({
          entryId: entry.id,
          entryTimestamp: entry.timestamp,
          field,
          target,
          currentValue,
        });
        return;
      }
      await finishRestaurar(entry, target);
    } catch (err) {
      if (!reportRestaurarError(err)) throw err;
    } finally {
      setPendingKey(null);
    }
  }

  async function handleConfirmConflict() {
    if (!conflict) return;
    setConfirming(true);
    try {
      await finishRestaurar(
        { id: conflict.entryId, timestamp: conflict.entryTimestamp },
        conflict.target,
      );
      setConflict(null);
    } catch (err) {
      if (!reportRestaurarError(err)) throw err;
    } finally {
      setConfirming(false);
    }
  }

  /**
   * "Restaurar documento" (#648) — the document-level counterpart of
   * {@link finishRestaurar}. Undeletes a `delete`-kind entry's whole document
   * (`extraData` singleton or one `imposto` row) by staging the RECONSTRUCTED
   * document into the form, same "stage, never write" contract as the
   * field-level revert.
   */
  async function finishRestaurarDocumento(
    entry: { id: string; timestamp: number | null },
    target: DocumentRestoreTarget,
  ) {
    if (!form) {
      notifications.show({
        color: 'red',
        title: 'Falha ao restaurar',
        message: 'O formulário do produto não está disponível nesta tela.',
      });
      return;
    }
    const base = await loadPrefillBase(target.subcolecao);
    const { key, value } = buildDocumentRestorePrefill(target, base);

    const section = sections?.sectionOfField(key);
    if (section) sections?.goToSection(section);

    form.setValue(key, value, { shouldDirty: true, shouldValidate: true });

    setStaged((prev) => ({
      ...prev,
      // Distinct field name (`__document__`) so this note never collides with
      // a per-field revert note staged into the very same form key.
      [`${entry.id}:__document__`]: { key, field: '__document__', timestamp: entry.timestamp },
    }));
    notifications.show({
      color: 'blue',
      title: 'Documento restaurado no formulário',
      message: 'Nada foi gravado ainda — clique em "Salvar alterações" para aplicar.',
    });
  }

  async function handleRestaurarDocumento(entry: ListEntry) {
    const target: DocumentRestoreTarget = {
      produtoId,
      subcolecao: entry.subcolecao,
      docId: entry.docId,
      changes: entry.changes,
    };
    setDocPendingId(entry.id);
    try {
      const { conflict: hasConflict, currentData } = await checkDocumentRestore(db, target);
      if (hasConflict) {
        setDocConflict({
          entryId: entry.id,
          entryTimestamp: entry.timestamp,
          target,
          currentData,
        });
        return;
      }
      await finishRestaurarDocumento(entry, target);
    } catch (err) {
      if (!reportRestaurarError(err)) throw err;
    } finally {
      setDocPendingId(null);
    }
  }

  async function handleConfirmDocConflict() {
    if (!docConflict) return;
    setDocConfirming(true);
    try {
      await finishRestaurarDocumento(
        { id: docConflict.entryId, timestamp: docConflict.entryTimestamp },
        docConflict.target,
      );
      setDocConflict(null);
    } catch (err) {
      if (!reportRestaurarError(err)) throw err;
    } finally {
      setDocConfirming(false);
    }
  }

  return (
    <Stack gap="md">
      {stagedCount > 0 && (
        <Alert color="yellow" icon={<IconInfoCircle size={16} />} title="Alterações não salvas">
          {stagedCount === 1
            ? '1 valor foi restaurado no formulário e ainda não foi gravado.'
            : `${stagedCount} valores foram restaurados no formulário e ainda não foram gravados.`}{' '}
          Clique em &quot;Salvar alterações&quot; para aplicar.
        </Alert>
      )}
      <ModificacaoHistoryFeed
        db={db}
        collection={historicoModificacoesCollection}
        ctx={{ produtoId }}
        subcolecaoLabels={SUBCOLECAO_LABELS}
        renderFieldActions={(entry, field, change) => (
          <RestaurarAction
            entry={entry}
            field={field}
            change={change}
            disabled={disabled}
            pending={pendingKey === `${entry.id}:${field}`}
            staged={stagedVisible[`${entry.id}:${field}`]}
            onRestaurar={() => void handleRestaurar(entry, field, change)}
          />
        )}
        renderEntryActions={(entry) => (
          <RestaurarDocumentoAction
            entry={entry}
            disabled={disabled}
            pending={docPendingId === entry.id}
            staged={stagedVisible[`${entry.id}:__document__`]}
            onRestaurar={() => void handleRestaurarDocumento(entry)}
          />
        )}
      />
      <Modal
        opened={docConflict !== null}
        onClose={() => setDocConflict(null)}
        title="Documento já existe"
        centered
      >
        {docConflict && (
          <Stack gap="xs">
            <Text size="sm">
              Já existe um documento nesta posição — restaurar substituiria o conteúdo atual pelo da
              modificação excluída.
            </Text>
            <Text size="sm">Conteúdo atual: {renderValue(docConflict.currentData)}</Text>
            <Group justify="flex-end" mt="sm">
              <Button
                variant="default"
                onClick={() => setDocConflict(null)}
                disabled={docConfirming}
              >
                Cancelar
              </Button>
              <Button
                color="red"
                onClick={() => void handleConfirmDocConflict()}
                loading={docConfirming}
              >
                Restaurar mesmo assim
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
      <Modal
        opened={conflict !== null}
        onClose={() => setConflict(null)}
        title="Valor mudou desde a modificação"
        centered
      >
        {conflict && (
          <Stack gap="xs">
            <Text size="sm">
              O campo <strong>{conflict.field}</strong> foi alterado novamente desde este registro.
            </Text>
            <Text size="sm">
              Valor que esta ação restauraria: {renderValue(conflict.target.oldValue)}
            </Text>
            <Text size="sm">Valor atual: {renderValue(conflict.currentValue)}</Text>
            <Group justify="flex-end" mt="sm">
              <Button variant="default" onClick={() => setConflict(null)} disabled={confirming}>
                Cancelar
              </Button>
              <Button color="red" onClick={() => void handleConfirmConflict()} loading={confirming}>
                Restaurar mesmo assim
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}

interface RestaurarActionProps {
  entry: ListEntry;
  field: string;
  change: { old: unknown; new: unknown };
  disabled?: boolean;
  pending: boolean;
  staged?: StagedRevert;
  onRestaurar: () => void;
}

function RestaurarAction({
  entry,
  field,
  change,
  disabled,
  pending,
  staged,
  onRestaurar,
}: RestaurarActionProps) {
  // Only a field-level UPDATE is revertible; a `delete` entry's document-level
  // undelete is a separate control, `RestaurarDocumentoAction` below (#648).
  // `create` has no document-level counterpart — there is nothing to restore.
  if (entry.kind !== 'update') return null;

  // Read-only viewers can never commit a staged value — see the prop's comment.
  if (disabled) return null;

  const gate = isRevertible(entry.subcolecao, field, change);
  const isPrecosOnParent = entry.subcolecao === null && field === 'precos';

  if (!gate.ok) {
    return (
      <Tooltip label={gate.reason ?? undefined}>
        <Button
          size="xs"
          variant="light"
          color="gray"
          disabled
          leftSection={<IconArrowBackUp size={14} />}
          aria-label={`Restaurar ${field}`}
          title={gate.reason ?? undefined}
        >
          Restaurar
        </Button>
      </Tooltip>
    );
  }

  return (
    <>
      <Button
        size="xs"
        variant="light"
        leftSection={<IconArrowBackUp size={14} />}
        loading={pending}
        onClick={onRestaurar}
        aria-label={`Restaurar ${field}`}
      >
        Restaurar
      </Button>
      {staged && (
        <Text size="xs" c="yellow.8">
          Valor restaurado da modificação de{' '}
          {staged.timestamp ? dateFmt.format(microsToDate(staged.timestamp)) : '—'} — salve para
          aplicar.
        </Text>
      )}
      {isPrecosOnParent && (
        <Text size="xs" c="orange">
          Restaurar o preço gera uma nova entrada de histórico e propaga para as variações ao
          salvar.
        </Text>
      )}
    </>
  );
}

interface RestaurarDocumentoActionProps {
  entry: ListEntry;
  disabled?: boolean;
  pending: boolean;
  staged?: StagedRevert;
  onRestaurar: () => void;
}

/**
 * "Restaurar documento" (#648) — undelete the WHOLE document a `delete`-kind
 * entry recorded, scoped to `extraData`/`imposto` (see `revert.ts`'s module
 * doc for why the produto document itself is out of scope). Rendered once per
 * entry via `renderEntryActions`, unlike `RestaurarAction` which renders once
 * PER FIELD.
 */
function RestaurarDocumentoAction({
  entry,
  disabled,
  pending,
  staged,
  onRestaurar,
}: RestaurarDocumentoActionProps) {
  if (entry.kind !== 'delete') return null;
  if (disabled) return null;

  const gate = isDocumentRestorable(entry.subcolecao, entry.changes);

  // The produto document's own delete entries (`subcolecao === null`) are
  // permanently out of scope, not merely momentarily blocked — showing a
  // disabled button on every one of them would be noise the operator can never
  // act on. A REAL block (a truncated field on an otherwise-restorable scope)
  // still gets the disabled-with-reason treatment below.
  if (!gate.ok && entry.subcolecao === null) return null;

  if (!gate.ok) {
    return (
      <Tooltip label={gate.reason ?? undefined}>
        <Button
          size="xs"
          variant="light"
          color="gray"
          disabled
          leftSection={<IconArrowBackUp size={14} />}
          aria-label="Restaurar documento"
          title={gate.reason ?? undefined}
        >
          Restaurar documento
        </Button>
      </Tooltip>
    );
  }

  return (
    <Group gap="xs" wrap="wrap">
      <Button
        size="xs"
        variant="light"
        leftSection={<IconArrowBackUp size={14} />}
        loading={pending}
        onClick={onRestaurar}
        aria-label="Restaurar documento"
      >
        Restaurar documento
      </Button>
      {staged && (
        <Text size="xs" c="yellow.8">
          Documento restaurado da modificação de{' '}
          {staged.timestamp ? dateFmt.format(microsToDate(staged.timestamp)) : '—'} — salve para
          aplicar.
        </Text>
      )}
    </Group>
  );
}
