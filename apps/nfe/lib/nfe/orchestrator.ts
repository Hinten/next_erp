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
  buildPagXml,
  buildTotalXml,
  buildTranspXml,
  consultarSituacaoNFe,
  generateNFe,
  impostoSchema,
  nextIdLote,
  nextNumeracao,
  nfeConfigStoreFromFirestore,
  outcomeFromRetConsSit,
  outcomeFromRetEnviNFe,
  signNFe,
  type GeneratorInput,
  type GeneratorItem,
  type Imposto,
  type NFeStatePatch,
  type Payment,
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
import { z } from 'zod';

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
  const cfopField = isInterstate ? 'cfopInterestadual' : 'cfop';

  const genItems: GeneratorItem[] = items.map((it, i) => {
    const where = `pedido '${bundle.pedidoId}' item ${it.itemIndex} (produto '${it.produtoUid}')`;
    // Resolution: item-imposto wins; operação as fallback; throw when both
    // are missing. Same rule for NCM / unidade / CEST below.
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
    // CEST is optional (only required when the product is in the CEST
    // list). Item wins, operação as fallback, omit when neither set.
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

  const totals = aggregateTotals(items.map((it) => ({ item: { vProd: it.vProd }, imposto: it.imposto })));
  const payments = buildPaymentsFromPedido(bundle, totals.vNF);

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
    transpXml: buildTranspXml(), // Phase A default; Phase D reads Pedido.frete
    pagXml: buildPagXml(payments),
  };
}

/**
 * Project Pedido.pagamentos into typed Payment entries. Phase A
 * fallback: when no payments are stamped, emit one `tPag='99'` (outros)
 * for vNF so the NF-e is XSD-valid. Real wiring of the Pedido.pagamentos
 * subcollection is a Phase D follow-up.
 */
function buildPaymentsFromPedido(bundle: PedidoBundle, vNF: number): Payment[] {
  // The Pedido schema today is z.passthrough() — pagamentos may or may
  // not be present. When absent, fall back to the documented Phase A
  // default.
  const rawPag = (bundle.pedido as { pagamentos?: unknown }).pagamentos;
  if (!Array.isArray(rawPag) || rawPag.length === 0) {
    return [{ tPag: '99', vPag: vNF }];
  }
  return rawPag
    .map((p) => {
      const o = (p ?? {}) as Record<string, unknown>;
      return {
        tPag: typeof o.tPag === 'string' ? (o.tPag as Payment['tPag']) : '99',
        vPag: Number(o.vPag ?? 0),
      };
    })
    .filter((p) => Number.isFinite(p.vPag) && p.vPag > 0);
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

  console.debug(`[nfe/orchestrator] Starting emit cycle for pedidoId '${pedidoId}', runtime ambiente '${rt.ambiente}'`);

  const bundle = await loadPedidoBundle(fs, pedidoId);
  if (bundle.pedido.bloquearEmissaoNFe) {
    throw new NFeBlockedError(pedidoId);
  }
  const items = flattenAndValidate(bundle);

  // Allocate transactionally from the per-filial NFeConfig — atomic, no
  // duplicates, no gaps (proved by numeracao.staging.test.ts).
  const store = nfeConfigStoreFromFirestore(fs);
  const { nNF, serie } = await nextNumeracao(store, bundle.filialId);
  const idLote = await nextIdLote(store, bundle.filialId);

  const input = buildGeneratorInput(bundle, items, nNF, serie, rt.ambiente);
  const generated = generateNFe(input);
  const signedXml = signNFe(generated.nfeXml, rt.cert);

  const nfeRef = fs
    .collection('pedidos')
    .doc(pedidoId)
    .collection('nfev4')
    .doc(generated.chave);
  const now = new Date().toISOString();

  // === Anti-loss anchor: persist BEFORE the SOAP send. =====================
  await nfeRef.set(
    {
      numeracao: nNF,
      serie,
      tpEmis: 1,
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

  const retEnvi = await autorizarLote(call, {
    idLote: String(idLote),
    NFe: [signedXml],
  });
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

// Internals exposed for tests only.
export const __internal = { flattenAndValidate, buildPaymentsFromPedido };
// Re-export Zod so test fixtures can use the same z instance.
export { z };
