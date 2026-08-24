/**
 * Mercado Envios `int_frete` ⇆ Mercado Livre conta (`integracao`) sync (#782).
 *
 * The order importer resolves an account's freight config through an `int_frete`
 * doc carrying `contaMercadoLivreMercadoEnviosOuterRef == documents/integracao/<id>`
 * (`orderImport.ts`'s `resolveMercadoEnviosIntFreteOuterRef`, legacy
 * `tasks.dart:515-517/623-625`). The legacy Flutter app maintained that doc from
 * the conta screen — `cadastroConta.dart:91-101` upserted it on EVERY save, create
 * and edit alike — while the new stack saves the conta through a plain `ObjectView`
 * with no companion write. Nothing created the doc, so the Frete tab rendered the
 * editable generic block instead of the marketplace lock and the etiqueta row action
 * resolved `{action:'none'}` and disappeared.
 *
 * This module is the pure, unit-testable core; `functions/src/onIntegracaoMercadoLivreChanged.ts`
 * is a thin trigger wrapper over it (the same split `nfeUpload.ts` / `onNfeAprovada.ts` use).
 *
 * ---- Concurrency ----
 * Every write path is ONE `db.runTransaction`: the lookup reads through `tx` and the
 * create/patch commits in the same transaction, so the read-modify-write can't interleave
 * with a concurrent conta write (which on the create path would otherwise have both
 * invocations see "no doc" and create a DUPLICATE). Layered on top, `docMaisNovoQueEvento`
 * refuses to apply an event older than what is already stored — Eventarc is at-least-once
 * and unordered, and this doc has another writer: the `/logistica` editor.
 *
 * ---- Parity notes vs `.old/` ----
 *  - Mirrored fields are the legacy `MercadoEnvios.fromConta` set
 *    (`.old/packages/canais_de_venda/mercado_livre/lib/src/models.dart:332-339`):
 *    `nome`, `ativo`, the filial ref (rebased `filialIntegracaoPedidoOuterRef` →
 *    `filialIntegracaoFreteOuterRef`) and the conta back-ref — plus `dataCadastro`,
 *    see below.
 *  - `mapa` / `faixaCep` / `horarioDeCorte` / `enderecoDeOrigem` are NEVER touched on
 *    an update. That is the legacy null-preserving generated `update()`
 *    (`models.odm.g.dart:14154-14176`, `other.x ?? this.x`), and it is how a
 *    hand-configured endereço de origem survives a conta re-save.
 *  - **Divergence — `dataCadastro`**: the legacy re-stamped it to `now` on every conta
 *    save (incidental: `fromConta` defaulted it to `DateTime.now()` and `update()` took
 *    `other.dataCadastro` unconditionally), which made a "registration date" field
 *    meaningless and the newest-first tie-break unstable. Here it MIRRORS the conta's
 *    own `dataCadastro`; `ultimaModificacao` carries the modification time.
 *  - **Divergence — delete**: the legacy orphaned the freight doc (its `deleteCascade`
 *    only cascades the two token subcollections). Here a deleted conta DEACTIVATES the
 *    doc — never deletes it, because live pedidos hold `integracaoFreteOuterRef`
 *    pointing at it and deleting it would blank the Frete tab + etiqueta action on
 *    historical orders.
 */
import type { DocumentData, Firestore, Query, Transaction } from 'firebase-admin/firestore';
import { coerceToMillis } from '@delfrance/core/datetime';
import {
  INTEGRACAO_FRETE,
  INTEGRACAO_TIPO,
  toOuterRef,
  toOuterRefOrNull,
} from '@delfrance/schemas';
import { intFreteCollection, integracaoCollection } from '@delfrance/data/admin/collections';

import { refMatchesIntegracao } from '../core/linkRefs';

/**
 * The `integracao` fields mirrored onto the freight doc. The first three are the
 * legacy `fromConta` set; `dataCadastro` is this port's addition (see the file
 * docblock) so the freight doc reports the same registration date as its conta.
 *
 * All four are scalars, so the change check below is a plain `!==` per field.
 */
export const CAMPOS_SINCRONIZADOS = [
  'nome',
  'ativo',
  'filialIntegracaoPedidoOuterRef',
  'dataCadastro',
] as const;

/** What one sync/deactivate call did — logged as one structured line by the trigger. */
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

type Raw = Record<string, unknown> | null | undefined;

/* -------------------------------------------------------------------------- */
/*                              Free-path gates                               */
/* -------------------------------------------------------------------------- */

/**
 * True for a Mercado Livre conta. ⚠️ `integracao.tipo` is the **int**
 * `INTEGRACAO_TIPO.mercadoLivre` (1) while `int_frete.tipo` is the **string**
 * `INTEGRACAO_FRETE.mercadoLivre` — this is the bridge between the two enums.
 */
export function ehContaMercadoLivre(data: Raw): boolean {
  return data?.tipo === INTEGRACAO_TIPO.mercadoLivre;
}

/**
 * True when a mirrored field moved. The trigger's free skip: a token refresh or a
 * `user_id` stamp touches none of these, so it costs zero reads and zero writes.
 */
export function mudouCampoSincronizado(before: Raw, after: Raw): boolean {
  return CAMPOS_SINCRONIZADOS.some((campo) => before?.[campo] !== after?.[campo]);
}

/* -------------------------------------------------------------------------- */
/*                                 Field mapping                              */
/* -------------------------------------------------------------------------- */

/** The canonical back-ref an ML freight doc must carry: `documents/integracao/<id>`. */
export function refCanonicalDaConta(integracaoId: string): string {
  return toOuterRef(integracaoCollection.docPath({}, integracaoId));
}

/**
 * The mirrored field values for this conta. A field is ABSENT from the result when
 * it cannot be resolved — `int_frete` declares `nome`, `filialIntegracaoFreteOuterRef`
 * and `dataCadastro` non-nullable, so writing null would be rejected by the schema
 * (and the legacy force-unwrapped the filial here, crashing outright). On a create
 * that makes the doc unbuildable; on an update the stored value simply survives.
 */
export function montarCamposIntFrete(
  integracaoId: string,
  conta: Raw,
): { campos: Record<string, unknown>; faltando: string[] } {
  const faltando: string[] = [];
  const campos: Record<string, unknown> = {
    tipo: INTEGRACAO_FRETE.mercadoLivre,
    // Absent → true, mirroring `integracaoSchema.ativo`'s `.default(true)`. Reading the
    // raw event snapshot bypasses that default, and a plain `=== true` would read a
    // legacy conta doc with no `ativo` key as INACTIVE.
    ativo: typeof conta?.ativo === 'boolean' ? conta.ativo : true,
    contaMercadoLivreMercadoEnviosOuterRef: refCanonicalDaConta(integracaoId),
  };

  const nome = conta?.nome;
  if (typeof nome === 'string' && nome.length > 0) campos.nome = nome;
  else faltando.push('nome');

  // Non-throwing on purpose: a legacy conta carrying a malformed ref must degrade to
  // "filial not resolvable" (below), not abort the trigger onto the Eventarc retry.
  const filial = toOuterRefOrNull(conta?.filialIntegracaoPedidoOuterRef);
  if (filial != null) campos.filialIntegracaoFreteOuterRef = filial;
  else faltando.push('filialIntegracaoPedidoOuterRef');

  // Normalize BEFORE diffing: `millisSinceEpoch`'s tolerant preprocess would rewrite
  // an ISO string / µs value to ms on write, so comparing the raw conta value against
  // the stored ms number would report a change on every single invocation.
  const dataCadastro = coerceToMillis(conta?.dataCadastro);
  if (dataCadastro != null) campos.dataCadastro = dataCadastro;
  else faltando.push('dataCadastro');

  return { campos, faltando };
}

/* -------------------------------------------------------------------------- */
/*                                   Lookup                                   */
/* -------------------------------------------------------------------------- */

interface IntFreteEncontrado {
  id: string;
  data: Record<string, unknown>;
}

function melhorPorDataCadastro(
  docs: ReadonlyArray<{ id: string; data(): DocumentData }>,
  filtro?: (raw: Record<string, unknown>) => boolean,
): IntFreteEncontrado | null {
  let melhor: IntFreteEncontrado | null = null;
  let melhorData = -Infinity;
  for (const d of docs) {
    const raw = d.data() as Record<string, unknown>;
    if (filtro && !filtro(raw)) continue;
    const dataCadastro = typeof raw.dataCadastro === 'number' ? raw.dataCadastro : 0;
    if (melhor == null || dataCadastro > melhorData) {
      melhor = { id: d.id, data: raw };
      melhorData = dataCadastro;
    }
  }
  return melhor;
}

/**
 * The account's Mercado Envios `int_frete` doc, newest `dataCadastro` first — the
 * legacy `orderBy__dataCadastro(false).first()` tie-break (`cadastroConta.dart:48-51`).
 *
 * ⚠️ `apenasAtivo` defaults to **false**, and the sync must keep it that way: filtering
 * `ativo == true` here would make re-enabling a deactivated conta find nothing and
 * CREATE A DUPLICATE doc instead of re-activating the existing one. Only the importer
 * (which wants a live config) passes `true` — matching the legacy split, where the
 * writer's lookup had no `ativo` filter and only `tasks.dart` added one.
 *
 * Rides `int_frete(tipo, contaMercadoLivreMercadoEnviosOuterRef, ativo, dataCadastro DESC)`:
 * the equalities are a prefix of that index either way, and neither call orders in the
 * query (the tie-break is client-side over what is normally a single doc). Enterprise
 * auto-creates nothing and silently full-scans an unindexed query, so this matters.
 */
export async function buscarIntFreteDaConta(
  db: Firestore,
  integracaoId: string,
  opts: { apenasAtivo?: boolean; tx?: Transaction } = {},
): Promise<IntFreteEncontrado | null> {
  // Inside a transaction the lookup MUST read through `tx` — a plain `q.get()` is an
  // ordinary read that neither participates in the transaction's conflict detection
  // nor sees its pending writes, which would reintroduce the very read-modify-write
  // gap the transaction exists to close. (Unlike the Firebase JS client SDK, the Admin
  // SDK can read a QUERY inside a transaction — `orderImport.ts:621` does the same.)
  const ler = (query: Query) => (opts.tx != null ? opts.tx.get(query) : query.get());

  let q: Query = intFreteCollection
    .ref(db, {})
    .where('tipo', '==', INTEGRACAO_FRETE.mercadoLivre)
    .where('contaMercadoLivreMercadoEnviosOuterRef', '==', refCanonicalDaConta(integracaoId));
  if (opts.apenasAtivo === true) q = q.where('ativo', '==', true);

  const snap = await ler(q);
  const direto = melhorPorDataCadastro(snap.docs);
  if (direto != null) return direto;

  // Fallback: a doc whose back-ref is stored in a non-canonical form (bare
  // `integracao/<id>`) is invisible to the equality above. Legacy Flutter wrote the
  // canonical form, so this should never hit — but it is exactly what the old
  // client-side scan tolerated, and dropping that tolerance silently would break
  // order import. The sync rewrites the ref to canonical on its next pass.
  let scan: Query = intFreteCollection
    .ref(db, {})
    .where('tipo', '==', INTEGRACAO_FRETE.mercadoLivre);
  if (opts.apenasAtivo === true) scan = scan.where('ativo', '==', true);
  const scanSnap = await ler(scan);
  const tolerante = melhorPorDataCadastro(scanSnap.docs, (raw) =>
    refMatchesIntegracao(raw.contaMercadoLivreMercadoEnviosOuterRef, integracaoId),
  );
  if (tolerante != null) {
    console.warn(
      '[mercado-livre] int_frete encontrado apenas pelo scan tolerante — ' +
        'contaMercadoLivreMercadoEnviosOuterRef não está na forma canônica ' +
        '(rode o backfill para normalizar)',
      { integracaoId, intFreteId: tolerante.id },
    );
  }
  return tolerante;
}

/* -------------------------------------------------------------------------- */
/*                                    Writes                                  */
/* -------------------------------------------------------------------------- */

/**
 * True when the STORED freight doc is strictly newer than the event being applied —
 * somebody wrote it after this event happened, so replaying the event would roll that
 * change back. The caller must then do nothing.
 *
 * Eventarc is at-least-once AND unordered, so this is not hypothetical: a redelivery
 * carries the ORIGINAL `event.time`, and it can land long after a newer conta write has
 * already synced. The other writer of this doc is the `/logistica` editor — a
 * human edit at T2 must survive a stale event from T1.
 *
 * Equal stamps PROCEED: same instant, and the write is idempotent (the field diff
 * below reduces it to a no-op anyway). Only `>` blocks.
 *
 * `coerceToMillis` because `ultimaModificacao` is tolerant on read — a legacy doc may
 * carry an ISO string or µs where the schema now says ms, and comparing those raw
 * against an ms stamp would silently mis-order them.
 */
export function docMaisNovoQueEvento(data: Record<string, unknown>, eventTimeMs: number): boolean {
  const armazenado = coerceToMillis(data.ultimaModificacao);
  return armazenado != null && armazenado > eventTimeMs;
}

/**
 * Upsert this conta's Mercado Envios freight doc. Creates it when absent, otherwise
 * patches ONLY the mirrored fields that actually differ — so a conta write that moved
 * nothing relevant (and an Eventarc replay of an already-applied event) performs no
 * write at all, and `dataCadastro` never churns.
 *
 * Lookup and write share ONE transaction. Without it this is a read-modify-write with
 * a gap, and two conta writes landing together (an Eventarc replay overlapping a fresh
 * event, or two operators on the conta screen) interleave: on the update path the later
 * read loses the earlier patch, and on the create path BOTH invocations see "no doc" and
 * create one — producing exactly the duplicate `int_frete` this issue exists to prevent.
 */
export async function sincronizarIntFreteDaConta(
  db: Firestore,
  integracaoId: string,
  conta: Raw,
  eventTimeMs: number,
): Promise<DisposicaoIntFrete> {
  const { campos, faltando } = montarCamposIntFrete(integracaoId, conta);

  return db.runTransaction(async (tx) => {
    const existente = await buscarIntFreteDaConta(db, integracaoId, { tx });

    if (existente == null) {
      if (faltando.length > 0) {
        // Legacy force-unwrapped the filial here and crashed. Degrade instead: the doc
        // is created by the next conta save, once the missing field is filled in.
        console.warn(
          '[mercado-livre] conta Mercado Livre sem dados suficientes para criar o int_frete',
          { integracaoId, faltando },
        );
        return { action: 'incompleto', faltando };
      }
      const id = intFreteCollection.newDocId(db, {});
      tx.create(
        intFreteCollection.docRef(db, {}, id),
        intFreteCollection.parse({ ...campos, ultimaModificacao: eventTimeMs }) as DocumentData,
      );
      return { action: 'criado', intFreteId: id, campos: Object.keys(campos) };
    }

    if (docMaisNovoQueEvento(existente.data, eventTimeMs)) {
      return { action: 'obsoleto', intFreteId: existente.id };
    }

    const patch: Record<string, unknown> = {};
    for (const [campo, valor] of Object.entries(campos)) {
      if (existente.data[campo] !== valor) patch[campo] = valor;
    }
    if (Object.keys(patch).length === 0) {
      return { action: 'inalterado', intFreteId: existente.id };
    }

    tx.set(
      intFreteCollection.docRef(db, {}, existente.id),
      intFreteCollection.parseMerge({
        ...patch,
        ultimaModificacao: eventTimeMs,
      }) as DocumentData,
      { merge: true },
    );
    return { action: 'atualizado', intFreteId: existente.id, campos: Object.keys(patch) };
  });
}

/**
 * Flip this conta's freight doc inactive — the conta was deleted, or its `tipo` was
 * edited away from Mercado Livre. Deactivate, never delete (see the file docblock);
 * `dataCadastro` is not touched, because deactivating is not re-registering.
 */
export async function desativarIntFreteDaConta(
  db: Firestore,
  integracaoId: string,
  eventTimeMs: number,
): Promise<DisposicaoIntFrete> {
  return db.runTransaction(async (tx) => {
    const existente = await buscarIntFreteDaConta(db, integracaoId, { tx });
    if (existente == null) return { action: 'nao-encontrado' };
    // A freight doc re-activated AFTER this event happened outranks it — deactivating
    // now would undo that newer decision with no event left to redo it.
    if (docMaisNovoQueEvento(existente.data, eventTimeMs)) {
      return { action: 'obsoleto', intFreteId: existente.id };
    }
    if (existente.data.ativo !== true) {
      return { action: 'inalterado', intFreteId: existente.id };
    }
    tx.set(
      intFreteCollection.docRef(db, {}, existente.id),
      intFreteCollection.parseMerge({
        ativo: false,
        ultimaModificacao: eventTimeMs,
      }) as DocumentData,
      { merge: true },
    );
    return { action: 'desativado', intFreteId: existente.id, campos: ['ativo'] };
  });
}

/**
 * True only when `integracao/{id}` is confirmed absent RIGHT NOW.
 *
 * An Eventarc redelivery replays the ORIGINAL CloudEvent — the same stale
 * before/after snapshots, not the current document. Without this guard, a delete
 * event redelivered (or arriving out of order) after the conta was recreated or
 * restored would deactivate a perfectly live freight doc, and nothing would ever
 * re-enable it. Costs one read, and only on the delete of an ML conta.
 */
export async function contaRealmenteExcluida(
  db: Firestore,
  integracaoId: string,
): Promise<boolean> {
  const snap = await integracaoCollection.docRef(db, {}, integracaoId).get();
  return !snap.exists;
}
