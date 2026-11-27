/**
 * ONE walk page of the daily reconcile's ERP phase, for both arms (master plan step 13, PR 13-f1):
 * the stock evaluation (`faseErp.ts`, unchanged) and the price arm (`armaPrecoErp.ts`, pure) over
 * the SAME produto read. Next-free, `db` a parameter.
 *
 * ## One read for both
 *
 *  - stock carried, price not: `avaliarPaginaErpLi` with exactly the stock-only arguments;
 *  - both carried: `avaliarPaginaErpLi` reading through the UNION mask — the stock fields plus
 *    `paiId`, `precos` and `propagatePriceToChildren` (`CAMPOS_PRODUTO_PRECO_LI`), ONE `getAll` per
 *    300 — and handing the masked raw data to the price arm. Every produto a priced conta's
 *    `vinculado` link names is in it: the priced contas are among the run's contas, and a
 *    `vinculado` verdict is the same reader's for both;
 *  - price carried, stock not: a price-only masked `getAll` (≤ 300 ids) of the produtos some
 *    priced conta's links make a child of, counted `erpProdutosLidos` like the stock reader.
 *
 * ## The price arm is contained per (page, conta)
 *
 * The stock evaluation has completed IN MEMORY before the price arm runs, and the arm only RETURNS
 * entries — already parsed — and counters; only then are they applied, and the apply cannot fail
 * on a parsed entry. So a coding bug or a value off its schema in the price arm (`TypeError`,
 * `RangeError`, `ZodError`) can neither change the stock state nor leave half a page in the price
 * state: it is counted on the conta (`armaFalhou`) with ONE ERROR line, and the conta's later price
 * phases skip it (its end still writes `ultimoReconcilePreco`, and no aviso). Anything else — a
 * Firestore failure of the shared read included — is rethrown, as the stock flow does.
 *
 * Every line carries ids and counts only. ⚠️ Never name the Admin SDK's multi-document
 * read-and-write call here (`estrutura.test.ts`).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { produtoCollection } from '@delfrance/data/admin/collections';
import {
  type EntradaSnapshotPrecoLi,
  type ProdutoPrecoLi,
  baldeSnapshotEstoqueLi,
  contadoresEstoqueLiSchema,
  entradaSnapshotPrecoLiSchema,
  vinculoDaContaLi,
} from '@delfrance/schemas';
import { ZodError } from 'zod';

import { CAMPOS_PRODUTO_PRECO_LI } from '../../preco/leituraPrecoErp';
import { MAX_PRODUTOS_POR_LEITURA_ESTOQUE_LI } from '../leituraEstoqueErp';
import { avaliarPrecoDaPaginaLi } from './armaPrecoErp';
import type { GrupoDeVinculosLi } from './caminhadaVinculos';
import type { ContaPrecoDoRunLi, EstadoContaPrecoLi } from './estadoPrecoReconcile';
import { type ContadoresErpLi, avaliarPaginaErpLi } from './faseErp';
import type { ContaDoRunLi, EstadoContaReconcileLi } from './snapshotReconcile';

const TAG = '[loja-integrada/preco] reconcile';

/** The motivo of the price arm's contained failure (module header). */
export const MOTIVO_ARMA_PRECO_FALHOU_LI = 'arma-preco-falhou';

/** The conta counter a contained price-arm failure adds to (module header). */
export const CONTADOR_ARMA_FALHOU_LI = 'armaFalhou';

/** Whether `err` is a failure the price arm contains (module header): a bug or a schema refusal. */
export function falhaContidaDoPrecoLi(err: unknown): boolean {
  return err instanceof TypeError || err instanceof RangeError || err instanceof ZodError;
}

/** The class name of a failure, for its line (never its message). */
export function classeDaFalhaLi(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const nome: unknown = Reflect.get(err, 'name');
  return typeof nome === 'string' && nome.length <= 100 ? nome : null;
}

/** A masked raw produto as the price function takes it: its id and its price fields, own keys. */
function produtoPrecoDe(id: string, bruto: Readonly<Record<string, unknown>>): ProdutoPrecoLi {
  const dados: Record<string, unknown> = {};
  for (const campo of CAMPOS_PRODUTO_PRECO_LI) {
    if (Object.hasOwn(bruto, campo)) dados[campo] = bruto[campo];
  }
  return { id, dados };
}

/**
 * The price-only read (module header): ONE `getAll` per 300 distinct ids, masked to
 * `CAMPOS_PRODUTO_PRECO_LI`. `null` for an absent document; no read for an empty list.
 */
export async function lerProdutosPrecoDaPaginaLi(
  db: Firestore,
  produtoIds: readonly string[],
): Promise<Map<string, ProdutoPrecoLi | null>> {
  const unicos = [...new Set(produtoIds)];
  const lidos = new Map<string, ProdutoPrecoLi | null>();
  for (let i = 0; i < unicos.length; i += MAX_PRODUTOS_POR_LEITURA_ESTOQUE_LI) {
    const fatia = unicos.slice(i, i + MAX_PRODUTOS_POR_LEITURA_ESTOQUE_LI);
    const snaps = await db.getAll(...fatia.map((id) => produtoCollection.docRef(db, {}, id)), {
      fieldMask: [...CAMPOS_PRODUTO_PRECO_LI],
    });
    fatia.forEach((id, n) => {
      const snap = snaps[n];
      lidos.set(id, snap?.exists === true ? produtoPrecoDe(id, snap.data() ?? {}) : null);
    });
  }
  return lidos;
}

/** What one page asks of each arm; `null` = the arm is not carried. */
export interface ArgsPaginaReconcileLi {
  readonly estoque: {
    readonly contas: readonly ContaDoRunLi[];
    readonly estados: ReadonlyMap<string, EstadoContaReconcileLi>;
  } | null;
  readonly preco: {
    readonly contas: readonly ContaPrecoDoRunLi[];
    readonly estados: ReadonlyMap<string, EstadoContaPrecoLi>;
    /** The arm (default {@link avaliarPrecoDaPaginaLi}); a test seam. */
    readonly arma?: typeof avaliarPrecoDaPaginaLi;
  } | null;
  /** The RUN's read-path counters of the page are added here (`faseErp.ts`). */
  readonly global: Map<string, number>;
  readonly logger: { error(msg: string, meta?: Record<string, unknown>): void };
  readonly execucaoId: string;
}

/**
 * One walk page for both arms (module header). Returns the stock arm's per-conta counters of the
 * page (empty when stock is not carried); the price arm's land on each conta's price state.
 */
export async function avaliarPaginaReconcileLi(
  db: Firestore,
  grupos: readonly GrupoDeVinculosLi[],
  args: ArgsPaginaReconcileLi,
): Promise<{ readonly porContaEstoque: Map<string, ContadoresErpLi> }> {
  const { estoque, preco } = args;
  if (preco === null) {
    if (estoque === null) return { porContaEstoque: new Map() };
    return {
      porContaEstoque: await avaliarPaginaErpLi(db, grupos, estoque.contas, estoque.estados, {
        global: args.global,
      }),
    };
  }

  let porContaEstoque = new Map<string, ContadoresErpLi>();
  let produtos = new Map<string, ProdutoPrecoLi | null>();
  if (estoque !== null) {
    porContaEstoque = await avaliarPaginaErpLi(db, grupos, estoque.contas, estoque.estados, {
      global: args.global,
      camposExtras: CAMPOS_PRODUTO_PRECO_LI,
      aoLerProdutos: (brutos) => {
        produtos = new Map(
          [...brutos].map(([id, bruto]) => [id, bruto === null ? null : produtoPrecoDe(id, bruto)]),
        );
      },
    });
  } else {
    const aLer = grupos.flatMap(({ produtoId, links }) =>
      preco.contas.some((c) => vinculoDaContaLi(c.contaId, links).tipo === 'vinculado')
        ? [produtoId]
        : [],
    );
    if (aLer.length > 0) {
      produtos = await lerProdutosPrecoDaPaginaLi(db, aLer);
      args.global.set(
        'erpProdutosLidos',
        (args.global.get('erpProdutosLidos') ?? 0) + new Set(aLer).size,
      );
    }
  }

  const arma = preco.arma ?? avaliarPrecoDaPaginaLi;
  for (const conta of preco.contas) {
    const estado = preco.estados.get(conta.contaId);
    if (estado === undefined || estado.contador(CONTADOR_ARMA_FALHOU_LI) > 0) continue;
    let entradas: (readonly [string, EntradaSnapshotPrecoLi])[];
    let contadores: ReadonlyMap<string, number>;
    try {
      const r = arma({ grupos, produtos, conta });
      // Validated whole BEFORE anything is applied (module header): an entry off its schema, a
      // store id no bucket holds, or a counter the root's schema refuses (a name off its form, a
      // count that is not a non-negative integer) fails the page for this conta and leaves nothing
      // of it behind — never the slice's one batch, which carries the stock writes too.
      entradas = r.entradas.map(([idLi, e]) => {
        if (baldeSnapshotEstoqueLi(idLi) === null) {
          throw new RangeError('reconcile: id da loja fora da forma no braço de preço');
        }
        return [idLi, entradaSnapshotPrecoLiSchema.parse(e)] as const;
      });
      contadores = new Map(
        Object.entries(contadoresEstoqueLiSchema.parse(Object.fromEntries(r.contadores))),
      );
    } catch (err) {
      if (!falhaContidaDoPrecoLi(err)) throw err;
      estado.contar(CONTADOR_ARMA_FALHOU_LI);
      args.logger.error(`${TAG} falha no braço de preço — a conta fica sem preço nesta execução`, {
        execucaoId: args.execucaoId,
        motivo: MOTIVO_ARMA_PRECO_FALHOU_LI,
        fase: 'erp',
        contaId: conta.contaId,
        classe: classeDaFalhaLi(err),
      });
      continue;
    }
    for (const [idLi, entrada] of entradas) estado.aplicar(idLi, entrada);
    for (const [nome, n] of contadores) estado.contar(nome, n);
  }
  return { porContaEstoque };
}
