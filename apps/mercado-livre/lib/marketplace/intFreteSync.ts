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
import type { DocumentData, Firestore, Query } from 'firebase-admin/firestore';
import { coerceToMillis } from '@delfrance/core/datetime';
import { INTEGRACAO_FRETE, INTEGRACAO_TIPO, outerRefSchema, toOuterRef } from '@delfrance/schemas';
import { intFreteCollection, integracaoCollection } from '@delfrance/data/admin/collections';

import { refMatchesIntegracao } from './linkRefs';

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
  action: 'criado' | 'atualizado' | 'inalterado' | 'desativado' | 'incompleto' | 'nao-encontrado';
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

/**
 * Normalize any accepted ref form to canonical `documents/<col>/<id>` WITHOUT
 * throwing. `toOuterRef` from `@delfrance/schemas` does the same normalization but
 * `.parse()`s, and a malformed ref on a legacy conta must degrade to "field not
 * resolvable" here, not abort the trigger (which would then ride the Eventarc retry
 * forever on a permanently bad doc).
 */
function normalizarOuterRef(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const segs = raw.split('/').filter(Boolean);
  if (segs[0] === 'documents') segs.shift();
  const candidato = `documents/${segs.join('/')}`;
  return outerRefSchema.safeParse(candidato).success ? candidato : null;
}

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

  const filial = normalizarOuterRef(conta?.filialIntegracaoPedidoOuterRef);
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
  opts: { apenasAtivo?: boolean } = {},
): Promise<IntFreteEncontrado | null> {
  let q: Query = intFreteCollection
    .ref(db, {})
    .where('tipo', '==', INTEGRACAO_FRETE.mercadoLivre)
    .where('contaMercadoLivreMercadoEnviosOuterRef', '==', refCanonicalDaConta(integracaoId));
  if (opts.apenasAtivo === true) q = q.where('ativo', '==', true);

  const snap = await q.get();
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
  const scanSnap = await scan.get();
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
 * Upsert this conta's Mercado Envios freight doc. Creates it when absent, otherwise
 * patches ONLY the mirrored fields that actually differ — so a conta write that moved
 * nothing relevant (and an Eventarc replay of an already-applied event) performs no
 * write at all, and `dataCadastro` never churns.
 */
export async function sincronizarIntFreteDaConta(
  db: Firestore,
  integracaoId: string,
  conta: Raw,
  eventTimeMs: number,
): Promise<DisposicaoIntFrete> {
  const { campos, faltando } = montarCamposIntFrete(integracaoId, conta);
  const existente = await buscarIntFreteDaConta(db, integracaoId);

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
    const ref = await intFreteCollection.add(db, {}, { ...campos, ultimaModificacao: eventTimeMs });
    return { action: 'criado', intFreteId: ref.id, campos: Object.keys(campos) };
  }

  const patch: Record<string, unknown> = {};
  for (const [campo, valor] of Object.entries(campos)) {
    if (existente.data[campo] !== valor) patch[campo] = valor;
  }
  if (Object.keys(patch).length === 0) {
    return { action: 'inalterado', intFreteId: existente.id };
  }

  await intFreteCollection.merge(db, {}, existente.id, {
    ...patch,
    ultimaModificacao: eventTimeMs,
  });
  return { action: 'atualizado', intFreteId: existente.id, campos: Object.keys(patch) };
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
  const existente = await buscarIntFreteDaConta(db, integracaoId);
  if (existente == null) return { action: 'nao-encontrado' };
  if (existente.data.ativo !== true) {
    return { action: 'inalterado', intFreteId: existente.id };
  }
  await intFreteCollection.merge(db, {}, existente.id, {
    ativo: false,
    ultimaModificacao: eventTimeMs,
  });
  return { action: 'desativado', intFreteId: existente.id, campos: ['ativo'] };
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
