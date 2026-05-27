/**
 * NF-e orchestrator — Pedido → emit → persist → apply outcome.
 *
 * The single source of truth for the **anti-loss persistence invariant**:
 * an NF-e document is written to Firestore with `estado='enviando'` and
 * its computed `chave` (44 digits) and signed `xml_assinado` **before**
 * the SOAP send. From that moment on, a crash anywhere is recoverable
 * by either the inline `consultarSituacaoNFe` (called on
 * `recover-via-consulta` outcomes) or the `processar-pendentes` cron.
 *
 * All fiscal data comes from typed, Zod-validated inputs — no
 * magic-string fallbacks (`?? '5102'`, `?? '00000000'`, …). Missing
 * required fields throw `NFeOrchestratorError` with a message naming
 * the exact pedido / item / field so the operator can fix the seed
 * data before retrying.
 *
 *   - `serie` + `nNF` come from `nextNumeracao(store, filialId)` —
 *     transactional, mirrors Flutter's NFeConfig.proxima_numeracao.
 *   - `idLote` comes from `nextIdLote(store, filialId)` — independent
 *     counter, same NFeConfig doc.
 *   - Per-item `<imposto>` comes from the library's tribute engine
 *     applied to `pedido.itens[i].imposto` (Zod-validated). Missing
 *     `imposto` is `NFeMissingImpostoError` (no Flutter-side fallback
 *     chain — Phase D port).
 */
import type { Firestore } from 'firebase-admin/firestore';

import {
  aggregateTotals,
  applyOutcome,
  autorizarLote,
  buildImpostoXml,
  buildNFeProc,
  buildPagXml,
  buildTotalXml,
  buildTranspXml,
  classifyCStat,
  consultarLote,
  consultarSituacaoNFe,
  generateNFe,
  impostoSchema,
  isBloqueada,
  NFeConfigNotFoundError,
  outcomeFromInfProt,
  outcomeFromRetConsRec,
  outcomeFromRetConsSit,
  outcomeFromRetEnviNFe,
  resolveTpEmis,
  sanitizeNFeText,
  signNFe,
  type GeneratorInput,
  type GeneratorItem,
  type Imposto,
  type NFeStatePatch,
  type Payment,
  type SefazCall,
  type SefazOutcome,
  type TpEmis,
  type TRetEnviNFe,
} from '@delfrance/integrations-nfe';
import {
  ESTADO_ENVI_NFE_MSG,
  ESTADO_NFE,
  FORMA_PAGAMENTO,
  STATUS_PAGAMENTO,
  freteDoPedidoSchema,
  integracaoSchema,
  nfeConfigSchema,
  pagamentoSchema,
  regraImpostoSchema,
  type Cliente,
  type Endereco,
  type EnviNFeMsg,
  type EstadoNFe,
  type Filial,
  type FreteDoPedido,
  type Integracao,
  type NFeConfig,
  type NotaFiscalEletronica,
  type Operacao,
  type Pagamento,
  type Pedido,
  type RegraImposto,
} from '@delfrance/schemas';
import { z } from 'zod';

import { createFirestoreImpostoResolver } from './imposto-resolver';
import type { NFeRuntime } from './runtime';

export class NFePedidoNotFoundError extends Error {
  constructor(pedidoId: string) {
    super(`Pedido '${pedidoId}' not found.`);
    this.name = 'NFePedidoNotFoundError';
  }
}
export class NFeBlockedError extends Error {
  constructor(pedidoId: string) {
    super(`Pedido '${pedidoId}' has bloquearEmissaoNFe set.`);
    this.name = 'NFeBlockedError';
  }
}
export class NFeOrchestratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NFeOrchestratorError';
  }
}
export class NFeMissingImpostoError extends Error {
  constructor(pedidoId: string, produtoUid: string, itemIndex: number) {
    super(
      `Pedido '${pedidoId}': item ${itemIndex} of produto '${produtoUid}' has no \`imposto\` ` +
        'stamped. Flutter resolves item → product → category → operação rules at ' +
        'pedido-authoring time; that resolver is a Phase D port. For now, every ' +
        'pedido item that will become an NF-e must arrive with `imposto` populated.',
    );
    this.name = 'NFeMissingImpostoError';
  }
}
/** Mirror of Flutter's `nFeSaidaIdFromTpEmis` — one nfev4 slot per (pedido, tpEmis). */
function nfeDocId(tpEmis: TpEmis): string {
  return `s${tpEmis}`;
}

/** Default doc id under `filiais/{filialId}/nfeconfig`. Mirrors the library adapter. */
const DEFAULT_NFE_CONFIG_DOC_ID = 'default';

/** Path to a filial's `enviNfe` audit-log subcollection. */
function enviNfeCollection(fs: Firestore, filialId: string) {
  return fs.collection(`filiais/${filialId}/enviNfe`);
}

/**
 * Build a typed write payload for a SEFAZ `autorizarLote` round-trip
 * — to be persisted as a new doc under the filial's `enviNfe`
 * subcollection. Mirrors Flutter's
 * `EnviNFeMsg.fromRetEnviNFeSchema` at
 * `.old/packages/nfe_client/lib/src/models.dart:333`.
 *
 * The response is JSON-stringified into `xml_retorno` for Phase A —
 * preserves every field we use (nRec, cStat, protocols, errors). If
 * raw SEFAZ XML is ever needed for external audit, that's a library
 * change (return `{ parsed, raw }` from `autorizarLote`).
 */
function buildEnviNFeMsgFromLote(params: {
  chave: string;
  idLote: number;
  tpEmis: TpEmis;
  signedXml: string;
  retEnvi: Awaited<ReturnType<typeof autorizarLote>>;
  /** `'1'` (sync) for 1-NFe lotes; `'0'` (async) for N>1 batches. */
  indSinc: '0' | '1';
}): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    targetsChnfe: [params.chave],
    idLote: params.idLote,
    indSinc: params.indSinc,
    xml_enviado: params.signedXml,
    xml_retorno: JSON.stringify(params.retEnvi),
    nRec: params.retEnvi.infRec?.nRec ?? null,
    cStat: params.retEnvi.cStat,
    xMotivo: params.retEnvi.xMotivo,
    error: null,
    tpEmis: params.tpEmis,
    estado: ESTADO_ENVI_NFE_MSG.respondido,
    timestamp: now,
    ultima_modificacao: now,
  };
}

/**
 * Build a typed write payload for a `consReciNFe` (preferred — has
 * the lote receipt) or `consSitNFe` (fallback — by chave) round-trip.
 * The `nRec` is carried forward from the originating lote message so
 * a single chave's audit chain stays linkable.
 */
function buildEnviNFeMsgFromConsulta(params: {
  chave: string;
  nRec: string | null;
  ret:
    | Awaited<ReturnType<typeof consultarLote>>
    | Awaited<ReturnType<typeof consultarSituacaoNFe>>;
  tpEmis: TpEmis;
}): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    targetsChnfe: [params.chave],
    idLote: null,
    indSinc: null,
    xml_enviado: null,
    xml_retorno: JSON.stringify(params.ret),
    nRec: params.nRec,
    cStat: params.ret.cStat,
    xMotivo: params.ret.xMotivo,
    error: null,
    tpEmis: params.tpEmis,
    estado: ESTADO_ENVI_NFE_MSG.concluido,
    timestamp: now,
    ultima_modificacao: now,
  };
}

/**
 * Project a `consultarLote` response onto a `SefazOutcome` for our
 * specific chave. The lote-level cStat is `104` (processado) — the
 * authoritative per-NFe status lives in `protNFe[i].infProt.cStat`.
 * When no matching protocol is in the response (lote still in
 * processing — cStat=105) fall back to the lote-level outcome so
 * `applyOutcome` polls again.
 */
function outcomeFromConsReci(
  ret: Awaited<ReturnType<typeof consultarLote>>,
  chave: string,
): SefazOutcome {
  const ourProt = ret.protNFe?.find((p) => p.infProt.chNFe === chave);
  if (ourProt) return outcomeFromInfProt(ourProt.infProt);
  return outcomeFromRetConsRec(ret);
}

/**
 * Look up the latest `EnviNFeMsg` whose `targetsChnfe` includes `chave`
 * AND that carries a non-null `nRec` — the receipt we need to call
 * `consultarLote`. Returns null when no recoverable msg exists (e.g.
 * the pedido was never sent, or only `consSit` messages were persisted
 * for an externally-recovered chave).
 */
async function findLatestEnviNFeMsgWithNRec(
  fs: Firestore,
  filialId: string,
  chave: string,
): Promise<EnviNFeMsg | null> {
  const snap = await enviNfeCollection(fs, filialId)
    .where('targetsChnfe', 'array-contains', chave)
    .orderBy('timestamp', 'desc')
    .limit(10)
    .get();
  for (const doc of snap.docs) {
    const data = doc.data() as EnviNFeMsg;
    if (data.nRec) return data;
  }
  return null;
}

/**
 * Project a persisted `NotaFiscalEletronica` onto the route's `EmitResult`
 * shape — used by the dedup branch when an existing bloqueada nfe makes
 * a re-emission unnecessary.
 */
function existingToEmitResult(
  pedidoId: string,
  nfeId: string,
  nota: NotaFiscalEletronica,
): EmitResult {
  return {
    nfeId,
    pedidoId,
    estado: nota.estado,
    chave: nota.chave ?? '',
    nRec: nota.nRec ?? null,
    cStat: nota.cStat ?? '',
    xMotivo: nota.xMotivo ?? '',
    reused: true,
  };
}

/** Output of a single emit cycle — the route returns this shape verbatim. */
export interface EmitResult {
  readonly nfeId: string;
  readonly pedidoId: string;
  readonly estado: EstadoNFe;
  readonly chave: string;
  readonly nRec: string | null;
  readonly cStat: string;
  readonly xMotivo: string;
  /**
   * `true` when the dedup branch short-circuited because an existing
   * nfev4 doc was already in a `STATUS_BLOQUEADORES` cStat — no fresh
   * SEFAZ call was made. `false` for every other path (fresh emission
   * or rejeitada-retry that did re-call SEFAZ).
   */
  readonly reused: boolean;
}

interface PedidoBundle {
  readonly pedidoId: string;
  readonly pedido: Pedido & { readonly bloquearEmissaoNFe?: unknown };
  readonly filialId: string;
  readonly filial: Filial;
  readonly clienteId: string;
  readonly cliente: Cliente;
  readonly enderecoDest: Endereco;
  readonly operacaoId: string;
  readonly operacao: Operacao;
  /**
   * Pagamentos under `pedidos/{pedidoId}/pagamento` (subcollection,
   * singular path — mirrors the Flutter ERP). Already filtered to
   * `status_pagamento ∈ { null, aprovado }` — matches Flutter's
   * `pedido_nfe_base.dart:449` predicate. May be empty (the NF-e
   * stamps `tPag='90'` sem-pagamento in that case).
   */
  readonly pagamentos: readonly Pagamento[];
  /**
   * Parsed `pedido.freteInicial` when present + valid; null otherwise.
   * The orchestrator projects this into `<transp>`, `<total>.vFrete`,
   * `<det[0].prod.vFrete>`, and the `<pag>` frete-emitente single-payment
   * override. Treat null as "no shipping declared on this pedido"
   * (modFrete='9' on the wire).
   */
  readonly frete: FreteDoPedido | null;
  /**
   * Marketplace intermediator doc, loaded only when
   * `operacao.indIntermed === '1'` AND `pedido.integracaoPedidoOuterRef`
   * is present. Used to populate `<infIntermed>` per SEFAZ NT 2020.006.
   * Null when the operação is non-marketplace or the integração doc
   * couldn't be resolved.
   */
  readonly integracao: Integracao | null;
  /**
   * Imposto rules under `operacao/{operacaoId}/regraimposto`. Pre-loaded
   * in the bundle fan-out so the per-item resolver (`resolveItemImposto`)
   * can OR-match against produtoUid / categoriaUid / NCM without any
   * additional Firestore reads. May be empty (common in setups where
   * every produto carries its own `impostoProduto` doc).
   */
  readonly regrasImposto: readonly RegraImposto[];
}

/** Per-item fiscal data after merging Pedido item + stamped Imposto. */
interface FiscalItem {
  readonly produtoUid: string;
  readonly itemIndex: number;
  readonly sku: string | null;
  readonly gtin: string | null;
  readonly nomeDeVenda: string | null;
  readonly precoDeVenda: number;
  readonly descontoUnitario: number | null;
  readonly quantidade: number;
  readonly imposto: Imposto;
  readonly vProd: number;
}

/**
 * Resolve the full Pedido bundle from Firestore. Pedido's outer refs
 * (`filialPedidoOuterRef`, `clientePedidoOuterRef`, …) are `z.unknown()`
 * in the schema today — we interpret them as Firestore document paths
 * stamped by the Flutter app.
 */
export async function loadPedidoBundle(
  fs: Firestore,
  pedidoId: string,
): Promise<PedidoBundle> {
  console.debug(`[nfe/orchestrator] Loading Pedido bundle for pedidoId '${pedidoId}'`);
  const pedidoSnap = await fs.collection('pedidos').doc(pedidoId).get();
  if (!pedidoSnap.exists) throw new NFePedidoNotFoundError(pedidoId);
  const pedido = pedidoSnap.data() as PedidoBundle['pedido'];

  const filialPath = refToPath(getField(pedido, 'filialPedidoOuterRef'));
  console.debug(`[nfe/orchestrator] Resolved filialPath '${filialPath}' for pedidoId '${pedidoId}'`);
  const clientePath = refToPath(getField(pedido, 'clientePedidoOuterRef'));
  console.debug(`[nfe/orchestrator] Resolved clientePath '${clientePath}' for pedidoId '${pedidoId}'`);
  const operacaoPath = refToPath(getField(pedido, 'operacaoPedidoOuterRef'));
  console.debug(`[nfe/orchestrator] Resolved operacaoPath '${operacaoPath}' for pedidoId '${pedidoId}'`);
  const enderecoPath = refToPath(getField(pedido, 'enderecoFiscalOuterRef'));
  console.debug(`[nfe/orchestrator] Resolved enderecoPath '${enderecoPath}' for pedidoId '${pedidoId}'`);

  if (!filialPath) throw new NFeOrchestratorError(`pedido '${pedidoId}': filialPedidoOuterRef missing`);
  if (!clientePath) throw new NFeOrchestratorError(`pedido '${pedidoId}': clientePedidoOuterRef missing`);
  if (!operacaoPath) throw new NFeOrchestratorError(`pedido '${pedidoId}': operacaoPedidoOuterRef missing`);
  if (!enderecoPath) throw new NFeOrchestratorError(`pedido '${pedidoId}': enderecoFiscalOuterRef missing`);

  const [filialSnap, clienteSnap, operacaoSnap, enderecoSnap, pagamentoSnap, regraImpostoSnap] =
    await Promise.all([
      fs.doc(filialPath).get(),
      fs.doc(clientePath).get(),
      fs.doc(operacaoPath).get(),
      fs.doc(enderecoPath).get(),
      fs.collection('pedidos').doc(pedidoId).collection('pagamento').get(),
      fs.doc(operacaoPath).collection('regraimposto').get(),
    ]);

  if (!filialSnap.exists) throw new NFeOrchestratorError(`filial '${filialPath}' not found`);
  if (!clienteSnap.exists) throw new NFeOrchestratorError(`cliente '${clientePath}' not found`);
  if (!operacaoSnap.exists) throw new NFeOrchestratorError(`operacao '${operacaoPath}' not found`);
  if (!enderecoSnap.exists) throw new NFeOrchestratorError(`endereco '${enderecoPath}' not found`);

  const pagamentos = loadPagamentosFromSnapshot(pedidoId, pagamentoSnap);
  console.debug(
    `[nfe/orchestrator] pedido '${pedidoId}': loaded ${pagamentos.length} pagamento(s) ` +
      `(of ${pagamentoSnap.size} in subcollection)`,
  );

  const operacao = operacaoSnap.data() as Operacao;
  const frete = parseFreteFromPedido(pedidoId, pedido);
  const integracao = await maybeLoadIntegracao(fs, pedidoId, pedido, operacao);
  const regrasImposto = parseRegraImpostoSnapshot(pedidoId, regraImpostoSnap);

  return {
    pedidoId,
    pedido,
    filialId: filialSnap.id,
    filial: filialSnap.data() as Filial,
    clienteId: clienteSnap.id,
    cliente: clienteSnap.data() as Cliente,
    enderecoDest: enderecoSnap.data() as Endereco,
    operacaoId: operacaoSnap.id,
    operacao,
    pagamentos,
    frete,
    integracao,
    regrasImposto,
  };
}

/**
 * Parse the `regraimposto` subcollection snapshot, dropping (with a
 * warning) any doc that fails `regraImpostoSchema` validation. The
 * resolver tolerates an empty array — the cascade will fall through to
 * the per-item `pedido.itens[i].imposto` (or fail loudly when nothing
 * stamps the item).
 */
function parseRegraImpostoSnapshot(
  pedidoId: string,
  snap: FirebaseFirestore.QuerySnapshot,
): readonly RegraImposto[] {
  const out: RegraImposto[] = [];
  for (const doc of snap.docs) {
    const parsed = regraImpostoSchema.safeParse({ id: doc.id, ...doc.data() });
    if (parsed.success) {
      out.push(parsed.data);
    } else {
      console.warn(
        `[nfe/orchestrator] pedido '${pedidoId}': skipping invalid regraImposto '${doc.id}' — ${parsed.error.issues[0]?.message ?? 'parse failed'}`,
      );
    }
  }
  console.debug(
    `[nfe/orchestrator] pedido '${pedidoId}': loaded ${out.length} regraImposto(s) ` +
      `(of ${snap.size} in subcollection)`,
  );
  return out;
}

/**
 * Parse `pedido.freteInicial` via `freteDoPedidoSchema`. The Pedido
 * schema declares it as a pass-through so we have to narrow + parse
 * here; on parse failure we warn and treat as null (emission falls
 * back to modFrete='9'). Mirrors Flutter's defensive read at
 * `pedido_nfe_base.dart:450`.
 */
function parseFreteFromPedido(
  pedidoId: string,
  pedido: PedidoBundle['pedido'],
): FreteDoPedido | null {
  const rawFrete = (pedido as { freteInicial?: unknown }).freteInicial;
  if (rawFrete == null) return null;
  const parsed = freteDoPedidoSchema.safeParse(rawFrete);
  if (!parsed.success) {
    console.warn(
      `[nfe/orchestrator] pedido '${pedidoId}': pedido.freteInicial failed ` +
        `freteDoPedidoSchema parse — treating as absent. issues: ` +
        `${JSON.stringify(parsed.error.issues)}`,
    );
    return null;
  }
  return parsed.data;
}

/**
 * Load the Integracao doc the pedido points at, BUT only when the
 * operação flags `indIntermed='1'`. Skipping the read for the common
 * non-marketplace case keeps `loadPedidoBundle` cheap.
 */
async function maybeLoadIntegracao(
  fs: Firestore,
  pedidoId: string,
  pedido: PedidoBundle['pedido'],
  operacao: Operacao,
): Promise<Integracao | null> {
  if (operacao.indIntermed !== '1') return null;
  const integracaoPath = refToPath(
    getField(pedido, 'integracaoPedidoOuterRef'),
  );
  if (!integracaoPath) {
    console.warn(
      `[nfe/orchestrator] pedido '${pedidoId}': operacao.indIntermed='1' ` +
        `but pedido.integracaoPedidoOuterRef is missing — SEFAZ will reject ` +
        `with cStat related to missing <infIntermed>`,
    );
    return null;
  }
  const snap = await fs.doc(integracaoPath).get();
  if (!snap.exists) {
    console.warn(
      `[nfe/orchestrator] pedido '${pedidoId}': integracao '${integracaoPath}' not found`,
    );
    return null;
  }
  const parsed = integracaoSchema.safeParse(snap.data());
  if (!parsed.success) {
    console.warn(
      `[nfe/orchestrator] pedido '${pedidoId}': integracao '${integracaoPath}' failed parse — ` +
        `${JSON.stringify(parsed.error.issues)}`,
    );
    return null;
  }
  return parsed.data;
}

/**
 * Parse + filter raw pagamento docs from the `pedidos/{id}/pagamento`
 * subcollection. Mirrors Flutter's `pedido_nfe_base.dart:449`:
 * keep pagamentos with `status_pagamento` null OR `aprovado`. Docs
 * that fail schema parse are skipped with a warn — a single malformed
 * doc must not block emission.
 */
function loadPagamentosFromSnapshot(
  pedidoId: string,
  snap: FirebaseFirestore.QuerySnapshot,
): Pagamento[] {
  const out: Pagamento[] = [];
  for (const doc of snap.docs) {
    const parsed = pagamentoSchema.safeParse(doc.data());
    if (!parsed.success) {
      console.warn(
        `[nfe/orchestrator] pedido '${pedidoId}': pagamento '${doc.id}' failed ` +
          `pagamentoSchema parse — skipping. issues: ${JSON.stringify(parsed.error.issues)}`,
      );
      continue;
    }
    const p = parsed.data;
    if (
      p.status_pagamento === null ||
      p.status_pagamento === STATUS_PAGAMENTO.aprovado
    ) {
      out.push(p);
    }
  }
  return out;
}

function getField(obj: unknown, key: string): unknown {
  return obj && typeof obj === 'object' && key in obj
    ? (obj as Record<string, unknown>)[key]
    : undefined;
}

function refToPath(ref: unknown): string | null {
  if (!ref) return null;
  if (typeof ref === 'string') return ref;
  if (typeof ref === 'object' && 'path' in ref) {
    const p = (ref as { path?: unknown }).path;
    return typeof p === 'string' ? p : null;
  }
  return null;
}

/**
 * For every pedido item whose `imposto` is missing, run the resolver
 * cascade (item → impostoProduto → impostoCategoria → regraImposto)
 * and stamp the resolved Imposto back onto the item. Items whose
 * imposto can't be resolved are left untouched — flattenAndValidate
 * will throw `NFeMissingImpostoError` with the precise location.
 *
 * Items already carrying a valid imposto skip the resolver entirely
 * (no Firestore reads for those) — preserves Phase A retail fixtures
 * that pre-stamp imposto at order time.
 */
async function preResolveImpostos(
  bundle: PedidoBundle,
  fs: Firestore,
): Promise<void> {
  const itens = (bundle.pedido as { itens?: Record<string, unknown[]> }).itens ?? {};
  const missing: Array<{ produtoUid: string; entry: Record<string, unknown> }> = [];
  for (const [produtoUid, list] of Object.entries(itens)) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (entry == null || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      if (e.imposto == null) missing.push({ produtoUid, entry: e });
    }
  }
  if (missing.length === 0) return;

  console.debug(
    `[nfe/orchestrator] pedido '${bundle.pedidoId}': ${missing.length} item(s) ` +
      'missing imposto — running resolver cascade',
  );
  const resolver = createFirestoreImpostoResolver(fs, {
    operacaoId: bundle.operacaoId,
    regrasImposto: bundle.regrasImposto,
  });
  for (const { produtoUid, entry } of missing) {
    const resolved = await resolver.resolve(produtoUid, null);
    if (resolved != null) entry.imposto = resolved;
  }
}

/**
 * Flatten + validate `pedido.itens` into per-item fiscal data.
 *
 * **Magic-string-free**: every field that isn't already a SEFAZ literal
 * (`'SEM GTIN'`) must come from real data. Missing fields throw
 * `NFeMissingImpostoError` (for the imposto blob) or
 * `NFeOrchestratorError` (for everything else), each naming the
 * exact pedido / produto / item so the operator can fix the seed.
 */
function flattenAndValidate(bundle: PedidoBundle): FiscalItem[] {
  const itens = (bundle.pedido as { itens?: Record<string, unknown[]> }).itens ?? {};
  const out: FiscalItem[] = [];
  for (const [produtoUid, list] of Object.entries(itens)) {
    if (!Array.isArray(list)) continue;
    list.forEach((rawEntry, itemIndex) => {
      const e = (rawEntry ?? {}) as Record<string, unknown>;
      const sku = typeof e.sku === 'string' ? e.sku : null;
      const gtin = typeof e.gtin === 'string' ? e.gtin : null;
      const nomeDeVenda = typeof e.nomeDeVenda === 'string' ? e.nomeDeVenda : null;
      const precoDeVenda = Number(e.precoDeVenda ?? 0);
      const descontoUnitario = e.descontoUnitario == null ? null : Number(e.descontoUnitario);
      const quantidade = Number(e.quantidade ?? 0);

      const where = `pedido '${bundle.pedidoId}' item ${itemIndex} (produto '${produtoUid}')`;
      if (e.imposto == null) {
        throw new NFeMissingImpostoError(bundle.pedidoId, produtoUid, itemIndex);
      }
      const impostoParse = impostoSchema.safeParse(e.imposto);
      if (!impostoParse.success) {
        const first = impostoParse.error.issues[0];
        throw new NFeOrchestratorError(
          `${where}: invalid \`imposto\` — ${first?.path.join('.') ?? '(root)'} ${first?.message ?? 'parse failed'}`,
        );
      }
      const imposto = impostoParse.data;

      if (!sku && !gtin) {
        throw new NFeOrchestratorError(`${where}: needs either \`sku\` or \`gtin\` for cProd`);
      }
      if (!nomeDeVenda) {
        throw new NFeOrchestratorError(`${where}: \`nomeDeVenda\` is required for xProd`);
      }
      if (!Number.isFinite(precoDeVenda) || precoDeVenda < 0) {
        throw new NFeOrchestratorError(`${where}: \`precoDeVenda\` must be a non-negative number`);
      }
      if (!Number.isFinite(quantidade) || quantidade <= 0) {
        throw new NFeOrchestratorError(`${where}: \`quantidade\` must be a positive number`);
      }
      out.push({
        produtoUid,
        itemIndex,
        sku,
        gtin,
        nomeDeVenda,
        precoDeVenda,
        descontoUnitario,
        quantidade,
        imposto,
        vProd: round2((precoDeVenda - (descontoUnitario ?? 0)) * quantidade),
      });
    });
  }
  if (out.length === 0) {
    throw new NFeOrchestratorError(`pedido '${bundle.pedidoId}' has no items`);
  }
  return out;
}

/**
 * Project the validated fiscal items + filial + cliente + operação +
 * counters into the typed `GeneratorInput`.
 *
 * **Fiscal-code resolution (CFOP / NCM / unidade / CEST).** Per the
 * Flutter resolver chain: the **item's** stamped imposto wins; when
 * a field is missing on the item we fall back to the operação's
 * matching field. Only when BOTH are missing do we throw. This
 * matches marketplace reality — many orders carry an operação-default
 * CFOP/NCM and only stamp item-level overrides for the products that
 * need them.
 */
export function buildGeneratorInput(
  bundle: PedidoBundle,
  items: ReadonlyArray<FiscalItem>,
  numeracao: number,
  serie: number,
  ambiente: NFeRuntime['ambiente'],
  tpEmis: GeneratorInput['tpEmis'] = 1,
): GeneratorInput {
  const isInterstate = bundle.enderecoDest.estado !== bundle.filial.sede.estado;
  const genItems = buildGenItems(items, bundle, isInterstate);

  // Compute frete value upfront so it can ride into both the totals
  // aggregator (NF-e level) and onto det[0].prod.vFrete (item level)
  // when the issuer contracts the carrier (modalidade='0').
  const freteEmitente =
    bundle.frete?.modalidade === '0' && (bundle.frete.valorCobrado ?? 0) > 0;
  const vFrete = freteEmitente ? (bundle.frete!.valorCobrado as number) : 0;
  if (vFrete > 0 && genItems.length > 0) {
    // Mirror of Flutter `pedido_nfe_base.dart:932`: stamp the full frete
    // value onto the first <det>'s <prod>. Phase D could split this
    // proportionally across items; Flutter doesn't.
    const first = genItems[0]!;
    genItems[0] = { ...first, vFrete };
  }

  const totals = aggregateTotals(
    items.map((it) => ({ item: { vProd: it.vProd }, imposto: it.imposto })),
    { vFrete },
  );
  const payments = buildPaymentsFromPagamentos(bundle.pagamentos, {
    vNF: totals.vNF,
    frete: bundle.frete,
  });

  const transpOpts = buildTranspFromFrete(bundle.frete);
  const cobr = buildCobrFromPagamentos(bundle.pagamentos);
  const infAdic = buildInfAdic(bundle.pedido, bundle.operacao);
  const exporta = buildExporta(bundle.operacao, bundle.filial);
  const infIntermed = buildInfIntermed(bundle.integracao, bundle.operacao);

  return {
    ambiente,
    numeracao,
    serie,
    tpEmis,
    dhEmi: new Date(),
    filial: bundle.filial,
    operacao: bundle.operacao,
    cliente: bundle.cliente,
    enderecoDest: bundle.enderecoDest,
    itens: genItems,
    totalXml: buildTotalXml(totals),
    transpXml: buildTranspXml(transpOpts),
    pagXml: buildPagXml(payments),
    ...(cobr ? { cobr } : {}),
    ...(infAdic ? { infAdic } : {}),
    ...(exporta ? { exporta } : {}),
    ...(infIntermed ? { infIntermed } : {}),
  };
}

/**
 * Project validated `FiscalItem`s into the typed `GeneratorItem[]` the
 * NF-e generator consumes. Resolves CFOP / NCM / unidade / CEST with the
 * item-imposto winning over the operação fallback; throws when both are
 * missing.
 *
 * Stops short of the Flutter resolver chain
 * (item → product → categoria → operação) at
 * `.old/packages/pedido_nfe/lib/src/pedido_nfe_base.dart:746` — that's a
 * Phase D port. Today every pedido item must arrive with `imposto`
 * already stamped (see `flattenAndValidate`).
 */
function buildGenItems(
  items: ReadonlyArray<FiscalItem>,
  bundle: PedidoBundle,
  isInterstate: boolean,
): GeneratorItem[] {
  const cfopField = isInterstate ? 'cfopInterestadual' : 'cfop';
  return items.map((it, i) => {
    const where = `pedido '${bundle.pedidoId}' item ${it.itemIndex} (produto '${it.produtoUid}')`;
    const cfop = it.imposto[cfopField] ?? bundle.operacao[cfopField];
    if (!cfop) {
      throw new NFeOrchestratorError(
        `${where}: no ${cfopField} — neither imposto.${cfopField} nor operacao.${cfopField} is set`,
      );
    }
    const NCM = it.imposto.NCM ?? bundle.operacao.NCM;
    if (!NCM) {
      throw new NFeOrchestratorError(
        `${where}: no NCM — neither imposto.NCM nor operacao.NCM is set`,
      );
    }
    const unidade = it.imposto.unidade ?? bundle.operacao.unidade;
    if (!unidade) {
      throw new NFeOrchestratorError(
        `${where}: no unidade — neither imposto.unidade nor operacao.unidade is set`,
      );
    }
    // CEST is optional — required only when the product is in the CEST
    // list. Item wins, operação as fallback, omit when neither set.
    const CEST = it.imposto.CEST ?? bundle.operacao.CEST;

    const cProd = it.sku ?? it.gtin!; // guarded in flattenAndValidate
    const cEAN = it.gtin && /^\d{8,14}$/.test(it.gtin) ? it.gtin : 'SEM GTIN';
    return {
      nItem: i + 1,
      cProd,
      cEAN,
      xProd: it.nomeDeVenda!, // guarded in flattenAndValidate
      NCM,
      ...(CEST ? { CEST } : {}),
      CFOP: cfop,
      uCom: unidade,
      qCom: it.quantidade,
      vUnCom: it.precoDeVenda,
      vProd: it.vProd,
      cEANTrib: cEAN,
      uTrib: unidade,
      qTrib: it.quantidade,
      vUnTrib: it.precoDeVenda,
      indTot: '1',
      impostoXml: buildImpostoXml(it.imposto, { vProd: it.vProd }),
    };
  });
}

/**
 * Project filtered Pagamentos into typed `Payment` entries — mirrors
 * Flutter's `pedido_nfe_base.dart:1766` (`get pag`) field-for-field:
 *
 *   - empty list → single `tPag='90'` (sem pagamento), `vPag=0` (Flutter's
 *     `1768–1776` default — SEFAZ-safe, no `<xPag>` needed).
 *   - per Pagamento: `tPag` = `forma_de_pagamento` padded to 2 digits;
 *     `vPag` = `valor + juros` (or 0 when `forma=90`); `indPag` from
 *     `aVista` (0=à vista, 1=a prazo).
 *   - `xPag` is stamped ONLY when `forma=99` (outros) — the absence of it
 *     on `tPag='99'` is exactly what triggers SEFAZ cStat=441. Falls back
 *     to `'Outro'` when `descricaoPagamento` is blank (Flutter line 1801).
 *   - `card` is stamped ONLY when `cartao != null` AND `forma != 99` —
 *     mirror of `pedido_nfe_base.dart:1812`. NB: SEFAZ NT 2022.001
 *     REQUIRES the `<card>` block on every card-like tPag (03 crédito,
 *     04 débito, **17 PIX**), so card-like Pagamentos must arrive with
 *     `cartao` already populated by the payment-gateway integration —
 *     otherwise SEFAZ rejects with cStat=391. We do not auto-stamp a
 *     placeholder here on purpose: silent defaults make fiscal bugs
 *     invisible.
 *   - **frete-emitente single-payment override**: when the issuer
 *     contracts the carrier (`frete.modalidade='0'`), frete has a
 *     non-zero `valorCobrado`, AND there's exactly one pagamento
 *     (whose forma isn't 90 — sem pagamento), Flutter overrides the
 *     payment's `vPag` to `vNF` so the wire reflects "the customer
 *     pays this amount, which includes the freight cost". Mirror of
 *     `pedido_nfe_base.dart:1790-1821`.
 */
function buildPaymentsFromPagamentos(
  pagamentos: ReadonlyArray<Pagamento>,
  ctx: { vNF: number; frete: FreteDoPedido | null } = { vNF: 0, frete: null },
): Payment[] {
  if (pagamentos.length === 0) {
    return [{ tPag: '90', vPag: 0 }];
  }
  const freteEmitenteOverride =
    pagamentos.length === 1 &&
    ctx.frete?.modalidade === '0' &&
    (ctx.frete.valorCobrado ?? 0) > 0;

  return pagamentos.map((p): Payment => {
    const isOutros = p.forma_de_pagamento === FORMA_PAGAMENTO.outros;
    const isSemPag = p.forma_de_pagamento === FORMA_PAGAMENTO.sem_pagamento;
    const tPag = String(p.forma_de_pagamento).padStart(2, '0') as Payment['tPag'];
    let vPag: number;
    if (isSemPag) {
      vPag = 0;
    } else if (freteEmitenteOverride) {
      vPag = ctx.vNF;
    } else {
      vPag = p.valor + (p.juros ?? 0);
    }
    const indPag: NonNullable<Payment['indPag']> = p.aVista ? '0' : '1';

    let xPag: string | undefined;
    if (isOutros) {
      const desc = (p.descricaoPagamento ?? '').trim();
      const cleaned = sanitizeNFeText(desc.length > 0 ? desc : 'Outro', 60);
      xPag = cleaned ?? 'Outro';
    }

    const card =
      p.cartao != null && !isOutros ? buildCardFromCartao(p.cartao) : undefined;

    return {
      tPag,
      vPag,
      indPag,
      ...(xPag ? { xPag } : {}),
      ...(card ? { card } : {}),
    };
  });
}

/**
 * Project the pass-through `Pagamento.cartao` blob into the typed
 * `Payment.card`. The schema declares `cartao` as `z.unknown()` (Flutter's
 * Cartao model is wider than SEFAZ needs), so we narrow defensively and
 * skip the whole block when `tpIntegra` is missing — emitting a `<card>`
 * without `tpIntegra` would be invalid against the XSD and trigger
 * cStat=391.
 *
 * Flutter source: `.old/packages/pedido/lib/src/models.dart` Cartao
 * (used at `pedido_nfe_base.dart:1812–1820`).
 */
function buildCardFromCartao(cartao: unknown): NonNullable<Payment['card']> | undefined {
  if (cartao == null || typeof cartao !== 'object') return undefined;
  const c = cartao as Record<string, unknown>;
  const tpIntegraRaw = c.tpIntegra;
  const tpIntegraStr =
    typeof tpIntegraRaw === 'number' ? String(tpIntegraRaw) : tpIntegraRaw;
  if (tpIntegraStr !== '1' && tpIntegraStr !== '2') return undefined;
  const card: NonNullable<Payment['card']> = { tpIntegra: tpIntegraStr };
  if (typeof c.cnpj_instituicao === 'string') card.CNPJ = c.cnpj_instituicao;
  if (typeof c.bandeira === 'string') card.tBand = c.bandeira;
  else if (typeof c.bandeira === 'number') card.tBand = String(c.bandeira);
  if (typeof c.cAut === 'string') card.cAut = c.cAut;
  return card;
}

/**
 * Project `pedido.freteInicial` into the typed `<transp>` input.
 * Mirrors Flutter `pedido_nfe_base.dart:1504-1702`:
 *   - null frete OR modalidade='9' → just modFrete='9'.
 *   - Otherwise route on modalidade and forward transporta / veicTransp /
 *     reboque / vol / vagao / balsa as available.
 *
 * Free-text fields go through `sanitizeNFeText` (maxLen per XSD): xNome /
 * xEnder / xMun ≤60, vol[i].esp / marca / nVol ≤60. We don't gate on a
 * specific modalidade beyond '9' — every other code carries the same
 * optional sub-blocks at the XSD level; emit what we have.
 */
function buildTranspFromFrete(frete: FreteDoPedido | null): {
  modFrete: '0' | '1' | '2' | '3' | '4' | '9';
  transporta?: NonNullable<Parameters<typeof buildTranspXml>[0]>['transporta'];
  veicTransp?: NonNullable<Parameters<typeof buildTranspXml>[0]>['veicTransp'];
  reboque?: NonNullable<Parameters<typeof buildTranspXml>[0]>['reboque'];
  vol?: NonNullable<Parameters<typeof buildTranspXml>[0]>['vol'];
  vagao?: string;
  balsa?: string;
} {
  if (frete == null || frete.modalidade === '9') {
    return { modFrete: '9' };
  }
  const out: ReturnType<typeof buildTranspFromFrete> = { modFrete: frete.modalidade };

  if (frete.transportadora) {
    const t = frete.transportadora;
    const transporta: NonNullable<typeof out.transporta> = {};
    if (typeof t.CNPJ === 'string' && t.CNPJ) transporta.CNPJ = t.CNPJ;
    else if (typeof t.CPF === 'string' && t.CPF) transporta.CPF = t.CPF;
    const xNome = sanitizeNFeText(t.xNome, 60);
    if (xNome) transporta.xNome = xNome;
    if (typeof t.IE === 'string' && t.IE) transporta.IE = t.IE;
    const xEnder = sanitizeNFeText(t.xEnder, 60);
    if (xEnder) transporta.xEnder = xEnder;
    const xMun = sanitizeNFeText(t.xMun, 60);
    if (xMun) transporta.xMun = xMun;
    if (typeof t.UF === 'string' && t.UF) {
      transporta.UF = t.UF as NonNullable<typeof transporta.UF>;
    }
    if (Object.keys(transporta).length > 0) out.transporta = transporta;
  }

  if (frete.veiculo?.placa) {
    out.veicTransp = {
      placa: frete.veiculo.placa,
      ...(frete.veiculo.UF
        ? { UF: frete.veiculo.UF as NonNullable<typeof out.veicTransp>['UF'] }
        : {}),
      ...(frete.veiculo.RNTC ? { RNTC: frete.veiculo.RNTC } : {}),
    };
  }

  if (frete.reboques && frete.reboques.length > 0) {
    const reboques = frete.reboques
      .filter((r) => typeof r.placa === 'string' && r.placa)
      .map((r) => ({
        placa: r.placa as string,
        ...(r.UF
          ? { UF: r.UF as NonNullable<typeof out.veicTransp>['UF'] }
          : {}),
        ...(r.RNTC ? { RNTC: r.RNTC } : {}),
      }));
    if (reboques.length > 0) out.reboque = reboques;
  }

  if (frete.vagao) out.vagao = frete.vagao;
  if (frete.balsa) out.balsa = frete.balsa;

  if (frete.volumes && frete.volumes.length > 0) {
    const vols = frete.volumes.map((v) => {
      const vol: NonNullable<typeof out.vol>[number] = {};
      if (typeof v.qVol === 'number' && Number.isInteger(v.qVol) && v.qVol >= 0) {
        vol.qVol = v.qVol;
      }
      const esp = sanitizeNFeText(v.esp, 60);
      if (esp) vol.esp = esp;
      const marca = sanitizeNFeText(v.marca, 60);
      if (marca) vol.marca = marca;
      const nVol = sanitizeNFeText(v.nVol, 60);
      if (nVol) vol.nVol = nVol;
      if (typeof v.pesoL === 'number' && v.pesoL >= 0) vol.pesoL = v.pesoL;
      if (typeof v.pesoB === 'number' && v.pesoB >= 0) vol.pesoB = v.pesoB;
      return vol;
    });
    out.vol = vols;
  }

  return out;
}

/**
 * Project the duplicata-style pagamentos into a `<cobr>` block.
 * Mirror of Flutter `pedido_nfe_base.dart:487-521`:
 *   - Filter pagamentos where `duplicata === true`.
 *   - Empty → return undefined (orchestrator omits `<cobr>`).
 *   - Otherwise: fat = { vOrig, vLiq } summing all duplicata vPag;
 *     dup[] one per duplicata with vDup + optional nDup + dVenc.
 *
 * SEFAZ cross-validates `fat.vLiq + Σ dup.vDup === Σ pag.vPag` on the
 * NF-e (catalog rule). We don't try to be clever — if math drifts we
 * surface a clear NFeOrchestratorError so the operator sees it before
 * SEFAZ does. Phase A doesn't apply `vDesc` at the fatura level.
 */
function buildCobrFromPagamentos(
  pagamentos: ReadonlyArray<Pagamento>,
): { fat?: { nFat?: string; vOrig?: string; vDesc?: string; vLiq?: string }; dup?: ReadonlyArray<{ nDup?: string; dVenc?: string; vDup: string }> } | undefined {
  const dups = pagamentos.filter((p) => p.duplicata === true);
  if (dups.length === 0) return undefined;

  const dup = dups.map((p, i) => {
    const valor = p.valor + (p.juros ?? 0);
    const out: { nDup?: string; dVenc?: string; vDup: string } = {
      vDup: valor.toFixed(2),
    };
    out.nDup = String(i + 1).padStart(3, '0');
    if (p.vencimento) {
      // pagamento.vencimento is `z.string().datetime()` (ISO timestamp).
      const parsed = new Date(p.vencimento);
      if (!Number.isNaN(parsed.getTime())) {
        out.dVenc = parsed.toISOString().slice(0, 10); // YYYY-MM-DD
      }
    }
    return out;
  });

  const vOrig = dups.reduce((acc, p) => acc + p.valor + (p.juros ?? 0), 0);
  const nFat =
    (dups[0]?.nFat ?? '').trim() || dup[0]?.nDup || undefined;
  const fat: { nFat?: string; vOrig?: string; vDesc?: string; vLiq?: string } = {
    vOrig: vOrig.toFixed(2),
    vDesc: (0).toFixed(2),
    vLiq: vOrig.toFixed(2),
  };
  if (nFat) fat.nFat = nFat;
  return { fat, dup };
}

/**
 * Build the `<infAdic>` block by concatenating `pedido.infCpl` with
 * `operacao.infCpl` (in that order, separated by a space). Returns
 * undefined when both are empty so the orchestrator omits the block.
 * Mirror of Flutter `pedido_nfe_base.dart:538-546`.
 */
function buildInfAdic(
  pedido: PedidoBundle['pedido'],
  operacao: Operacao,
): { infCpl?: string } | undefined {
  const pedidoCpl =
    typeof (pedido as { infCpl?: unknown }).infCpl === 'string'
      ? ((pedido as { infCpl: string }).infCpl).trim()
      : '';
  const operacaoCpl = (operacao.infCpl ?? '').trim();
  const parts = [pedidoCpl, operacaoCpl].filter((s) => s.length > 0);
  if (parts.length === 0) return undefined;
  return { infCpl: parts.join(' ') };
}

/**
 * Build the `<exporta>` block when the operação is an export (idDest=3
 * on the wire — driven here by `operacao.ehExterior === true`).
 * `UFSaidaPais` is the UF the goods leave Brazil through (defaults to
 * the filial's UF); `xLocExporta` is the customs city (default: filial
 * city). Returns undefined for domestic operations.
 */
function buildExporta(
  operacao: Operacao,
  filial: Filial,
): {
  UFSaidaPais:
    | 'AC' | 'AL' | 'AM' | 'AP' | 'BA' | 'CE' | 'DF' | 'ES' | 'GO'
    | 'MA' | 'MG' | 'MS' | 'MT' | 'PA' | 'PB' | 'PE' | 'PI' | 'PR'
    | 'RJ' | 'RN' | 'RO' | 'RR' | 'RS' | 'SC' | 'SE' | 'SP' | 'TO';
  xLocExporta: string;
  xLocDespacho?: string;
} | undefined {
  if (!operacao.ehExterior) return undefined;
  const ufRaw = filial.sede.estado;
  if (ufRaw === 'EX') {
    // 'EX' is the foreign-carrier placeholder used inside <transporta>,
    // not a valid emitter UF — SEFAZ rejects `<emit><enderEmit><UF>EX`.
    throw new NFeOrchestratorError(
      `filial.sede.estado='EX' is not a valid emitter UF for an export operation`,
    );
  }
  const cityRaw = sanitizeNFeText(filial.sede.cidade, 60);
  if (!cityRaw) {
    throw new NFeOrchestratorError(
      `pedido marked ehExterior=true but filial.sede.cidade is empty`,
    );
  }
  return {
    UFSaidaPais: ufRaw,
    xLocExporta: cityRaw,
  };
}

/**
 * Build the `<infIntermed>` block from the loaded Integracao doc.
 * Mirror of Flutter `pedido_nfe_base.dart:523-536`. SEFAZ requires
 * both `CNPJ` and `idCadIntTran` when the operação flags
 * `indIntermed='1'`; missing either is a hard error here so the
 * operator fixes the Integracao record before SEFAZ rejects.
 */
function buildInfIntermed(
  integracao: Integracao | null,
  operacao: Operacao,
): { CNPJ: string; idCadIntTran: string } | undefined {
  if (operacao.indIntermed !== '1') return undefined;
  if (!integracao) {
    throw new NFeOrchestratorError(
      `operacao.indIntermed='1' but no Integracao doc resolved — set ` +
        `pedido.integracaoPedidoOuterRef to a valid Integracao path.`,
    );
  }
  if (!integracao.cpf_cnpj || !integracao.idCadIntTran) {
    throw new NFeOrchestratorError(
      `<infIntermed> requires both Integracao.cpf_cnpj and Integracao.idCadIntTran ` +
        `(SEFAZ NT 2020.006); got cpf_cnpj='${integracao.cpf_cnpj ?? ''}', ` +
        `idCadIntTran='${integracao.idCadIntTran ?? ''}'`,
    );
  }
  return {
    CNPJ: integracao.cpf_cnpj,
    idCadIntTran: integracao.idCadIntTran,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Result of `prepareEmission` — the inputs `runAllocateGenerateSignTx`
 * needs, with no side effects yet. Single source of truth for the
 * single-pedido orchestrator AND the batch orchestrator.
 */
export interface EmissionPrep {
  readonly bundle: PedidoBundle;
  readonly items: ReadonlyArray<FiscalItem>;
  readonly tpEmis: TpEmis;
  readonly nfeRef: FirebaseFirestore.DocumentReference;
  readonly nfeConfigRef: FirebaseFirestore.DocumentReference;
}

type TxOutcome =
  | { skip: true; existing: NotaFiscalEletronica }
  | { skip: false; chave: string; signedXml: string; idLote: number };

/**
 * Phase 1 of the emit cycle: load + resolve + validate + compute the
 * stable nfev4 doc id. Pure (no SOAP, no Firestore writes). Throws
 * `NFeBlockedError` when `bloquearEmissaoNFe` is set so the batch path
 * can classify the pedido into the "Não emitidas" bucket cleanly.
 */
async function prepareEmission(
  fs: Firestore,
  rt: NFeRuntime,
  pedidoId: string,
): Promise<EmissionPrep> {
  const bundle = await loadPedidoBundle(fs, pedidoId);
  if (bundle.pedido.bloquearEmissaoNFe) {
    throw new NFeBlockedError(pedidoId);
  }
  await preResolveImpostos(bundle, fs);
  const items = flattenAndValidate(bundle);

  // Stable doc id per (pedido, tpEmis) — mirrors Flutter's
  // `NotaFiscalEletronica.nFeSaidaIdFromTpEmis(tpEmis)` so every retry
  // for the same pedido targets the same nfev4 doc instead of accreting
  // chave-keyed duplicates.
  const tpEmis = resolveTpEmis(bundle.filial.sede.estado);
  const nfeRef = fs
    .collection('pedidos')
    .doc(pedidoId)
    .collection('nfev4')
    .doc(nfeDocId(tpEmis));
  const nfeConfigRef = fs.doc(
    `filiais/${bundle.filialId}/nfeconfig/${DEFAULT_NFE_CONFIG_DOC_ID}`,
  );
  return { bundle, items, tpEmis, nfeRef, nfeConfigRef };
}

/**
 * Phase 2 of the emit cycle: atomic dedup pre-check + allocate (nNF +
 * idLote) + generate + sign + persist `estado='enviando'`. All counter
 * advances and XML persistence happen in ONE Firestore transaction so a
 * crash mid-flight can never strand a consumed numeração without a
 * matching nfev4 doc. The SEFAZ SOAP call happens AFTER the tx commits.
 *
 * `sharedIdLote` is the batch hook: when present, the tx stamps that id
 * on the nfev4 doc and does NOT advance `NFeConfig.idLote` (the batch's
 * outer allocate tx already did that). When undefined (single-pedido
 * path), the tx allocates `cfg.idLote + 1` and writes it back.
 */
async function runAllocateGenerateSignTx(
  fs: Firestore,
  rt: NFeRuntime,
  prep: EmissionPrep,
  sharedIdLote?: number,
): Promise<TxOutcome> {
  const { bundle, items, tpEmis, nfeRef, nfeConfigRef } = prep;
  const pedidoId = bundle.pedidoId;
  return fs.runTransaction<TxOutcome>(async (tx) => {
    // Reads MUST precede writes in a Firestore transaction.
    const nfeSnap = await tx.get(nfeRef);
    const existing = nfeSnap.exists
      ? (nfeSnap.data() as NotaFiscalEletronica)
      : null;

    // Bloqueada NFes (cStat in STATUS_BLOQUEADORES) short-circuit —
    // covers both the normal pre-check AND the race where another emit
    // wrote the doc between attempts of this transaction.
    if (existing && isBloqueada(existing.cStat)) {
      console.debug(
        `[nfe/orchestrator] pedido '${pedidoId}' has existing bloqueada NFe ` +
          `(cStat=${existing.cStat}) — skipping emit and returning persisted state`,
      );
      return { skip: true, existing };
    }

    console.debug(`[nfe/orchestrator] No bloqueada NFe found for pedidoId '${pedidoId}' — proceeding with emit. ` +
      `Existing NFe doc ${existing ? 'is not bloqueada (cStat=' + existing.cStat + ')' : 'does not exist'}.`);

    const cfgSnap = await tx.get(nfeConfigRef);
    if (!cfgSnap.exists) throw new NFeConfigNotFoundError(bundle.filialId);
    const cfg = nfeConfigSchema.parse(cfgSnap.data()) as NFeConfig;

    // Reuse numeração + serie when an existing rejeitada / error /
    // never-sent doc is present; allocate fresh otherwise. idLote
    // always advances — every retry is a fresh SEFAZ lote. The batch
    // path pre-allocates one shared idLote outside this tx.
    const reuse = existing != null;
    const nNF = reuse ? existing.numeracao : cfg.numeracao_atual + 1;
    const serie = reuse ? existing.serie : cfg.serie;
    const idLote = sharedIdLote ?? cfg.idLote + 1;

    // Generate + sign (CPU only — safe to run inside the tx). The chave
    // is deterministic from nNF + serie + dhEmi + filial CNPJ + tpEmis,
    // so a tx retry with a fresh nNF regenerates a consistent set.
    const input = buildGeneratorInput(bundle, items, nNF, serie, rt.ambiente, tpEmis);
    const generated = generateNFe(input);
    const signedXml = signNFe(generated.nfeXml, rt.cert);

    const now = new Date().toISOString();

    // Writes — counter doc first, then NFe doc. Both commit or neither.
    // When `sharedIdLote` was provided, the outer allocate tx already
    // advanced `cfg.idLote`; we leave it alone to avoid clobbering with
    // a stale read value.
    tx.set(nfeConfigRef, {
      ...cfg,
      ...(reuse ? {} : { numeracao_atual: nNF }),
      ...(sharedIdLote == null ? { idLote } : {}),
      timestamp: now,
    });
    tx.set(nfeRef, {
      numeracao: nNF,
      serie,
      tpEmis,
      estado: ESTADO_NFE.enviando,
      chave: generated.chave,
      idLote: String(idLote),
      infNFe: null,
      xml_nfe_proc: null,
      xml_epec_proc: null,
      xml_assinado: signedXml,
      nRec: null,
      retries: 0,
      cStat: null,
      xMotivo: null,
      data_emissao: now,
      data_autorizacao: null,
      dataContingencia: null,
      justificativaContingencia: null,
      error: null,
      ultima_modificacao: now,
    });

    return { skip: false, chave: generated.chave, signedXml, idLote };
  });
}

/**
 * Phase 3 of the emit cycle: audit-log + outcome + recovery branches +
 * `<nfeProc>` build + persist. Per-chave; the batch path calls this
 * once per pedido after polling `consultarLote` for the lote's
 * `protNFe[]`.
 *
 * `protNFeForChave` is the chave-specific protocol when the caller
 * already has it (batch path — extracted from `consultarLote.protNFe[]`).
 * Single-pedido path passes `null` and the helper derives the outcome
 * from `retEnvi.protNFe` (the sync response).
 */
async function applyAutorizadoOutcome(args: {
  fs: Firestore;
  rt: NFeRuntime;
  bundle: PedidoBundle;
  nfeRef: FirebaseFirestore.DocumentReference;
  chave: string;
  signedXml: string;
  idLote: number;
  tpEmis: TpEmis;
  retEnvi: Awaited<ReturnType<typeof autorizarLote>>;
  protNFeForChave: NonNullable<Awaited<ReturnType<typeof autorizarLote>>['protNFe']> | null;
  /** `'1'` (sync, single NFe) or `'0'` (async, batch). */
  indSinc: '0' | '1';
}): Promise<EmitResult> {
  const { fs, rt, bundle, nfeRef, chave, signedXml, idLote, tpEmis, retEnvi, indSinc } = args;

  // Audit-log the SOAP round-trip BEFORE running the state machine — so
  // nRec is durable even if anything below this line crashes.
  await enviNfeCollection(fs, bundle.filialId).add(
    buildEnviNFeMsgFromLote({ chave, idLote, tpEmis, signedXml, retEnvi, indSinc }),
  );

  const call: SefazCall = {
    url: rt.endpoints.NfeAutorizacao,
    cert: rt.cert,
    agent: rt.agent,
    tpAmb: rt.tpAmb,
  };

  // Derive the initial outcome — from the chave-specific protocol when
  // the batch caller supplied one, otherwise from the lote-level
  // retEnvi (the sync single-NFe path).
  let outcome: SefazOutcome = args.protNFeForChave
    ? outcomeFromInfProt(args.protNFeForChave.infProt)
    : outcomeFromRetEnviNFe(retEnvi);
  let patch = applyOutcome(
    { estado: ESTADO_NFE.enviando, retries: 0 },
    outcome,
  );
  // The chave that ends up on the result (and on the nfev4 doc) may
  // change during a cStat=539 recovery: the "real" NF-e at SEFAZ lives
  // under a different chave (the one in xMotivo's [chNFe:...] marker).
  let finalChave = chave;
  // Capture the authoritative SEFAZ protocol object for our chave —
  // populated for the happy path and re-assigned for each recovery
  // branch that surfaces one. Used at the end to build `<nfeProc>`.
  // Left as `null` for 539 (chave swap) since our local signedXml
  // doesn't match the recovered protocol's chNFe.
  let protNFeRaw: typeof retEnvi.protNFe | null =
    args.protNFeForChave ?? retEnvi.protNFe ?? null;

  // Duplicidade / lote-not-found → query SEFAZ for the real status.
  if (patch.action === 'recover-via-consulta') {
    if (outcome.cStat === '539') {
      const recovered = await recoverFrom539({
        fs,
        bundle,
        nfeRef,
        rt,
        call,
        tpEmis,
        outcome,
        patch,
      });
      patch = recovered.patch;
      if (recovered.chaveOverride) finalChave = recovered.chaveOverride;
      protNFeRaw = null;
    } else if (patch.nRec) {
      const consReciCall: SefazCall = { ...call, url: rt.endpoints.NfeRetAutorizacao };
      const retRec = await consultarLote(consReciCall, { nRec: patch.nRec });
      await enviNfeCollection(fs, bundle.filialId).add(
        buildEnviNFeMsgFromConsulta({ chave, nRec: patch.nRec, ret: retRec, tpEmis }),
      );
      protNFeRaw =
        retRec.protNFe?.find((p) => p.infProt.chNFe === chave) ?? null;
      outcome = outcomeFromConsReci(retRec, chave);
      patch = applyOutcome({ estado: patch.estado, retries: patch.retries }, outcome);
    } else {
      const consSitCall: SefazCall = { ...call, url: rt.endpoints.NfeConsultaProtocolo };
      const retSit = await consultarSituacaoNFe(consSitCall, { chave });
      await enviNfeCollection(fs, bundle.filialId).add(
        buildEnviNFeMsgFromConsulta({ chave, nRec: null, ret: retSit, tpEmis }),
      );
      protNFeRaw = retSit.protNFe ?? null;
      outcome = outcomeFromRetConsSit(retSit);
      patch = applyOutcome({ estado: patch.estado, retries: patch.retries }, outcome);
    }
  }

  // Build the `<nfeProc>` envelope when SEFAZ authorized the NF-e and
  // we still have the matching local signedXml (no chave swap). This
  // is the canonical form for DANFE rendering and fiscal archives.
  const nfeProcXml =
    classifyCStat(patch.cStat) === 'autorizada' &&
    protNFeRaw != null &&
    finalChave === chave
      ? buildNFeProc(signedXml, protNFeRaw)
      : null;

  await persistPatch(
    nfeRef,
    patch,
    nfeProcXml != null ? { xml_nfe_proc: nfeProcXml } : undefined,
  );

  return {
    nfeId: nfeRef.id,
    pedidoId: bundle.pedidoId,
    estado: patch.estado,
    chave: finalChave,
    nRec: patch.nRec,
    cStat: patch.cStat,
    xMotivo: patch.xMotivo,
    reused: false,
  };
}

/**
 * The full emit cycle for a single pedido. Persists `estado='enviando'`
 * BEFORE the SOAP send; applies `applyOutcome` after; runs an inline
 * `consultarSituacaoNFe` if the state machine asks for
 * `recover-via-consulta`.
 *
 * Composition of the three phase helpers (`prepareEmission`,
 * `runAllocateGenerateSignTx`, `applyAutorizadoOutcome`) — `emitirPedidosLote`
 * uses the same three helpers with one shared `idLote` per chunk.
 */
export async function emitirPedido(
  fs: Firestore,
  rt: NFeRuntime,
  pedidoId: string,
): Promise<EmitResult> {
  console.debug(`[nfe/orchestrator] Starting emit cycle for pedidoId '${pedidoId}', runtime ambiente '${rt.ambiente}'`);

  const prep = await prepareEmission(fs, rt, pedidoId);
  const captured = await runAllocateGenerateSignTx(fs, rt, prep);

  if (captured.skip) {
    console.debug(
      `[nfe/orchestrator] pedido '${pedidoId}' has existing bloqueada NFe ` +
        `(cStat=${captured.existing.cStat}) — returning persisted state without re-emission`,
    );
    return existingToEmitResult(pedidoId, prep.nfeRef.id, captured.existing);
  }

  const { chave, signedXml, idLote } = captured;
  const call: SefazCall = {
    url: rt.endpoints.NfeAutorizacao,
    cert: rt.cert,
    agent: rt.agent,
    tpAmb: rt.tpAmb,
  };

  const retEnvi = await autorizarLote(call, {
    idLote: String(idLote),
    NFe: [signedXml],
  });
  console.debug(JSON.stringify({ retEnvi }));

  return applyAutorizadoOutcome({
    fs,
    rt,
    bundle: prep.bundle,
    nfeRef: prep.nfeRef,
    chave,
    signedXml,
    idLote,
    tpEmis: prep.tpEmis,
    retEnvi,
    protNFeForChave: null,
    indSinc: '1',
  });
}

// ---------------------------------------------------------------------------
// Batch emission — emitirPedidosLote
// ---------------------------------------------------------------------------

/** SEFAZ MOC 7.0 caps a single batch at 50 NF-es. We enforce this at request entry. */
const MAX_PEDIDOS_PER_BATCH = 50;
/**
 * SEFAZ accepts up to 50 per lote, but Flutter's `gerarNFePedidos`
 * (`.old/packages/pedido_nfe/lib/src/tasks.dart:633`) chunks at 20 per
 * lote for connection reliability + message-size headroom. We mirror
 * that battle-tested limit.
 */
const MAX_PEDIDOS_PER_CHUNK = 20;
const POLL_MAX_ATTEMPTS = 12;
const POLL_INITIAL_DELAY_MS = 1000;
const POLL_MAX_DELAY_MS = 8000;

/** Per-pedido failure inside a batch. Distinct shape from EmitResult so callers can branch. */
export interface EmitError {
  readonly pedidoId: string;
  /** Class name of the error (JSON-safe — `NFeBlockedError`, `NFePedidoNotFoundError`, ...). */
  readonly errorCode: string;
  readonly errorMessage: string;
}

export interface BatchEmitResult {
  readonly results: ReadonlyArray<EmitResult | EmitError>;
}

/**
 * Batch emit cycle. Mirrors `emitirPedido` but fans out across one
 * shared idLote per (filial, ≤20-pedido) chunk. Per-pedido failures
 * surface as `EmitError` entries in the result array — the request
 * never throws unless an upstream invariant fails (empty input, >50
 * total pedidos, runtime boot).
 *
 * Mirror of Flutter's `gerarNFePedidos` at
 * `.old/packages/pedido_nfe/lib/src/tasks.dart:59`: group by filial,
 * sub-chunk at 20, allocate one idLote per chunk, call autorizarLote
 * once per chunk, poll consultarLote for async chunks, apply per-chave
 * outcome.
 */
export async function emitirPedidosLote(
  fs: Firestore,
  rt: NFeRuntime,
  pedidoIds: ReadonlyArray<string>,
): Promise<BatchEmitResult> {
  if (pedidoIds.length === 0) {
    throw new NFeOrchestratorError('emitirPedidosLote: pedidoIds is empty');
  }
  if (pedidoIds.length > MAX_PEDIDOS_PER_BATCH) {
    throw new NFeOrchestratorError(
      `emitirPedidosLote: ${pedidoIds.length} pedidos exceeds MAX_PEDIDOS_PER_BATCH (${MAX_PEDIDOS_PER_BATCH})`,
    );
  }
  console.debug(`[nfe/orchestrator] Batch emit starting — ${pedidoIds.length} pedido(s), ambiente '${rt.ambiente}'`);

  // 1. Prepare every pedido in parallel. prepareEmission failures
  //    (NFeBlockedError, NFePedidoNotFoundError, NFeMissingImpostoError,
  //    NFeOrchestratorError) become per-pedido EmitError entries — the
  //    pedido never reaches a lote.
  const preps = await Promise.allSettled(
    pedidoIds.map((id) => prepareEmission(fs, rt, id)),
  );
  const results: Array<EmitResult | EmitError> = [];
  const successPreps: Array<{ prep: EmissionPrep; pedidoId: string }> = [];
  preps.forEach((p, i) => {
    const pedidoId = pedidoIds[i]!;
    if (p.status === 'rejected') {
      results.push(toEmitError(pedidoId, p.reason));
    } else {
      successPreps.push({ prep: p.value, pedidoId });
    }
  });
  if (successPreps.length === 0) return { results };

  // 2. Group by filialId — each filial has its own NFeConfig + idLote
  //    counter. Mirrors the Flutter outer loop at tasks.dart:134.
  const groups = new Map<string, Array<{ prep: EmissionPrep; pedidoId: string }>>();
  for (const sp of successPreps) {
    const filialId = sp.prep.bundle.filialId;
    const arr = groups.get(filialId) ?? [];
    arr.push(sp);
    groups.set(filialId, arr);
  }

  // 3. Sub-chunk each filial group into runs of ≤20 (Flutter parity).
  const chunks: Array<{ filialId: string; group: Array<{ prep: EmissionPrep; pedidoId: string }> }> = [];
  for (const [filialId, group] of groups) {
    for (let i = 0; i < group.length; i += MAX_PEDIDOS_PER_CHUNK) {
      chunks.push({
        filialId,
        group: group.slice(i, i + MAX_PEDIDOS_PER_CHUNK),
      });
    }
  }
  console.debug(
    `[nfe/orchestrator] Batch fan-out: ${groups.size} filial(is) × ${chunks.length} chunk(s)`,
  );

  // 4. Process each chunk in parallel. Chunk-level failures (e.g.
  //    NFeConfig missing) cascade to every pedido in that chunk.
  const chunkResults = await Promise.allSettled(
    chunks.map((c) => processChunk(fs, rt, c.filialId, c.group)),
  );
  chunkResults.forEach((cr, i) => {
    const chunk = chunks[i]!;
    if (cr.status === 'rejected') {
      for (const sp of chunk.group) {
        results.push(toEmitError(sp.pedidoId, cr.reason));
      }
    } else {
      for (const r of cr.value) results.push(r);
    }
  });
  return { results };
}

/**
 * Process one (filial, ≤20-pedido) chunk: allocate one shared idLote,
 * run per-pedido alloc-generate-sign txs in parallel, call
 * autorizarLote once for the chunk, poll for async lotes, apply
 * per-chave outcome.
 */
async function processChunk(
  fs: Firestore,
  rt: NFeRuntime,
  filialId: string,
  group: ReadonlyArray<{ prep: EmissionPrep; pedidoId: string }>,
): Promise<Array<EmitResult | EmitError>> {
  // 4a. Allocate one shared idLote for the whole chunk (one tx).
  const nfeConfigRef = fs.doc(
    `filiais/${filialId}/nfeconfig/${DEFAULT_NFE_CONFIG_DOC_ID}`,
  );
  const sharedIdLote = await fs.runTransaction(async (tx) => {
    const cfgSnap = await tx.get(nfeConfigRef);
    if (!cfgSnap.exists) throw new NFeConfigNotFoundError(filialId);
    const cfg = nfeConfigSchema.parse(cfgSnap.data()) as NFeConfig;
    const idLote = cfg.idLote + 1;
    tx.set(nfeConfigRef, { ...cfg, idLote, timestamp: new Date().toISOString() });
    return idLote;
  });

  // 4b. Per-pedido tx in parallel — each allocates its own nNF but
  //     stamps the shared idLote on its nfev4 doc.
  const txOutcomes = await Promise.allSettled(
    group.map((sp) => runAllocateGenerateSignTx(fs, rt, sp.prep, sharedIdLote)),
  );
  const txResults: Array<EmitResult | EmitError> = [];
  const toSend: Array<{
    prep: EmissionPrep;
    pedidoId: string;
    chave: string;
    signedXml: string;
  }> = [];
  txOutcomes.forEach((o, i) => {
    const sp = group[i]!;
    if (o.status === 'rejected') {
      txResults.push(toEmitError(sp.pedidoId, o.reason));
    } else if (o.value.skip) {
      // Mirrors Flutter's `jaAprovadas` short-circuit at tasks.dart:159 —
      // existing bloqueada/aprovada/cancelada nfev4 short-circuits out
      // of the lote and lands in the "Não emitidas" bucket on the UI.
      txResults.push(
        existingToEmitResult(sp.pedidoId, sp.prep.nfeRef.id, o.value.existing),
      );
    } else {
      toSend.push({
        prep: sp.prep,
        pedidoId: sp.pedidoId,
        chave: o.value.chave,
        signedXml: o.value.signedXml,
      });
    }
  });
  if (toSend.length === 0) return txResults;

  // 4c. autorizarLote — one SOAP call for the whole chunk. indSinc='1'
  //     when only one NFe survived prep+tx; '0' otherwise.
  const call: SefazCall = {
    url: rt.endpoints.NfeAutorizacao,
    cert: rt.cert,
    agent: rt.agent,
    tpAmb: rt.tpAmb,
  };
  const indSinc: '0' | '1' = toSend.length === 1 ? '1' : '0';
  const retEnvi = await autorizarLote(call, {
    idLote: String(sharedIdLote),
    NFe: toSend.map((s) => s.signedXml),
    indSinc,
  });
  console.debug(
    `[nfe/orchestrator] Batch chunk autorizarLote — filial=${filialId} ` +
      `idLote=${sharedIdLote} count=${toSend.length} indSinc=${indSinc} ` +
      `retCStat=${retEnvi.cStat}`,
  );

  // 4d. For async chunks, poll consultarLote until cStat=104 (lote
  //     processado) or the budget runs out.
  let protNFeArr: NonNullable<TRetEnviNFe['protNFe']>[] = [];
  if (indSinc === '0') {
    const nRec = retEnvi.infRec?.nRec ?? null;
    if (!nRec) {
      // SEFAZ accepted but didn't give us nRec — exceptional but
      // defended. Each pedido stays in aguardandoResposta; the
      // processar-pendentes cron has nothing to look up, so the
      // operator handles via consSit(chave).
      for (const s of toSend) {
        txResults.push({
          nfeId: s.prep.nfeRef.id,
          pedidoId: s.pedidoId,
          estado: ESTADO_NFE.aguardandoResposta,
          chave: s.chave,
          nRec: null,
          cStat: retEnvi.cStat,
          xMotivo: retEnvi.xMotivo,
          reused: false,
        });
      }
      return txResults;
    }
    protNFeArr = await pollConsultarLote(rt, call, nRec);
    if (protNFeArr.length === 0) {
      // Timed out without resolution. Persist nRec on each nfev4 so
      // the cron at apps/nfe/app/api/nfe/processar-pendentes can
      // drain it later, then return aguardandoResposta entries.
      await Promise.all(
        toSend.map((s) =>
          persistPatch(s.prep.nfeRef, {
            estado: ESTADO_NFE.aguardandoResposta,
            retries: 0,
            nRec,
            cStat: '105',
            xMotivo: 'Lote em processamento — handed off to processar-pendentes',
            action: 'backoff',
          }),
        ),
      );
      for (const s of toSend) {
        txResults.push({
          nfeId: s.prep.nfeRef.id,
          pedidoId: s.pedidoId,
          estado: ESTADO_NFE.aguardandoResposta,
          chave: s.chave,
          nRec,
          cStat: '105',
          xMotivo: 'Lote em processamento — handed off to processar-pendentes',
          reused: false,
        });
      }
      return txResults;
    }
  } else {
    // Sync (single-NFe) chunk — retEnvi.protNFe is the singular protocol.
    if (retEnvi.protNFe) protNFeArr = [retEnvi.protNFe];
  }

  // 4e. Apply outcome per chave. Each call audits the retEnvi-level
  //     response (parameterized indSinc) AND handles per-chave
  //     recovery branches (539 / nRec / 106).
  const outcomes = await Promise.allSettled(
    toSend.map(async (s) => {
      const proto = protNFeArr.find((p) => p.infProt.chNFe === s.chave) ?? null;
      return applyAutorizadoOutcome({
        fs,
        rt,
        bundle: s.prep.bundle,
        nfeRef: s.prep.nfeRef,
        chave: s.chave,
        signedXml: s.signedXml,
        idLote: sharedIdLote,
        tpEmis: s.prep.tpEmis,
        retEnvi,
        protNFeForChave: proto,
        indSinc,
      });
    }),
  );
  outcomes.forEach((o, i) => {
    const s = toSend[i]!;
    if (o.status === 'rejected') {
      txResults.push(toEmitError(s.pedidoId, o.reason));
    } else {
      txResults.push(o.value);
    }
  });
  return txResults;
}

/**
 * Poll `consultarLote(nRec)` until cStat=104 (lote processado) or the
 * budget runs out. Returns the `protNFe[]` on success; empty array on
 * timeout (caller persists nRec and hands off to the cron).
 */
async function pollConsultarLote(
  rt: NFeRuntime,
  call: SefazCall,
  nRec: string,
): Promise<NonNullable<TRetEnviNFe['protNFe']>[]> {
  const consReciCall: SefazCall = { ...call, url: rt.endpoints.NfeRetAutorizacao };
  let delay = POLL_INITIAL_DELAY_MS;
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise<void>((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, POLL_MAX_DELAY_MS);
    }
    const retRec = await consultarLote(consReciCall, { nRec });
    console.debug(
      `[nfe/orchestrator] pollConsultarLote nRec=${nRec} attempt=${attempt} ` +
        `cStat=${retRec.cStat} protNFe=${retRec.protNFe?.length ?? 0}`,
    );
    if (retRec.cStat === '104' && retRec.protNFe && retRec.protNFe.length > 0) {
      return retRec.protNFe;
    }
    if (retRec.cStat !== '105') {
      // 4xx / 5xx / unexpected — bail out. The caller's per-chave
      // recovery branch handles non-104/105 outcomes via consSit.
      return [];
    }
  }
  return []; // budget exhausted
}

/**
 * Narrow an unknown exception into a JSON-safe EmitError. Non-Error
 * throwables are re-raised (CLAUDE.md rule 6 — don't swallow what we
 * can't classify).
 */
function toEmitError(pedidoId: string, reason: unknown): EmitError {
  if (reason instanceof NFeBlockedError) {
    return { pedidoId, errorCode: 'NFeBlockedError', errorMessage: reason.message };
  }
  if (reason instanceof NFePedidoNotFoundError) {
    return { pedidoId, errorCode: 'NFePedidoNotFoundError', errorMessage: reason.message };
  }
  if (reason instanceof NFeMissingImpostoError) {
    return { pedidoId, errorCode: 'NFeMissingImpostoError', errorMessage: reason.message };
  }
  if (reason instanceof NFeOrchestratorError) {
    return { pedidoId, errorCode: 'NFeOrchestratorError', errorMessage: reason.message };
  }
  if (reason instanceof NFeConfigNotFoundError) {
    return { pedidoId, errorCode: 'NFeConfigNotFoundError', errorMessage: reason.message };
  }
  if (reason instanceof Error) {
    return { pedidoId, errorCode: reason.name, errorMessage: reason.message };
  }
  throw reason;
}

/**
 * Handle a cStat=539 outcome: SEFAZ already has an NF-e with our
 * `nNF + serie + tpEmis + emit-CNPJ` but under a DIFFERENT chave (the
 * `[chNFe:...]` marker in xMotivo). Recovery strategy:
 *   1. Pull the previously-emitted chave from xMotivo markers.
 *   2. Look it up in our `EnviNFeMsg` audit log (the SEFAZ-roundtrip
 *      log written on every lote send / consult).
 *   3. If found, the previous lote's `nRec` is also in the audit log
 *      msg — call `consultarLote(prevNRec)` to fetch SEFAZ's
 *      authoritative protocol for that chave, swap the nfev4 doc's
 *      `chave` to the recovered one, and return the consult outcome.
 *   4. If not found (or no chNFe marker), the note is "lost" from our
 *      side — return a patch marking estado=error with the original
 *      cStat=539 + xMotivo preserved so the operator can fix manually
 *      (download from SEFAZ portal + upload).
 *
 * NB: this does NOT touch `xml_assinado` — it still holds the locally
 * signed XML for OUR chave. After a successful 539 recovery the doc
 * has a mismatch (recovered chave + local signed XML for the old
 * chave); the next step in production is to fetch the authorized XML
 * from SEFAZ DistDFe (a Phase D port).
 */
async function recoverFrom539(params: {
  fs: Firestore;
  bundle: PedidoBundle;
  nfeRef: FirebaseFirestore.DocumentReference;
  rt: NFeRuntime;
  call: SefazCall;
  tpEmis: TpEmis;
  outcome: SefazOutcome;
  patch: NFeStatePatch;
}): Promise<{ patch: NFeStatePatch; chaveOverride?: string }> {
  const { fs, bundle, nfeRef, rt, call, tpEmis, outcome, patch } = params;

  const recoveredChave = outcome.chNFeFromXMotivo;
  if (!recoveredChave) {
    console.warn(
      `[nfe/orchestrator] pedido '${bundle.pedidoId}': cStat=539 sem ` +
        `marcador [chNFe:...] em xMotivo — marcando como error.`,
    );
    return { patch: markAsLost(patch, 'cStat=539 sem marcador [chNFe:...] em xMotivo') };
  }

  const prevMsg = await findLatestEnviNFeMsgWithNRec(fs, bundle.filialId, recoveredChave);
  if (!prevMsg?.nRec) {
    console.warn(
      `[nfe/orchestrator] pedido '${bundle.pedidoId}': cStat=539 — chave ` +
        `${recoveredChave} não encontrada no audit log com nRec; marcando como error.`,
    );
    return {
      patch: markAsLost(
        patch,
        `cStat=539 — chave ${recoveredChave} não está no audit log local`,
      ),
    };
  }

  const consReciCall: SefazCall = { ...call, url: rt.endpoints.NfeRetAutorizacao };
  const retRec = await consultarLote(consReciCall, { nRec: prevMsg.nRec });
  await enviNfeCollection(fs, bundle.filialId).add(
    buildEnviNFeMsgFromConsulta({
      chave: recoveredChave,
      nRec: prevMsg.nRec,
      ret: retRec,
      tpEmis,
    }),
  );
  const recoveredOutcome = outcomeFromConsReci(retRec, recoveredChave);
  const recoveredPatch = applyOutcome(
    { estado: patch.estado, retries: 0 },
    recoveredOutcome,
  );

  // Swap chave on the nfev4 doc — done outside persistPatch (which is
  // generic) since this only happens on 539 recovery.
  await nfeRef.set(
    { chave: recoveredChave, ultima_modificacao: new Date().toISOString() },
    { merge: true },
  );

  return { patch: recoveredPatch, chaveOverride: recoveredChave };
}

/**
 * Final-state patch when a duplicidade-class outcome can't be recovered:
 * keeps cStat + the SEFAZ-supplied xMotivo (with its [chNFe:...] /
 * [nRec:...] markers) visible to the operator, appends a short reason
 * tail, and flips estado to `error`. No SEFAZ calls happen after this.
 */
function markAsLost(patch: NFeStatePatch, reason: string): NFeStatePatch {
  return {
    ...patch,
    estado: ESTADO_NFE.error,
    xMotivo: `${patch.xMotivo} | ${reason}`,
  };
}

/**
 * Standalone SEFAZ consulta for an already-persisted nfev4 doc. Reads
 * the stable `s${tpEmis}` doc, queries SEFAZ via `consultarSituacaoNFe`,
 * applies the outcome, persists the patch, and returns the same shape
 * `emitirPedido` does (with `reused: false` — always a fresh SEFAZ call).
 *
 * Mirrors the `recover-via-consulta` branch inside `emitirPedido` but
 * starts from a persisted doc instead of a just-completed lote response.
 * Used by the `consult:dev-pedido` CLI for manual polling and (later)
 * by the `processar-pendentes` cron.
 */
export async function consultarPedido(
  fs: Firestore,
  rt: NFeRuntime,
  pedidoId: string,
): Promise<EmitResult> {
  console.debug(`[nfe/orchestrator] consultarPedido pedidoId='${pedidoId}'`);

  const bundle = await loadPedidoBundle(fs, pedidoId);
  const tpEmis = resolveTpEmis(bundle.filial.sede.estado);
  const nfeRef = fs
    .collection('pedidos')
    .doc(pedidoId)
    .collection('nfev4')
    .doc(nfeDocId(tpEmis));

  const snap = await nfeRef.get();
  if (!snap.exists) {
    throw new NFeOrchestratorError(
      `pedido '${pedidoId}': no nfev4 doc at ${nfeRef.path} — nothing to consult. ` +
        'Run `emit:dev-pedido` first.',
    );
  }
  const nota = snap.data() as NotaFiscalEletronica;
  if (!nota.chave) {
    throw new NFeOrchestratorError(
      `pedido '${pedidoId}': persisted nfev4 doc has no chave — cannot consult.`,
    );
  }

  // Prefer consReci(nRec) when an audit-log msg holds a receipt — it
  // works while the lote is still queued at SEFAZ (cStat=105) and
  // gives us the protocol once processed. Fall back to consSit(chave)
  // only when no msg with nRec exists (e.g. externally-recovered NFe).
  const baseCall = {
    cert: rt.cert,
    agent: rt.agent,
    tpAmb: rt.tpAmb,
  } as const;
  const msgWithNRec = await findLatestEnviNFeMsgWithNRec(
    fs,
    bundle.filialId,
    nota.chave,
  );

  let outcome: SefazOutcome;
  if (msgWithNRec?.nRec) {
    const consReciCall: SefazCall = { ...baseCall, url: rt.endpoints.NfeRetAutorizacao };
    const retRec = await consultarLote(consReciCall, { nRec: msgWithNRec.nRec });
    await enviNfeCollection(fs, bundle.filialId).add(
      buildEnviNFeMsgFromConsulta({
        chave: nota.chave,
        nRec: msgWithNRec.nRec,
        ret: retRec,
        tpEmis,
      }),
    );
    outcome = outcomeFromConsReci(retRec, nota.chave);
  } else {
    const consSitCall: SefazCall = { ...baseCall, url: rt.endpoints.NfeConsultaProtocolo };
    const retSit = await consultarSituacaoNFe(consSitCall, { chave: nota.chave });
    await enviNfeCollection(fs, bundle.filialId).add(
      buildEnviNFeMsgFromConsulta({
        chave: nota.chave,
        nRec: null,
        ret: retSit,
        tpEmis,
      }),
    );
    outcome = outcomeFromRetConsSit(retSit);
  }

  const patch = applyOutcome(
    { estado: nota.estado, retries: nota.retries ?? 0 },
    outcome,
  );
  await persistPatch(nfeRef, patch);

  return {
    nfeId: nfeRef.id,
    pedidoId,
    estado: patch.estado,
    chave: nota.chave,
    nRec: patch.nRec ?? msgWithNRec?.nRec ?? nota.nRec,
    cStat: patch.cStat,
    xMotivo: patch.xMotivo,
    reused: false,
  };
}

async function persistPatch(
  nfeRef: FirebaseFirestore.DocumentReference,
  patch: NFeStatePatch,
  extras?: Record<string, unknown>,
): Promise<void> {
  // Preserve `nRec`: omit it from the merge when the new patch lacks
  // one (e.g. consSit responses don't carry an nRec), so we don't
  // overwrite the value the lote-receipt response (cStat=103) saved.
  // The authoritative receipt always lives in the enviNfe audit log
  // anyway; this copy is just for the NFCell.
  //
  // `extras` lets the caller stamp other fields in the same write —
  // currently used for `xml_nfe_proc` on cStat=100 (autorizada). Kept
  // generic so future fields (e.g. `data_autorizacao`, `nProt`) can
  // ride along without another method.
  await nfeRef.set(
    {
      estado: patch.estado,
      cStat: patch.cStat,
      xMotivo: patch.xMotivo,
      retries: patch.retries,
      ...(patch.nRec != null ? { nRec: patch.nRec } : {}),
      ...(extras ?? {}),
      ultima_modificacao: new Date().toISOString(),
    },
    { merge: true },
  );
}

// Internals exposed for tests only.
export const __internal = {
  flattenAndValidate,
  buildPaymentsFromPagamentos,
  buildCardFromCartao,
  buildGenItems,
  loadPagamentosFromSnapshot,
  buildTranspFromFrete,
  buildCobrFromPagamentos,
  buildInfAdic,
  buildExporta,
  buildInfIntermed,
  parseFreteFromPedido,
};
// Re-export Zod so test fixtures can use the same z instance.
export { z };
