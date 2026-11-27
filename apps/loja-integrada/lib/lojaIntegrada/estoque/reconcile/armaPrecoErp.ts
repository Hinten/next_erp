/**
 * The daily reconcile's PRICE ARM over one ERP walk page (master plan step 13, PR 13-f1): for one
 * priced conta, every store id the page's links name, turned into the conta's price snapshot
 * entry. PURE — no I/O, no clock, no environment: the page's links and its produtos (already read,
 * masked) come in, entries and counters go out, and the caller applies them
 * (`paginaErpReconcile.ts`).
 *
 * ## Per group of links (`vinculoDaContaLi`, the reader the stock flow and the send run use)
 *
 * | verdict | entry, per store id the conta's links name | counter |
 * | --- | --- | --- |
 * | `sem-vinculo` | — | — |
 * | `pai` | `{ p, f: 'pai' }` | `pais` |
 * | `nao-suportado` | `{ p, f: 'ns' }` | `naoSuportados` |
 * | `vinculo-ambiguo` | `{ p, f: 'amb' }` | `ambiguos` |
 * | `vinculado`, the produto absent | none (never asked) | `ausentes` |
 * | `vinculado`, a parent id no document can have | `{ p, f: 'v', a: { r: 'pai-ausente' } }` | `paiInvalido` |
 * | `vinculado` otherwise | `{ p, f: 'v', pai?, n, pr? }` | `validos` |
 *
 * `pai` is `paiDoProdutoErp`'s answer — so a `''` root and a self-parent are roots, never a raw
 * `paiId` check — and the parent id must be one `idDocumentoEstoqueLiSchema` accepts, or the child
 * is held at once, with no parent to read (`precoAlvoLi` answers the same). `n` and `pr` are the
 * produto's OWN readings at the run's tabelas (`leituraTabelaPrecoLi` then
 * `leituraSnapshotDaTabelaLi`), read even under a propagating parent — whether the parent
 * propagates is known only once the parents unit reads it; a promotional tabela the run does not
 * have gives no `pr`. A key whose reading is "absent" is omitted.
 *
 * Every entry is PARSED here (`entradaSnapshotPrecoLiSchema`), so a malformed one throws inside
 * this function — before anything is applied — and the caller's narrow containment answers it.
 */
import {
  type EntradaSnapshotPrecoLi,
  FLAG_ENTRADA_PRECO_LI,
  MOTIVO_RETENCAO_PRECO_LI,
  type ProdutoPrecoLi,
  entradaSnapshotPrecoLiSchema,
  idDocumentoEstoqueLiSchema,
  idsDosVinculosDaContaLi,
  leituraSnapshotDaTabelaLi,
  leituraTabelaPrecoLi,
  paiDoProdutoErp,
  vinculoDaContaLi,
} from '@delfrance/schemas';

import type { GrupoDeVinculosLi } from './caminhadaVinculos';
import type { ContaPrecoDoRunLi } from './estadoPrecoReconcile';

/** What the arm hands back for one conta of one page: parsed entries, and its counters. */
export interface ResultadoArmaPrecoLi {
  /** `[store id, entry]`, every entry ALREADY parsed. */
  readonly entradas: readonly (readonly [string, EntradaSnapshotPrecoLi])[];
  readonly contadores: ReadonlyMap<string, number>;
}

/** An OWN property only: an inherited one is not stored data. */
function proprio(o: Readonly<Record<string, unknown>>, chave: string): unknown {
  return Object.hasOwn(o, chave) ? o[chave] : undefined;
}

/** The entry of a VALID child (module header's table, last two rows). */
function entradaDoVinculado(
  produto: ProdutoPrecoLi,
  conta: ContaPrecoDoRunLi,
): { readonly entrada: EntradaSnapshotPrecoLi; readonly contador: string } {
  const pai = paiDoProdutoErp(produto.dados, produto.id);
  if (pai !== null && !idDocumentoEstoqueLiSchema.safeParse(pai).success) {
    return {
      entrada: {
        p: produto.id,
        f: FLAG_ENTRADA_PRECO_LI.valido,
        a: { r: MOTIVO_RETENCAO_PRECO_LI.paiAusente },
      },
      contador: 'paiInvalido',
    };
  }
  const precos = proprio(produto.dados, 'precos');
  const n = leituraSnapshotDaTabelaLi(leituraTabelaPrecoLi(precos, conta.tabelas.normal));
  const pr =
    conta.tabelas.promocional === null
      ? null
      : leituraSnapshotDaTabelaLi(leituraTabelaPrecoLi(precos, conta.tabelas.promocional));
  return {
    entrada: {
      p: produto.id,
      f: FLAG_ENTRADA_PRECO_LI.valido,
      ...(pai === null ? {} : { pai }),
      ...(n === null ? {} : { n }),
      ...(pr === null ? {} : { pr }),
    },
    contador: 'validos',
  };
}

/**
 * The price arm of one page for one conta (module header). `produtos` holds every produto a
 * `vinculado` link of the conta names (masked; `null` = absent); one it does not hold is a caller
 * bug, thrown as `RangeError`.
 */
export function avaliarPrecoDaPaginaLi(args: {
  readonly grupos: readonly GrupoDeVinculosLi[];
  readonly produtos: ReadonlyMap<string, ProdutoPrecoLi | null>;
  readonly conta: ContaPrecoDoRunLi;
}): ResultadoArmaPrecoLi {
  const { conta } = args;
  const entradas: (readonly [string, EntradaSnapshotPrecoLi])[] = [];
  const contadores = new Map<string, number>();
  const contar = (nome: string): void => {
    contadores.set(nome, (contadores.get(nome) ?? 0) + 1);
  };
  const adicionar = (idLi: string, entrada: EntradaSnapshotPrecoLi): void => {
    entradas.push([idLi, entradaSnapshotPrecoLiSchema.parse(entrada)]);
  };
  const porId = (
    produtoId: string,
    links: readonly unknown[],
    f: EntradaSnapshotPrecoLi['f'],
  ): void => {
    for (const idLi of idsDosVinculosDaContaLi(conta.contaId, links)) {
      adicionar(idLi, { p: produtoId, f });
    }
  };

  for (const { produtoId, links } of args.grupos) {
    const vinculo = vinculoDaContaLi(conta.contaId, links);
    switch (vinculo.tipo) {
      case 'sem-vinculo':
        break;
      case 'pai':
        porId(produtoId, links, FLAG_ENTRADA_PRECO_LI.pai);
        contar('pais');
        break;
      case 'nao-suportado':
        porId(produtoId, links, FLAG_ENTRADA_PRECO_LI.naoSuportado);
        contar('naoSuportados');
        break;
      case 'vinculo-ambiguo':
        porId(produtoId, links, FLAG_ENTRADA_PRECO_LI.ambiguo);
        contar('ambiguos');
        break;
      case 'vinculado': {
        if (!args.produtos.has(produtoId)) {
          throw new RangeError('reconcile: produto vinculado sem leitura na página');
        }
        const produto = args.produtos.get(produtoId) ?? null;
        if (produto === null) {
          contar('ausentes');
          break;
        }
        const { entrada, contador } = entradaDoVinculado(produto, conta);
        adicionar(vinculo.idLi, entrada);
        contar(contador);
        break;
      }
    }
  }
  return { entradas, contadores };
}
