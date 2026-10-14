/**
 * The `int_frete` ⇆ marketplace-conta (`integracao`) sync — ONE core for every channel (#1369).
 *
 * A marketplace conta owns a freight doc in `int_frete`, tied to it by a back-reference holding
 * `documents/integracao/<id>`. The legacy Flutter app maintained that doc from the conta screen,
 * upserting it on every save; the new stack saves the conta through a plain `ObjectView` with no
 * companion write, so a Firestore trigger per channel keeps it in step instead. Mercado Livre did
 * it first (#782, `apps/mercado-livre/lib/marketplace/frete/intFreteSync.ts`, now a binding of
 * this module); Shopee step 20 (#1528) is the second channel and Loja Integrada step 20 (#1826)
 * the third, and the per-channel facts — the two tipo enums, the back-ref key, the log prefix, the
 * deterministic-id prefix — are ONE pure row each in `VINCULO_INT_FRETE_CONTA`
 * (`@delfrance/schemas`). Nothing here knows a channel by name. Neither does the doc chooser: the
 * newest-`dataCadastro` pick is `escolherIntFreteMaisNovo` (`@delfrance/schemas`), so a browser
 * surface that must name the same doc calls the same copy.
 *
 * ---- One pure planner, two drivers ----
 * {@link SyncIntFreteConta.planejarIntFreteDaConta} makes every create / patch / deactivate
 * decision. Two drivers apply it, and the window pass (`tools/migrations`) runs it over a scan:
 *
 *  - **Shopee and Loja Integrada — state-driven** (`reconciliarIntFreteDaConta`). The caller
 *    passes the conta ID and nothing else. Inside ONE `db.runTransaction` the conta is re-read
 *    through `tx.get`, the doc is looked up through `tx.get` (plus the deterministic id on a
 *    miss), and the planner decides from those snapshots alone. Rule 7 class **A**: nothing captured outside reaches the write,
 *    so there is no event clock and no watermark — a replayed, retried or out-of-order event
 *    converges to the conta as it stands at commit, and a conta write landing between the read
 *    and the commit puts the conta in the conflict set, so the attempt re-runs. A create targets
 *    `<prefixoDocId>-<integracaoId>` (rule 7 tier 0): two concurrent first reconciles contend on
 *    ONE path, and the loser aborts or fails ALREADY_EXISTS, whose Eventarc retry then patches.
 *    `ultimaModificacao` is stamped with the conta read's `readTime` (ms) — display only, since
 *    nothing on this path reads it as a guard.
 *  - **Mercado Livre — event-driven** (`sincronizarIntFreteDaConta` / `desativarIntFreteDaConta`),
 *    behaviour-identical to the pre-#1528 ML module (its `it` blocks are byte-unedited; only the
 *    FakeDb gained `tx.update`). The mirrored fields come from the event's `after`, OUTSIDE the
 *    callback (class **B**); the named guard is the **ms** watermark {@link docMaisNovoQueEvento}
 *    on the callback's own `tx.get` — stored strictly newer than the event ⇒ `obsoleto`, zero
 *    writes; equal proceeds. ⚠️ Its known gaps
 *    are characterised in `intFreteContaSync.test.ts` and filed as ONE follow-up, #1888 (move ML
 *    onto the state-driven driver): a NEWER event whose diff is empty writes nothing, so it never
 *    advances the watermark and an older retry applied afterwards wins; and a random-id create
 *    relies on Firestore protecting the lookup query's range against a concurrent insert.
 *
 * A patch or a deactivation writes through `tx.update`, of the keys that moved only (out of the
 * ones `montarCamposIntFrete` builds: the mirrored fields plus `tipo` and the back-ref) and the
 * `ultimaModificacao` stamp — on a doc the same transaction just read, so `update` ≡ a
 * merge-`set`, minus the silent upsert. A create (`tx.create`) writes the full schema-parsed doc.
 *
 * ---- Parity notes vs `.old/` ----
 *  - Mirrored fields are the legacy `fromConta` set (Mercado Livre:
 *    `.old/packages/canais_de_venda/mercado_livre/lib/src/models.dart:332-339`; Shopee:
 *    `.old/packages/canais_de_venda/shopee/lib/src/models.dart:176-183`): `nome`, `ativo`, the
 *    filial ref (rebased `filialIntegracaoPedidoOuterRef` → `filialIntegracaoFreteOuterRef`) and
 *    the conta back-ref — plus `dataCadastro`, see below.
 *  - `mapa` / `faixaCep` / `horarioDeCorte` / `enderecoDeOrigem` are NEVER written by a patch or a
 *    deactivation. That is the legacy null-preserving generated `update()` (`other.x ?? this.x`),
 *    and it is how a hand-configured endereço de origem survives a conta re-save. A create writes
 *    them at the schema defaults (`null`; likewise `prazoExtra` 0, `client_id` / `client_secret`
 *    null) — there is nothing to preserve yet. Nothing here ever deletes.
 *  - **Divergence — `dataCadastro`**: the legacy re-stamped it to `now` on every conta save
 *    (incidental: `fromConta` defaulted it to `DateTime.now()`), which made a "registration date"
 *    meaningless and the newest-first tie-break unstable. Here it MIRRORS the conta's own
 *    `dataCadastro`; `ultimaModificacao` carries the modification time.
 *  - **Divergence — delete**: the legacy orphaned the freight doc. Here a deleted conta (or one
 *    whose `tipo` moved away) DEACTIVATES it — never deletes it, because live pedidos hold
 *    `integracaoFreteOuterRef` pointing at it, and deleting it would blank the Frete tab and the
 *    etiqueta action on historical orders.
 *
 * Firestore types are imported as TYPES only (`adminBundleSafety.test.ts`): the caller hands in
 * its own `db`.
 */
import type { DocumentData, Firestore, Query, Transaction } from 'firebase-admin/firestore';
import { coerceToMillis } from '@delfrance/core/datetime';
import {
  INTEGRACAO_TIPO_LABELS,
  escolherIntFreteMaisNovo,
  toOuterRef,
  toOuterRefOrNull,
  type VinculoIntFreteConta,
} from '@delfrance/schemas';

import { intFreteCollection, integracaoCollection } from '../collections';

/**
 * The `integracao` fields mirrored onto the freight doc. The first three are the legacy
 * `fromConta` set; `dataCadastro` is this port's addition (see the module docblock) so the
 * freight doc reports the same registration date as its conta.
 *
 * All four are scalars, so the change check is a plain `!==` per field.
 */
export const CAMPOS_SINCRONIZADOS = [
  'nome',
  'ativo',
  'filialIntegracaoPedidoOuterRef',
  'dataCadastro',
] as const;

/** What one sync / deactivate / reconcile call did — logged as one structured line by the trigger. */
export interface DisposicaoIntFrete {
  action:
    | 'criado'
    | 'atualizado'
    | 'inalterado'
    | 'desativado'
    | 'incompleto'
    | 'nao-encontrado'
    | 'obsoleto';
  intFreteId?: string;
  /** Field names actually written (create/update only). */
  campos?: string[];
  /** Mirrored fields that could not be resolved (`incompleto` only). */
  faltando?: string[];
}

/** A raw `integracao` snapshot body (an event's `before`/`after`, or a `tx.get`), or nothing. */
export type ContaBruta = Record<string, unknown> | null | undefined;

/** One `int_frete` doc as the lookup returns it: its id and its raw body. */
export interface IntFreteEncontrado {
  id: string;
  data: Record<string, unknown>;
}

/** The pure decision. `id: null` on `criar` ⇒ a random id (no `prefixoDocId`, Mercado Livre). */
export type PlanoIntFrete =
  | { acao: 'criar'; id: string | null; campos: Record<string, unknown> }
  | { acao: 'atualizar'; id: string; patch: Record<string, unknown> }
  | { acao: 'desativar'; id: string }
  | { acao: 'inalterado'; id: string }
  | { acao: 'incompleto'; faltando: string[] }
  | { acao: 'nao-encontrado' };

/**
 * Mercado Livre only. True when the STORED freight doc is strictly newer than the event being
 * applied — somebody wrote it after this event happened, so replaying the event would roll that
 * change back. The caller must then do nothing.
 *
 * Eventarc is at-least-once AND unordered: a redelivery carries the ORIGINAL `event.time`, and it
 * can land long after a newer conta write has already synced. The other writer of the doc is the
 * `/logistica` editor — a human edit at T2 must survive a stale event from T1.
 *
 * Equal stamps PROCEED: same instant, and the write is idempotent (the field diff reduces it to a
 * no-op anyway). Only `>` blocks.
 *
 * `coerceToMillis` on the stored side because `ultimaModificacao` is tolerant on read — a legacy
 * doc may carry an ISO string or µs where the schema says ms, and comparing those raw against an
 * ms event stamp would silently mis-order them. Both sides are MILLISECONDS.
 */
export function docMaisNovoQueEvento(data: Record<string, unknown>, eventTimeMs: number): boolean {
  const armazenado = coerceToMillis(data.ultimaModificacao);
  return armazenado != null && armazenado > eventTimeMs;
}

/**
 * Every key of `campos` whose value differs (`!==`) from the stored one — the patch. Pure.
 *
 * The folds happen BEFORE this, in `montarCamposIntFrete` (`dataCadastro` through
 * `coerceToMillis`, the filial through `toOuterRefOrNull`, an absent `ativo` as `true`); this is
 * a plain identity compare of the already-folded scalars, and folds nothing of its own — a
 * stored `dataCadastro` one millisecond off, or a back-ref in the bare form, IS a change.
 */
export function diffCamposIntFrete(
  campos: Readonly<Record<string, unknown>>,
  armazenado: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [campo, valor] of Object.entries(campos)) {
    if (armazenado[campo] !== valor) patch[campo] = valor;
  }
  return patch;
}

export interface OpcoesSyncIntFrete {
  /**
   * Mercado Livre only (`refMatchesIntegracao`): enables the tolerant fallback scan for a doc
   * whose back-ref is stored in a non-canonical form. Absent ⇒ the lookup never scans: the Shopee
   * and Loja Integrada bindings read only the two-equality query and the deterministic id. The
   * window adoption pass both channels bind (`tools/migrations/src/intFreteAdocao/executar.ts`)
   * does read the channel's whole `tipo ==` population — once, by design — and REPORTS a
   * non-canonical ref instead of matching it, refusing to create beside it.
   */
  readonly refTolerante?: (ref: unknown, integracaoId: string) => boolean;
}

export interface SyncIntFreteConta {
  readonly vinculo: VinculoIntFreteConta;
  /** True for this channel's conta: `data?.tipo === vinculo.tipoConta` (the INT enum). */
  ehConta(data: ContaBruta): boolean;
  /** True when a mirrored field moved: `CAMPOS_SINCRONIZADOS.some(!==)`. */
  mudouCampoSincronizado(before: ContaBruta, after: ContaBruta): boolean;
  /**
   * The trigger's payload pre-filter — COST only; `reconciliarIntFreteDaConta` is correct for any
   * call:
   * `(ehConta(before) || ehConta(after)) &&
   *  (before == null || after == null || ehConta(before) !== ehConta(after) || mudouCampoSincronizado(before, after))`.
   */
  deveReconciliar(before: ContaBruta, after: ContaBruta): boolean;
  /** The canonical back-ref a freight doc of this conta must carry: `documents/integracao/<id>`. */
  refCanonicalDaConta(integracaoId: string): string;
  /** The lookup's two equalities, in memory: `raw.tipo === tipoFrete && raw[campoBackRef] === canonical`. */
  ehDocDaConta(raw: Record<string, unknown>, integracaoId: string): boolean;
  /**
   * Pure twin of the lookup the drivers run: the `ehDocDaConta` matches, newest `dataCadastro`
   * (an equal one ⇒ the lowest id); else (only with `refTolerante`) the tolerant matches of this
   * `tipoFrete`; else (only with `prefixoDocId`) the doc at the deterministic id. The window pass
   * chooses with it.
   */
  escolherIntFreteDaConta(
    docs: ReadonlyArray<IntFreteEncontrado>,
    integracaoId: string,
  ): IntFreteEncontrado | null;
  /**
   * The mirrored field values for this conta. A field is ABSENT from `campos` when it cannot be
   * resolved and is named in `faltando` instead — `int_frete` declares `nome`,
   * `filialIntegracaoFreteOuterRef` and `dataCadastro` non-nullable, so writing null would be
   * rejected by the schema (the legacy force-unwrapped the filial here and crashed). On a create
   * that makes the doc unbuildable; on an update the stored value simply survives.
   */
  montarCamposIntFrete(
    integracaoId: string,
    conta: ContaBruta,
  ): { campos: Record<string, unknown>; faltando: string[] };
  /**
   * Pure. `conta` absent, or not this channel's tipo ⇒ the deactivate branch; else create / patch
   * / nothing.
   */
  planejarIntFreteDaConta(
    integracaoId: string,
    conta: ContaBruta,
    existente: IntFreteEncontrado | null,
  ): PlanoIntFrete;
  /**
   * This conta's freight doc: the newest `dataCadastro`, and on an equal `dataCadastro` the
   * lexically LOWEST doc id — explicit in `escolherIntFreteMaisNovo` (`@delfrance/schemas`), so
   * the pick does not depend on the order a query returns its docs in.
   *
   * ⚠️ That is NOT the legacy tie-break, and there was no single legacy rule. Legacy Mercado Livre
   * ran `orderBy__dataCadastro(false).first()` (`ascending: false` ⇒ DESC, and Firestore orders
   * the implicit `__name__` in the last `orderBy`'s direction), so on a tie it kept the HIGHEST
   * id. Legacy Shopee ran `contaShopeeFreteOuterRef__isEqualTo(conta).first()` with no `orderBy`:
   * the lowest id, ignoring `dataCadastro` altogether — because Standard (the legacy edition)
   * returns a query with no `orderBy` in ascending `__name__` order.
   *
   * ⚠️ So the explicit tie IS a Mercado Livre behaviour change. Before it, this lookup kept the
   * first doc in result order, and Enterprise guarantees no such order: with no `orderBy` it picks
   * whatever ordering the indexes available at execution time make cheapest (the REST
   * `StructuredQuery.orderBy` reference), and this query orders by nothing. On an equal
   * `dataCadastro` the ML pick therefore depended on the query plan; it is now deterministically
   * the lowest id. That is a deliberate determinism change, not a no-op — parity with the legacy
   * highest id is #1888's call.
   *
   * ⚠️ `apenasAtivo` defaults to **false**, and every sync driver must keep it that way:
   * filtering `ativo == true` would make re-enabling a deactivated conta find nothing and CREATE
   * A DUPLICATE instead of re-activating the existing doc. Only an importer (which wants a live
   * config) passes `true` — the legacy split, where the writer's lookup had no `ativo` filter.
   *
   * Rides `int_frete (tipo, <campoBackRef>, ativo, dataCadastro DESC)` — one per
   * `VINCULO_INT_FRETE_CONTA` row, pinned by `intFrete.vinculo.test.ts`: the equalities are a
   * prefix of it either way, and neither variant orders in the query (the tie-break is
   * client-side over what is normally a single doc). Enterprise auto-creates nothing and silently
   * full-scans an unindexed query.
   */
  buscarIntFreteDaConta(
    db: Firestore,
    integracaoId: string,
    opts?: { apenasAtivo?: boolean; tx?: Transaction },
  ): Promise<IntFreteEncontrado | null>;
  /**
   * Shopee and Loja Integrada: state-driven, class A. Re-reads the conta through `tx.get`; takes
   * no conta, no clock.
   */
  reconciliarIntFreteDaConta(db: Firestore, integracaoId: string): Promise<DisposicaoIntFrete>;
  /**
   * Mercado Livre: event-driven, class B. Creates the doc when absent, otherwise patches ONLY the
   * mirrored fields that differ — so a conta write that moved nothing relevant (and a replay of
   * an already-applied event) writes nothing, and `dataCadastro` never churns. `obsoleto` when
   * the stored doc is newer than `eventTimeMs`.
   */
  sincronizarIntFreteDaConta(
    db: Firestore,
    integracaoId: string,
    conta: ContaBruta,
    eventTimeMs: number,
  ): Promise<DisposicaoIntFrete>;
  /**
   * Mercado Livre: flip this conta's freight doc inactive (the conta was deleted, or its `tipo`
   * edited away). Never deletes; `dataCadastro` is not touched — deactivating is not
   * re-registering. `obsoleto` when the stored doc is newer than `eventTimeMs`.
   */
  desativarIntFreteDaConta(
    db: Firestore,
    integracaoId: string,
    eventTimeMs: number,
  ): Promise<DisposicaoIntFrete>;
  /**
   * Mercado Livre: true only when `integracao/{id}` is confirmed absent RIGHT NOW. A redelivery
   * replays the ORIGINAL CloudEvent, so without this a delete event arriving after the conta was
   * re-created would deactivate a live freight doc. Existence only — a conta present under another
   * tipo reads `false` (a known ML gap, closed by moving ML onto the state-driven driver, #1888).
   */
  contaRealmenteExcluida(db: Firestore, integracaoId: string): Promise<boolean>;
}

function comoEncontrados(
  docs: ReadonlyArray<{ id: string; data(): DocumentData }>,
): IntFreteEncontrado[] {
  return docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> }));
}

/**
 * Binds the core to one channel's {@link VinculoIntFreteConta} row. Every returned function is a
 * closure (no `this`), so a binding can destructure them or spread them into a mock.
 */
export function intFreteContaSync(
  vinculo: VinculoIntFreteConta,
  opcoes: OpcoesSyncIntFrete = {},
): SyncIntFreteConta {
  const { tipoConta, tipoFrete, campoBackRef, rotuloLog, prefixoDocId } = vinculo;
  const { refTolerante } = opcoes;
  const nomeCanal = INTEGRACAO_TIPO_LABELS[tipoConta];

  const idDeterministico = (integracaoId: string): string => `${prefixoDocId}-${integracaoId}`;

  /* ------------------------------ free gates ------------------------------ */

  const ehConta = (data: ContaBruta): boolean => data?.tipo === tipoConta;

  const mudouCampoSincronizado = (before: ContaBruta, after: ContaBruta): boolean =>
    CAMPOS_SINCRONIZADOS.some((campo) => before?.[campo] !== after?.[campo]);

  const deveReconciliar = (before: ContaBruta, after: ContaBruta): boolean => {
    const antes = ehConta(before);
    const depois = ehConta(after);
    if (!antes && !depois) return false;
    return (
      before == null || after == null || antes !== depois || mudouCampoSincronizado(before, after)
    );
  };

  /* ---------------------------- field mapping ----------------------------- */

  const refCanonicalDaConta = (integracaoId: string): string =>
    toOuterRef(integracaoCollection.docPath({}, integracaoId));

  const ehDocDaConta = (raw: Record<string, unknown>, integracaoId: string): boolean =>
    raw.tipo === tipoFrete && raw[campoBackRef] === refCanonicalDaConta(integracaoId);

  const montarCamposIntFrete = (
    integracaoId: string,
    conta: ContaBruta,
  ): { campos: Record<string, unknown>; faltando: string[] } => {
    const faltando: string[] = [];
    const campos: Record<string, unknown> = {
      tipo: tipoFrete,
      // Absent → true, mirroring `integracaoSchema.ativo`'s `.default(true)`. Reading the raw
      // snapshot bypasses that default, and a plain `=== true` would read a legacy conta doc
      // with no `ativo` key as INACTIVE.
      ativo: typeof conta?.ativo === 'boolean' ? conta.ativo : true,
      [campoBackRef]: refCanonicalDaConta(integracaoId),
    };

    const nome = conta?.nome;
    if (typeof nome === 'string' && nome.length > 0) campos.nome = nome;
    else faltando.push('nome');

    // Non-throwing on purpose: a legacy conta carrying a malformed ref must degrade to "filial
    // not resolvable" (below), not abort the trigger onto the Eventarc retry.
    const filial = toOuterRefOrNull(conta?.filialIntegracaoPedidoOuterRef);
    if (filial != null) campos.filialIntegracaoFreteOuterRef = filial;
    else faltando.push('filialIntegracaoPedidoOuterRef');

    // Normalize BEFORE diffing: `millisSinceEpoch`'s tolerant preprocess would rewrite an ISO
    // string / µs value to ms on write, so comparing the raw conta value against the stored ms
    // number would report a change on every single invocation.
    const dataCadastro = coerceToMillis(conta?.dataCadastro);
    if (dataCadastro != null) campos.dataCadastro = dataCadastro;
    else faltando.push('dataCadastro');

    return { campos, faltando };
  };

  /* ------------------------------- planner -------------------------------- */

  const planejarSincronizacao = (
    integracaoId: string,
    existente: IntFreteEncontrado | null,
    { campos, faltando }: { campos: Record<string, unknown>; faltando: string[] },
  ): PlanoIntFrete => {
    if (existente == null) {
      // Legacy force-unwrapped the filial here and crashed. Degrade instead: the doc is created
      // by the next conta save, once the missing field is filled in.
      if (faltando.length > 0) return { acao: 'incompleto', faltando };
      return {
        acao: 'criar',
        id: prefixoDocId != null ? idDeterministico(integracaoId) : null,
        campos,
      };
    }
    const patch = diffCamposIntFrete(campos, existente.data);
    if (Object.keys(patch).length === 0) return { acao: 'inalterado', id: existente.id };
    return { acao: 'atualizar', id: existente.id, patch };
  };

  const planejarDesativacao = (existente: IntFreteEncontrado | null): PlanoIntFrete => {
    if (existente == null) return { acao: 'nao-encontrado' };
    if (existente.data.ativo !== true) return { acao: 'inalterado', id: existente.id };
    return { acao: 'desativar', id: existente.id };
  };

  const planejarIntFreteDaConta = (
    integracaoId: string,
    conta: ContaBruta,
    existente: IntFreteEncontrado | null,
  ): PlanoIntFrete =>
    ehConta(conta)
      ? planejarSincronizacao(integracaoId, existente, montarCamposIntFrete(integracaoId, conta))
      : planejarDesativacao(existente);

  /* -------------------------------- lookup -------------------------------- */

  const escolherIntFreteDaConta = (
    docs: ReadonlyArray<IntFreteEncontrado>,
    integracaoId: string,
  ): IntFreteEncontrado | null => {
    const direto = escolherIntFreteMaisNovo(docs, (raw) => ehDocDaConta(raw, integracaoId));
    if (direto != null) return direto;
    if (refTolerante != null) {
      const tolerante = escolherIntFreteMaisNovo(
        docs,
        (raw) => raw.tipo === tipoFrete && refTolerante(raw[campoBackRef], integracaoId),
      );
      if (tolerante != null) return tolerante;
    }
    if (prefixoDocId == null) return null;
    const idDet = idDeterministico(integracaoId);
    return docs.find((d) => d.id === idDet) ?? null;
  };

  const buscarIntFreteDaConta = async (
    db: Firestore,
    integracaoId: string,
    opts: { apenasAtivo?: boolean; tx?: Transaction } = {},
  ): Promise<IntFreteEncontrado | null> => {
    // Inside a transaction the lookup MUST read through `tx` — a plain `q.get()` is an ordinary
    // read that neither participates in the transaction's conflict detection nor sees its
    // pending writes, which would reintroduce the very read-modify-write gap the transaction
    // exists to close. (Unlike the Firebase JS client SDK, the Admin SDK can read a QUERY inside
    // a transaction.)
    const ler = (query: Query) => (opts.tx != null ? opts.tx.get(query) : query.get());

    let q: Query = intFreteCollection
      .ref(db, {})
      .where('tipo', '==', tipoFrete)
      .where(campoBackRef, '==', refCanonicalDaConta(integracaoId));
    if (opts.apenasAtivo === true) q = q.where('ativo', '==', true);

    const snap = await ler(q);
    const direto = escolherIntFreteMaisNovo(comoEncontrados(snap.docs));
    if (direto != null || refTolerante == null) return direto;

    // Fallback (Mercado Livre only): a doc whose back-ref is stored in a non-canonical form (bare
    // `integracao/<id>`) is invisible to the equality above. Legacy Flutter wrote the canonical
    // form, so this should never hit — but it is exactly what the old client-side scan
    // tolerated, and dropping that tolerance silently would break order import. The sync
    // rewrites the ref to canonical on its next pass.
    let scan: Query = intFreteCollection.ref(db, {}).where('tipo', '==', tipoFrete);
    if (opts.apenasAtivo === true) scan = scan.where('ativo', '==', true);
    const scanSnap = await ler(scan);
    const tolerante = escolherIntFreteMaisNovo(comoEncontrados(scanSnap.docs), (raw) =>
      refTolerante(raw[campoBackRef], integracaoId),
    );
    if (tolerante != null) {
      console.warn(
        `${rotuloLog} int_frete encontrado apenas pelo scan tolerante — ` +
          `${campoBackRef} não está na forma canônica ` +
          '(rode o backfill para normalizar)',
        { integracaoId, intFreteId: tolerante.id },
      );
    }
    return tolerante;
  };

  /**
   * The lookup inside a transaction, plus — when the channel creates at a deterministic id — a
   * `tx.get` of that id on a miss: a doc whose back-ref was altered is still THIS conta's doc, and
   * it is the path a create would collide on, so reading it also enrols it in the conflict set.
   */
  const localizarNoTx = async (
    db: Firestore,
    tx: Transaction,
    integracaoId: string,
  ): Promise<IntFreteEncontrado | null> => {
    const achado = await buscarIntFreteDaConta(db, integracaoId, { tx });
    if (achado != null || prefixoDocId == null) return achado;
    const idDet = idDeterministico(integracaoId);
    const snap = await tx.get(intFreteCollection.docRef(db, {}, idDet));
    return snap.exists ? { id: idDet, data: snap.data() as Record<string, unknown> } : null;
  };

  /* ------------------------------ apply step ------------------------------ */

  /** Stages AT MOST ONE write for `plano` on `tx`, and reports it. */
  const aplicarPlano = (
    db: Firestore,
    tx: Transaction,
    integracaoId: string,
    plano: PlanoIntFrete,
    carimboMs: number,
  ): DisposicaoIntFrete => {
    switch (plano.acao) {
      case 'criar': {
        const id = plano.id ?? intFreteCollection.newDocId(db, {});
        tx.create(
          intFreteCollection.docRef(db, {}, id),
          intFreteCollection.parse({
            ...plano.campos,
            ultimaModificacao: carimboMs,
          }) as DocumentData,
        );
        return { action: 'criado', intFreteId: id, campos: Object.keys(plano.campos) };
      }
      case 'atualizar':
        tx.update(
          intFreteCollection.docRef(db, {}, plano.id),
          intFreteCollection.parseMerge({
            ...plano.patch,
            ultimaModificacao: carimboMs,
          }) as DocumentData,
        );
        return { action: 'atualizado', intFreteId: plano.id, campos: Object.keys(plano.patch) };
      case 'desativar':
        tx.update(
          intFreteCollection.docRef(db, {}, plano.id),
          intFreteCollection.parseMerge({
            ativo: false,
            ultimaModificacao: carimboMs,
          }) as DocumentData,
        );
        return { action: 'desativado', intFreteId: plano.id, campos: ['ativo'] };
      case 'inalterado':
        return { action: 'inalterado', intFreteId: plano.id };
      case 'incompleto':
        console.warn(
          `${rotuloLog} conta ${nomeCanal} sem dados suficientes para criar o int_frete`,
          {
            integracaoId,
            faltando: plano.faltando,
          },
        );
        return { action: 'incompleto', faltando: plano.faltando };
      case 'nao-encontrado':
        return { action: 'nao-encontrado' };
    }
  };

  /* -------------------------------- drivers ------------------------------- */

  const reconciliarIntFreteDaConta = (
    db: Firestore,
    integracaoId: string,
  ): Promise<DisposicaoIntFrete> =>
    db.runTransaction(async (tx) => {
      // ALL reads before any write, and every input to the write comes from one of them.
      const contaSnap = await tx.get(integracaoCollection.docRef(db, {}, integracaoId));
      const existente = await localizarNoTx(db, tx, integracaoId);
      const conta = contaSnap.exists ? (contaSnap.data() as Record<string, unknown>) : null;
      return aplicarPlano(
        db,
        tx,
        integracaoId,
        planejarIntFreteDaConta(integracaoId, conta, existente),
        contaSnap.readTime.toMillis(),
      );
    });

  const sincronizarIntFreteDaConta = (
    db: Firestore,
    integracaoId: string,
    conta: ContaBruta,
    eventTimeMs: number,
  ): Promise<DisposicaoIntFrete> => {
    const alvo = montarCamposIntFrete(integracaoId, conta);
    return db.runTransaction(async (tx) => {
      const existente = await localizarNoTx(db, tx, integracaoId);
      if (existente != null && docMaisNovoQueEvento(existente.data, eventTimeMs)) {
        return { action: 'obsoleto', intFreteId: existente.id };
      }
      return aplicarPlano(
        db,
        tx,
        integracaoId,
        planejarSincronizacao(integracaoId, existente, alvo),
        eventTimeMs,
      );
    });
  };

  const desativarIntFreteDaConta = (
    db: Firestore,
    integracaoId: string,
    eventTimeMs: number,
  ): Promise<DisposicaoIntFrete> =>
    db.runTransaction(async (tx) => {
      const existente = await localizarNoTx(db, tx, integracaoId);
      if (existente == null) return { action: 'nao-encontrado' };
      // A freight doc re-activated AFTER this event happened outranks it — deactivating now would
      // undo that newer decision with no event left to redo it.
      if (docMaisNovoQueEvento(existente.data, eventTimeMs)) {
        return { action: 'obsoleto', intFreteId: existente.id };
      }
      return aplicarPlano(db, tx, integracaoId, planejarDesativacao(existente), eventTimeMs);
    });

  const contaRealmenteExcluida = async (db: Firestore, integracaoId: string): Promise<boolean> => {
    const snap = await integracaoCollection.docRef(db, {}, integracaoId).get();
    return !snap.exists;
  };

  return {
    vinculo,
    ehConta,
    mudouCampoSincronizado,
    deveReconciliar,
    refCanonicalDaConta,
    ehDocDaConta,
    escolherIntFreteDaConta,
    montarCamposIntFrete,
    planejarIntFreteDaConta,
    buscarIntFreteDaConta,
    reconciliarIntFreteDaConta,
    sincronizarIntFreteDaConta,
    desativarIntFreteDaConta,
    contaRealmenteExcluida,
  };
}
