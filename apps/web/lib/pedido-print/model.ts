/**
 * The flat, fully-resolved print model the two pedido sheets render from, plus
 * the pure helpers that derive its display values. Keeping these pure (no
 * Firestore, no React) makes the kit math, the stock heuristic and the variação
 * resolution unit-testable in isolation; `assemble.ts` does the I/O and fills
 * this in.
 *
 * Faithful port of the Flutter `pdf_orcamento.dart` / `pdf_formato.dart` row
 * builders (`.old/packages/pedido_impressao`).
 */
import type { GrupoDeVariacoes, ItemDoPedido, Produto } from '@delfrance/schemas';
import { itemSubtotal, parseFakePath } from '@delfrance/schemas';

import { coverArquivoIds } from '../produtos/fotoRefs';
import { formatQuantidade, microsToDate } from './format';

/* -------------------------------------------------------------------------- */
/*                                   Types                                     */
/* -------------------------------------------------------------------------- */

export interface PrintAddress {
  logradouro: string;
  numero: string;
  complemento: string | null;
  bairro: string;
  cidade: string;
  uf: string;
  cep: string;
  /** NF-e destinatário / recebedor name, when the address carries one. */
  recebedorNome: string | null;
}

export interface PrintCliente {
  nome: string | null;
  cpfCnpj: string | null;
  idEstrangeiro: string | null;
  ie: string | null;
  imun: string | null;
  email: string | null;
  telefone: string | null;
  observacoesInternas: string | null;
}

export interface PrintFilial {
  /** `fantasia ?? razaoSocial`. */
  nome: string;
  email: string | null;
  telefone: string | null;
}

export interface PrintFrete {
  tipoNome: string;
  modalidadeLabel: string;
  servicoMelhorEnvio: string | null;
  transportadora: { nome: string | null; cnpj: string | null } | null;
  veiculo: string | null;
  valorCobrado: number | null;
  ehReverso: boolean;
  dataPrevisaoEntregaMicros: number | null;
  temSeguro: boolean;
  valorSeguro: number | null;
}

/** A kit component sub-row (comum print only). */
export interface PrintKitComponente {
  produtoId: string;
  sku: string | null;
  nome: string | null;
  variacoesText: string | null;
  fotoUrl: string | null;
  /** item.quantidade × componente.quantidade. */
  quantidade: number;
  estoqueText: string;
  localizacao: string;
}

export interface PrintItem {
  produtoId: string | null;
  sku: string | null;
  nome: string | null;
  variacoesText: string | null;
  fotoUrl: string | null;
  quantidade: number;
  precoUnitario: number;
  descontoUnitario: number;
  subtotal: number;
  // Comum-only fields ------------------------------------------------------
  /** `'-' | '0' | '99+' | <decimal>` — see {@link stockText}. */
  estoqueText: string;
  localizacao: string;
  isKit: boolean;
  componentes: PrintKitComponente[];
}

export interface PedidoPrintModel {
  pedidoId: string;
  numero: string | null;
  estadoLabel: string;
  timestampMicros: number | null;
  observacoesInternas: string | null;
  subtotal: number;
  descontoTotal: number;
  total: number;
  /** Any item carries a unit discount → the orçamento shows its Desc. column. */
  hasDesconto: boolean;
  /** Kit-aware total item count (comum footer). */
  totalQuantidadeItens: number;
  prazoDespachoMicros: number | null;
  cliente: PrintCliente | null;
  enderecoFiscal: PrintAddress | null;
  enderecoEntrega: PrintAddress | null;
  frete: PrintFrete | null;
  /** Orçamento header (resolved from the integração's filial). */
  filial: PrintFilial | null;
  integracaoNome: string | null;
  vendedorNome: string | null;
  items: PrintItem[];
}

/* -------------------------------------------------------------------------- */
/*                               Pure helpers                                  */
/* -------------------------------------------------------------------------- */

/**
 * The `arquivos` ids the cover photo of a produto can be rendered from, best
 * first — the 200px derivative (compact + fast for batch), then 400px, then the
 * original. Empty when there is no photo.
 *
 * ⚠️ This is a LIST, not a single pick, and the reason is
 * `packages/schemas/src/storage/foto.ts`: `buildFotoRefs` writes every
 * derivative ref **optimistically** at upload time, so the 200px ref string is
 * non-null whether or not `resizeProductImage` ever produced the document it
 * names. Picking one ref with `??` and reading only that doc prints no photo at
 * all for every produto whose derivatives are missing — silently, since a print
 * has no placeholder. The caller falls through on document existence; see
 * `buildFotoResolver` in `./assemble.ts`.
 */
export function pickCoverFotoIds(produto: Pick<Produto, 'fotos'> | null | undefined): string[] {
  return coverArquivoIds(produto);
}

/**
 * Stock cell text (comum print). Port of the Flutter heuristic in
 * `pdf_formato.dart`:
 *  - kit parent OR no stock data (`null`) → `'-'`;
 *  - negative → `'0'`;
 *  - greater than 99 → `'99+'`;
 *  - otherwise the decimal quantity.
 */
export function stockText(disponivel: number | null, isKitParent: boolean): string {
  if (isKitParent) return '-';
  if (disponivel == null) return '-';
  if (disponivel < 0) return '0';
  if (disponivel > 99) return '99+';
  return formatQuantidade(disponivel);
}

/**
 * Build the `Grupo:Valor/Grupo:Valor` variation label from a produto's
 * `variacoesUid`, sorted by the group's `ordem`. Port of the `variacoesText`
 * computation in both Flutter renderers. Unknown groups/variants degrade to
 * `???:???` / `Grupo:???` exactly like the old app. Returns `null` when empty.
 */
export function resolveVariacoesText(
  variacoesUid: readonly string[] | null | undefined,
  gruposById: ReadonlyMap<string, GrupoDeVariacoes>,
): string | null {
  if (!variacoesUid || variacoesUid.length === 0) return null;

  const parsed = variacoesUid
    .map((uid) => parseFakePath(uid))
    .filter((p): p is { grupoId: string; varianteId: string } => p !== null);
  if (parsed.length === 0) return null;

  parsed.sort((a, b) => {
    const oa = gruposById.get(a.grupoId)?.ordem ?? Number.POSITIVE_INFINITY;
    const ob = gruposById.get(b.grupoId)?.ordem ?? Number.POSITIVE_INFINITY;
    return oa - ob;
  });

  return parsed
    .map(({ grupoId, varianteId }) => {
      const grupo = gruposById.get(grupoId);
      if (!grupo) return '???:???';
      const variante = grupo.variacoes?.find((v) => v.id === varianteId);
      return `${grupo.nome}:${variante?.nome ?? '???'}`;
    })
    .join('/');
}

/** Component quantity inside a kit line — item.quantidade × componente.quantidade. */
export function kitComponentQuantidade(
  itemQuantidade: number,
  componenteQuantidade: number,
): number {
  return itemQuantidade * componenteQuantidade;
}

/**
 * Kit-aware total item count (comum footer): a kit line counts the sum of its
 * components × the line quantity; a regular line counts its own quantity. Port
 * of the `totalQuantidadeItens` loop in `pdf_formato.dart`.
 */
export function countTotalItens(
  items: readonly ItemDoPedido[],
  produtoById: ReadonlyMap<string, Pick<Produto, 'ehKit' | 'componentesKit'>>,
): number {
  let total = 0;
  for (const item of items) {
    const produto = item.produtoUid ? produtoById.get(item.produtoUid) : undefined;
    if (produto?.ehKit && produto.componentesKit) {
      for (const componente of Object.values(produto.componentesKit)) {
        total += componente.quantidade * item.quantidade;
      }
    } else {
      total += item.quantidade;
    }
  }
  return total;
}

/** Σ item subtotals — the orçamento's pre-discount subtotal. */
export function itemsSubtotal(items: readonly ItemDoPedido[]): number {
  return items.reduce((sum, item) => sum + itemSubtotal(item), 0);
}

/**
 * True when the dispatch deadline (µs since epoch) falls before the start of
 * `now`'s day — the comum print stamps a red marker on overdue orders. Port of
 * the Flutter `getPrazoDespachoIcone` overdue branch (day-granular comparison).
 */
export function isDispatchOverdue(prazoMicros: number | null, now: Date = new Date()): boolean {
  if (prazoMicros == null) return false;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const deadline = microsToDate(prazoMicros);
  const startOfDeadlineDay = new Date(
    deadline.getFullYear(),
    deadline.getMonth(),
    deadline.getDate(),
  ).getTime();
  return startOfDeadlineDay < startOfToday;
}
