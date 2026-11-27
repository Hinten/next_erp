/**
 * The daily reconcile's PRICE-ARM fixtures (master plan step 13, PR 13-f1), **for tests only**
 * (`estrutura.test.ts`: nothing outside a test imports `testing/`): one seeded catalogue, the
 * world a chain of slices runs in, and a TRACE of everything a slice did — what the GOLDEN suite
 * (`estoque/reconcile/reconcileEstoque.golden.test.ts`) pins byte for byte, and what the MIRROR
 * suite compares stock against stock.
 *
 * ## The catalogue
 *
 * Two contas, each with a depósito AND a normal tabela; the first names a promotional tabela too
 * (in the bare ref form). The first conta's families carry `precos` and the parent flag on
 * purpose — a propagating parent, a non-propagating one, a `''` root, a parent no document holds,
 * a parent id that names no document, a legacy bare-number entry, a promotion at the full price —
 * so a price read or write leaking into the stock flow shows in the trace. Beside them the stock
 * shapes a run meets: a kit and its components, a parent link, a root link with no grades, one
 * store id on two produtos, every linked child with a record and a store row, one row out of step.
 *
 * Every id and amount is INVENTED (`testing/precoLi.ts` conventions: store ids from 1000,
 * repeated-digit prices); nothing here comes from a capture.
 *
 * ## The trace
 *
 * Per slice, in order: the outcome, every document path read, every `getAll` with its paths and
 * field mask (recorded by a Proxy around the fake), every query, every write that landed (verb,
 * path, data, batch, commit stamp), both producers' enqueues and every logger line. Each record is
 * ONE line of JSON with its keys sorted, so a change shows as a line diff.
 *
 * The world's clock moves only by fixed steps — on every `getAll`, on every store call, and
 * between slices — so the budget cuts the run at the same units every time.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { TIPO_TAREFA_RECONCILE_ESTOQUE_LI } from '@delfrance/schemas';

import { LIMITE_PAGINA_ESTOQUE_ENV_LI } from '../estoque/configEstoqueLi';
import {
  type DepsReconcileEstoqueLi,
  type ResultadoReconcileLi,
  despacharReconcileEstoqueLi,
} from '../estoque/reconcile/despachoReconcile';
import { CANARIO_ENV_LI, CHAMADAS_ENV_LI, VALVULA_ENV_LI } from '../core/valvulas';
import type { AmbienteLi } from '../core/valvulas';
import { type ConsultaFake, type EscritaFake, FakeDb, asDb, increment } from './fakeDb';
import { gravadorDeLog, seedCredencial } from './fixtures';
import {
  type PlataformaEscritaLi,
  criarPlataformaEscritaLi,
  linhaEstoqueLi,
} from './plataformaEscritaLi';
import {
  AGORA_RECONCILE_MS,
  type EnfileiradoReconcileLi,
  type EnviadaEstoqueLi,
  type LinhaReconcileLi,
  RUN_A,
  agendadorGravador,
  componentesDoKit,
  filaEstoqueGravadora,
  loggerGravador,
  refDeposito,
  seedContaComDeposito,
  seedLinkFilho,
  seedProduto,
  seedRegistro,
} from './reconcileEstoqueLi';

/* -------------------------------------------------------------------------- */
/*                                The catalogue                               */
/* -------------------------------------------------------------------------- */

/** The two contas of the catalogue, in the listing's order. */
export const CONTA_PRECO_A = 'C1';
export const CONTA_PRECO_B = 'C2';

/** Their depósitos. */
export const DEPOSITO_PRECO_A = 'dep-1';
export const DEPOSITO_PRECO_B = 'dep-2';

/** Their tabelas (bare `listaDePrecos` ids): the first conta's normal and promotional, the second's normal. */
export const TABELA_NORMAL_A = 'tab-n';
export const TABELA_PROMO_A = 'tab-p';
export const TABELA_NORMAL_B = 'tab-c2';

/** A `precos` entry, as the ERP stores one. */
function preco(valor: number): { readonly valor: number } {
  return { valor };
}

/**
 * One linked produto of the catalogue: its id, its store id, the produto's own fields, its
 * record at the conta's depósito (`null`: none), and what the store row says.
 */
interface ItemDoCatalogoLi {
  readonly produtoId: string;
  readonly idLi: number;
  readonly produto: Readonly<Record<string, unknown>>;
  readonly quantidade: number | null;
  readonly naLoja: number;
}

/** The first conta's linked children (store ids from 1001), in store-id order. */
export const FILHOS_PRECO_A: readonly ItemDoCatalogoLi[] = [
  // A child of a PROPAGATING parent, with its own price beside the parent's: out of step in stock.
  {
    produtoId: 'fa-1',
    idLi: 1001,
    produto: { paiId: 'pai-a', precos: { [TABELA_NORMAL_A]: preco(33.33) } },
    quantidade: 3,
    naLoja: 9,
  },
  // A child of the same parent with no price of its own.
  { produtoId: 'fa-2', idLi: 1002, produto: { paiId: 'pai-a' }, quantidade: 4, naLoja: 4 },
  // A child of a NON-propagating parent, its promotion at or above its full price.
  {
    produtoId: 'fb-1',
    idLi: 1003,
    produto: {
      paiId: 'pai-b',
      precos: { [TABELA_NORMAL_A]: preco(44.44), [TABELA_PROMO_A]: preco(55.55) },
    },
    quantidade: 5,
    naLoja: 5,
  },
  // A `''` root (a legacy root's spelling) with its own prices.
  {
    produtoId: 'raiz-1',
    idLi: 1007,
    produto: {
      paiId: '',
      precos: { [TABELA_NORMAL_A]: preco(77.77), [TABELA_PROMO_A]: preco(66.66) },
    },
    quantidade: 6,
    naLoja: 6,
  },
  // A child whose parent no document holds.
  {
    produtoId: 'fx-1',
    idLi: 1008,
    produto: { paiId: 'pai-fantasma', precos: { [TABELA_NORMAL_A]: preco(11.11) } },
    quantidade: 1,
    naLoja: 1,
  },
  // A child whose parent id names no document at all.
  {
    produtoId: 'fy-1',
    idLi: 1009,
    produto: { paiId: 'a/b', precos: { [TABELA_NORMAL_A]: preco(22.22) } },
    quantidade: 1,
    naLoja: 1,
  },
  // A root with a legacy bare-number entry (unreadable for price).
  {
    produtoId: 'fz-1',
    idLi: 1010,
    produto: { precos: { [TABELA_NORMAL_A]: 12 } },
    quantidade: 2,
    naLoja: 2,
  },
];

/** The second conta's one child. */
export const FILHO_PRECO_B: ItemDoCatalogoLi = {
  produtoId: 'c2-1',
  idLi: 2001,
  produto: { precos: { [TABELA_NORMAL_B]: preco(88.88) } },
  quantidade: 7,
  naLoja: 7,
};

/**
 * The whole catalogue (module header): the two contas (with a credential each), every produto,
 * link and record, and the store's stock rows. Returns the store.
 */
export function semearCatalogoPrecoLi(db: FakeDb): PlataformaEscritaLi {
  seedContaComDeposito(db, CONTA_PRECO_A, refDeposito(DEPOSITO_PRECO_A), {
    nome: 'Loja A',
    tabelaNormalOuterRef: `documents/listaDePrecos/${TABELA_NORMAL_A}`,
    tabelaPromocionalOuterRef: `listaDePrecos/${TABELA_PROMO_A}`,
  });
  seedContaComDeposito(db, CONTA_PRECO_B, refDeposito(DEPOSITO_PRECO_B), {
    nome: 'Loja B',
    tabelaNormalOuterRef: `documents/listaDePrecos/${TABELA_NORMAL_B}`,
  });
  seedCredencial(db, CONTA_PRECO_A);
  seedCredencial(db, CONTA_PRECO_B);

  // The parents: one propagates (no flag), one does not; only the first has a link (a parent root).
  seedProduto(db, 'pai-a', {
    precos: { [TABELA_NORMAL_A]: preco(22.22), [TABELA_PROMO_A]: preco(11.11) },
  });
  seedLinkFilho(db, 'pai-a', 'l1', CONTA_PRECO_A, 1000, {
    paiProdutoIntegradaId: null,
    grades: [1],
  });
  seedProduto(db, 'pai-b', {
    propagatePriceToChildren: false,
    precos: { [TABELA_NORMAL_A]: preco(99.99) },
  });

  const linhas: Record<string, unknown>[] = [linhaEstoqueLi(1000, { quantidade: 0 })];
  for (const item of FILHOS_PRECO_A) {
    seedProduto(db, item.produtoId, item.produto);
    seedLinkFilho(db, item.produtoId, 'l1', CONTA_PRECO_A, item.idLi);
    if (item.quantidade !== null) {
      seedRegistro(db, item.produtoId, DEPOSITO_PRECO_A, item.quantidade);
    }
    linhas.push(linhaEstoqueLi(item.idLi, { quantidade: item.naLoja }));
  }

  // A kit its components bound, with a price of its own.
  seedProduto(db, 'kit-1', {
    ehKit: true,
    componentesKit: componentesDoKit({ 'comp-1': 1, 'comp-2': 2 }),
    precos: { [TABELA_NORMAL_A]: preco(55.55) },
  });
  seedLinkFilho(db, 'kit-1', 'l1', CONTA_PRECO_A, 1004);
  seedRegistro(db, 'comp-1', DEPOSITO_PRECO_A, 10);
  seedRegistro(db, 'comp-2', DEPOSITO_PRECO_A, 6);
  linhas.push(linhaEstoqueLi(1004, { quantidade: 3 }));

  // A root link with no grades (a shape the step does not send).
  seedProduto(db, 'ns-1', { precos: { [TABELA_NORMAL_A]: preco(33.33) } });
  seedLinkFilho(db, 'ns-1', 'l1', CONTA_PRECO_A, 1005, { paiProdutoIntegradaId: null });
  linhas.push(linhaEstoqueLi(1005, { quantidade: 0 }));

  // One store id on two produtos.
  for (const produtoId of ['dup-1', 'dup-2']) {
    seedProduto(db, produtoId, { precos: { [TABELA_NORMAL_A]: preco(44.44) } });
    seedLinkFilho(db, produtoId, 'l1', CONTA_PRECO_A, 1006);
    seedRegistro(db, produtoId, DEPOSITO_PRECO_A, 1);
  }
  linhas.push(linhaEstoqueLi(1006, { quantidade: 1 }));

  // The second conta's child, its link in the bare conta form.
  seedProduto(db, FILHO_PRECO_B.produtoId, FILHO_PRECO_B.produto);
  seedLinkFilho(db, FILHO_PRECO_B.produtoId, 'l1', CONTA_PRECO_B, FILHO_PRECO_B.idLi, {
    contaLojaIntegrada: `integracao/${CONTA_PRECO_B}`,
  });
  seedRegistro(db, FILHO_PRECO_B.produtoId, DEPOSITO_PRECO_B, FILHO_PRECO_B.quantidade ?? 0);
  linhas.push(linhaEstoqueLi(FILHO_PRECO_B.idLi, { quantidade: FILHO_PRECO_B.naLoja }));

  return criarPlataformaEscritaLi({ estoque: linhas });
}

/* -------------------------------------------------------------------------- */
/*                                 The scenarios                              */
/* -------------------------------------------------------------------------- */

/** Scenario A's environment: stock `on`, canary `*`, the read switch `on`, a two-row store page. */
export const AMBIENTE_ESTOQUE_LIGADO_LI: AmbienteLi = Object.freeze({
  [VALVULA_ENV_LI.estoque]: 'on',
  [CANARIO_ENV_LI.estoque]: '*',
  [CHAMADAS_ENV_LI]: 'on',
  [LIMITE_PAGINA_ESTOQUE_ENV_LI]: '2',
});

/* -------------------------------------------------------------------------- */
/*                                   The world                                */
/* -------------------------------------------------------------------------- */

/** One `getAll` as the Proxy recorded it. */
export interface GetAllRastreadoLi {
  readonly caminhos: readonly string[];
  readonly mascara: readonly string[] | null;
}

/**
 * A Proxy around the fake (`asDb`) that records every `getAll` — its paths and its field mask —
 * and calls `aoLer` before answering it. Every other member is the fake's own, bound to it.
 */
export function dbRastreadoLi(
  fake: FakeDb,
  aoLer: () => void = () => undefined,
): { readonly db: Firestore; readonly getAlls: GetAllRastreadoLi[] } {
  const getAlls: GetAllRastreadoLi[] = [];
  const alvo = asDb(fake);
  const db = new Proxy(alvo, {
    get(t, prop) {
      if (prop === 'getAll') {
        return (...args: unknown[]) => {
          const ultimo = args.at(-1);
          const opcao =
            typeof ultimo === 'object' &&
            ultimo !== null &&
            !Array.isArray(ultimo) &&
            !Object.hasOwn(ultimo, 'path')
              ? (ultimo as { readonly fieldMask?: readonly string[] })
              : null;
          const refs = opcao === null ? args : args.slice(0, -1);
          getAlls.push({
            caminhos: refs.map((ref) => String((ref as { readonly path?: unknown }).path)),
            mascara: opcao?.fieldMask === undefined ? null : [...opcao.fieldMask],
          });
          aoLer();
          return fake.getAll(...args);
        };
      }
      const valor: unknown = Reflect.get(t, prop, t);
      return typeof valor === 'function' ? (valor as (...a: unknown[]) => unknown).bind(t) : valor;
    },
  });
  return { db, getAlls };
}

/** How the world's clock moves (module header, "The trace"). */
export interface PassosDoRelogioLi {
  /** Per `getAll` (default 12 s): the ERP pages spend the budget too. */
  readonly porLeituraMs?: number;
  /** Per store call, after the pacer's wait (default 4 s). */
  readonly porChamadaMs?: number;
  /** Between one slice's hand-off and the next slice (default 2 s). */
  readonly entreFatiasMs?: number;
}

/** One world a chain of slices runs in: the db (traced), the store, the producers, the logs. */
export function mundoReconcilePrecoLi(o: {
  readonly ambiente: AmbienteLi;
  readonly passos?: PassosDoRelogioLi;
  readonly tamanhoPaginaCaminhada?: number;
}) {
  const fake = new FakeDb();
  const plataforma = semearCatalogoPrecoLi(fake);
  const relogio = { agora: AGORA_RECONCILE_MS };
  const porLeitura = o.passos?.porLeituraMs ?? 12_000;
  const porChamada = o.passos?.porChamadaMs ?? 4_000;
  const { db, getAlls } = dbRastreadoLi(fake, () => {
    relogio.agora += porLeitura;
  });
  const fila = agendadorGravador();
  const estoque = filaEstoqueGravadora();
  const log = loggerGravador();
  const sink = gravadorDeLog();
  const deps = (extra: Partial<DepsReconcileEstoqueLi> = {}): DepsReconcileEstoqueLi => ({
    ambiente: o.ambiente,
    agoraMs: () => relogio.agora,
    inicioMs: relogio.agora,
    tentativa: 0,
    idTarefa: null,
    esperar: async (ms) => {
      await plataforma.esperar(ms);
      relogio.agora += porChamada;
      // A macrotask turn per call: a slice that never ends fails on the test's timeout instead
      // of starving the timer queue.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    },
    increment,
    agendador: () => fila.agendador,
    agendadorEstoque: () => estoque.agendador,
    logger: log.logger,
    fetch: plataforma.fetch,
    escrever: sink.escrever,
    tamanhoPaginaCaminhada: o.tamanhoPaginaCaminhada ?? 5,
    ...extra,
  });
  return {
    fake,
    db,
    getAlls,
    plataforma,
    relogio,
    fila,
    estoque,
    log,
    deps,
    entreFatiasMs: o.passos?.entreFatiasMs ?? 2_000,
  };
}
export type MundoReconcilePrecoLi = ReturnType<typeof mundoReconcilePrecoLi>;

/** What one slice did, as the trace records it (module header). */
export interface FatiaRastreadaLi {
  readonly resultado: ResultadoReconcileLi;
  readonly leituras: readonly string[];
  readonly getAlls: readonly GetAllRastreadoLi[];
  readonly consultas: readonly ConsultaFake[];
  readonly escritas: readonly EscritaFake[];
  readonly filaLeitura: readonly EnfileiradoReconcileLi[];
  readonly filaEstoque: readonly EnviadaEstoqueLi[];
  readonly linhas: readonly LinhaReconcileLi[];
}

/**
 * The chain from `seq` 0 of {@link RUN_A}: each slice that hands off is followed by the next,
 * until one does not (at most `maxFatias`). Each slice's own share of every record.
 */
export async function encadearReconcilePrecoLi(
  m: MundoReconcilePrecoLi,
  o: { readonly maxFatias?: number; readonly extra?: Partial<DepsReconcileEstoqueLi> } = {},
): Promise<FatiaRastreadaLi[]> {
  const fatias: FatiaRastreadaLi[] = [];
  let seq = 0;
  for (let n = 0; n < (o.maxFatias ?? 80); n += 1) {
    const marca = {
      leituras: m.fake.leituras.length,
      getAlls: m.getAlls.length,
      consultas: m.fake.consultas.length,
      escritas: m.fake.escritas.length,
      filaLeitura: m.fila.enfileirados.length,
      filaEstoque: m.estoque.enviadas.length,
      linhas: m.log.linhas.length,
    };
    const resultado = await despacharReconcileEstoqueLi(
      m.db,
      { tipo: TIPO_TAREFA_RECONCILE_ESTOQUE_LI, execucaoId: RUN_A, seq },
      m.deps({ inicioMs: m.relogio.agora, ...o.extra }),
    );
    fatias.push({
      resultado,
      leituras: m.fake.leituras.slice(marca.leituras),
      getAlls: m.getAlls.slice(marca.getAlls),
      consultas: m.fake.consultas.slice(marca.consultas),
      escritas: m.fake.escritas.slice(marca.escritas),
      filaLeitura: m.fila.enfileirados.slice(marca.filaLeitura),
      filaEstoque: m.estoque.enviadas.slice(marca.filaEstoque),
      linhas: m.log.linhas.slice(marca.linhas),
    });
    if (resultado.kind !== 'continua') return fatias;
    seq = resultado.seq;
    m.relogio.agora += m.entreFatiasMs;
  }
  throw new Error('encadearReconcilePrecoLi: a cadeia não terminou');
}

/* -------------------------------------------------------------------------- */
/*                                 Serialisation                              */
/* -------------------------------------------------------------------------- */

/** `v` with every object's keys sorted, functions and `undefined` dropped, a `Date` as ISO text. */
function estavel(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(estavel);
  if (typeof v === 'object' && v !== null) {
    const saida: Record<string, unknown> = {};
    for (const chave of Object.keys(v).sort()) {
      const x: unknown = (v as Readonly<Record<string, unknown>>)[chave];
      if (x === undefined || typeof x === 'function') continue;
      saida[chave] = estavel(x);
    }
    return saida;
  }
  return v;
}

/** One record as ONE line of JSON, keys sorted (module header). */
export function linhaEstavelLi(v: unknown): string {
  return JSON.stringify(estavel(v));
}

/** The whole trace as text: a header line per slice, then one line per record (module header). */
export function textoDoTracoLi(fatias: readonly FatiaRastreadaLi[]): string {
  const saida: string[] = [];
  fatias.forEach((f, n) => {
    saida.push(`=== fatia ${String(n)} ===`);
    saida.push(`resultado ${linhaEstavelLi(f.resultado)}`);
    for (const caminho of f.leituras) saida.push(`leitura ${caminho}`);
    for (const g of f.getAlls) saida.push(`getAll ${linhaEstavelLi(g)}`);
    for (const c of f.consultas) saida.push(`consulta ${linhaEstavelLi(c)}`);
    for (const e of f.escritas) saida.push(`escrita ${linhaEstavelLi(e)}`);
    for (const t of f.filaLeitura) saida.push(`fila-leitura ${linhaEstavelLi(t)}`);
    for (const t of f.filaEstoque) saida.push(`fila-estoque ${linhaEstavelLi(t)}`);
    for (const l of f.linhas) saida.push(`linha ${linhaEstavelLi(l)}`);
  });
  return `${saida.join('\n')}\n`;
}
