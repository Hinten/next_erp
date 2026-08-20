import {
  ORIGEM_INCIDENTE,
  TIPO_INCIDENTE,
  derivePedidoTotals,
  idFromRef,
  pedidoSchema,
  toOuterRef,
  type ItemDoPedido,
  type Pedido,
} from '@delfrance/schemas';
import { CAMPOS_ESTOQUE_SYNC } from './estoquePlan';
import type { PedidoDataPort, PedidoDevolucaoDataPort, PedidoWriteOp } from './port';
import { PedidoConflictError, buildIncidenteOp, remotelyChangedFields } from './usecases';
import { PEDIDO_COUNTER_PATH, mintNumeros, operacaoNumeroPrefix } from './numero';

/**
 * Devolução (returns) save-time side effects behind the SDK-agnostic port —
 * ports of the legacy Flutter flows (#488 troca / #551 devolução integral):
 * creating the entrada "devolução" pedido atomically with the origin-pedido
 * link updates, collecting the referenced NF-e chaves, and writing the
 * troca/devolução incidentes.
 */

/** Full doc path of a pedido. */
export const PEDIDO_PATH = (id: string): string => `pedidos/${id}`;

/**
 * Sentinel key for "no origin pedido" (avulso items) in the outer
 * `itensDevolvidos` map, and for "no produto" in the inner map — the legacy
 * `'NONE'` (see `pedidoSchema.itensDevolvidos`).
 */
const NONE_KEY = 'NONE';

type ItensDevolvidos = Record<string, Record<string, ItemDoPedido[]>>;

/** Extract the doc id from an outer-ref value; null for anything unparseable. */
function refIdOf(ref: unknown): string | null {
  if (typeof ref !== 'string' || ref === '') return null;
  const id = idFromRef(ref);
  return id === '' ? null : id;
}

/** Append `add` to a wire `entradasRelacionadas`/`saidasRelacionadas` value, deduped. */
function unionIds(current: unknown, add: string): string[] {
  const list = Array.isArray(current)
    ? current.filter((x): x is string => typeof x === 'string')
    : [];
  return list.includes(add) ? list : [...list, add];
}

// ---------------------------------------------------------------------------
// Operação de devolução
// ---------------------------------------------------------------------------

/** The operação the entrada devolução will be created under. */
export interface DevolucaoOperacaoInfo {
  /** `documents/operacao/<id>` (null when no operação could be resolved). */
  outerRef: string | null;
  id: string | null;
  nome: string | null;
  /** Whether the operação can emit a devolução NF-e (`ehFiscal` + `finNFe === 4`). */
  fiscalCapable: boolean;
}

function toOperacaoInfo(id: string, operacao: Record<string, unknown>): DevolucaoOperacaoInfo {
  return {
    outerRef: toOuterRef(`operacao/${id}`),
    id,
    nome: typeof operacao.nome === 'string' ? operacao.nome : null,
    fiscalCapable: operacao.ehFiscal !== false && operacao.finNFe === 4,
  };
}

/**
 * Resolve the operação for an entrada devolução: the integração's dedicated
 * `operacaoDevolucaoOuterRef` when the pedido has an integração and the chain
 * dereferences to an existing operação; otherwise the default entrada operação
 * (`findOperacaoEntradaPadrao`). When neither resolves, every field is null and
 * `fiscalCapable` is false — the devolução is still created, just numero-prefixed
 * `NUL` and never fiscal.
 */
export async function resolveDevolucaoOperacao(
  port: PedidoDevolucaoDataPort,
  args: { integracaoOuterRef: unknown },
): Promise<DevolucaoOperacaoInfo> {
  const integracaoId = refIdOf(args.integracaoOuterRef);
  if (integracaoId !== null) {
    const integracao = await port.getIntegracao(integracaoId);
    const operacaoId = refIdOf(integracao?.operacaoDevolucaoOuterRef);
    if (operacaoId !== null) {
      const operacao = await port.getOperacao(operacaoId);
      if (operacao !== null) return toOperacaoInfo(operacaoId, operacao);
    }
  }
  const padrao = await port.findOperacaoEntradaPadrao();
  if (padrao === null) return { outerRef: null, id: null, nome: null, fiscalCapable: false };
  return toOperacaoInfo(padrao.id, padrao.data);
}

// ---------------------------------------------------------------------------
// NF-e chaves referenciadas
// ---------------------------------------------------------------------------

/**
 * Collect the approved NF-e chaves of the origin pedidos, for the devolução's
 * `chNFeReferenciadas`. `'first'` takes the first approved doc with a
 * NON-EMPTY chave per origin (the legacy #488 troca flow — a null-chave first
 * doc must not silently drop the origin's reference); `'all'` takes every
 * approved chave (the legacy #551 integral pre-seed). Null/empty chaves are
 * skipped; an origin with no approved NF-e contributes nothing. The per-origin
 * reads run concurrently; the result preserves the `originIds` order.
 *
 * `listNFesAprovadas` carries no orderBy (Firestore result order is undefined),
 * so the docs are sorted here by `ultima_modificacao` desc — "first" then
 * deterministically means the LATEST approved NF-e, matching the app's other
 * latest-NF-e pickers.
 */
export async function collectChNFeReferenciadas(
  port: PedidoDevolucaoDataPort,
  originIds: ReadonlyArray<string>,
  perOrigin: 'first' | 'all',
): Promise<string[]> {
  const modificacaoDe = (nfe: Record<string, unknown>): number =>
    typeof nfe.ultima_modificacao === 'number' ? nfe.ultima_modificacao : Number.NEGATIVE_INFINITY;
  const perOriginChaves = await Promise.all(
    originIds.map(async (originId) => {
      const nfes = await port.listNFesAprovadas(originId);
      const chaves = [...nfes]
        .sort((a, b) => modificacaoDe(b) - modificacaoDe(a))
        .map((nfe) => nfe.chave)
        .filter((chave): chave is string => typeof chave === 'string' && chave !== '');
      return perOrigin === 'first' ? chaves.slice(0, 1) : chaves;
    }),
  );
  return perOriginChaves.flat();
}

// ---------------------------------------------------------------------------
// Devolução pedido doc (the entrada created alongside a troca saída — #488)
// ---------------------------------------------------------------------------

/**
 * Build the entrada devolução pedido doc (sans id/numero) from a saída's
 * `itensDevolvidos`: items re-keyed by produtoUid across ALL outer buckets
 * (including the `'NONE'` avulso bucket — the legacy flow iterated every
 * origin), keeping only items with `quantidade > 0` and preserving item order.
 * `ehSaida: false`, `estado: 'pago'`; the cliente/endereço/lista/vendedor/
 * integração refs are copied from the saída; money caches come from
 * `derivePedidoTotals` exactly like the form resolver (`valorCobrado` = the
 * derived total). `saidasRelacionadas` is non-empty by contract (the caller
 * passes the origin ids). Runs `pedidoSchema.parse`, so defaults are filled and
 * every nullable field is `null`, never `undefined` (Firestore SDK v12 rejects
 * `undefined`).
 */
export function buildDevolucaoPedido(
  port: PedidoDataPort,
  args: {
    saida: Pedido;
    itensDevolvidos: ItensDevolvidos;
    operacaoOuterRef: string | null;
    chNFeReferenciadas: ReadonlyArray<string>;
    saidasRelacionadas: ReadonlyArray<string>;
  },
): Record<string, unknown> {
  const itens: Record<string, ItemDoPedido[]> = {};
  for (const porProduto of Object.values(args.itensDevolvidos)) {
    for (const lista of Object.values(porProduto)) {
      for (const item of lista) {
        if (!(item.quantidade > 0)) continue;
        const key = item.produtoUid && item.produtoUid !== '' ? item.produtoUid : NONE_KEY;
        (itens[key] ??= []).push(item);
      }
    }
  }

  const totals = derivePedidoTotals({
    itens: Object.values(itens).flat(),
    descontoTotal: 0,
    freteInicial: null,
    itensDevolvidos: null,
  });

  const now = port.now();
  const doc = pedidoSchema.parse({
    ehSaida: false,
    estado: 'pago',
    itens,
    itensIds: Object.keys(itens),
    vendedorPedidoOuterRef: args.saida.vendedorPedidoOuterRef ?? null,
    integracaoPedidoOuterRef: args.saida.integracaoPedidoOuterRef ?? null,
    clientePedidoOuterRef: args.saida.clientePedidoOuterRef ?? null,
    enderecoFiscalOuterRef: args.saida.enderecoFiscalOuterRef ?? null,
    listaDePrecosOuterRef: args.saida.listaDePrecosOuterRef ?? null,
    operacaoPedidoOuterRef: args.operacaoOuterRef,
    chNFeReferenciadas: args.chNFeReferenciadas.length > 0 ? [...args.chNFeReferenciadas] : null,
    saidasRelacionadas: [...args.saidasRelacionadas],
    valorCobrado: totals.valorCobrado,
    timestamp: now,
    ultimaModificacao: now,
  });
  return doc as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Troca com devolução (#488): prepare (pre-dialog reads) + atomic save
// ---------------------------------------------------------------------------

/** Everything the pre-save dialog + the atomic save need, read once. */
export interface DevolucaoSavePrepared {
  /** Origin pedido ids (the outer `itensDevolvidos` keys, minus `'NONE'`). */
  originIds: string[];
  /** Origin docs as read at prepare time — the drift baselines for the save. */
  originBaselines: ReadonlyMap<string, Record<string, unknown>>;
  /** Any read origin already links an entrada (a previous devolução exists). */
  temOutraDevolucao: boolean;
  operacao: DevolucaoOperacaoInfo;
  /** First approved chave per origin (legacy #488). */
  chNFeReferenciadas: string[];
}

/**
 * Gather everything the "criar troca?" flow needs BEFORE the confirmation
 * dialog: the origin ids/baselines, whether an origin already has a devolução,
 * the devolução operação, and the referenced chaves. Returns null when the flow
 * doesn't apply (`values.ehSaida !== true`, or no `itensDevolvidos`).
 *
 * A missing origin doc contributes no baseline and no chave but STAYS in
 * `originIds` (and therefore in the devolução's `saidasRelacionadas`) —
 * legacy-faithful: the Flutter flow never read the origin docs at all, so a
 * dangling origin id still rides the link fields. The baselines let
 * {@link criarSaidaComDevolucao} drift-check the origins that DID exist here.
 */
export async function prepareDevolucaoSave(
  port: PedidoDevolucaoDataPort,
  args: { values: Pedido },
): Promise<DevolucaoSavePrepared | null> {
  const { values } = args;
  if (values.ehSaida !== true) return null;
  const itensDevolvidos = values.itensDevolvidos;
  if (itensDevolvidos == null || Object.keys(itensDevolvidos).length === 0) return null;

  // `''` is excluded like `'NONE'` (matching `novosOriginsDeTroca`): an empty
  // key would reach `getPedido('')` and throw an invalid doc-ref error.
  const originIds = Object.keys(itensDevolvidos).filter((k) => k !== NONE_KEY && k !== '');
  // Independent reads — the baselines, the chaves and the operação never feed
  // each other, so run them all concurrently.
  const [origins, chNFeReferenciadas, operacao] = await Promise.all([
    Promise.all(originIds.map((originId) => port.getPedido(originId))),
    collectChNFeReferenciadas(port, originIds, 'first'),
    resolveDevolucaoOperacao(port, { integracaoOuterRef: values.integracaoPedidoOuterRef }),
  ]);

  const originBaselines = new Map<string, Record<string, unknown>>();
  let temOutraDevolucao = false;
  originIds.forEach((originId, i) => {
    const origin = origins[i] ?? null;
    if (origin === null) return;
    originBaselines.set(originId, origin);
    if (Array.isArray(origin.entradasRelacionadas) && origin.entradasRelacionadas.length > 0) {
      temOutraDevolucao = true;
    }
  });
  return { originIds, originBaselines, temOutraDevolucao, operacao, chNFeReferenciadas };
}

/**
 * Create the saída AND its entrada devolução in ONE transaction (the legacy
 * #488 "criar troca" save): mint both numeros from the counter, drift-check +
 * link-update every origin, and write both pedidos.
 *
 * Origins with a prepare-time baseline are guarded like `savePedido`: missing
 * in the tx → `PedidoConflictError(null)`; any field drifted from the baseline
 * (`remotelyChangedFields`, stamps ignored) → `PedidoConflictError(txDoc)`.
 * Origins that were ALREADY missing at prepare are skipped for drift and only
 * link-updated if they exist in the tx (they stay in `saidasRelacionadas`
 * regardless — see {@link prepareDevolucaoSave}).
 *
 * The saída doc is prepared exactly like `createPedidoWithNumero` prepares its
 * doc (the resolved form values spread + `numero`; the adapter's converter
 * validates on set), plus `entradasRelacionadas: [devolucaoId]`.
 */
export async function criarSaidaComDevolucao(
  port: PedidoDevolucaoDataPort,
  args: { values: Pedido; prepared: DevolucaoSavePrepared; saidaOperacaoNome: string | null },
): Promise<{
  saidaId: string;
  saidaNumero: string;
  devolucaoId: string;
  devolucaoNumero: string;
}> {
  const { values, prepared } = args;
  const saidaId = port.newId();
  const devolucaoId = port.newId();
  const devolucaoDoc = buildDevolucaoPedido(port, {
    saida: values,
    itensDevolvidos: values.itensDevolvidos ?? {},
    operacaoOuterRef: prepared.operacao.outerRef,
    chNFeReferenciadas: prepared.chNFeReferenciadas,
    saidasRelacionadas: prepared.originIds,
  });
  const prefixes = [
    operacaoNumeroPrefix(args.saidaOperacaoNome),
    operacaoNumeroPrefix(prepared.operacao.nome),
  ];

  // Set by the FINAL (committed) `apply` attempt; reset per attempt since the
  // transaction re-runs `apply` on contention.
  let saidaNumero = '';
  let devolucaoNumero = '';
  await port.transact({
    reads: [PEDIDO_COUNTER_PATH, ...prepared.originIds.map(PEDIDO_PATH)],
    apply: (docs) => {
      const ops: PedidoWriteOp[] = [];
      const { numeros, counterOp } = mintNumeros(docs.get(PEDIDO_COUNTER_PATH) ?? null, prefixes);
      saidaNumero = numeros[0] ?? '';
      devolucaoNumero = numeros[1] ?? '';
      ops.push(counterOp);

      for (const originId of prepared.originIds) {
        const txDoc = docs.get(PEDIDO_PATH(originId)) ?? null;
        const baseline = prepared.originBaselines.get(originId);
        if (baseline !== undefined) {
          if (txDoc === null) throw new PedidoConflictError(null);
          if (remotelyChangedFields(baseline, txDoc).length > 0) {
            throw new PedidoConflictError(txDoc);
          }
        }
        // No baseline AND missing in the tx too → keep the id in
        // `saidasRelacionadas` (legacy-faithful) but skip the link update.
        if (txDoc === null) continue;
        ops.push({
          type: 'update',
          path: PEDIDO_PATH(originId),
          data: {
            entradasRelacionadas: unionIds(txDoc.entradasRelacionadas, devolucaoId),
            ultimaModificacao: port.now(),
          },
        });
      }

      ops.push({
        type: 'set',
        path: PEDIDO_PATH(saidaId),
        data: {
          ...(values as unknown as Record<string, unknown>),
          entradasRelacionadas: [devolucaoId],
          numero: numeros[0],
        },
      });
      ops.push({
        type: 'set',
        path: PEDIDO_PATH(devolucaoId),
        data: { ...devolucaoDoc, numero: numeros[1] },
      });
      return ops;
    },
  });
  return { saidaId, saidaNumero, devolucaoId, devolucaoNumero };
}

// ---------------------------------------------------------------------------
// Troca incidentes (#488)
// ---------------------------------------------------------------------------

/**
 * Origin pedido ids that are NEW in the edited `itensDevolvidos` versus the
 * stored one — the origins a re-save must write a troca incidente for (never
 * the `'NONE'`/`''` avulso buckets, never an origin already present).
 */
export function novosOriginsDeTroca(
  oldItens: ItensDevolvidos | null | undefined,
  newItens: ItensDevolvidos | null | undefined,
): string[] {
  const oldKeys = new Set(Object.keys(oldItens ?? {}));
  return Object.keys(newItens ?? {}).filter((k) => k !== NONE_KEY && k !== '' && !oldKeys.has(k));
}

/** The legacy auto-comment stamped on system-created incidentes (local clock). */
function autoComentario(nowMicros: number): string {
  const d = new Date(Math.floor(nowMicros / 1000));
  const pad = (n: number): string => String(n).padStart(2, '0');
  const data = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  const hora = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `Incidente criado automaticamente pelo sistema em ${data} as ${hora}.`;
}

/**
 * Shared writer for the troca/devolução return incidentes: one incidente per
 * origin pedido, pointing back at the created pedido (`externalId`). No-op when
 * `originIds` is empty (a re-save that added no new origin).
 */
async function registrarIncidentesDeRetorno(
  port: PedidoDataPort,
  args: {
    originIds: ReadonlyArray<string>;
    origem: number;
    tipo: string;
    /** The verb leading the motivo text (`'Troca'` / `'Devolução'`). */
    verbo: string;
    /** The created pedido the incidentes point back at. */
    refPedidoId: string;
    refPedidoNumero: string | null;
  },
): Promise<void> {
  if (args.originIds.length === 0) return;
  const ops = args.originIds.map((originId) =>
    buildIncidenteOp(port, originId, null, {
      origem: args.origem,
      tipo: args.tipo,
      motivoDoIncidente: `${args.verbo} criada com o pedido #${args.refPedidoNumero ?? args.refPedidoId}`,
      comentarios: autoComentario(port.now()),
      externalId: args.refPedidoId,
    }),
  );
  await port.commit(ops);
}

/**
 * Write one troca incidente (origem `troca`, tipo `'t'`) on each origin pedido,
 * pointing back at the saída (`externalId`). No-op when `originIds` is empty
 * (a re-save that added no new origin).
 */
export async function registrarIncidentesDeTroca(
  port: PedidoDataPort,
  args: {
    saidaPedidoId: string;
    saidaNumero: string | null;
    originIds: ReadonlyArray<string>;
  },
): Promise<void> {
  await registrarIncidentesDeRetorno(port, {
    originIds: args.originIds,
    origem: ORIGEM_INCIDENTE.troca,
    tipo: TIPO_INCIDENTE.troca,
    verbo: 'Troca',
    refPedidoId: args.saidaPedidoId,
    refPedidoNumero: args.saidaNumero,
  });
}

// ---------------------------------------------------------------------------
// Devolução integral (#551): seed + atomic create + incidente
// ---------------------------------------------------------------------------

/**
 * Origin fields the integral-devolução clone must NOT inherit: state/print/
 * marketplace/error/notes metadata that belongs to the SAÍDA, not the new
 * entrada. Stripped before the re-parse so schema defaults refill them.
 * `foiImpresso` is a justified addition to the legacy strip list: the new app
 * pairs it with `dtImpressao`, so carrying it over would mark a never-printed
 * entrada as printed.
 */
export const DEVOLUCAO_INTEGRAL_STRIP_KEYS = [
  'estado',
  'dtImpressao',
  'foiImpresso',
  'lastMarketplaceUpdate',
  'ultimaModificacao',
  'timestamp',
  'error',
  'observacoesInternas',
  // ⚠️ SPREAD, never hand-listed — same reason `duplicar` does it. This list
  // hand-listed 8 keys and nulled `estoqueAplicado` alone further down, which
  // was survivable only while the two legacy markers were client-writable.
  // They are `serverOwnedFields` now, so a clone carrying either is a
  // PERMISSION_DENIED on the create — the whole devolução integral flow, for
  // any origin pedido the estoque sync had touched.
  ...CAMPOS_ESTOQUE_SYNC,
] as const;

/**
 * Build the pre-seeded form values for a devolução integral (#551): the origin
 * pedido cloned with the {@link DEVOLUCAO_INTEGRAL_STRIP_KEYS} removed and
 * re-parsed so defaults refill (`estado` has no schema default, so it is reset
 * to `'iniciado'` explicitly — the entrada restarts the flow), `ehSaida: false`,
 * the devolução operação resolved from the origin's integração, ALL approved
 * chaves referenced, and the current user as vendedor. Items are copied as-is.
 *
 * Deliberate divergence-safe cleanup beyond the strip keys: the clone also
 * nulls `entradasRelacionadas` / `saidasRelacionadas` / `itensDevolvidos` /
 * `numero` — the seed must not carry the origin's links or numero; the entrada
 * gets its own at save. The stock fields are handled by the strip list itself
 * (`...CAMPOS_ESTOQUE_SYNC`), which is why they no longer appear here.
 *
 * Throws `PedidoConflictError(null)` when the origin no longer exists.
 */
export async function buildDevolucaoIntegralSeed(
  port: PedidoDevolucaoDataPort,
  args: { originId: string; usuarioRef: string | null },
): Promise<{
  values: Record<string, unknown>;
  operacao: DevolucaoOperacaoInfo;
  originNumero: string | null;
}> {
  const origin = await port.getPedido(args.originId);
  if (origin === null) throw new PedidoConflictError(null);
  const originNumero = typeof origin.numero === 'string' ? origin.numero : null;

  const clone: Record<string, unknown> = { ...origin };
  for (const key of DEVOLUCAO_INTEGRAL_STRIP_KEYS) delete clone[key];

  // Independent reads — run the operação resolution and the chave collection
  // concurrently.
  const [operacao, chaves] = await Promise.all([
    resolveDevolucaoOperacao(port, { integracaoOuterRef: origin.integracaoPedidoOuterRef }),
    collectChNFeReferenciadas(port, [args.originId], 'all'),
  ]);

  const values = pedidoSchema.parse({
    ...clone,
    ehSaida: false,
    estado: 'iniciado',
    operacaoPedidoOuterRef: operacao.outerRef,
    chNFeReferenciadas: chaves.length > 0 ? chaves : null,
    vendedorPedidoOuterRef: args.usuarioRef,
    entradasRelacionadas: null,
    saidasRelacionadas: null,
    itensDevolvidos: null,
    numero: null,
  }) as Record<string, unknown>;

  return { values, operacao, originNumero };
}

/**
 * Create the entrada devolução integral (#551) in ONE transaction: mint its
 * numero, write the entrada with `saidasRelacionadas: [originId]`, and
 * link-update the origin (`entradasRelacionadas` union from the tx-read value —
 * race-free, so no prepare-time drift baseline is needed in this flow; the
 * origin merely gains a link). Origin missing in the tx →
 * `PedidoConflictError(null)`. The entrada doc is prepared exactly like
 * `createPedidoWithNumero` (values spread + `numero`; the adapter's converter
 * validates on set).
 */
export async function criarEntradaDevolucaoIntegral(
  port: PedidoDevolucaoDataPort,
  args: { values: Pedido; originId: string; operacaoNome: string | null },
): Promise<{ entradaId: string; numero: string }> {
  const entradaId = port.newId();
  const prefix = operacaoNumeroPrefix(args.operacaoNome);

  // Set by the FINAL (committed) `apply` attempt; reset per attempt.
  let numero = '';
  await port.transact({
    reads: [PEDIDO_COUNTER_PATH, PEDIDO_PATH(args.originId)],
    apply: (docs) => {
      const txOrigin = docs.get(PEDIDO_PATH(args.originId)) ?? null;
      if (txOrigin === null) throw new PedidoConflictError(null);
      const { numeros, counterOp } = mintNumeros(docs.get(PEDIDO_COUNTER_PATH) ?? null, [prefix]);
      numero = numeros[0] ?? '';
      return [
        counterOp,
        {
          type: 'set',
          path: PEDIDO_PATH(entradaId),
          data: {
            ...(args.values as unknown as Record<string, unknown>),
            saidasRelacionadas: [args.originId],
            numero: numeros[0],
          },
        },
        {
          type: 'update',
          path: PEDIDO_PATH(args.originId),
          data: {
            entradasRelacionadas: unionIds(txOrigin.entradasRelacionadas, entradaId),
            ultimaModificacao: port.now(),
          },
        },
      ];
    },
  });
  return { entradaId, numero };
}

/**
 * Write the devolução incidente (origem `devolucao`, tipo `'returns'`) on the
 * origin pedido, pointing back at the entrada (`externalId`).
 */
export async function registrarIncidenteDeDevolucaoIntegral(
  port: PedidoDataPort,
  args: { originId: string; entradaId: string; entradaNumero: string | null },
): Promise<void> {
  await registrarIncidentesDeRetorno(port, {
    originIds: [args.originId],
    origem: ORIGEM_INCIDENTE.devolucao,
    tipo: TIPO_INCIDENTE.devolucao,
    verbo: 'Devolução',
    refPedidoId: args.entradaId,
    refPedidoNumero: args.entradaNumero,
  });
}
