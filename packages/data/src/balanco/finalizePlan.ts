import type { ItemRelatorioBalanco } from '@delfrance/schemas';
import { planMovimentacao, type EstoqueAtual, type MovimentacaoPlan } from '../produto/usecases';

/**
 * Pure planning for the balanço finalize (`apps/functions` drives the I/O).
 * Everything that decides WHAT lands on an estoque doc lives here so it is
 * unit-testable without an emulator; the function file only reads, writes and
 * chunks.
 */

/** One produto on the frozen work list, as stored in a `relatorios` shard. */
export interface ItemTrabalhoBalanco {
  produtoId: string;
  sku: string | null;
  nome: string | null;
  /**
   * Units counted, or `null` when the produto was never counted and is only on
   * the list because `zerarNaoContados` is on. Applied as 0 either way; the
   * distinction is preserved in the report so "counted and found empty" reads
   * differently from "never counted".
   */
  contado: number | null;
  /** Estoque docs beyond the canonical one for this produto+depósito. */
  estoquesExtras: number | null;
}

/** What the worker should do with one produto, once its estoque doc is read. */
export type AcaoBalanco =
  | { tipo: 'ja-aplicado' }
  | { tipo: 'inalterado'; estoqueAntes: number }
  | { tipo: 'aplicar'; estoqueAntes: number; plan: MovimentacaoPlan };

/** Raw stored counters, straight off the snapshot — coerced here, not by the caller. */
export interface EstoqueCru {
  quantidade: unknown;
  quantidadeReservada: unknown;
}

/**
 * Thrown when a plan came out with a non-finite `movimento`. It should be
 * unreachable — the balanço path always holds the value it is replacing — but
 * writing the row anyway is the one failure mode that corrupts silently, so
 * the job dies instead.
 *
 * ⚠️ Why this is worse than a crash: the Mercado Livre stock sweep
 * reconstructs "stock at time T" as `atual − Σmovimento` over the ledger, and
 * its fail-open counter tests `not(exists('movimento'))`. A `null` PASSES
 * `exists`, so `sum` skips the row while the counter does not catch it — the
 * window then looks like nothing moved and the sweep skips a real change. An
 * absent key fails open; a null fails silently.
 */
export class MovimentoBalancoIndefinidoError extends Error {
  constructor(readonly produtoId: string) {
    super(`balanço: movimento indefinido para o produto ${produtoId} — nada foi gravado`);
    this.name = 'MovimentoBalancoIndefinidoError';
  }
}

/** Coerce a stored counter defensively (legacy docs may hold junk). */
function contador(valor: unknown): number {
  return typeof valor === 'number' && Number.isFinite(valor) ? valor : 0;
}

/** True when the stored counters are real finite numbers we can trust as "before". */
function contadoresSaos(cru: EstoqueCru): boolean {
  return (
    typeof cru.quantidade === 'number' &&
    Number.isFinite(cru.quantidade) &&
    typeof cru.quantidadeReservada === 'number' &&
    Number.isFinite(cru.quantidadeReservada) &&
    cru.quantidadeReservada >= 0
  );
}

/** The `historicoEstoque.motivo` a balanço stamps. Server-side, never from the client. */
export function motivoBalanco(nome: string): string {
  return `Balanço ${nome}`;
}

/**
 * Decide what one produto's finalize does.
 *
 * `atual` is the raw stored estoque, or `null` when the produto has no estoque
 * doc in this depósito. `jaAplicado` is the deterministic-history-id marker:
 * the produto was already written by an earlier attempt of THIS balanço.
 *
 * Three outcomes, and two of them write nothing:
 *
 * - **`ja-aplicado`** — the marker exists. Crucially the plan is NOT recomputed:
 *   re-deriving `contado − atual` against a value this job already moved would
 *   record a second, wrong delta (usually 0) on a ledger that must stay
 *   summable. This is what makes a mid-shard crash safe to resume.
 * - **`inalterado`** — the count confirmed what was already stored. Nothing is
 *   written: not the estoque doc, and not a history row. A zero-delta row is
 *   not a movement, and on a full-catalogue count most produtos match — writing
 *   them would bloat every 15-minute ML sweep aggregate for the next 24h for no
 *   information (`carimbarKitsVendidos` sets the same precedent). The report
 *   shard still records `estoque` and `contado`, so "counted and matched" is
 *   fully auditable there.
 *   Stored junk (a non-number, a negative reservation) is deliberately NOT
 *   `inalterado` — it gets a real write so the doc self-heals.
 * - **`aplicar`** — the delta is real. `planMovimentacao` produces the absolute
 *   set for the doc AND the signed `contado − atual` the ledger needs, and
 *   preserves `quantidadeReservada` (clamped once, in the plan).
 *
 * A produto with no estoque doc AND a count of 0 is `inalterado`: no doc means
 * no stock in this depósito, so creating an empty one records nothing. Legacy
 * created it — and, on the `zerar` path, created one for every product in the
 * catalogue.
 */
export function planejarItemBalanco(args: {
  produtoId: string;
  contado: number;
  atual: EstoqueCru | null;
  jaAplicado: boolean;
  motivo: string;
  agoraMs: number;
}): AcaoBalanco {
  const { produtoId, contado, atual, jaAplicado, motivo, agoraMs } = args;
  if (jaAplicado) return { tipo: 'ja-aplicado' };

  const estoqueAntes = atual ? contador(atual.quantidade) : 0;

  if (atual === null) {
    if (contado === 0) return { tipo: 'inalterado', estoqueAntes: 0 };
  } else if (contadoresSaos(atual) && estoqueAntes === contado) {
    return { tipo: 'inalterado', estoqueAntes };
  }

  const antes: EstoqueAtual = {
    quantidade: estoqueAntes,
    quantidadeReservada: atual ? contador(atual.quantidadeReservada) : 0,
  };
  const plan = planMovimentacao(
    {
      tipo: 'balanco',
      quantidade: contado,
      quantidadeReservada: antes.quantidadeReservada,
      motivo,
    },
    agoraMs,
    antes,
  );
  if (!Number.isFinite(plan.historico.movimento)) {
    throw new MovimentoBalancoIndefinidoError(produtoId);
  }
  return { tipo: 'aplicar', estoqueAntes, plan };
}

/**
 * Split the frozen work list into `relatorios` shard bodies, in produto-id
 * order so shard N always holds the same produtos across a retry (paired with
 * the deterministic shard ids, a re-run of phase A overwrites its own shards
 * instead of duplicating them).
 */
export function montarShardsRelatorio(
  itens: ItemTrabalhoBalanco[],
  tamanho: number,
): Array<Record<string, ItemRelatorioBalanco>> {
  const ordenados = [...itens].sort((a, b) => a.produtoId.localeCompare(b.produtoId));
  const shards: Array<Record<string, ItemRelatorioBalanco>> = [];
  for (let i = 0; i < ordenados.length; i += tamanho) {
    const body: Record<string, ItemRelatorioBalanco> = {};
    for (const item of ordenados.slice(i, i + tamanho)) {
      body[item.produtoId] = {
        sku: item.sku,
        nome: item.nome,
        // Filled in by phase B, from inside the applying transaction — the
        // real "before", not whatever a client happened to have cached.
        estoque: null,
        contado: item.contado,
        estoquesExtras: item.estoquesExtras,
      };
    }
    shards.push(body);
  }
  return shards;
}

/**
 * Merge the counted totals with the `zerarNaoContados` targets into one work
 * list.
 *
 * `contagem` is what the movimentos aggregate returned (produtoId → units).
 * `comEstoque` is every produto holding an estoque doc in this depósito —
 * which is also the ONLY set `zerar` can meaningfully touch, since a produto
 * with no doc has no stock here. Legacy loaded the entire non-kit catalogue
 * instead, then created an estoque + history row for each: O(catalog) writes
 * for produtos that never had stock.
 *
 * `kits` are excluded from the zerar side only. A kit holds no stock of its own
 * (it is expanded into components at sale time, ADR 0014), so zeroing one would
 * be meaningless; a kit that was somehow counted is already rejected at
 * lançamento time and never reaches the aggregate.
 */
export function montarListaTrabalho(args: {
  contagem: Map<string, number>;
  comEstoque: Set<string>;
  kits: Set<string>;
  extrasPorProduto: Map<string, number>;
  detalhes: Map<string, { sku: string | null; nome: string | null }>;
  zerarNaoContados: boolean;
}): ItemTrabalhoBalanco[] {
  const { contagem, comEstoque, kits, extrasPorProduto, detalhes, zerarNaoContados } = args;
  const itens: ItemTrabalhoBalanco[] = [];

  for (const [produtoId, contado] of contagem) {
    itens.push({
      produtoId,
      sku: detalhes.get(produtoId)?.sku ?? null,
      nome: detalhes.get(produtoId)?.nome ?? null,
      contado,
      estoquesExtras: extrasPorProduto.get(produtoId) ?? null,
    });
  }

  if (zerarNaoContados) {
    for (const produtoId of comEstoque) {
      if (contagem.has(produtoId) || kits.has(produtoId)) continue;
      itens.push({
        produtoId,
        sku: detalhes.get(produtoId)?.sku ?? null,
        nome: detalhes.get(produtoId)?.nome ?? null,
        contado: null,
        estoquesExtras: extrasPorProduto.get(produtoId) ?? null,
      });
    }
  }

  return itens;
}
