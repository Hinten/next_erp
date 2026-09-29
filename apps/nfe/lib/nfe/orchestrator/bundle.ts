import type { Firestore } from 'firebase-admin/firestore';

import { roundReais } from '@delfrance/core/money';
import { nfeConfigCollection } from '@delfrance/data/admin/collections';
import {
  NFeConfigNotFoundError,
  impostoSchema,
  type Imposto,
  type TpEmis,
} from '@delfrance/integrations-nfe';
import {
  IND_INTERMED_OPERACAO,
  freteDoPedidoSchema,
  integracaoSchema,
  isPagamentoPagante,
  nfeConfigSchema,
  operacaoSchema,
  pagamentoSchema,
  regraImpostoSchema,
  toDocPathOrNull,
  ufSchema,
  type AjusteRtcEntrada,
  type Cliente,
  type DfeReferenciadoEntrada,
  type Endereco,
  type EstadoNFe,
  type Filial,
  type FreteDoPedido,
  type Integracao,
  type IntegracaoTipo,
  type NFeConfig,
  type Operacao,
  type Pagamento,
  type Pedido,
  type RegraImposto,
} from '@delfrance/schemas';

import { createFirestoreImpostoResolver } from '../imposto-resolver';
import type { ImpostoResolver } from '../imposto-resolver';
import { ensureCodigoMunicipio } from './cmun';
import { NFeMissingImpostoError, NFeOrchestratorError, NFePedidoNotFoundError } from './errors';

/** Mirror of Flutter's `nFeSaidaIdFromTpEmis` — one nfev4 slot per (pedido, tpEmis). */
export function nfeDocId(tpEmis: TpEmis): string {
  return `s${tpEmis}`;
}

/** Default doc id under `filiais/{filialId}/nfeconfig`. Mirrors the library adapter. */
export const DEFAULT_NFE_CONFIG_DOC_ID = 'default';

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
   * SEFAZ call was made. Also `true` for a #512 no-receipt lote member whose
   * reply was NOT persisted because the doc went final or was re-stamped by
   * another lote mid-flight: the result is that doc's live state, written by
   * another run. `false` for every other path (fresh emission or
   * rejeitada-retry that did re-call SEFAZ).
   */
  readonly reused: boolean;
}

export interface PedidoBundle {
  readonly pedidoId: string;
  readonly pedido: Pedido & { readonly bloquearEmissaoNFe?: unknown };
  readonly filialId: string;
  readonly filial: Filial;
  readonly clienteId: string;
  readonly cliente: Cliente;
  /** The FISCAL address (`pedido.enderecoFiscalOuterRef`) — `<dest><enderDest>`. */
  readonly enderecoDest: Endereco;
  /**
   * Where the goods go, when that is another document (#422). Resolved at
   * load time but judged only where a nota is generated: an unresolvable
   * delivery address must not block `consultarPedido`, which shares this
   * loader, and must not change what a bloqueada / in-flight doc does.
   */
  readonly entrega: EntregaDoPedido;
  readonly operacaoId: string;
  readonly operacao: Operacao;
  /**
   * Pagamentos under `pedidos/{pedidoId}/pagamentos` (subcollection,
   * plural path — mirrors the Flutter ERP's `PAGAMENTO_COLLECTION`).
   * Already filtered by {@link isPagamentoPagante} — the shared "counts as
   * paid" rule, which is `status_pagamento ∈ { null, aprovado, em_disputa }`.
   * A mediation is a HOLD, not a reversal, so a disputed payment still belongs
   * on the nota; a refund arrives as `estornado`/`devolvido` and drops out.
   * May be empty (the NF-e stamps `tPag='90'` sem-pagamento in that case).
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
   * `integracao.tipo` — the SALES CHANNEL, off the same snapshot as
   * {@link integracao} but read UNCONDITIONALLY. {@link intermediadorFromSnap}
   * discards the doc unless `operacao.indIntermed === '1'`, and "which channel
   * sold this" is a separate question from "does this nota carry an
   * `<infIntermed>` block".
   *
   * Null when the doc carries no numeric `tipo`. Consumers must treat null as
   * an UNKNOWN channel and take the conservative arm — see the troco gate in
   * `generator-input.ts`.
   */
  readonly integracaoTipo: IntegracaoTipo | null;
  /**
   * Imposto rules under `operacao/{operacaoId}/regras`. Pre-loaded
   * in the bundle fan-out so the per-item resolver (`resolveItemImposto`)
   * can OR-match against produtoUid / categoriaUid / NCM without any
   * additional Firestore reads. May be empty (common in setups where
   * every produto carries its own `impostoProduto` doc).
   */
  readonly regrasImposto: readonly RegraImposto[];
}

/**
 * The pedido's delivery address, as the NF-e sees it (#422):
 *  - `enderecoFiscal` — no frete, no delivery ref, or a ref to the SAME
 *    document as the fiscal one (path compared after normalization, so
 *    `documents/clientes/C/enderecos/E` and `clientes/C/enderecos/E` are one);
 *  - `outroEndereco` — a different document, read and `cMun`-resolved;
 *  - `irresolvivel` — a delivery ref that cannot be followed. Kept as data
 *    here and refused only by generation (`entregaDaOperacao`).
 *
 * ⚠️ "Different" is judged by the DOCUMENT, never by content. Two documents
 * holding the same address emit a redundant but valid `<entrega>`; comparing
 * content would couple the decision to sanitising/truncation rules and could
 * merge two addresses that really differ.
 */
export type EntregaDoPedido =
  | { readonly tipo: 'enderecoFiscal' }
  | { readonly tipo: 'outroEndereco'; readonly path: string; readonly endereco: Endereco }
  | { readonly tipo: 'irresolvivel'; readonly motivo: string };

/** Per-item fiscal data after merging Pedido item + stamped Imposto. */
export interface FiscalItem {
  readonly produtoUid: string;
  readonly itemIndex: number;
  readonly sku: string | null;
  readonly gtin: string | null;
  readonly nomeDeVenda: string | null;
  readonly precoDeVenda: number;
  readonly descontoUnitario: number | null;
  readonly quantidade: number;
  readonly imposto: Imposto;
  /**
   * Net-of-unit-discount line value: `roundReais((preço − descontoUnitário) × qtd)`.
   * This is the tribute base (ICMS/PIS/COFINS/RTC `vBC`) — matching the legacy
   * Flutter `item.subtotal` — and the weight used to apportion the pedido-level
   * `descontoTotal` across items. It is NOT the wire `<vProd>` (see `vProdBruto`).
   */
  readonly vProd: number;
  /**
   * Gross line value: `roundReais(preço × qtd)`. This is the wire `<prod><vProd>`
   * SEFAZ validates against `vUnCom × qCom` (rejection 629). The discount lives in
   * a separate `<prod><vDesc>` (unit discount + apportioned `descontoTotal`),
   * mirroring the legacy Flutter generator.
   */
  readonly vProdBruto: number;
  /**
   * The item's `dfeReferenciado` (NT 2025.002 Grupo VC, #330), read
   * best-effort: a value that is not the stored shape is kept as an unusable
   * reference (empty chave / NaN nItem) so the document rules REFUSE it with a
   * message, instead of prep throwing or the reference silently vanishing.
   */
  readonly dfeReferenciado: DfeReferenciadoEntrada | null;
  /**
   * The item's `ajusteRtc` — the IBS/CBS amounts of a nota de débito whose tipo
   * binds a fixed cClassTrib (#330) — read best-effort the same way: a stored
   * value that is not the shape keeps NaN amounts, which the document rules
   * refuse by name.
   */
  readonly ajusteRtc: AjusteRtcEntrada | null;
}

/** Best-effort read of a stored `itens[*].ajusteRtc` (see {@link FiscalItem}). */
export function lerAjusteRtc(raw: unknown): AjusteRtcEntrada | null {
  if (raw == null) return null;
  if (typeof raw !== 'object') return { vIBS: Number.NaN, vCBS: Number.NaN, competApur: null };
  const r = raw as { vIBS?: unknown; vCBS?: unknown; competApur?: unknown };
  return {
    vIBS: typeof r.vIBS === 'number' ? r.vIBS : Number.NaN,
    vCBS: typeof r.vCBS === 'number' ? r.vCBS : Number.NaN,
    competApur: typeof r.competApur === 'string' ? r.competApur : null,
  };
}

/** Best-effort read of a stored `itens[*].dfeReferenciado` (see {@link FiscalItem}). */
export function lerDfeReferenciado(raw: unknown): DfeReferenciadoEntrada | null {
  if (raw == null) return null;
  if (typeof raw !== 'object') return { chaveAcesso: '', nItem: Number.NaN };
  const r = raw as { chaveAcesso?: unknown; nItem?: unknown };
  return {
    chaveAcesso: typeof r.chaveAcesso === 'string' ? r.chaveAcesso : '',
    nItem: r.nItem == null ? null : typeof r.nItem === 'number' ? r.nItem : Number.NaN,
  };
}

/**
 * Resolve the full Pedido bundle from Firestore. Pedido's outer refs
 * (`integracaoPedidoOuterRef`, `clientePedidoOuterRef`, …) are `z.unknown()`
 * in the schema today — we interpret them as Firestore document paths
 * stamped by the Flutter app. The issuing filial is resolved one hop
 * further, via the integração's `filialIntegracaoPedidoOuterRef`.
 */
/**
 * Request-scoped read cache for a single `emitirPedidosLote` invocation.
 * Pedidos in one batch routinely share a filial, an operação (+ its
 * `regras` subcollection) and an imposto resolver — without this,
 * `loadPedidoBundle` + `preResolveImpostos` re-read identical docs once
 * per pedido. Keyed by stable identifiers (doc path, operacaoId) and
 * discarded when the batch returns, so there is no staleness window. The
 * single-pedido path passes no context and reads Firestore directly.
 */
export interface BatchReadContext {
  /** Memoized `fs.doc(path).get()` keyed by doc path. */
  readonly docByPath: Map<string, Promise<FirebaseFirestore.DocumentSnapshot>>;
  /** Memoized `operacao/{id}/regras` query keyed by operação path. */
  readonly regraByOperacaoPath: Map<string, Promise<FirebaseFirestore.QuerySnapshot>>;
  /** Imposto resolver shared across pedidos with the same operacaoId. */
  readonly resolverByOperacaoId: Map<string, ImpostoResolver>;
}

export function createBatchReadContext(): BatchReadContext {
  return {
    docByPath: new Map(),
    regraByOperacaoPath: new Map(),
    resolverByOperacaoId: new Map(),
  };
}

/**
 * Read + parse the filial's NFeConfig OUTSIDE a transaction — for the
 * pre-allocation decisions that depend on it (contingency mode →
 * `tpEmis`). The allocation transaction still re-reads it transactionally
 * for the counters; a mode flip between the two reads only affects WHICH
 * doc/lote the emission targets, never counter integrity. Memoized on the
 * batch context so a 50-pedido batch reads each filial's config once.
 */
export async function loadNfeConfigForEmission(
  fs: Firestore,
  filialId: string,
  ctx?: BatchReadContext,
): Promise<NFeConfig> {
  const ref = nfeConfigCollection.docRef(fs, { filialId }, DEFAULT_NFE_CONFIG_DOC_ID);
  let snapP = ctx?.docByPath.get(ref.path);
  if (!snapP) {
    snapP = ref.get();
    ctx?.docByPath.set(ref.path, snapP);
  }
  const snap = await snapP;
  if (!snap.exists) throw new NFeConfigNotFoundError(filialId);
  return nfeConfigSchema.parse(snap.data()) as NFeConfig;
}

export async function loadPedidoBundle(
  fs: Firestore,
  pedidoId: string,
  ctx?: BatchReadContext,
): Promise<PedidoBundle> {
  console.debug(`[nfe/orchestrator] Loading Pedido bundle for pedidoId '${pedidoId}'`);
  // Memoize the shared outer-ref reads against the batch context (if any)
  // so pedidos sharing a filial / operação don't re-fetch identical docs.
  // `getDoc` / `getRegra` dereference dynamic "outer ref" paths (the target
  // collection is only known at runtime, e.g. filial / cliente / operação /
  // endereço and the operação's `regras` subcollection), so they
  // legitimately use raw refs. All WRITES go through the validated handles in
  // `lib/data`; these are read-only.
  /* eslint-disable no-restricted-syntax -- read-only dynamic outer-ref derefs */
  const getDoc = (path: string): Promise<FirebaseFirestore.DocumentSnapshot> => {
    if (!ctx) return fs.doc(path).get();
    let p = ctx.docByPath.get(path);
    if (!p) {
      p = fs.doc(path).get();
      ctx.docByPath.set(path, p);
    }
    return p;
  };
  const getRegra = (opPath: string): Promise<FirebaseFirestore.QuerySnapshot> => {
    if (!ctx) return fs.doc(opPath).collection('regras').get();
    let p = ctx.regraByOperacaoPath.get(opPath);
    if (!p) {
      p = fs.doc(opPath).collection('regras').get();
      ctx.regraByOperacaoPath.set(opPath, p);
    }
    return p;
  };
  /* eslint-enable no-restricted-syntax */

  // eslint-disable-next-line no-restricted-syntax -- read-only; pedido docs are written by apps/web / apps/integrations handles, not here
  const pedidoSnap = await fs.collection('pedidos').doc(pedidoId).get();
  if (!pedidoSnap.exists) throw new NFePedidoNotFoundError(pedidoId);
  const pedido = pedidoSnap.data() as PedidoBundle['pedido'];

  // The issuing filial is NOT on the pedido — it lives on the pedido's
  // integração (`integracao.filialIntegracaoPedidoOuterRef`). Resolve the
  // integração first, then derive the filial path from it. This read is
  // memoized against the batch context (pedidos in a lote routinely share one
  // integração), so it costs at most one extra read per distinct integração.
  const integracaoPath = refToPath(
    getField(pedido, 'integracaoPedidoOuterRef'),
    `pedido '${pedidoId}'.integracaoPedidoOuterRef`,
  );
  if (!integracaoPath)
    throw new NFeOrchestratorError(`pedido '${pedidoId}': integracaoPedidoOuterRef missing`);
  const integracaoSnap = await getDoc(integracaoPath);
  if (!integracaoSnap.exists)
    throw new NFeOrchestratorError(`integracao '${integracaoPath}' not found`);
  const filialPath = refToPath(
    getField(integracaoSnap.data(), 'filialIntegracaoPedidoOuterRef'),
    `integracao '${integracaoPath}'.filialIntegracaoPedidoOuterRef`,
  );
  console.debug(
    `[nfe/orchestrator] Resolved filialPath '${filialPath}' (via integracao ` +
      `'${integracaoPath}') for pedidoId '${pedidoId}'`,
  );
  const clientePath = refToPath(
    getField(pedido, 'clientePedidoOuterRef'),
    `pedido '${pedidoId}'.clientePedidoOuterRef`,
  );
  console.debug(
    `[nfe/orchestrator] Resolved clientePath '${clientePath}' for pedidoId '${pedidoId}'`,
  );
  const operacaoPath = refToPath(
    getField(pedido, 'operacaoPedidoOuterRef'),
    `pedido '${pedidoId}'.operacaoPedidoOuterRef`,
  );
  console.debug(
    `[nfe/orchestrator] Resolved operacaoPath '${operacaoPath}' for pedidoId '${pedidoId}'`,
  );
  const enderecoPath = refToPath(
    getField(pedido, 'enderecoFiscalOuterRef'),
    `pedido '${pedidoId}'.enderecoFiscalOuterRef`,
  );
  console.debug(
    `[nfe/orchestrator] Resolved enderecoPath '${enderecoPath}' for pedidoId '${pedidoId}'`,
  );

  if (!filialPath)
    throw new NFeOrchestratorError(
      `integracao '${integracaoPath}': filialIntegracaoPedidoOuterRef missing`,
    );
  if (!clientePath)
    throw new NFeOrchestratorError(`pedido '${pedidoId}': clientePedidoOuterRef missing`);
  if (!operacaoPath)
    throw new NFeOrchestratorError(`pedido '${pedidoId}': operacaoPedidoOuterRef missing`);
  if (!enderecoPath)
    throw new NFeOrchestratorError(`pedido '${pedidoId}': enderecoFiscalOuterRef missing`);

  // The delivery address (#422), from the RAW frete field rather than the
  // parsed `frete` below: `parseFreteFromPedido` drops the WHOLE block on any
  // parse failure, and a defect in some unrelated frete field must not quietly
  // turn an interstate delivery back into the fiscal UF. The common case —
  // marketplace imports set it to the fiscal ref itself — costs no read.
  const entregaRef = lerRef(
    getField(getField(pedido, 'freteInicial'), 'enderecoFreteOuterReference'),
  );
  const entregaPath =
    entregaRef.tipo === 'caminho' && entregaRef.path !== enderecoPath ? entregaRef.path : null;

  const [
    filialSnap,
    clienteSnap,
    operacaoSnap,
    enderecoSnap,
    pagamentoSnap,
    regraImpostoSnap,
    entregaSnap,
  ] = await Promise.all([
    getDoc(filialPath),
    getDoc(clientePath),
    getDoc(operacaoPath),
    getDoc(enderecoPath),
    // eslint-disable-next-line no-restricted-syntax -- read-only `pagamentos` subcollection
    fs.collection('pedidos').doc(pedidoId).collection('pagamentos').get(),
    getRegra(operacaoPath),
    entregaPath === null ? null : getDoc(entregaPath),
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

  // Schema-parse the operação — it drives tpNF (`tipo`), natOp, CFOP fallbacks
  // and the resolver's default tier. A cast here let a missing/corrupt `tipo`
  // silently emit tpNF='0' (entrada) for a sale (#398); a malformed doc now
  // fails loudly, naming the exact field. NB: `consultarPedido` shares this
  // loader, so a broken operação blocks consultas too — same operator fix.
  const operacaoParse = operacaoSchema.safeParse(operacaoSnap.data());
  if (!operacaoParse.success) {
    const first = operacaoParse.error.issues[0];
    throw new NFeOrchestratorError(
      `operacao '${operacaoPath}' failed operacaoSchema — ` +
        `${first?.path.map(String).join('.') || '(root)'} ${first?.message ?? 'parse failed'}`,
    );
  }
  const operacao: Operacao = operacaoParse.data;
  const frete = parseFreteFromPedido(pedidoId, pedido);
  const integracao = intermediadorFromSnap(pedidoId, integracaoPath, integracaoSnap, operacao);
  const integracaoTipo = integracaoTipoFromSnap(integracaoSnap);
  const regrasImposto = parseRegraImpostoSnapshot(pedidoId, regraImpostoSnap);

  // `codigoMunicipio` (IBGE) is mandatory for enderDest.cMun, enderEmit.cMun
  // AND ide.cMunFG, but nothing on any server path used to produce it (#785).
  // Resolve both endereços from the `CMUN` table here, so the generator stays a
  // pure function of its input and a failure names the document and the CEP.
  //
  // This READS ONLY — neither document is written. The CEP → município cache is
  // the CMUN table itself (the resolver teaches it any CEP it did not know);
  // `endereco.codigoMunicipio` is a manual operator override, never a cache.
  //
  // The patched `filial` MUST be the one returned: `ide.ts` reads
  // `filial.sede.codigoMunicipio` for cMunFG and `parties.ts` for enderEmit.
  const filialRaw = filialSnap.data() as Filial;
  const [enderecoDest, sede, entrega] = await Promise.all([
    ensureCodigoMunicipio(fs, enderecoSnap.data() as Endereco, {
      contexto: `endereco '${enderecoPath}'`,
    }),
    ensureCodigoMunicipio(fs, filialRaw.sede, {
      contexto: `filial '${filialPath}'.sede`,
    }),
    resolverEntrega(fs, pedidoId, entregaRef, entregaPath, entregaSnap),
  ]);

  return {
    pedidoId,
    pedido,
    filialId: filialSnap.id,
    filial: { ...filialRaw, sede },
    clienteId: clienteSnap.id,
    cliente: clienteSnap.data() as Cliente,
    enderecoDest,
    entrega,
    operacaoId: operacaoSnap.id,
    operacao,
    pagamentos,
    frete,
    integracao,
    integracaoTipo,
    regrasImposto,
  };
}

/**
 * Settle the delivery address {@link loadPedidoBundle} read (#422). Never
 * throws for a data problem: each one becomes `irresolvivel` with the reason,
 * and generation refuses the nota with it. Only an error this module does not
 * own is rethrown (root CLAUDE.md rule 6).
 */
async function resolverEntrega(
  fs: Firestore,
  pedidoId: string,
  ref: RefLida,
  path: string | null,
  snap: FirebaseFirestore.DocumentSnapshot | null,
): Promise<EntregaDoPedido> {
  const campo = `pedido '${pedidoId}'.freteInicial.enderecoFreteOuterReference`;
  if (ref.tipo === 'ausente') return { tipo: 'enderecoFiscal' };
  if (ref.tipo === 'malformada') {
    return {
      tipo: 'irresolvivel',
      motivo: `${campo}: malformed reference ${JSON.stringify(ref.bruto)}`,
    };
  }
  // A readable ref with no read issued: it named the fiscal document itself.
  if (path === null || snap === null) return { tipo: 'enderecoFiscal' };
  if (!snap.exists) {
    return { tipo: 'irresolvivel', motivo: `${campo}: endereco '${path}' not found` };
  }
  // `estado` now DECIDES idDest and the CFOP, so it is parsed, not cast.
  const raw = snap.data() as Endereco;
  const uf = ufSchema.safeParse(raw.estado);
  if (!uf.success) {
    return {
      tipo: 'irresolvivel',
      motivo: `delivery endereco '${path}': estado ${JSON.stringify(raw.estado ?? null)} is not a UF`,
    };
  }
  try {
    const endereco = await ensureCodigoMunicipio(
      fs,
      { ...raw, estado: uf.data },
      { contexto: `delivery endereco '${path}'` },
    );
    return { tipo: 'outroEndereco', path, endereco };
  } catch (err) {
    if (err instanceof NFeOrchestratorError) return { tipo: 'irresolvivel', motivo: err.message };
    throw err;
  }
}

/**
 * Parse the `regras` subcollection snapshot, dropping (with a
 * warning) any doc that fails `regraImpostoSchema` validation. The
 * resolver tolerates an empty array — the cascade will fall through to
 * the per-item `pedido.itens[i].imposto` (or fail loudly when nothing
 * stamps the item).
 */
export function parseRegraImpostoSnapshot(
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
export function parseFreteFromPedido(
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
 * The marketplace intermediator Integracao for `<infIntermed>`, parsed from the
 * ALREADY-loaded integração snapshot — the doc is fetched up-front in
 * `loadPedidoBundle` to resolve the issuing filial, so this adds no extra read.
 * Returns null for non-marketplace operações (`indIntermed !== '1'`) or when the
 * doc fails `integracaoSchema` (the `<infIntermed>` block is then simply omitted).
 */
export function intermediadorFromSnap(
  pedidoId: string,
  integracaoPath: string,
  integracaoSnap: FirebaseFirestore.DocumentSnapshot,
  operacao: Operacao,
): Integracao | null {
  if (operacao.indIntermed !== IND_INTERMED_OPERACAO.plataformaTerceiros) return null;
  const parsed = integracaoSchema.safeParse(integracaoSnap.data());
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
 * `integracao.tipo` off the ALREADY-loaded snapshot — no extra read.
 *
 * Deliberately NOT schema-parsed and NOT gated on `indIntermed`, unlike
 * {@link intermediadorFromSnap}. Callers feed this to `ehMarketplace`
 * (`@delfrance/schemas`), which is documented to TOLERATE a value outside the
 * enum — the migrated legacy corpus carries wire-format enums
 * `integracaoTipoSchema` does not model — and to answer "is a marketplace" for
 * it. That is the conservative arm of every gate built on it, so parsing
 * strictly here would buy nothing and lose the legacy tipos we CAN read.
 */
export function integracaoTipoFromSnap(
  integracaoSnap: FirebaseFirestore.DocumentSnapshot,
): IntegracaoTipo | null {
  // `getField(snap.data(), …)` — the reader this file already uses on THIS
  // snapshot (see the filial resolve above). `snap.get()` would work against a
  // real DocumentSnapshot and blow up on every hand-rolled test double.
  const raw = getField(integracaoSnap.data(), 'tipo');
  return typeof raw === 'number' ? (raw as IntegracaoTipo) : null;
}

/**
 * Parse + filter raw pagamento docs from the `pedidos/{id}/pagamentos`
 * subcollection. Docs that fail schema parse are skipped with a warn — a single
 * malformed doc must not block emission.
 *
 * ⚠️ The predicate is {@link isPagamentoPagante}, the SHARED rule — not a local
 * copy of it. This used to inline `status_pagamento === null || === aprovado`,
 * a faithful port of Flutter's `pedido_nfe_base.dart:449`, and the duplication
 * was silent debt until the rule changed: widening the shared helper to cover
 * `em_disputa` left the NF-e bundle disagreeing with the footer, both admin
 * reconciles and every other "how much is paid?" consumer, with nothing
 * failing to say so. One rule, one definition.
 */
export function loadPagamentosFromSnapshot(
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
    if (isPagamentoPagante(p.status_pagamento)) {
      out.push(p);
    }
  }
  return out;
}

export function getField(obj: unknown, key: string): unknown {
  return obj && typeof obj === 'object' && key in obj
    ? (obj as Record<string, unknown>)[key]
    : undefined;
}

/**
 * A stored outer ref, read for dereferencing. Three outcomes, kept apart on
 * purpose: an ABSENT ref (the field is unset) and a MALFORMED one (set, but no
 * document path can be formed from it) are different operator problems, and
 * reporting the second as "missing" sends the operator to fill in a field that
 * is already filled in.
 */
export type RefLida =
  | { readonly tipo: 'ausente' }
  | { readonly tipo: 'caminho'; readonly path: string }
  | { readonly tipo: 'malformada'; readonly bruto: unknown };

/**
 * Read an outer ref into the BARE document path the Admin SDK's `doc()` takes.
 *
 * Accepts every stored form: the canonical `documents/<col>/<id>`
 * (`outerRefSchema` — what `toOuterRef`, the ML/Shopee importers and the
 * Flutter `pathWithDocuments` write), the bare `<col>/<id>`, and a legacy
 * object carrying a string `path`. ⚠️ The canonical form used to be handed to
 * `fs.doc()` verbatim, and the Admin SDK refuses it — `documents/` makes the
 * segment count odd ("must point to a document") — so every pedido written by
 * the app itself failed to load, while every fixture here, seeded with bare
 * paths, passed.
 *
 * The result is also the memo key of {@link BatchReadContext.docByPath}, so the
 * same document referenced in two forms is read once.
 */
export function lerRef(ref: unknown): RefLida {
  if (!ref) return { tipo: 'ausente' };
  const bruto = typeof ref === 'object' && 'path' in ref ? (ref as { path?: unknown }).path : ref;
  const path = toDocPathOrNull(bruto);
  return path === null ? { tipo: 'malformada', bruto: ref } : { tipo: 'caminho', path };
}

/**
 * {@link lerRef} for a ref the caller needs: `null` when absent (the caller
 * names what is missing), the bare path when readable, and a thrown
 * `NFeOrchestratorError` naming `campo` when malformed.
 */
export function refToPath(ref: unknown, campo: string): string | null {
  const lida = lerRef(ref);
  if (lida.tipo === 'ausente') return null;
  if (lida.tipo === 'caminho') return lida.path;
  throw new NFeOrchestratorError(
    `${campo}: malformed reference ${JSON.stringify(lida.bruto)} — expected ` +
      `'documents/<collection>/<id>' or '<collection>/<id>' (an even number of segments)`,
  );
}

/**
 * For every pedido item whose `imposto` is missing **or fails the engine
 * `impostoSchema`**, run the resolver cascade (item → impostoProduto →
 * impostoCategoria → regraImposto → operação default) and stamp the
 * resolved Imposto back onto the item. Items whose imposto can't be
 * resolved are left untouched — flattenAndValidate will throw
 * `NFeMissingImpostoError` (absent) or `NFeOrchestratorError` naming the
 * bad sub-field (invalid stamp, nothing resolvable).
 *
 * A stamped-but-invalid imposto used to abort emission without ever
 * consulting the cascade (#398) — contradicting both the resolver
 * contract and Flutter, which re-resolved partial stamps. Deliberate
 * deviation from Flutter: Flutter MERGED (kept the stamped blob and
 * filled only the missing `configuracaoICMS` from the cascade); we
 * replace the whole invalid blob with the cascade result — the resolver
 * contract is whole-Imposto, and partial merges of tribute configs
 * produce untestable hybrids.
 *
 * Items already carrying a valid imposto skip the resolver entirely
 * (no Firestore reads for those) — preserves Phase A retail fixtures
 * that pre-stamp imposto at order time.
 */
export async function preResolveImpostos(
  bundle: PedidoBundle,
  fs: Firestore,
  ctx?: BatchReadContext,
): Promise<void> {
  const itens = (bundle.pedido as { itens?: Record<string, unknown[]> }).itens ?? {};
  const missing: Array<{ produtoUid: string; entry: Record<string, unknown> }> = [];
  for (const [produtoUid, list] of Object.entries(itens)) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (entry == null || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      if (e.imposto == null) {
        missing.push({ produtoUid, entry: e });
        continue;
      }
      const stamped = impostoSchema.safeParse(e.imposto);
      if (!stamped.success) {
        const first = stamped.error.issues[0];
        console.warn(
          `[nfe/orchestrator] pedido '${bundle.pedidoId}': item (produto '${produtoUid}') carries an invalid imposto stamp — ${first?.path.map(String).join('.') || '(root)'} ${first?.message ?? 'parse failed'} — running the resolver cascade`,
        );
        missing.push({ produtoUid, entry: e });
      }
    }
  }
  if (missing.length === 0) return;

  console.debug(
    `[nfe/orchestrator] pedido '${bundle.pedidoId}': ${missing.length} item(s) ` +
      'missing imposto — running resolver cascade',
  );
  // Share one resolver per operacaoId across the batch: its
  // produtoUid→Imposto memo (and the produto/imposto-subcoll reads behind
  // it) then span every pedido on the same operação instead of resetting
  // per pedido. The cascade inputs (operacaoId + regrasImposto + the operação's
  // own default config) are identical for a given operacaoId, so the shared
  // instance is correct.
  let resolver = ctx?.resolverByOperacaoId.get(bundle.operacaoId);
  if (!resolver) {
    resolver = createFirestoreImpostoResolver(fs, {
      operacaoId: bundle.operacaoId,
      regrasImposto: bundle.regrasImposto,
      operacao: bundle.operacao as unknown as Record<string, unknown>,
    });
    ctx?.resolverByOperacaoId.set(bundle.operacaoId, resolver);
  }
  for (const { produtoUid, entry } of missing) {
    // Pass the (possibly invalid) stamp through — the resolver's tier 1
    // falls through on an invalid blob and its NCM can still key the
    // regra tier. When the cascade also misses, the original blob stays
    // for flattenAndValidate to report precisely.
    const resolved = await resolver.resolve(produtoUid, entry.imposto ?? null);
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
export function flattenAndValidate(bundle: PedidoBundle): FiscalItem[] {
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
        vProd: roundReais((precoDeVenda - (descontoUnitario ?? 0)) * quantidade),
        vProdBruto: roundReais(precoDeVenda * quantidade),
        dfeReferenciado: lerDfeReferenciado(e.dfeReferenciado),
        ajusteRtc: lerAjusteRtc(e.ajusteRtc),
      });
    });
  }
  if (out.length === 0) {
    throw new NFeOrchestratorError(`pedido '${bundle.pedidoId}' has no items`);
  }
  return out;
}
