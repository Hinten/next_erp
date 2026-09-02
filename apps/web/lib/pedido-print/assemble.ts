/**
 * Resolve a pedido into the flat {@link PedidoPrintModel} both sheets render
 * from — the client-side port of the data-loading half of the Flutter
 * `_folhaPedido` / `folhaOrcamento` builders.
 *
 * Everything reads through the typed `defineCollection` handles + the shared
 * `dereferenceOuterRef` helper (the legacy `documents/<col>/<id>` outer refs),
 * so Firestore security rules enforce tenancy + permissions on every read. No
 * server hop — this runs in the browser. Reads within each phase fan out with
 * `Promise.all`; the batch caller (comum print) drives many pedidos in bounded
 * waves.
 */
import { getDoc, type DocumentReference, type Firestore } from 'firebase/firestore';
import { roundReais } from '@delfrance/core/money';
import {
  ESTADO_PEDIDO_LABELS,
  MODALIDADE_FRETE_LABELS,
  estoqueDisponivel,
  itemSubtotal,
  makeEstoqueUid,
  parseFakePath,
  unidadeVendavel,
  type Cliente,
  type Endereco,
  type EstoqueProduto,
  type Filial,
  type GrupoDeVariacoes,
  type Integracao,
  type ItemDoPedido,
  type Pedido,
  type Produto,
} from '@delfrance/schemas';
import { arquivoCollection } from '@delfrance/storage';

import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import { estoqueProdutoCollection } from '@/lib/data/estoqueProdutoCollection';
import { grupoDeVariacoesCollection } from '@/lib/data/grupoDeVariacoesCollection';
import { pedidoCollection } from '@/lib/data/pedidoCollection';
import { produtoCollection } from '@/lib/data/produtoCollection';

import {
  countTotalItens,
  itemsSubtotal,
  kitComponentQuantidade,
  pickCoverFotoIds,
  resolveVariacoesText,
  stockText,
  type PedidoPrintModel,
  type PrintAddress,
  type PrintCliente,
  type PrintFilial,
  type PrintFrete,
  type PrintItem,
  type PrintKitComponente,
} from './model';

export interface AssembleOptions {
  /** Resolve per-depósito stock + localização (comum print). */
  readonly withStock?: boolean;
  /** Expand kit lines into their component sub-rows (comum print). */
  readonly withKits?: boolean;
}

/** Thrown when the pedido doc does not exist. */
export class PedidoNotFoundError extends Error {
  constructor(pedidoId: string) {
    super(`Pedido ${pedidoId} não encontrado.`);
    this.name = 'PedidoNotFoundError';
  }
}

/* -------------------------------------------------------------------------- */
/*                              small mappers                                 */
/* -------------------------------------------------------------------------- */

function toPrintAddress(e: Endereco | null): PrintAddress | null {
  if (!e) return null;
  return {
    logradouro: e.logradouro,
    numero: e.numero,
    complemento: e.complemento,
    bairro: e.bairro,
    cidade: e.cidade,
    uf: e.estado,
    cep: e.cep,
    recebedorNome: e.nome,
  };
}

function toPrintCliente(c: Cliente | null): PrintCliente | null {
  if (!c) return null;
  return {
    nome: c.nome,
    cpfCnpj: c.cpf_cnpj,
    idEstrangeiro: c.idEstrangeiro,
    ie: c.ie,
    imun: c.imun,
    email: c.email,
    telefone: c.telefone,
    observacoesInternas: c.observacoesInternas,
  };
}

function toPrintFilial(f: Filial | null): PrintFilial | null {
  if (!f) return null;
  return {
    nome: f.fantasia ?? f.razaoSocial,
    email: f.sede?.email ?? null,
    telefone: f.sede?.telefone ?? null,
  };
}

function formatVeiculo(v: {
  placa?: string | null;
  uf?: string | null;
  rntc?: string | null;
}): string {
  const base = [v.placa, v.uf].filter((x): x is string => !!x).join(' - ');
  return v.rntc ? `${base} (RNTC ${v.rntc})` : base;
}

/**
 * Best-effort Melhor Envio service name from the persisted `externalOptionData`
 * — port of `getNomeServicoMelhorEnvios`. Prefers a decoded `name`, falls back
 * to `tipo (code)`.
 */
function melhorEnvioServiceName(data: Record<string, unknown> | null | undefined): string | null {
  if (!data) return null;
  if (typeof data.name === 'string' && data.name) return data.name;
  const code = typeof data.code === 'string' ? data.code : null;
  const tipo = typeof data.tipo === 'string' ? data.tipo : null;
  if (code && tipo) return `${tipo} (${code})`;
  return tipo ?? code ?? null;
}

/* -------------------------------------------------------------------------- */
/*                               core helpers                                 */
/* -------------------------------------------------------------------------- */

/** Dereference an opaque outer ref and read it (untyped — raw wire data). */
async function readRef<T>(db: Firestore, outerRef: unknown): Promise<T | null> {
  const ref: DocumentReference | null = dereferenceOuterRef(db, outerRef);
  if (!ref) return null;
  const snap = await getDoc(ref);
  return snap.exists() ? (snap.data() as T) : null;
}

/** Flatten the grouped `pedido.itens` record, deriving produtoUid from the map key. */
function flattenItens(grouped: Pedido['itens']): ItemDoPedido[] {
  const out: ItemDoPedido[] = [];
  for (const [key, list] of Object.entries(grouped)) {
    const keyUid = key && key !== 'NONE' ? key : null;
    for (const item of list) {
      out.push({ ...item, produtoUid: item.produtoUid ?? keyUid });
    }
  }
  out.sort((a, b) => a.ordem - b.ordem);
  return out;
}

/* -------------------------------------------------------------------------- */
/*                              buildPrintModel                               */
/* -------------------------------------------------------------------------- */

export async function buildPrintModel(
  db: Firestore,
  pedidoId: string,
  opts: AssembleOptions = {},
): Promise<PedidoPrintModel> {
  const { withStock = false, withKits = false } = opts;

  // 1. Pedido ---------------------------------------------------------------
  const pedidoSnap = await getDoc(pedidoCollection.docRef(db, {}, pedidoId));
  if (!pedidoSnap.exists()) throw new PedidoNotFoundError(pedidoId);
  const pedido = pedidoSnap.data();
  const items = flattenItens(pedido.itens);
  const frete = pedido.freteInicial;

  // 2. Header references (parallel) -----------------------------------------
  const [integracao, cliente, enderecoFiscal, integracaoFrete, enderecoEntrega, vendedor] =
    await Promise.all([
      readRef<Integracao>(db, pedido.integracaoPedidoOuterRef),
      readRef<Cliente>(db, pedido.clientePedidoOuterRef),
      readRef<Endereco>(db, pedido.enderecoFiscalOuterRef),
      frete ? readRef<{ nome?: string; tipo?: string }>(db, frete.integracaoFreteOuterRef) : null,
      frete ? readRef<Endereco>(db, frete.enderecoFreteOuterReference) : null,
      readRef<{ displayName?: string; nome?: string; email?: string }>(
        db,
        pedido.vendedorPedidoOuterRef,
      ),
    ]);

  const filial = integracao
    ? await readRef<Filial>(db, integracao.filialIntegracaoPedidoOuterRef)
    : null;

  // 3. Products (main + kit components) -------------------------------------
  const produtoIds = [...new Set(items.map((i) => i.produtoUid).filter((x): x is string => !!x))];
  const produtoById = await readProdutos(db, produtoIds);

  const componentIds = new Set<string>();
  if (withKits) {
    for (const p of produtoById.values()) {
      if (p.ehKit && p.componentesKit) {
        for (const cid of Object.keys(p.componentesKit)) componentIds.add(cid);
      }
    }
  }
  const componentById = await readProdutos(db, [...componentIds]);
  const allProdutos = new Map<string, Produto>([...produtoById, ...componentById]);

  // 4. Photos, variations, stock (parallel across all products) -------------
  const depositoId = withStock
    ? (dereferenceOuterRef(db, integracao?.depositoOuterRef)?.id ?? null)
    : null;

  const [fotoUrlOf, variacoesTextOf, stockOf] = await Promise.all([
    buildFotoResolver(db, allProdutos),
    buildVariacaoResolver(db, allProdutos),
    buildStockResolver(db, allProdutos, depositoId),
  ]);

  // 5. Item rows ------------------------------------------------------------
  const printItems: PrintItem[] = items.map((item) => {
    const produto = item.produtoUid ? produtoById.get(item.produtoUid) : undefined;
    const isKit = withKits && !!produto?.ehKit && !!produto.componentesKit;
    const stock = stockOf(item.produtoUid);

    const componentes: PrintKitComponente[] = [];
    if (isKit && produto?.componentesKit) {
      // Sorted by component id, matching the Flutter row builder.
      const entries = Object.entries(produto.componentesKit).sort(([a], [b]) => a.localeCompare(b));
      for (const [cid, kit] of entries) {
        const comp = componentById.get(cid);
        const cStock = stockOf(cid);
        componentes.push({
          produtoId: cid,
          sku: comp?.sku ?? null,
          nome: comp?.nome ?? null,
          variacoesText: variacoesTextOf(cid),
          fotoUrl: fotoUrlOf(cid),
          quantidade: kitComponentQuantidade(item.quantidade, kit.quantidade),
          estoqueText: stockText(cStock.disponivel, false),
          localizacao: cStock.localizacao,
        });
      }
    }

    return {
      produtoId: item.produtoUid,
      sku: produto?.sku ?? item.sku,
      nome: produto?.nome ?? item.nomeDeVenda,
      variacoesText: variacoesTextOf(item.produtoUid),
      fotoUrl: fotoUrlOf(item.produtoUid),
      quantidade: item.quantidade,
      precoUnitario: item.precoDeVenda,
      descontoUnitario: item.descontoUnitario ?? 0,
      subtotal: itemSubtotal(item),
      estoqueText: stockText(stock.disponivel, isKit),
      localizacao: stock.localizacao,
      isKit,
      componentes,
    };
  });

  // 6. Totals + frete + assemble -------------------------------------------
  const subtotal = roundReais(itemsSubtotal(items));
  const descontoTotal = pedido.descontoTotal ?? 0;
  const total =
    pedido.valorCobrado ??
    roundReais(roundReais(subtotal - descontoTotal) + (frete?.valorCobrado ?? 0));

  const printFrete: PrintFrete | null = frete
    ? {
        tipoNome: integracaoFrete?.nome ?? 'Genérico',
        modalidadeLabel: MODALIDADE_FRETE_LABELS[frete.modalidade] ?? frete.modalidade,
        servicoMelhorEnvio:
          integracaoFrete?.tipo === 'melhorEnvios'
            ? melhorEnvioServiceName(frete.externalOptionData)
            : null,
        transportadora: frete.transportadora
          ? { nome: frete.transportadora.nome, cnpj: frete.transportadora.cnpj }
          : null,
        veiculo: frete.veiculo ? formatVeiculo(frete.veiculo) : null,
        valorCobrado: frete.valorCobrado,
        ehReverso: frete.ehReverso,
        dataPrevisaoEntregaMicros: frete.dataPrevisaoEntrega,
        temSeguro: (frete.valor_assegurado ?? 0) > 0,
        valorSeguro: (frete.valor_assegurado ?? 0) > 0 ? frete.valor_assegurado : null,
      }
    : null;

  return {
    pedidoId,
    numero: pedido.numero,
    estadoLabel: ESTADO_PEDIDO_LABELS[pedido.estado] ?? pedido.estado,
    timestampMicros: pedido.timestamp,
    observacoesInternas: pedido.observacoesInternas,
    subtotal,
    descontoTotal,
    total,
    hasDesconto: items.some((i) => (i.descontoUnitario ?? 0) > 0),
    totalQuantidadeItens: countTotalItens(items, produtoById),
    prazoDespachoMicros: frete?.prazoDespacho ?? null,
    cliente: toPrintCliente(cliente),
    enderecoFiscal: toPrintAddress(enderecoFiscal),
    enderecoEntrega: toPrintAddress(enderecoEntrega),
    frete: printFrete,
    filial: toPrintFilial(filial),
    integracaoNome: integracao?.nome ?? null,
    vendedorNome: vendedor?.displayName ?? vendedor?.nome ?? vendedor?.email ?? null,
    items: printItems,
  };
}

/* -------------------------------------------------------------------------- */
/*                        resolver builders (per phase)                       */
/* -------------------------------------------------------------------------- */

/** Read many produtos by id (typed handle), skipping missing docs. */
async function readProdutos(db: Firestore, ids: readonly string[]): Promise<Map<string, Produto>> {
  const entries = await Promise.all(
    ids.map(async (id) => {
      const snap = await getDoc(produtoCollection.docRef(db, {}, id));
      return [id, snap.exists() ? snap.data() : null] as const;
    }),
  );
  const map = new Map<string, Produto>();
  for (const [id, p] of entries) if (p) map.set(id, p);
  return map;
}

/**
 * produtoId → cover-photo download URL (or null).
 *
 * ⚠️ Each produto contributes a candidate LIST (200px → 400px → original), not
 * a single id, and the resolver returns the first candidate that actually
 * resolved. `buildFotoRefs` writes derivative refs optimistically, so reading
 * only the preferred one prints nothing at all for every produto whose
 * derivatives the resize function never produced — and a print has no
 * broken-image placeholder to make that visible. Exported for `assemble.test.ts`,
 * which pins the read count. Every distinct id is still
 * fetched exactly once, shared across the produtos that name it.
 */
export async function buildFotoResolver(
  db: Firestore,
  produtos: ReadonlyMap<string, Produto>,
): Promise<(produtoId: string | null) => string | null> {
  const idsByProduto = new Map<string, readonly string[]>();
  let maxRungs = 0;
  for (const [pid, p] of produtos) {
    const aids = pickCoverFotoIds(p);
    if (aids.length > 0) {
      idsByProduto.set(pid, aids);
      maxRungs = Math.max(maxRungs, aids.length);
    }
  }

  // ⚠️ LAZY, one rung at a time — never `Promise.all` over every candidate.
  // Fetching the whole ladder up front would make the HEALTHY case cost 3x the
  // reads it used to (a produto whose 200px derivative exists would still pay
  // for the 400px and the original), permanently, on the batch print path and
  // on a database that bills data scanned (root `CLAUDE.md` rule 1). Instead
  // each wave asks only for the produtos still unresolved, so the healthy case
  // is one wave and ~N reads, and only the degraded produtos pay for a second.
  const urlByProduto = new Map<string, string | null>();
  const urlById = new Map<string, string | null>();
  for (let rung = 0; rung < maxRungs; rung++) {
    const querer = new Set<string>();
    for (const [pid, aids] of idsByProduto) {
      if (urlByProduto.has(pid)) continue;
      const aid = aids[rung];
      if (aid !== undefined && !urlById.has(aid)) querer.add(aid);
    }
    await Promise.all(
      [...querer].map(async (aid) => {
        const snap = await getDoc(arquivoCollection.docRef(db, {}, aid));
        urlById.set(aid, snap.exists() ? (snap.data().url ?? null) : null);
      }),
    );
    // Settle every produto whose rung resolved; the rest fall to the next wave.
    for (const [pid, aids] of idsByProduto) {
      if (urlByProduto.has(pid)) continue;
      const aid = aids[rung];
      if (aid === undefined) {
        urlByProduto.set(pid, null); // ladder shorter than the deepest one
        continue;
      }
      const url = urlById.get(aid) ?? null;
      if (url !== null) urlByProduto.set(pid, url);
    }
  }

  return (produtoId) => (produtoId ? (urlByProduto.get(produtoId) ?? null) : null);
}

/** produtoId → `Grupo:Valor/...` variation label (or null). */
async function buildVariacaoResolver(
  db: Firestore,
  produtos: ReadonlyMap<string, Produto>,
): Promise<(produtoId: string | null) => string | null> {
  const grupoIds = new Set<string>();
  for (const p of produtos.values()) {
    for (const uid of p.variacoesUid ?? []) {
      const parsed = parseFakePath(uid);
      if (parsed) grupoIds.add(parsed.grupoId);
    }
  }
  const gruposById = new Map<string, GrupoDeVariacoes>();
  await Promise.all(
    [...grupoIds].map(async (gid) => {
      const snap = await getDoc(grupoDeVariacoesCollection.docRef(db, {}, gid));
      if (snap.exists()) gruposById.set(gid, snap.data());
    }),
  );
  return (produtoId) => {
    if (!produtoId) return null;
    return resolveVariacoesText(produtos.get(produtoId)?.variacoesUid, gruposById);
  };
}

/** Per-produto stock view for the comum print. */
export interface StockInfo {
  /** Available quantity, or `null` when there's no stock data (no depósito / no doc). */
  disponivel: number | null;
  localizacao: string;
}
type StockResolver = (produtoId: string | null) => StockInfo;

const NO_STOCK: StockInfo = { disponivel: null, localizacao: '' };

/** produtoId → {disponivel, localizacao} for the integração's depósito. */
export async function buildStockResolver(
  db: Firestore,
  produtos: ReadonlyMap<string, Produto>,
  depositoId: string | null,
): Promise<StockResolver> {
  const byProduto = new Map<string, StockInfo>();

  // ⚠️ Read the produto that owns the AVAILABLE stock, which for a family of one
  // is the child (#1398) — the parent is a wrapper, and after the units have
  // moved its row prints a truthful, useless `0` on a picking list someone walks
  // the warehouse with.
  //
  // The RESOLUTION is free: every produto on this sheet, line items AND kit
  // components alike, is already in `produtos`, so it costs no produto read. The
  // estoque READ COUNT is unchanged too — `alvos` is never larger than
  // `produtos` — though the documents differ: a sole member's row is one this
  // sheet did not read before. The keys stay the ids the pedido and the kit map
  // name; only the estoque doc that answers for them moves.
  const alvoDe = new Map<string, string>();
  for (const [id, p] of produtos) alvoDe.set(id, unidadeVendavel({ ...p, id }));

  if (depositoId) {
    const ler = async (pid: string): Promise<StockInfo | null> => {
      const estId = makeEstoqueUid(pid, depositoId);
      const snap = await getDoc(estoqueProdutoCollection.docRef(db, { produtoId: pid }, estId));
      if (!snap.exists()) return null;
      const e: EstoqueProduto = snap.data();
      return { disponivel: estoqueDisponivel(e), localizacao: e.localizacao ?? '' };
    };

    // Distinct targets: a produto and its sole member never collide, but two
    // kit entries pointing at one produto would read the same doc twice.
    const porAlvo = new Map<string, StockInfo>();
    await Promise.all(
      [...new Set(alvoDe.values())].map(async (pid) => {
        const info = await ler(pid);
        if (info) porAlvo.set(pid, info);
      }),
    );

    // ⚠️ A produto whose sole member has NO row at this depósito keeps its OWN.
    // `filhoUnicoId` records that the family has exactly one child; it says
    // NOTHING about where the units sit. `upSoleMember` moves them, but that is
    // the Mercado Livre publish path — a produto whose stock was lançado on the
    // parent and never moved still has the number there, and resolving past it
    // would print `-` for units that are on the shelf.
    //
    // One extra read, and only in that anomalous case. ⚠️ When BOTH rows hold
    // units the sole member's answers, matching what the ERP does for any
    // parent/child split; the parent's remainder is `residualEstoquePai`'s job.
    const semLinha = [
      ...new Set(
        [...alvoDe].filter(([id, alvo]) => alvo !== id && !porAlvo.has(alvo)).map(([id]) => id),
      ),
    ];
    const porProprio = new Map<string, StockInfo>();
    await Promise.all(
      semLinha.map(async (pid) => {
        const info = await ler(pid);
        if (info) porProprio.set(pid, info);
      }),
    );

    for (const [id, alvo] of alvoDe) {
      const info = porAlvo.get(alvo) ?? porProprio.get(id);
      if (info) byProduto.set(id, info);
    }
  }

  return (produtoId) => (produtoId ? (byProduto.get(produtoId) ?? NO_STOCK) : NO_STOCK);
}
