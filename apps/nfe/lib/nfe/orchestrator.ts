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
 * Touches Firestore (Admin SDK) and the library's typed operations
 * layer. Everything else (cert, agent, endpoints, ambiente) comes
 * pre-baked from `getNFeRuntime`.
 */
import type { Firestore } from 'firebase-admin/firestore';

import {
  applyOutcome,
  autorizarLote,
  consultarSituacaoNFe,
  generateNFe,
  outcomeFromRetConsSit,
  outcomeFromRetEnviNFe,
  signNFe,
  type GeneratorInput,
  type GeneratorItem,
  type NFeStatePatch,
  type SefazCall,
} from '@delfrance/integrations-nfe';
import {
  ESTADO_NFE,
  type Cliente,
  type Endereco,
  type EstadoNFe,
  type Filial,
  type Operacao,
  type Pedido,
} from '@delfrance/schemas';

import type { NFeRuntime } from './runtime';
import {
  buildEmptyTotalXml,
  buildSimplePag,
  buildSimpleTransp,
  buildSimplesNacionalCsosn102ImpostoXml,
} from './tribute';

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

/** Output of a single emit cycle — the route returns this shape verbatim. */
export interface EmitResult {
  readonly nfeId: string;
  readonly pedidoId: string;
  readonly estado: EstadoNFe;
  readonly chave: string;
  readonly nRec: string | null;
  readonly cStat: string;
  readonly xMotivo: string;
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
  const pedidoSnap = await fs.collection('pedidos').doc(pedidoId).get();
  if (!pedidoSnap.exists) throw new NFePedidoNotFoundError(pedidoId);
  const pedido = pedidoSnap.data() as PedidoBundle['pedido'];

  // Pedido's outer refs are pass-through (`z.unknown()`) in the schema —
  // cast at this boundary. Tolerate either a doc-path string or a
  // DocumentReference instance.
  const filialPath = refToPath(getField(pedido, 'filialPedidoOuterRef'));
  const clientePath = refToPath(getField(pedido, 'clientePedidoOuterRef'));
  const operacaoPath = refToPath(getField(pedido, 'operacaoPedidoOuterRef'));
  const enderecoPath = refToPath(getField(pedido, 'enderecoFiscalOuterRef'));

  if (!filialPath) throw new NFeOrchestratorError(`pedido '${pedidoId}': filialPedidoOuterRef missing`);
  if (!clientePath) throw new NFeOrchestratorError(`pedido '${pedidoId}': clientePedidoOuterRef missing`);
  if (!operacaoPath) throw new NFeOrchestratorError(`pedido '${pedidoId}': operacaoPedidoOuterRef missing`);
  if (!enderecoPath) throw new NFeOrchestratorError(`pedido '${pedidoId}': enderecoFiscalOuterRef missing`);

  const [filialSnap, clienteSnap, operacaoSnap, enderecoSnap] = await Promise.all([
    fs.doc(filialPath).get(),
    fs.doc(clientePath).get(),
    fs.doc(operacaoPath).get(),
    fs.doc(enderecoPath).get(),
  ]);

  if (!filialSnap.exists) throw new NFeOrchestratorError(`filial '${filialPath}' not found`);
  if (!clienteSnap.exists) throw new NFeOrchestratorError(`cliente '${clientePath}' not found`);
  if (!operacaoSnap.exists) throw new NFeOrchestratorError(`operacao '${operacaoPath}' not found`);
  if (!enderecoSnap.exists) throw new NFeOrchestratorError(`endereco '${enderecoPath}' not found`);

  return {
    pedidoId,
    pedido,
    filialId: filialSnap.id,
    filial: filialSnap.data() as Filial,
    clienteId: clienteSnap.id,
    cliente: clienteSnap.data() as Cliente,
    enderecoDest: enderecoSnap.data() as Endereco,
    operacaoId: operacaoSnap.id,
    operacao: operacaoSnap.data() as Operacao,
  };
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
 * Allocate the next `nNF` for a (filial, serie) pair via a Firestore
 * transaction. Counter doc lives at `filiais/{filialId}/nfe-counters/{serie}`.
 * Initialised to 1 on first read.
 */
export async function nextNumeracao(
  fs: Firestore,
  filialId: string,
  serie: number,
): Promise<number> {
  const ref = fs
    .collection('filiais')
    .doc(filialId)
    .collection('nfe-counters')
    .doc(String(serie));
  return fs.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const curr = snap.exists ? Number((snap.data() as { next?: number }).next ?? 0) : 0;
    const nNF = curr + 1;
    tx.set(ref, { next: nNF }, { merge: true });
    return nNF;
  });
}

/**
 * Project a `PedidoBundle` into the typed `GeneratorInput` shape. Items
 * come from `pedido.itens` (a record keyed by produtoUid → array). For
 * each item, the homologação tributary stub fills in `impostoXml`.
 */
export function buildGeneratorInput(
  bundle: PedidoBundle,
  numeracao: number,
  ambiente: NFeRuntime['ambiente'],
): GeneratorInput {
  const flatItems: { produtoUid: string; index: number; entry: ReturnType<typeof itemAccessor> }[] = [];
  const itens = (bundle.pedido as { itens?: Record<string, unknown[]> }).itens ?? {};
  for (const [produtoUid, list] of Object.entries(itens)) {
    if (!Array.isArray(list)) continue;
    list.forEach((entry, index) => {
      flatItems.push({ produtoUid, index, entry: itemAccessor(entry) });
    });
  }
  if (flatItems.length === 0) {
    throw new NFeOrchestratorError(`pedido '${bundle.pedidoId}' has no items`);
  }

  const cfop = ambiente === 'producao' && bundle.enderecoDest.estado !== bundle.filial.sede.estado
    ? (bundle.operacao.cfopInterestadual ?? bundle.operacao.cfop ?? '6102')
    : (bundle.operacao.cfop ?? '5102');

  const genItems: GeneratorItem[] = flatItems.map(({ produtoUid, index, entry }, i) => {
    const item: GeneratorItem = {
      nItem: i + 1,
      cProd: entry.sku ?? entry.gtin ?? (produtoUid.slice(0, 60) || `ITEM-${i + 1}`),
      cEAN: entry.gtin && /^\d{8,14}$/.test(entry.gtin) ? entry.gtin : 'SEM GTIN',
      xProd: entry.nomeDeVenda ?? `Item ${i + 1}`,
      NCM: bundle.operacao.NCM ?? '00000000',
      CFOP: cfop,
      uCom: bundle.operacao.unidade ?? 'UN',
      qCom: entry.quantidade,
      vUnCom: entry.precoDeVenda,
      vProd: round2((entry.precoDeVenda - (entry.descontoUnitario ?? 0)) * entry.quantidade),
      cEANTrib: entry.gtin && /^\d{8,14}$/.test(entry.gtin) ? entry.gtin : 'SEM GTIN',
      uTrib: bundle.operacao.unidade ?? 'UN',
      qTrib: entry.quantidade,
      vUnTrib: entry.precoDeVenda,
      indTot: '1',
      impostoXml: '',
    };
    return { ...item, impostoXml: buildSimplesNacionalCsosn102ImpostoXml(item) };
  });
  void produtoUidUnused; // silence "produtoUid" unused warning at lint time

  const vNF = round2(genItems.reduce((acc, it) => acc + it.vProd, 0));

  return {
    ambiente,
    numeracao,
    serie: 1,
    tpEmis: 1,
    dhEmi: new Date(),
    filial: bundle.filial,
    operacao: bundle.operacao,
    cliente: bundle.cliente,
    enderecoDest: bundle.enderecoDest,
    itens: genItems,
    totalXml: buildEmptyTotalXml(genItems),
    transpXml: buildSimpleTransp(),
    pagXml: buildSimplePag(vNF),
  };
}

// Local alias to keep TS happy with the closure-style helpers above.
function produtoUidUnused() { /* no-op */ }

interface FlatItem {
  readonly sku: string | null;
  readonly gtin: string | null;
  readonly nomeDeVenda: string | null;
  readonly precoDeVenda: number;
  readonly descontoUnitario: number | null;
  readonly quantidade: number;
}

function itemAccessor(entry: unknown): FlatItem {
  const o = (entry ?? {}) as Record<string, unknown>;
  return {
    sku: typeof o.sku === 'string' ? o.sku : null,
    gtin: typeof o.gtin === 'string' ? o.gtin : null,
    nomeDeVenda: typeof o.nomeDeVenda === 'string' ? o.nomeDeVenda : null,
    precoDeVenda: Number(o.precoDeVenda ?? 0),
    descontoUnitario: o.descontoUnitario == null ? null : Number(o.descontoUnitario),
    quantidade: Number(o.quantidade ?? 0),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The full emit cycle. Persists `estado='enviando'` BEFORE the SOAP send;
 * applies `applyOutcome` after; runs an inline `consultarSituacaoNFe`
 * if the state machine asks for `recover-via-consulta`.
 */
export async function emitirPedido(
  fs: Firestore,
  rt: NFeRuntime,
  pedidoId: string,
): Promise<EmitResult> {
  const bundle = await loadPedidoBundle(fs, pedidoId);
  if (bundle.pedido.bloquearEmissaoNFe) {
    throw new NFeBlockedError(pedidoId);
  }

  const numeracao = await nextNumeracao(fs, bundle.filialId, 1);
  const input = buildGeneratorInput(bundle, numeracao, rt.ambiente);
  const generated = generateNFe(input);
  const signedXml = signNFe(generated.nfeXml, rt.cert);

  const nfeRef = fs
    .collection('pedidos')
    .doc(pedidoId)
    .collection('nfev4')
    .doc(generated.chave);
  const now = new Date().toISOString();
  const idLote = generated.chave.slice(-15);

  // === Anti-loss anchor: persist BEFORE the SOAP send. =====================
  await nfeRef.set(
    {
      numeracao,
      serie: 1,
      tpEmis: 1,
      estado: ESTADO_NFE.enviando,
      chave: generated.chave,
      idLote,
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
    },
    { merge: false },
  );
  // ========================================================================

  const call: SefazCall = {
    url: rt.endpoints.NfeAutorizacao,
    cert: rt.cert,
    agent: rt.agent,
    tpAmb: rt.tpAmb,
  };

  const retEnvi = await autorizarLote(call, { idLote, NFe: [signedXml] });
  let outcome = outcomeFromRetEnviNFe(retEnvi);
  let patch = applyOutcome(
    { estado: ESTADO_NFE.enviando, retries: 0 },
    outcome,
  );

  // Duplicidade / lote-not-found → query SEFAZ for the real status.
  if (patch.action === 'recover-via-consulta') {
    const consSitCall: SefazCall = {
      ...call,
      url: rt.endpoints.NfeConsultaProtocolo,
    };
    const retSit = await consultarSituacaoNFe(consSitCall, { chave: generated.chave });
    outcome = outcomeFromRetConsSit(retSit);
    patch = applyOutcome({ estado: patch.estado, retries: patch.retries }, outcome);
  }

  await persistPatch(nfeRef, patch);

  return {
    nfeId: generated.chave,
    pedidoId,
    estado: patch.estado,
    chave: generated.chave,
    nRec: patch.nRec,
    cStat: patch.cStat,
    xMotivo: patch.xMotivo,
  };
}

async function persistPatch(
  nfeRef: FirebaseFirestore.DocumentReference,
  patch: NFeStatePatch,
): Promise<void> {
  await nfeRef.set(
    {
      estado: patch.estado,
      cStat: patch.cStat,
      xMotivo: patch.xMotivo,
      retries: patch.retries,
      nRec: patch.nRec,
      ultima_modificacao: new Date().toISOString(),
    },
    { merge: true },
  );
}
