/**
 * Synthetic Loja Integrada PRODUCT rows, details and a scripted store, **for tests only** (the
 * `fakeDb.ts` rule: nothing outside a `*.test.ts` imports this) — shared by the product import's
 * phase suites (master plan step 9).
 *
 * Every value is invented, in the shape of the public document's `GET /v1/produto` example: list
 * rows carry no `pai`, variations are rows of their own, ids are product URIs. Nothing reaches the
 * network: the store is a responder for `plataformaCatalogoLi` (`catalogoLi.ts`), a `fetch` the
 * test hands the context's client (D17).
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  type ProdutoLiDetalhado,
  type ProdutoLiLido,
  lerDetalheProdutoLi,
  lerProdutoLi,
} from '@delfrance/schemas';

import { type ContextoLojaIntegrada, loadLojaIntegradaContext } from '../core/contexto';
import type { EscritorLogLi } from '../core/log';
import {
  type ChamadaCatalogoLi,
  type RespostaCatalogoLi,
  ok,
  plataformaCatalogoLi,
} from './catalogoLi';
import type { DocData } from './fakeDb';
import { AMBIENTE_LIGADO, ritmoFalso } from './fixtures';

/** A product URI in the document's form. */
export function uriProdutoLi(id: number): string {
  return `/api/v1/produto/${String(id)}`;
}

/** A two-id option URI in the document's form. */
export function uriOpcaoLi(gradeId: number, opcaoId: number): string {
  return `/api/v1/grade/${String(gradeId)}/variacao/${String(opcaoId)}`;
}

/** One list row, a simple product unless `over` says otherwise. */
export function linhaProdutoLi(id: number, over: DocData = {}): DocData {
  return {
    apelido: null,
    ativo: true,
    bloqueado: false,
    categorias: [],
    descricao_completa: '',
    destaque: false,
    filhos: [],
    grades: [],
    gtin: '',
    id,
    id_externo: null,
    mpn: '',
    ncm: '',
    nome: `Produto ${String(id)}`,
    removido: false,
    resource_uri: uriProdutoLi(id),
    seo: '/api/v1/seo/None',
    sku: `SKU-${String(id)}`,
    tipo: 'normal',
    url: 'https://loja.invalid/produto',
    url_video_youtube: null,
    variacoes: [],
    ...over,
  };
}

/** A parent row claiming `filhos` (ids) in its `filhos` URIs. */
export function paiLi(id: number, filhos: readonly number[], over: DocData = {}): DocData {
  return linhaProdutoLi(id, {
    tipo: 'atributo',
    filhos: filhos.map(uriProdutoLi),
    ...over,
  });
}

/** A variation row: no `nome`, one option. */
export function filhoLi(id: number, over: DocData = {}): DocData {
  return linhaProdutoLi(id, {
    tipo: 'atributo_opcao',
    nome: null,
    variacoes: [uriOpcaoLi(8946, id)],
    ...over,
  });
}

/** A product detail: the row plus what only a detail carries (`pai` a product id, or `null`). */
export function detalheLi(linha: DocData, pai: number | null = null, over: DocData = {}): DocData {
  return {
    ...linha,
    pai: pai === null ? null : uriProdutoLi(pai),
    marca: null,
    peso: '0.200',
    altura: 10,
    largura: 12,
    profundidade: 14,
    imagem_principal: null,
    imagens: [],
    preco_cheio: '99.90',
    estoque_gerenciado: true,
    ...over,
  };
}

/** A synthetic row with its `id` typed, as the package hands it over. */
function comId(linha: DocData): DocData & { readonly id: number } {
  if (typeof linha.id !== 'number') throw new Error('produtosLi: a linha não tem id numérico');
  return { ...linha, id: linha.id };
}

/** The ROW view of a synthetic row (through the shared reader, like the job). */
export function vistaLi(linha: DocData): ProdutoLiLido {
  const vista = lerProdutoLi(comId(linha));
  if (vista === null) throw new Error('vistaLi: a linha não tem id utilizável');
  return vista;
}

/** The DETAIL view of a synthetic detail (through the shared reader, like the job). */
export function vistaDetalhadaLi(corpo: DocData): ProdutoLiDetalhado {
  const vista = lerDetalheProdutoLi(comId(corpo));
  if (vista === null) throw new Error('vistaDetalhadaLi: o detalhe não tem id utilizável');
  return vista;
}

/** One `/v1/produto/` page of `objetos`: `next` keeps `limit` and `removido`, as the store does. */
export function paginaProdutosLi(
  objetos: readonly DocData[],
  opts: {
    readonly offset: number;
    readonly limite: number;
    readonly removido: boolean;
    readonly total?: number | null;
    readonly temProxima: boolean;
  },
): RespostaCatalogoLi {
  const { offset, limite, removido } = opts;
  const total = opts.total === undefined ? offset + objetos.length : opts.total;
  return ok({
    meta: {
      limit: limite,
      offset,
      total_count: total,
      previous: null,
      next: opts.temProxima
        ? `/api/v1/produto/?limit=${String(limite)}&removido=${String(removido)}&offset=${String(
            offset + limite,
          )}`
        : null,
    },
    objects: objetos,
  });
}

/** A scripted store's catalogue. */
export interface LojaDeProdutosLi {
  /** The live list (`removido=false`), in the order the store pages it. */
  readonly ativos: readonly DocData[];
  /** The trash list (`removido=true`). */
  readonly lixeira?: readonly DocData[];
  /** The detail bodies by id; a missing id answers 404 with an empty body. */
  readonly detalhes?: ReadonlyMap<number, DocData>;
  /** The page size the store applies (default: the one asked). */
  readonly limiteAplicado?: number;
  /** The `total_count` each list announces (default: its length). */
  readonly totais?: { readonly ativos?: number | null; readonly lixeira?: number | null };
}

/** The query value of `chave` in a request, or `undefined`. */
export function parametroDe(chamada: ChamadaCatalogoLi, chave: string): string | undefined {
  return chamada.query.find(([k]) => k === chave)?.[1];
}

/**
 * A responder for `plataformaCatalogoLi` playing the store: `/v1/produto/` pages its two lists by
 * the request's own `offset`, `limit` and `removido`; `/v1/produto/<id>/` answers the detail or 404;
 * anything else is a 500, so a request built differently fails loudly.
 */
export function respostasDaLojaLi(
  loja: LojaDeProdutosLi,
): (chamada: ChamadaCatalogoLi) => RespostaCatalogoLi {
  return (chamada) => {
    if (chamada.caminho === '/v1/produto/') {
      const removido = parametroDe(chamada, 'removido') === 'true';
      const linhas = removido ? (loja.lixeira ?? []) : loja.ativos;
      const offset = Number(parametroDe(chamada, 'offset') ?? '0');
      const limite = loja.limiteAplicado ?? Number(parametroDe(chamada, 'limit') ?? '20');
      const total = removido ? loja.totais?.lixeira : loja.totais?.ativos;
      return paginaProdutosLi(linhas.slice(offset, offset + limite), {
        offset,
        limite,
        removido,
        total: total === undefined ? linhas.length : total,
        temProxima: offset + limite < linhas.length,
      });
    }
    const id = /^\/v1\/produto\/(\d+)\/$/.exec(chamada.caminho)?.[1];
    if (id !== undefined) {
      const detalhe = loja.detalhes?.get(Number(id));
      return detalhe === undefined ? { status: 404, corpo: '' } : ok(detalhe);
    }
    return { status: 500, corpo: { erro: 'rota nao roteirizada' } };
  };
}

/**
 * The REAL context of a seeded conta (switch on, the pacer recorded, the log lines kept), its
 * client calling `responder` — the store a phase suite scripts.
 */
export async function contextoDeTesteLi(
  db: Firestore,
  contaId: string,
  responder: (c: ChamadaCatalogoLi) => RespostaCatalogoLi | Promise<RespostaCatalogoLi>,
  escrever: EscritorLogLi,
): Promise<{
  readonly contexto: ContextoLojaIntegrada;
  readonly chamadas: ChamadaCatalogoLi[];
  readonly esperas: number[];
}> {
  const plataforma = plataformaCatalogoLi(responder);
  const { ritmo, esperas } = ritmoFalso();
  const contexto = await loadLojaIntegradaContext(db, contaId, {
    ambiente: AMBIENTE_LIGADO,
    ritmo,
    registro: { fluxo: 'importacao', escrever },
    fetch: plataforma.fetch,
  });
  return { contexto, chamadas: plataforma.chamadas, esperas };
}
