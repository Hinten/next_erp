'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Group,
  Loader,
  MultiSelect,
  Paper,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconArrowBackUp,
  IconExternalLink,
  IconGripVertical,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconWand,
} from '@tabler/icons-react';
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { FirebaseError } from 'firebase/app';
import { type Firestore, writeBatch } from 'firebase/firestore';
import { ZodError } from 'zod';
import { buildQuery, whereEqual } from '@delfrance/data';
import { useFormContext } from 'react-hook-form';
import { useDocSnapshot, useSnapshot } from '@delfrance/data/hooks';
import {
  type GrupoComId,
  type PrecosMap,
  type Produto,
  cartesianVariations,
  compareSortKeys,
  findDuplicateSkus,
  normalizeVariacoesUid,
  montarMembroUnico,
  parseFakePath,
  planejarMembroSobrevivente,
  produtoSchema,
  derivarFilhoUnico,
  reconcileStagedChildren,
  reconstructFromSkuSuffix,
  reconstructFromVariacoesUid,
  sameCombo,
  varianteFakePath,
} from '@delfrance/schemas';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { newDocId } from '@/lib/produtos/docId';
import {
  describeReferences,
  findManyProdutoReferences,
  findProdutoReferences,
  hasReferences,
} from '@/lib/produtos/references';

/**
 * One row of the children list: a persisted child `Produto` (with its doc id)
 * or a locally staged new one. Edits/deletions are staged and only hit
 * Firestore in {@link flushStagedChildren} (wired to the parent ObjectView's
 * `onAfterSave`), per the app-wide staged-mutation convention.
 */
interface ChildRow {
  /**
   * Stable list key — ALWAYS a doc id: the persisted one for a server row, the
   * pre-minted one a staged row will be written under ({@link stagedRowKey}).
   * `id`, never `key`, is what tells the two apart, so it stays `null` until the
   * document actually exists.
   */
  key: string;
  id: string | null;
  nome: string;
  /** Empty string = no SKU (persisted as null). */
  sku: string;
  variacoesUid: string[];
  serverOrdem: number | null;
  deleteMark: boolean;
  /** Local edits pending (nome/sku/variacoesUid changed vs the server doc). */
  dirty: boolean;
}

/**
 * The current variation set (saved + staged) published to the page so the Kit
 * tab's "Gerar Variações" grid can target variations that aren't saved yet. New
 * rows carry `id: null` until their document exists, but their `key` is already
 * the doc id the flush writes under, so `resolveStagedKitVariacoes` resolves
 * them by id as soon as the snapshot echoes the new child — it only falls back
 * to matching by `variacoesUid` in the window before that.
 */
export interface VariationRow {
  key: string;
  id: string | null;
  nome: string;
  sku: string;
  variacoesUid: string[];
  deleteMark: boolean;
}

/** What the children flush tells the page, for the kit-variation flush that follows. */
export interface ChildrenFlushResult {
  /**
   * Staged row key → the doc id its create was absorbed onto by the #117 SKU id
   * reuse. Those rows are written as an UPDATE on the reused id and never as a
   * document under their own key, so this pairing is the ONLY exact record of
   * where they went — and the flush then clears the row, so it cannot be
   * recovered afterwards. `resolveStagedKitVariacoes` consumes it.
   */
  reusedByKey: Record<string, string>;
}

/** The children flush the page invokes in `onAfterSave`. */
export type ChildrenFlush = (parentId: string) => Promise<ChildrenFlushResult>;

/** Local staged patch over a persisted child (keyed by doc id). */
interface ChildPatch {
  nome?: string;
  sku?: string;
  variacoesUid?: string[];
  deleteMark?: boolean;
}

export interface VariationManagerProps {
  /** `null` in create mode — children need a saved parent to point at. */
  produtoId: string | null;
  /**
   * The parent's `filhoUnicoId` — its SOLE MEMBER's doc id, when it has one
   * (#1398). A produto born as a family of one owns a child that mirrors it, and
   * the moment real variations arrive that child must become the first of them
   * rather than sit beside them: see rule 3 of `reconcileStagedChildren`.
   */
  membroUnicoId?: string | null;
  db: Firestore;
  /** All variation groups (live), supplied by the page. */
  grupos: GrupoComId[];
  /** Load error from the page's grupos snapshot — surfaced, never swallowed. */
  gruposError?: string;
  /** Parent `variacoesUid` (variant fake paths) from the form. */
  value: string[] | null;
  onChange: (next: string[]) => void;
  /** Lifted group selection — the page's `deriveOnSave` persists it. */
  onGroupsChange: (groupIds: string[]) => void;
  /**
   * Publishes the current variation rows (saved + staged) so the Kit tab's
   * "Gerar Variações" grid can render + target them. Pass a stable setter.
   */
  onRowsChange?: (rows: VariationRow[]) => void;
  /**
   * Receives the flush function so the page can wire it into the ObjectView's
   * `onAfterSave` (children are written only when the parent saves).
   */
  flushRef: React.MutableRefObject<ChildrenFlush | null>;
  disabled?: boolean;
}

/**
 * Mint the key of a staged row — a real Firestore doc id, minted HERE rather
 * than at write time (`newDocId` is pure, no network). That makes a staged row
 * and its future document ONE identity, which buys two things: the optimistic
 * snapshot echo of a just-created child REPLACES its staged twin in `rows`
 * instead of doubling it, and re-running the flush before the ack overwrites
 * that same doc instead of creating a second one — root `CLAUDE.md` Critical
 * rule 7 tier 0. Same idiom as the chat composer's pre-minted mensagem ids
 * (#529, `useMensagensWindow`).
 */
function stagedRowKey(): string {
  return newDocId();
}

/** No id reuse happened — the common case, shared so the exits stay cheap. */
const NOTHING_REUSED: ChildrenFlushResult = { reusedByKey: {} };

/** Stable empty set, so releasing `absorbedKeys` can't schedule a re-render. */
const EMPTY_KEYS: ReadonlySet<string> = new Set();

/**
 * A flush-abort error. ObjectView only renders `ZodError`/`FirebaseError`
 * rejections from `onAfterSave` in the form alert (anything else is treated
 * as a bug and rethrown), so integrity violations ship as custom Zod issues.
 */
function flushAbort(message: string): ZodError {
  return new ZodError([{ code: 'custom', path: [], message } as never]);
}

/** Bare group ids referenced by a parent doc + its current variant selection. */
function impliedGroupIds(parent: Produto | undefined, uids: string[]): string[] {
  const fromDoc = (parent?.grupoDeVariacoesUid ?? []).map((u) => u.split('/').pop()!);
  const fromUids = uids
    .map((u) => parseFakePath(u)?.grupoId)
    .filter((g): g is string => g !== undefined);
  return [...new Set([...fromDoc, ...fromUids])];
}

/**
 * Variations tab of the product editor — port of the Flutter
 * `CadastroVariacoes` (`produtoCadastro.dart:2216`). Select variation groups,
 * pick variants per group, generate one child `Produto` per Cartesian
 * combination, reconstruct legacy children, reorder and stage-delete. All
 * child writes flush in ONE `writeBatch` after the parent saves.
 */
export function VariationManager({
  produtoId,
  membroUnicoId = null,
  db,
  grupos,
  gruposError,
  value,
  onChange,
  onGroupsChange,
  onRowsChange,
  flushRef,
  disabled,
}: VariationManagerProps) {
  const uids = useMemo(() => value ?? [], [value]);

  // Persisted parent doc — fallback source for the parent fields.
  const parentRef = useMemo(
    () => (produtoId ? produtoCollection.docRef(db, {}, produtoId) : null),
    [db, produtoId],
  );
  const parentSnap = useDocSnapshot(parentRef);
  const parent = parentSnap.data?.data;

  // The surrounding ObjectView form (via FormProvider). Gerar/Reconstituir and
  // the dims inheritance read the LIVE form values first — a nome/SKU the user
  // just typed (still unsaved) must feed the generated children; the old
  // Flutter flows read only the persisted doc, which left children with empty
  // SKUs when the parent's SKU was filled in the same session. NOTE: RHF's
  // `useFormContext` is TYPED non-null but actually returns `null` outside a
  // provider (its context default), hence the optional chaining below.
  const form = useFormContext();
  const liveParent = <K extends keyof Produto>(key: K): Produto[K] | null => {
    const live = form?.getValues(key as string) as Produto[K] | undefined;
    if (live !== undefined && live !== null && live !== '') return live;
    return (parent?.[key] ?? null) as Produto[K] | null;
  };

  // Live children (paiId == produtoId), sorted client-side by `ordem` —
  // Firestore's orderBy would silently drop docs missing the field.
  const childrenQuery = useMemo(
    () =>
      produtoId
        ? buildQuery(produtoCollection.ref(db, {}), [whereEqual('paiId', produtoId)])
        : null,
    [db, produtoId],
  );
  const childrenSnap = useSnapshot(childrenQuery);

  // Staged local state: patches over persisted rows + brand-new rows + a
  // manual order. Everything merges at render time (no state syncing effects);
  // flush clears it and the live snapshot takes back over.
  const [patches, setPatches] = useState<Record<string, ChildPatch>>({});
  const [newRows, setNewRows] = useState<ChildRow[]>([]);
  // Staged creates the #117 id reuse redirected onto an EXISTING doc id: the
  // batch updates that doc instead of creating one under the row's own key, so
  // the identity filter in `rows` can't see them. Held only for the commit
  // window, released on both exits.
  const [absorbedKeys, setAbsorbedKeys] = useState<ReadonlySet<string>>(EMPTY_KEYS);
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const [groupsTouched, setGroupsTouched] = useState<string[] | null>(null);
  const [actionError, setActionError] = useState<string[] | null>(null);
  // Rows with an in-flight reference check (the delete-guard lookup).
  const [checking, setChecking] = useState<Set<string>>(new Set());

  const groupsSelected = groupsTouched ?? impliedGroupIds(parent, uids);

  const rows = useMemo<ChildRow[]>(() => {
    const server = [...(childrenSnap.data ?? [])]
      .sort((a, b) => (a.data.ordem ?? Infinity) - (b.data.ordem ?? Infinity))
      .map((r): ChildRow => {
        const patch = patches[r.id] ?? {};
        return {
          key: r.id,
          id: r.id,
          nome: patch.nome ?? r.data.nome,
          sku: patch.sku ?? r.data.sku ?? '',
          variacoesUid: patch.variacoesUid ?? r.data.variacoesUid ?? [],
          serverOrdem: r.data.ordem ?? null,
          deleteMark: patch.deleteMark ?? false,
          dirty:
            patch.nome !== undefined || patch.sku !== undefined || patch.variacoesUid !== undefined,
        };
      });
    // A staged row's key IS the doc id it will be written to, so a server row
    // carrying that id is not a sibling — it IS this row, echoed back. Firestore
    // applies a batch to the local cache and fires `onSnapshot` before the
    // server ack (`useSnapshot` listens with `includeMetadataChanges: true`), so
    // without this the whole commit window holds every new child TWICE:
    // `findDuplicateSkus` reports a collision that exists only in our own echo,
    // the flush gate then refuses the next save, and `onRowsChange` publishes
    // the doubled list to the Kit tab. Filtering here — inside the memo, atomic
    // with the merge — also keeps React and dnd-kit from ever seeing two rows
    // that share a key.
    const persisted = new Set(server.map((r) => r.id));
    const staged = newRows.filter((r) => !persisted.has(r.key) && !absorbedKeys.has(r.key));
    const all = [...server, ...staged];
    if (!localOrder) return all;
    const pos = new Map(localOrder.map((k, i) => [k, i]));
    return all.sort((a, b) => (pos.get(a.key) ?? Infinity) - (pos.get(b.key) ?? Infinity));
  }, [childrenSnap.data, patches, newRows, absorbedKeys, localOrder]);

  // Publish the variation rows to the page (for the Kit "Gerar Variações" grid),
  // only when the relevant fields actually change — so the setter can't loop.
  const publishedRowsKey = useRef<string>('');
  useEffect(() => {
    if (!onRowsChange) return;
    const mapped: VariationRow[] = rows.map((r) => ({
      key: r.key,
      id: r.id,
      nome: r.nome,
      sku: r.sku,
      variacoesUid: r.variacoesUid,
      deleteMark: r.deleteMark,
    }));
    const key = JSON.stringify(mapped);
    if (key === publishedRowsKey.current) return;
    publishedRowsKey.current = key;
    onRowsChange(mapped);
  }, [rows, onRowsChange]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  // Sibling SKU uniqueness: non-empty SKUs shared by two or more live rows
  // get an inline error here and a hard gate in the flush — duplicates would
  // make the SKU-based id reuse (#117) ambiguous.
  const duplicateSkuKeys = useMemo(
    () => new Set([...findDuplicateSkus(rows).values()].flat()),
    [rows],
  );

  /**
   * Drop the staged mutations THIS flush resolved, identified by the row keys it
   * actually saw — never the whole staging.
   *
   * A blind clear loses work no batch ever wrote. Two ways in: a row staged
   * while the commit was in flight, and — since the identity filter in `rows`
   * hides a staged row the moment its echo lands — a concurrent flush that
   * therefore computes `writes === 0`. Clearing there would drop rows whose only
   * `set` is still parked in the other flush's `commit()`, and if THAT batch is
   * rejected Firestore rolls the local writes back, leaving neither the document
   * nor the staged row.
   */
  function clearStagedState(
    handledStaged: ReadonlySet<string>,
    handledPatches: ReadonlySet<string>,
  ) {
    setPatches((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([id]) => !handledPatches.has(id))),
    );
    setNewRows((prev) => prev.filter((r) => !handledStaged.has(r.key)));
    setLocalOrder(null);
  }

  /**
   * Commit every staged child mutation in ONE batch: deletes, creates (full
   * docs through the Zod converter) and updates, rewriting `ordem` as the
   * final position over the non-deleted rows. Children inherit the parent's
   * dims/weights on create (Flutter parity). Plain doc deletes — subcollection
   * orphan cleanup is server-side (issues #95/#136).
   *
   * Integrity passes before any write:
   *  1. duplicate-SKU gate (sibling uniqueness);
   *  2. `reconcileStagedChildren` turns same-SKU (delete, create) pairs into
   *     updates that keep the original doc id (#117) — a reused row carries
   *     `serverOrdem: null`, so the update branch below always writes it;
   *  3. reference re-check on every remaining real delete (kits/marketplace
   *     links may have appeared since the stage-time check) — any hit aborts
   *     the whole flush.
   *
   * Pricing parity: children CREATED here carry the PARENT's `precos`, with NO
   * history entry for that initial value — the `onProdutoChanged` trigger's
   * `produtoExtraIgnores` drops `precos` from the diff for any produto with a
   * `paiId` set, a deliberate omission so the parent's own propagation write
   * doesn't echo back as a spurious "child changed" entry. Refreshing the
   * precos of EXISTING children when the parent's map changes is server-owned
   * too: the `onProdutoChanged` Cloud Function trigger fires on the parent's
   * produto write, so it propagates even when the Variações tab — and
   * therefore this manager's live children snapshot — was never opened.
   */
  const flushStagedChildren = async (parentId: string): Promise<ChildrenFlushResult> => {
    // Nothing staged ⇒ nothing to write, and that guard is load-bearing now that
    // the section is persistent: this closure runs on EVERY produto save, not
    // only after the tab was opened. Without it the `ordem` renumbering below
    // rewrites nome/sku/variacoesUid/ordem on every child whose stored `ordem`
    // is not already its index — the legacy 1-based (or null) shape, rule 8 —
    // on a save that never touched variations. Renumbering an untouched family
    // may be worth doing, but it should be a deliberate action, not a side
    // effect of the tab having mounted.
    if (Object.keys(patches).length === 0 && newRows.length === 0 && localOrder === null)
      return NOTHING_REUSED;

    const { rows: reconciliadas, reusedIds } = reconcileStagedChildren(rows, membroUnicoId);

    // ⚠️ A family never loses its last child (#1398). The sellable unit IS a
    // child — it owns the estoque rows, a pedido line binds it, the ML family
    // publishes it — so a parent left alone is not "a simple produto", it is a
    // produto NOTHING CAN SELL, with every stock reader resolving to a document
    // that no longer exists. `toggleDeleteAll` reaches that in one click, and
    // after #1424 every produto carries a member row here, so "delete the only
    // variation" is the ordinary way in.
    //
    // Planned on the RECONCILED rows: a delete a staged create already absorbed
    // is not a delete, and must not push this into the `criar` arm.
    const sobrevivente = planejarMembroSobrevivente(reconciliadas);
    // `renomear` un-marks the delete and turns it into an in-place rename onto
    // the parent's nome/sku. The doc id survives, and with it the estoque rows
    // and their ledger, kit entries, marketplace links, pedido lines and NF-e
    // history — the same reason `reconcileStagedChildren` reuses ids (#117),
    // applied where the "create" is implicit. It also takes the row OUT of
    // `deleteTargets` below, so an inbound reference no longer aborts a save
    // that deletes nothing.
    const reconciled =
      sobrevivente.tipo === 'renomear'
        ? reconciliadas.map((r) =>
            r.id === sobrevivente.id
              ? {
                  ...r,
                  deleteMark: false,
                  dirty: true,
                  nome: liveParent('nome') ?? r.nome,
                  sku: liveParent('sku') ?? '',
                  variacoesUid: [],
                }
              : r,
          )
        : reconciliadas;

    // ⚠️ The gate runs LAST, on the rows that will actually be written, and both
    // halves of that order are load-bearing.
    //
    // It used to run FIRST, and after #1424 that made a legal, modelled shape
    // unsavable: the sole member copies the parent's SKU verbatim, and
    // `cartesianVariations` emits `base.sku + (variante.codigo ?? '')` — so a
    // variante with no `codigo` generates a child whose SKU IS the parent's. Rule
    // 3 exists to absorb exactly that create onto the sole member's document, but
    // the gate had already thrown, and the operator could not proceed without
    // hand-editing a SKU or deleting the member.
    //
    // It also runs after the SURVIVOR rename, which rewrites a row's SKU to the
    // parent's — checking before it would judge a value the flush is about to
    // replace. What must be unique is what will actually be WRITTEN, and a create
    // the reuse absorbed is no longer a second document. The #117 delete/create
    // pairing was already relying on that; it just got it for free, because
    // `findDuplicateSkus` skips delete-marked rows.
    const duplicates = findDuplicateSkus(reconciled);
    if (duplicates.size > 0) {
      throw flushAbort(
        `SKU duplicado entre as variações: ${[...duplicates.keys()].join(', ')}. ` +
          'Cada variação precisa de um SKU próprio — ajuste antes de salvar.',
      );
    }

    // Staged creates the reuse absorbed onto an existing doc: the batch issues
    // an UPDATE on that doc, never a `set` under the row's own key, so `rows`
    // cannot recognise the echo by identity. Undoing the paired deletion
    // mid-flight — the rows stay enabled while the form submits — would
    // otherwise show the server row and its staged twin as two live siblings
    // sharing one SKU.
    const stagedKeys = new Set(rows.filter((r) => r.id === null).map((r) => r.key));
    // ONE derivation, two consumers: the keys suppress the staged twin in `rows`
    // (above), and the pairing goes to the page so the kit flush can address
    // those rows exactly — nothing else records where they were written.
    const reusedByKey = Object.fromEntries(
      reconciled
        .filter((r) => r.id !== null && stagedKeys.has(r.key))
        .map((r) => [r.key, r.id!] as const),
    );
    const absorbed = new Set(Object.keys(reusedByKey));

    // Exactly what this flush is answerable for — the rows its closure captured,
    // split by which staging bucket they came from. `key` alone cannot tell the
    // two apart: a staged row's key IS its future doc id, so it collides with
    // the server row's key by design. Anything staged since, or hidden from
    // `rows` by another flush's echo, is in neither set and is not ours to clear.
    const handledPatchIds = new Set(rows.filter((r) => r.id !== null).map((r) => r.id!));

    // The parent's just-saved precos for children CREATED here: the live form
    // value when available (null = all prices cleared — deliberate, must NOT
    // fall back to the stale persisted doc), the persisted doc only without a
    // form context.
    const livePrecos = form?.getValues('precos') as PrecosMap | undefined;
    const parentPrecos = livePrecos !== undefined ? livePrecos : (parent?.precos ?? null);

    const deleteTargets = reconciled.filter((r) => r.deleteMark && r.id);
    const refsById = await findManyProdutoReferences(
      db,
      deleteTargets.map((r) => r.id!),
    );
    const blocked = deleteTargets
      .filter((row) => hasReferences(refsById.get(row.id!)!))
      .map(
        (row) =>
          `variação "${row.nome || row.sku}" está ${describeReferences(refsById.get(row.id!)!)}`,
      );
    if (blocked.length > 0) {
      throw flushAbort(`Exclusão bloqueada — ${blocked.join('; ')}.`);
    }

    const batch = writeBatch(db);
    let writes = 0;
    let ordem = 0;
    for (const row of reconciled) {
      if (row.deleteMark) {
        if (row.id) {
          batch.delete(produtoCollection.docRef(db, {}, row.id));
          writes += 1;
        }
        continue;
      }
      const normalized = normalizeVariacoesUid(row.variacoesUid, grupos);
      if (!row.id) {
        let docData: Produto;
        try {
          // Inherited fields read the live form values first — the flush runs
          // right after the parent save, before its snapshot re-emits.
          docData = produtoSchema.parse({
            nome: row.nome,
            sku: row.sku === '' ? null : row.sku,
            paiId: parentId,
            ordem,
            variacoesUid: normalized.length > 0 ? normalized : null,
            precos: parentPrecos,
            codPai: liveParent('codPai'),
            pesoLiquidoKg: liveParent('pesoLiquidoKg'),
            pesoBrutoKg: liveParent('pesoBrutoKg'),
            alturaCm: liveParent('alturaCm'),
            larguraCm: liveParent('larguraCm'),
            profundidadeCm: liveParent('profundidadeCm'),
          });
        } catch (err) {
          if (err instanceof ZodError) {
            // Re-throw with the row identified so the form alert is actionable.
            throw new ZodError(
              err.issues.map((issue) => ({
                ...issue,
                message: `variação "${row.nome || row.sku || '(sem nome)'}": ${issue.message}`,
              })),
            );
          }
          throw err;
        }
        // `row.key` IS this child's doc id — minted when the row was staged, so
        // re-running the flush before the ack overwrites the same document
        // rather than orphaning it under a fresh id. A row the reuse absorbed
        // never reaches here: it carries an `id` and takes the update branch.
        batch.set(produtoCollection.docRef(db, {}, row.key), docData);
        writes += 1;
        // A newly created child's initial `precos` gets NO history entry: the
        // `onProdutoChanged` trigger's `produtoExtraIgnores` drops `precos`
        // from the diff for any produto with a `paiId` set (it would just echo
        // the parent's own propagation as a spurious "child changed" entry —
        // apps/functions/src/produtos/onProdutoChanged.ts), so this is a
        // deliberate omission, not a gap the client needs to fill.
      } else if (row.dirty || ordem !== row.serverOrdem) {
        // precos is propagated to existing children server-side (the
        // `onProdutoChanged` trigger, on the parent's produto write).
        batch.update(produtoCollection.docRef(db, {}, row.id), {
          nome: row.nome,
          sku: row.sku === '' ? null : row.sku,
          variacoesUid: normalized.length > 0 ? normalized : null,
          ordem,
        } as never);
        writes += 1;
      }
      ordem += 1;
    }

    // ⚠️ The `criar` arm: two or more children deleted at once. Merging their
    // stock into one is a decision nobody authorised and picking a survivor
    // would be arbitrary, so the replacement starts EMPTY — their estoque
    // subtrees are swept by `onProdutoDeleted` either way, so nothing extra is
    // lost. What this stops is the produto being left unsellable.
    const membroCriadoId = sobrevivente.tipo === 'criar' ? newDocId() : null;
    if (membroCriadoId !== null) {
      batch.set(
        produtoCollection.docRef(db, {}, membroCriadoId),
        produtoSchema.parse(
          montarMembroUnico(parentId, {
            nome: liveParent('nome'),
            sku: liveParent('sku'),
            codPai: liveParent('codPai'),
            gtin: liveParent('gtin'),
            publicado: liveParent('publicado'),
            ehKit: liveParent('ehKit'),
            ehKitVirtual: liveParent('ehKitVirtual'),
            ehUsado: liveParent('ehUsado'),
            componentesKit: liveParent('componentesKit'),
            precos: parentPrecos,
            categoriaProdutoOuterRef: liveParent('categoriaProdutoOuterRef'),
            pesoLiquidoKg: liveParent('pesoLiquidoKg'),
            pesoBrutoKg: liveParent('pesoBrutoKg'),
            alturaCm: liveParent('alturaCm'),
            larguraCm: liveParent('larguraCm'),
            profundidadeCm: liveParent('profundidadeCm'),
          }),
        ) as never,
      );
      writes += 1;
    }

    // ⚠️ The pointer is re-derived from the child set this flush leaves behind,
    // in the SAME batch that changes it. An absorbed sole member keeps its doc
    // id, so `filhoUnicoId` would still name a real child — while the family now
    // has several — and every stock reader would resolve to one arbitrary
    // variation. `derivarFilhoUnico` is the one producer of the value.
    const filhosVivos = [
      ...reconciled.filter((r) => !r.deleteMark).map((r) => ({ id: r.id ?? r.key })),
      ...(membroCriadoId === null ? [] : [{ id: membroCriadoId }]),
    ];
    const filhoUnico = derivarFilhoUnico(filhosVivos);
    if (filhoUnico !== membroUnicoId) {
      batch.update(produtoCollection.docRef(db, {}, parentId), {
        filhoUnicoId: filhoUnico,
      } as never);
      writes += 1;
    }

    if (writes === 0) {
      // Nothing to write, but the staging this flush saw DID resolve — e.g. a
      // row added and then delete-marked before saving. Clearing those keys
      // stops that ghost row from surviving the save.
      clearStagedState(stagedKeys, handledPatchIds);
      return NOTHING_REUSED;
    }
    setAbsorbedKeys(absorbed.size > 0 ? absorbed : EMPTY_KEYS);
    try {
      await batch.commit();
    } finally {
      // Released on BOTH exits: a rejected batch is rolled back locally, so the
      // staged rows have to come back carrying the operator's work.
      setAbsorbedKeys(EMPTY_KEYS);
    }
    clearStagedState(stagedKeys, handledPatchIds);
    notifications.show({
      color: 'green',
      message:
        reusedIds.length > 0
          ? `${writes} variação(ões) gravada(s) — ${reusedIds.length} id(s) reaproveitado(s) por SKU.`
          : `${writes} variação(ões) gravada(s).`,
    });
    return { reusedByKey };
  };

  // Hand the page the current flush closure (it captures this render's rows).
  // Assigned in an effect — mutating a ref during render is forbidden.
  //
  // The cleanup matters: on unmount this closure is stale by definition, and its
  // `childrenSnap` listener is gone with it, so calling it would rewrite the
  // children from frozen data. It is safe to null only because 'Variações' is in
  // `PRODUTO_PERSISTENT_SECTIONS` — without that, `<Activity>` would tear the
  // effect down on every tab switch and the page's `flushChildrenRef.current?.()`
  // would silently skip the child writes instead.
  useEffect(() => {
    flushRef.current = produtoId ? flushStagedChildren : null;
    return () => {
      flushRef.current = null;
    };
  });

  if (!produtoId) {
    return (
      <Alert color="blue" variant="light">
        Salve o produto para poder gerar variações.
      </Alert>
    );
  }

  function patchRow(row: ChildRow, patch: ChildPatch) {
    if (row.id) {
      const id = row.id;
      setPatches((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
    } else {
      setNewRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, ...patch } : r)));
    }
  }

  function changeGroups(ids: string[]) {
    setGroupsTouched(ids);
    onGroupsChange(ids);
    // Unselecting a group also drops its variant chips from the parent
    // selection (the old app left them dangling in a "no group" bucket).
    // Group ids the snapshot doesn't know are rendered as placeholder chips
    // (see `groupOptions`), so they survive every edit unless the user
    // removes them explicitly — a removal here is always deliberate.
    const kept = uids.filter((u) => {
      const grupoId = parseFakePath(u)?.grupoId;
      return grupoId === undefined || ids.includes(grupoId);
    });
    if (kept.length !== uids.length) onChange(kept);
  }

  function changeVariantes(grupoId: string, varianteIds: string[]) {
    const others = uids.filter((u) => parseFakePath(u)?.grupoId !== grupoId);
    onChange([...others, ...varianteIds.map((v) => varianteFakePath(grupoId, v))]);
  }

  function gerar() {
    setActionError(null);
    const parentNome = liveParent('nome');
    if (!parentNome) {
      setActionError(['Para gerar variações é necessário um nome no produto pai.']);
      return;
    }
    const combos = cartesianVariations({
      parentNome,
      parentSku: liveParent('sku'),
      grupos: grupos.filter((g) => groupsSelected.includes(g.id)),
      selectedUids: uids,
    });
    const fresh = combos.filter(
      (c) => !rows.some((r) => !r.deleteMark && sameCombo(r.variacoesUid, c.variacoesUid)),
    );
    if (fresh.length > 0) {
      setNewRows((prev) => [
        ...prev,
        ...fresh.map(
          (c): ChildRow => ({
            key: stagedRowKey(),
            id: null,
            nome: c.nome,
            sku: c.sku,
            variacoesUid: c.variacoesUid,
            serverOrdem: null,
            deleteMark: false,
            dirty: true,
          }),
        ),
      ]);
    }
    notifications.show({
      color: fresh.length > 0 ? 'green' : 'gray',
      message:
        fresh.length > 0
          ? `${fresh.length} variação(ões) gerada(s) — salve para gravar.`
          : 'Todas as combinações já existem.',
    });
    // Duplicate SKUs out of the generation (two variants sharing a código)
    // would be rejected at save — warn right away so the user fixes the
    // códigos (or the SKUs) before hitting the flush gate.
    const dupAfterGen = findDuplicateSkus([
      ...rows.map((r) => ({ key: r.key, sku: r.sku, deleteMark: r.deleteMark })),
      ...fresh.map((c, i) => ({ key: `gen-${i}`, sku: c.sku, deleteMark: false })),
    ]);
    if (dupAfterGen.size > 0) {
      notifications.show({
        color: 'yellow',
        message: `SKUs duplicados após gerar: ${[...dupAfterGen.keys()].join(', ')} — ajuste os códigos das variantes ou os SKUs antes de salvar.`,
        autoClose: 10_000,
      });
    }
  }

  function reconstituir() {
    setActionError(null);
    const parentNome = liveParent('nome');
    const parentSku = liveParent('sku');
    if (!parentNome || !parentSku) {
      setActionError(['Para reconstituir é necessário nome e SKU no produto pai.']);
      return;
    }
    const ctx = { parentNome, parentSku, grupos };
    const errors: string[] = [];
    const keyed: Array<{ key: string; sortKey: number[] }> = [];
    for (const row of rows) {
      if (row.deleteMark) continue;
      const result =
        row.variacoesUid.length > 0
          ? reconstructFromVariacoesUid({ childUids: row.variacoesUid, ...ctx })
          : reconstructFromSkuSuffix({ childSku: row.sku, ...ctx });
      if (!result.ok) {
        errors.push(result.error);
        continue;
      }
      keyed.push({ key: row.key, sortKey: result.sortKey });
      patchRow(row, { nome: result.nome, sku: result.sku, variacoesUid: result.variacoesUid });
    }
    setActionError(errors.length > 0 ? errors : null);
    if (errors.length === 0) {
      // Apply the recovered Cartesian order — `flushStagedChildren` rewrites
      // `ordem` from the final row order, so reordering here is what actually
      // fixes a legacy child's position on save. Delete-marked rows keep
      // their current place at the end.
      const sorted = [...keyed]
        .sort((a, b) => compareSortKeys(a.sortKey, b.sortKey))
        .map((k) => k.key);
      const deletedKeys = rows.filter((r) => r.deleteMark).map((r) => r.key);
      setLocalOrder([...sorted, ...deletedKeys]);
      notifications.show({
        color: 'green',
        message: 'Variações reconstituídas — salve para gravar.',
      });
    }
  }

  function addManual() {
    setNewRows((prev) => [
      ...prev,
      {
        key: stagedRowKey(),
        id: null,
        nome: '',
        sku: '',
        variacoesUid: [],
        serverOrdem: null,
        deleteMark: false,
        dirty: true,
      },
    ]);
  }

  /**
   * Probe a persisted row's inbound references (kits, marketplace links) and
   * block the staging when any exist — deleting a referenced child severs the
   * kit/listing keyed to its doc id (#117/#135). Fail-closed: if the lookup
   * itself fails, the deletion is NOT staged.
   */
  async function checkDeletable(row: ChildRow): Promise<boolean> {
    if (!row.id) return true; // unsaved rows have no doc, hence no references
    setChecking((prev) => new Set(prev).add(row.key));
    try {
      const refs = await findProdutoReferences(db, row.id);
      if (hasReferences(refs)) {
        notifications.show({
          color: 'red',
          title: 'Não é possível excluir',
          message: `A variação "${row.nome || row.sku}" está ${describeReferences(refs)}. Remova os vínculos antes de excluí-la.`,
          autoClose: 10_000,
        });
        return false;
      }
      return true;
    } catch (err) {
      if (err instanceof FirebaseError) {
        console.error('[VariationManager] reference check failed', err);
        notifications.show({
          color: 'red',
          message: `Falha ao verificar vínculos (${err.code}) — exclusão não aplicada.`,
        });
        return false;
      }
      throw err;
    } finally {
      setChecking((prev) => {
        const next = new Set(prev);
        next.delete(row.key);
        return next;
      });
    }
  }

  async function requestDelete(row: ChildRow) {
    if (row.deleteMark) {
      patchRow(row, { deleteMark: false }); // undo is always allowed
      return;
    }
    if (await checkDeletable(row)) patchRow(row, { deleteMark: true });
  }

  /**
   * Bulk mark/unmark. Marking runs the reference guard over every persisted
   * row through the concurrency-capped bulk lookup (~8 reads per row — an
   * unbounded fan-out would throttle) and reports every blocked row in ONE
   * notification. Fail-closed: a lookup error marks nothing.
   */
  async function toggleDeleteAll() {
    const target = !rows.every((r) => r.deleteMark);
    if (!target) {
      for (const row of rows) patchRow(row, { deleteMark: false });
      return;
    }
    const pending = rows.filter((r) => !r.deleteMark);
    setChecking(new Set(pending.map((r) => r.key)));
    try {
      const refsById = await findManyProdutoReferences(
        db,
        pending.filter((r) => r.id).map((r) => r.id!),
      );
      const blocked = pending.filter((row) => row.id && hasReferences(refsById.get(row.id)!));
      for (const row of pending) {
        if (!blocked.includes(row)) patchRow(row, { deleteMark: true });
      }
      if (blocked.length > 0) {
        notifications.show({
          color: 'red',
          title: 'Não é possível excluir',
          message: `${blocked
            .map(
              (row) =>
                `"${row.nome || row.sku}" está ${describeReferences(refsById.get(row.id!)!)}`,
            )
            .join('; ')}. Remova os vínculos antes de excluí-la(s).`,
          autoClose: 10_000,
        });
      }
    } catch (err) {
      if (err instanceof FirebaseError) {
        console.error('[VariationManager] bulk reference check failed', err);
        notifications.show({
          color: 'red',
          message: `Falha ao verificar vínculos (${err.code}) — exclusões não aplicadas.`,
        });
        return;
      }
      throw err;
    } finally {
      setChecking(new Set());
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const keys = rows.map((r) => r.key);
    const from = keys.indexOf(String(active.id));
    const to = keys.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    setLocalOrder(arrayMove(keys, from, to));
  }

  // Known groups plus a placeholder option for every selected id the snapshot
  // doesn't carry (still loading / query limit / permissions) — Mantine only
  // renders chips for values present in `data`, so without placeholders those
  // selections would be invisible and silently dropped on the next edit.
  const groupOptions = [
    ...grupos.map((g) => ({ value: g.id, label: g.data.nome })),
    ...groupsSelected
      .filter((id) => !grupos.some((g) => g.id === id))
      .map((id) => ({ value: id, label: `${id} (grupo não carregado)` })),
  ];

  return (
    <Stack>
      {gruposError && (
        <Alert color="red">Falha ao carregar os grupos de variação: {gruposError}</Alert>
      )}
      <MultiSelect
        label="Grupos de variação"
        description="Selecione os grupos (Tamanho, Cor, …) aplicados a este produto"
        data={groupOptions}
        value={groupsSelected}
        onChange={changeGroups}
        disabled={disabled}
        searchable
      />

      {groupsSelected.map((grupoId) => {
        const grupo = grupos.find((g) => g.id === grupoId);
        if (!grupo) return null;
        const variantes = grupo.data.variacoes ?? [];
        const selectedIds = uids
          .map((u) => parseFakePath(u))
          .filter((p) => p?.grupoId === grupoId)
          .map((p) => p!.varianteId);
        return (
          <MultiSelect
            key={grupoId}
            label={grupo.data.nome}
            data={variantes.map((v) => ({
              value: v.id,
              label: v.codigo ? `${v.nome} (${v.codigo})` : v.nome,
            }))}
            value={selectedIds.filter((id) => variantes.some((v) => v.id === id))}
            onChange={(ids) => changeVariantes(grupoId, ids)}
            disabled={disabled}
            searchable
          />
        );
      })}

      {!disabled && (
        <Group justify="flex-end">
          <Button
            variant="default"
            size="xs"
            leftSection={<IconRefresh size={14} />}
            onClick={reconstituir}
          >
            Reconstituir variações
          </Button>
          <Button size="xs" leftSection={<IconWand size={14} />} onClick={gerar}>
            Gerar variações
          </Button>
        </Group>
      )}

      {actionError && (
        <Alert color="red">
          {actionError.map((e) => (
            <Text size="sm" key={e}>
              {e}
            </Text>
          ))}
        </Alert>
      )}

      {childrenSnap.loading && <Loader size="sm" />}
      {childrenSnap.error && <Alert color="red">{childrenSnap.error.message}</Alert>}

      {rows.length === 0 ? (
        <Text size="sm" c="dimmed">
          Nenhuma variação. Selecione as variantes acima e clique em “Gerar variações”.
        </Text>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={rows.map((r) => r.key)} strategy={verticalListSortingStrategy}>
            <Stack gap="xs">
              {rows.map((row) => (
                <SortableChild
                  key={row.key}
                  row={row}
                  disabled={disabled}
                  checkingRefs={checking.has(row.key)}
                  skuError={
                    duplicateSkuKeys.has(row.key) ? 'SKU duplicado entre as variações' : undefined
                  }
                  onNome={(nome) => patchRow(row, { nome })}
                  onSku={(sku) => patchRow(row, { sku })}
                  onToggleDelete={() => void requestDelete(row)}
                />
              ))}
            </Stack>
          </SortableContext>
        </DndContext>
      )}

      {!disabled && (
        <Group>
          <Button
            variant="light"
            size="xs"
            leftSection={<IconPlus size={14} />}
            onClick={addManual}
          >
            Nova variante
          </Button>
          {rows.length > 0 && (
            <Button
              variant="subtle"
              color="red"
              size="xs"
              onClick={() => void toggleDeleteAll()}
              loading={checking.size > 0}
            >
              Excluir/restaurar todas
            </Button>
          )}
        </Group>
      )}
    </Stack>
  );
}

interface SortableChildProps {
  row: ChildRow;
  disabled?: boolean;
  /** Reference lookup in flight for this row (delete guard). */
  checkingRefs?: boolean;
  /** Sibling-uniqueness violation message for the SKU input. */
  skuError?: string;
  onNome: (value: string) => void;
  onSku: (value: string) => void;
  onToggleDelete: () => void;
}

function SortableChild({
  row,
  disabled,
  checkingRefs,
  skuError,
  onNome,
  onSku,
  onToggleDelete,
}: SortableChildProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: row.key,
    disabled,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : row.deleteMark ? 0.55 : 1,
    borderColor: row.deleteMark ? 'var(--mantine-color-red-6)' : undefined,
  };

  return (
    <Paper ref={setNodeRef} style={style} withBorder p="xs">
      <Group wrap="nowrap" align="flex-end" gap="xs">
        {!disabled && (
          <ActionIcon
            variant="subtle"
            mb={4}
            style={{ cursor: 'grab' }}
            aria-label="Reordenar"
            {...attributes}
            {...listeners}
          >
            <IconGripVertical size={16} />
          </ActionIcon>
        )}
        <TextInput
          label="Nome"
          value={row.nome}
          onChange={(e) => onNome(e.currentTarget.value)}
          disabled={disabled || row.deleteMark}
          style={{ flex: 1 }}
        />
        <TextInput
          label="SKU"
          value={row.sku}
          onChange={(e) => onSku(e.currentTarget.value)}
          disabled={disabled || row.deleteMark}
          error={skuError}
          w={160}
        />
        {!row.id && (
          <Badge color="blue" variant="light" mb={6}>
            nova
          </Badge>
        )}
        {row.deleteMark && (
          <Badge color="red" variant="light" mb={6}>
            Será excluída
          </Badge>
        )}
        {row.id && (
          <ActionIcon
            component={Link}
            href={`/produtos/${row.id}/editar`}
            variant="subtle"
            mb={4}
            aria-label="Abrir variação"
          >
            <IconExternalLink size={16} />
          </ActionIcon>
        )}
        {!disabled &&
          (row.deleteMark ? (
            <ActionIcon
              variant="subtle"
              color="blue"
              mb={4}
              onClick={onToggleDelete}
              aria-label="Desfazer exclusão"
            >
              <IconArrowBackUp size={16} />
            </ActionIcon>
          ) : (
            <ActionIcon
              variant="subtle"
              color="red"
              mb={4}
              onClick={onToggleDelete}
              loading={checkingRefs}
              aria-label="Remover variação"
            >
              <IconTrash size={16} />
            </ActionIcon>
          ))}
      </Group>
    </Paper>
  );
}
