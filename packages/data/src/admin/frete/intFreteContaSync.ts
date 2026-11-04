/**
 * The `int_frete` ⇆ marketplace-conta (`integracao`) reconciliation — one core for every channel
 * (#1369, #1888): Mercado Livre (#782), Shopee (#1528), Loja Integrada (#1826) and Amazon
 * (#1930). The per-channel facts live in `VINCULO_INT_FRETE_CONTA`, and nothing here knows a
 * channel by name. Neither does the doc chooser: the newest-`dataCadastro` pick is
 * `escolherIntFreteMaisNovo` (`@delfrance/schemas`), so a browser surface that must name the same
 * doc calls the same copy.
 *
 * The caller passes only the conta ID. One transaction re-reads the current conta and freight
 * record, and the pure `planejarIntFreteDaConta` decides from those snapshots. Rule 7 class A:
 * a replay, retry or out-of-order event converges to current state; an account write between
 * read and commit conflicts and re-runs the callback. `ultimaModificacao` uses the conta
 * snapshot's `readTime` in ms for display, never as a watermark or a reconciliation guard.
 *
 * Existing canonical records, then tolerant legacy back-references when configured, are adopted
 * before checking the deterministic path. A new record targets `<prefixoDocId>-<integracaoId>`
 * for Mercado Livre, Shopee, Loja Integrada and Amazon (`amz-<integracaoId>`) alike (rule 7
 * tier 0), so concurrent first reconciliations contend on one path even without lookup-query
 * range protection. Equal `dataCadastro` values select the lexically lower record ID, preserving
 * the deliberate policy confirmed for #1888.
 *
 * Updates use `tx.update` for only differing mirrored fields, plus the display stamp. Operator
 * configuration (`mapa`, `faixaCep`, `horarioDeCorte`, `enderecoDeOrigem`) survives updates and
 * deactivation. Creates write the full schema-parsed document with configuration defaults.
 *
 * Parity with the legacy `fromConta` set: `nome`, `ativo`, the filial ref (rebased from
 * `filialIntegracaoPedidoOuterRef`) and the conta back-ref. `dataCadastro` additionally mirrors
 * the conta's registration date instead of the legacy save-time stamp. Account deletion or a
 * change of channel deactivates the freight record; it never deletes or renames it, because
 * historical orders retain `integracaoFreteOuterRef` references to that record.
 *
 * Firestore imports are types only (`adminBundleSafety.test.ts`); the caller supplies its own db.
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

/** What one reconciliation did — logged as one structured line by the trigger. */
export interface DisposicaoIntFrete {
  action: 'criado' | 'atualizado' | 'inalterado' | 'desativado' | 'incompleto' | 'nao-encontrado';
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

/** The pure decision. `id: null` on `criar` ⇒ a random ID for a binding without `prefixoDocId`. */
export type PlanoIntFrete =
  | { acao: 'criar'; id: string | null; campos: Record<string, unknown> }
  | { acao: 'atualizar'; id: string; patch: Record<string, unknown> }
  | { acao: 'desativar'; id: string }
  | { acao: 'inalterado'; id: string }
  | { acao: 'incompleto'; faltando: string[] }
  | { acao: 'nao-encontrado' };

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
   * whose back-ref is stored in a non-canonical form. Absent ⇒ the lookup never scans: the Shopee,
   * Loja Integrada and Amazon bindings read only the two-equality query and the deterministic id.
   * The window adoption pass those channels bind (`tools/migrations/src/intFreteAdocao/executar.ts`)
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
   * Pure twin of the reconciliation lookup: the `ehDocDaConta` matches, newest `dataCadastro`
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
   * highest ID was considered for #1888; the lower-ID policy was retained.
   *
   * ⚠️ `apenasAtivo` defaults to **false**, and reconciliation must keep it that way:
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
  /** State-driven, class A: re-reads the conta through `tx.get`; takes no conta or event clock. */
  reconciliarIntFreteDaConta(db: Firestore, integracaoId: string): Promise<DisposicaoIntFrete>;
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

  /* ----------------------------- reconciliation --------------------------- */

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
  };
}
