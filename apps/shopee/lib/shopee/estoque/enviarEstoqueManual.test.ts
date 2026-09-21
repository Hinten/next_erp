import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import {
  SHOPEE_ERROR_KIND,
  ShopeeConfigError,
  ShopeeError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  type ShopeeClient,
} from '@delfrance/integrations-shopee';
import { ESTADO_ANUNCIO_SHOPEE } from '@delfrance/schemas';

import { FakeDb, asDb } from '../testing/fakeDb';
import {
  ENVIO_MANUAL_MAX_TENTATIVAS,
  ENVIO_MANUAL_RETRY_DELAY_MS,
  STOCK_SEND_MAX_ATTEMPTS,
} from './constantesEstoque';
import {
  OUTCOME_ENVIO_ESTOQUE,
  type EnvioEstoqueDeps,
  type ResultadoEnvioEstoqueShopee,
} from './enviarEstoque';
import {
  CHAVES_DA_LISTAGEM,
  CHAVES_DO_ENVELOPE,
  CHAVES_DO_RESUMO,
  CHAVES_SEM_ENVIO,
  MENSAGEM_ENVIO_LIMPO,
  concorrenciaEnvioManual,
  enviarEstoqueManualShopee,
  paraOutcomeDeEnvio,
  type DepsEnvioManual,
  type EnvioEstoqueListing,
} from './enviarEstoqueManual';
import {
  MENSAGEM_POR_MOTIVO,
  MOTIVO_ESTOQUE_SHOPEE,
  RESULTADO_MODELO,
  ShopeeEnvioEstoqueGuardError,
  ehRecusa,
  type LinhaDeModeloEnviada,
} from './errosEstoque';
import type { LinhaDeFamiliaShopee, TarefaDeEstoqueShopee } from './planoEstoque';

/* --------------------------------- fixtures ------------------------------- */

const INT = 'int-1';
const REF_CONTA = `documents/integracao/${INT}`;
const DEPOSITO = 'documents/deposito/dep-1';
const ITEM_ID = 2500139861;
const MODEL_ID = 2000458802;
const AGORA_MS = 1_760_000_000_000;

const CONTA: Readonly<Record<string, unknown>> = { depositoOuterRef: DEPOSITO, nome: 'Loja teste' };

function membro(produtoId: string, quantidade: number) {
  return {
    produtoId,
    ehKit: false,
    ehKitVirtual: false,
    publicado: true,
    componentesKit: null,
    timestampMs: AGORA_MS,
    estoque: { quantidade, quantidadeReservada: 0 },
    componentEstoques: [],
  };
}

function familia(
  anchorId: string,
  over: { conta?: string; link?: Record<string, unknown> } = {},
): LinhaDeFamiliaShopee {
  return {
    anchorId,
    anchor: membro(anchorId, 7),
    integracoesComProduto: [over.conta ?? INT],
    links: [
      {
        contaProdutoShopeeOuterRef: REF_CONTA,
        linkDocId: `link-${anchorId}`,
        item_id: ITEM_ID,
        item_status: 'NORMAL',
        estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.ativo,
        ...over.link,
      },
    ],
    children: [],
  };
}

function linhaDeModelo(over: Partial<LinhaDeModeloEnviada> = {}): LinhaDeModeloEnviada {
  return {
    modelId: MODEL_ID,
    produtoId: 'prod-1',
    varLinkDocId: null,
    quantidadeSolicitada: 7,
    quantidadeEnviada: 7,
    resultado: RESULTADO_MODELO.enviado,
    motivo: null,
    codigo: null,
    mensagem: MENSAGEM_POR_MOTIVO[MOTIVO_ESTOQUE_SHOPEE.clampadoNaReserva],
    clampado: false,
    piso: null,
    ...over,
  };
}

function resultadoEnviado(over: Partial<ResultadoEnvioEstoqueShopee> = {}) {
  return {
    outcome: OUTCOME_ENVIO_ESTOQUE.enviado,
    motivo: null,
    codigo: null,
    modelos: [linhaDeModelo()],
    quantidadeEnviada: 7,
    chamadasShopee: 1,
    pausadoAte: null,
    ...over,
  } satisfies ResultadoEnvioEstoqueShopee;
}

interface Chamada {
  readonly tarefa: TarefaDeEstoqueShopee;
  readonly retryCount: number | undefined;
  readonly ignoreSyncFlag: boolean | undefined;
}

function montarDeps(
  db: FakeDb,
  rows: readonly LinhaDeFamiliaShopee[],
  enviar: (c: Chamada) => Promise<ResultadoEnvioEstoqueShopee>,
  over: Partial<DepsEnvioManual> = {},
): { deps: DepsEnvioManual; chamadas: Chamada[]; esperas: number[] } {
  const chamadas: Chamada[] = [];
  const esperas: number[] = [];
  void db;
  const deps: DepsEnvioManual = {
    nowMs: AGORA_MS,
    agora: () => AGORA_MS,
    esperar: (ms: number) => {
      esperas.push(ms);
      return Promise.resolve();
    },
    conta: CONTA,
    contaNome: 'Loja teste',
    client: {} as unknown as ShopeeClient,
    increment: (by: number) => ({ __increment: by }),
    buscarFamilias: (_db, args) =>
      Promise.resolve(rows.filter((r) => args.produtoIds.includes(r.anchorId))),
    enviarTarefa: (_db: Firestore, raw: unknown, d: EnvioEstoqueDeps) => {
      const chamada: Chamada = {
        tarefa: raw as TarefaDeEstoqueShopee,
        retryCount: d.retryCount,
        ignoreSyncFlag: d.ignoreSyncFlag,
      };
      chamadas.push(chamada);
      return enviar(chamada);
    },
    ...over,
  };
  return { deps, chamadas, esperas };
}

function semear(db: FakeDb, produtoIds: readonly string[]): void {
  for (const id of produtoIds) db.seed(`produtos/${id}`, { nome: `Camiseta ${id}`, paiId: null });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

/* ------------------------------ the accounting ----------------------------- */

describe('enviarEstoqueManualShopee — a contabilidade', () => {
  it('1 — todo id pedido cai em EXATAMENTE uma lista, numa mistura achado/não-achado/outra-conta', async () => {
    const db = new FakeDb();
    semear(db, ['prod-1', 'prod-2', 'prod-3']);
    const { deps } = montarDeps(
      db,
      [familia('prod-1'), familia('prod-3', { conta: 'int-outra' })],
      () => Promise.resolve(resultadoEnviado()),
    );

    const res = await enviarEstoqueManualShopee(
      asDb(db),
      { integracaoId: INT, produtoIds: ['prod-1', 'prod-2', 'prod-3'], reenviarComErro: false },
      deps,
    );

    const cobertos = [
      ...res.listings.map((l) => l.produtoId),
      ...res.produtosSemEnvio.map((p) => p.produtoId),
    ].sort();
    expect(cobertos).toEqual(['prod-1', 'prod-2', 'prod-3']);
    expect(res.produtosSemEnvio.map((p) => [p.produtoId, p.motivo])).toEqual([
      ['prod-2', MOTIVO_ESTOQUE_SHOPEE.produtoNaoEncontrado],
      ['prod-3', MOTIVO_ESTOQUE_SHOPEE.contaForaDoProduto],
    ]);
    expect(res.solicitados).toBe(3);
    expect(res.familias).toBe(2);
  });

  it('2 — PAR: o mesmo id pedido duas vezes é UM produto (a dobra do conjunto)', async () => {
    const db = new FakeDb();
    semear(db, ['prod-1']);
    const { deps, chamadas } = montarDeps(db, [familia('prod-1')], () =>
      Promise.resolve(resultadoEnviado()),
    );

    const res = await enviarEstoqueManualShopee(
      asDb(db),
      { integracaoId: INT, produtoIds: ['prod-1', 'prod-1'], reenviarComErro: false },
      deps,
    );

    expect(res.solicitados).toBe(1);
    expect(chamadas).toHaveLength(1);
  });

  it('3 — QUASE-PAR: "prod-1" e "prod-1 " são produtos DISTINTOS, nada é fundido', async () => {
    const db = new FakeDb();
    semear(db, ['prod-1', 'prod-1 ']);
    const { deps } = montarDeps(db, [familia('prod-1')], () => Promise.resolve(resultadoEnviado()));

    const res = await enviarEstoqueManualShopee(
      asDb(db),
      { integracaoId: INT, produtoIds: ['prod-1', 'prod-1 '], reenviarComErro: false },
      deps,
    );

    expect(res.solicitados).toBe(2);
    expect(res.produtosSemEnvio.map((p) => p.produtoId)).toEqual(['prod-1 ']);
  });

  it('4 — o depósito é derivado da conta e chega ao leitor por ids', async () => {
    const db = new FakeDb();
    semear(db, ['prod-1']);
    const vistos: string[] = [];
    const { deps } = montarDeps(db, [familia('prod-1')], () => Promise.resolve(resultadoEnviado()));
    const comEspiao: DepsEnvioManual = {
      ...deps,
      buscarFamilias: (_db, args) => {
        vistos.push(args.depositoId);
        return Promise.resolve([familia('prod-1')]);
      },
    };

    await enviarEstoqueManualShopee(
      asDb(db),
      { integracaoId: INT, produtoIds: ['prod-1'], reenviarComErro: false },
      comEspiao,
    );

    expect(vistos).toEqual(['dep-1']);
  });

  it('5 — uma conta sem depósito recusa com a classe de guarda, antes de qualquer leitura', async () => {
    const db = new FakeDb();
    const { deps, chamadas } = montarDeps(db, [familia('prod-1')], () =>
      Promise.resolve(resultadoEnviado()),
    );

    await expect(
      enviarEstoqueManualShopee(
        asDb(db),
        { integracaoId: INT, produtoIds: ['prod-1'], reenviarComErro: false },
        { ...deps, conta: { depositoOuterRef: '  ' } },
      ),
    ).rejects.toBeInstanceOf(ShopeeEnvioEstoqueGuardError);
    expect(chamadas).toHaveLength(0);
  });

  it('6 — acima do limite de produtos a classe é de CONFIGURAÇÃO (a rota recusa antes)', async () => {
    const db = new FakeDb();
    const ids = Array.from({ length: 51 }, (_v, i) => `prod-${String(i)}`);
    const { deps } = montarDeps(db, [], () => Promise.resolve(resultadoEnviado()));

    await expect(
      enviarEstoqueManualShopee(
        asDb(db),
        { integracaoId: INT, produtoIds: ids, reenviarComErro: false },
        deps,
      ),
    ).rejects.toBeInstanceOf(ShopeeConfigError);
  });
});

/* -------------------------------- the ladder ------------------------------- */

describe('enviarEstoqueManualShopee — a escada', () => {
  it('7 — a ÚLTIMA tentativa mapeia no teto da fila menos um e as anteriores em 0', async () => {
    const db = new FakeDb();
    semear(db, ['prod-1']);
    let n = 0;
    const { deps, chamadas, esperas } = montarDeps(db, [familia('prod-1')], () => {
      n += 1;
      if (n === 1) return Promise.reject(new ShopeeError('falha transitória'));
      return Promise.resolve(resultadoEnviado());
    });

    const res = await enviarEstoqueManualShopee(
      asDb(db),
      { integracaoId: INT, produtoIds: ['prod-1'], reenviarComErro: false },
      deps,
    );

    expect(chamadas.map((c) => c.retryCount)).toEqual([0, STOCK_SEND_MAX_ATTEMPTS - 1]);
    expect(esperas).toEqual([ENVIO_MANUAL_RETRY_DELAY_MS]);
    expect(res.listings[0]?.outcome).toBe('enviado');
  });

  it('8 — nunca passa de ENVIO_MANUAL_MAX_TENTATIVAS, e o erro do canal vira uma FALHA', async () => {
    const db = new FakeDb();
    semear(db, ['prod-1']);
    const { deps, chamadas } = montarDeps(db, [familia('prod-1')], () =>
      Promise.reject(new ShopeeError('recusa persistente')),
    );

    const res = await enviarEstoqueManualShopee(
      asDb(db),
      { integracaoId: INT, produtoIds: ['prod-1'], reenviarComErro: false },
      deps,
    );

    expect(chamadas).toHaveLength(ENVIO_MANUAL_MAX_TENTATIVAS);
    expect(res.listings[0]?.outcome).toBe('falha');
    expect(res.listings[0]?.motivo).toBe(MOTIVO_ESTOQUE_SHOPEE.recusaDesconhecida);
  });

  it('9 — o envio manual IGNORA a válvula de sincronização', async () => {
    const db = new FakeDb();
    semear(db, ['prod-1']);
    const { deps, chamadas } = montarDeps(db, [familia('prod-1')], () =>
      Promise.resolve(resultadoEnviado()),
    );

    await enviarEstoqueManualShopee(
      asDb(db),
      { integracaoId: INT, produtoIds: ['prod-1'], reenviarComErro: false },
      deps,
    );

    expect(chamadas[0]?.ignoreSyncFlag).toBe(true);
  });

  it('10 — um erro de CONFIGURAÇÃO não é contido: sobe para a rota responder 500', async () => {
    const db = new FakeDb();
    semear(db, ['prod-1']);
    const { deps } = montarDeps(db, [familia('prod-1')], () =>
      Promise.reject(new ShopeeConfigError('corpo malformado que NÓS montamos')),
    );

    await expect(
      enviarEstoqueManualShopee(
        asDb(db),
        { integracaoId: INT, produtoIds: ['prod-1'], reenviarComErro: false },
        deps,
      ),
    ).rejects.toBeInstanceOf(ShopeeConfigError);
  });

  it('11 — um token morto interrompe a corrida inteira em vez de virar linha', async () => {
    const db = new FakeDb();
    semear(db, ['prod-1']);
    const { deps } = montarDeps(db, [familia('prod-1')], () =>
      Promise.reject(
        new ShopeeReauthRequiredError('reconecte', {
          code: 'error_auth',
          kind: SHOPEE_ERROR_KIND.reauth,
          httpStatus: 200,
          path: '/api/v2/product/update_stock',
        }),
      ),
    );

    await expect(
      enviarEstoqueManualShopee(
        asDb(db),
        { integracaoId: INT, produtoIds: ['prod-1'], reenviarComErro: false },
        deps,
      ),
    ).rejects.toBeInstanceOf(ShopeeReauthRequiredError);
  });
});

/* ------------------------------- the deadline ------------------------------ */

describe('enviarEstoqueManualShopee — o prazo', () => {
  it('12 — o prazo corre no relógio DECORRIDO injetado', async () => {
    const db = new FakeDb();
    semear(db, ['prod-1']);
    let leituras = 0;
    const { deps, chamadas } = montarDeps(db, [familia('prod-1')], () =>
      Promise.resolve(resultadoEnviado()),
    );
    const comRelogio: DepsEnvioManual = {
      ...deps,
      agora: () => {
        leituras += 1;
        // A primeira leitura é o início; a segunda já passou do orçamento.
        return leituras === 1 ? 0 : 120_001;
      },
    };

    const res = await enviarEstoqueManualShopee(
      asDb(db),
      { integracaoId: INT, produtoIds: ['prod-1'], reenviarComErro: false },
      comRelogio,
    );

    expect(chamadas).toHaveLength(0);
    expect(res.listings[0]?.outcome).toBe('nao-tentado');
    expect(res.listings[0]?.motivo).toBe(MOTIVO_ESTOQUE_SHOPEE.tempoEsgotado);
  });

  it('13 — QUASE-MISS: um nowMs injetado NO PASSADO não estoura o prazo', async () => {
    const db = new FakeDb();
    semear(db, ['prod-1']);
    const { deps, chamadas } = montarDeps(db, [familia('prod-1')], () =>
      Promise.resolve(resultadoEnviado()),
    );
    // `nowMs` muito antigo, relógio decorrido vivo e constante: se o prazo
    // fosse medido como `nowMs + orçamento` a corrida inteira sairia vazia.
    const comRelogio: DepsEnvioManual = { ...deps, nowMs: 1, agora: () => AGORA_MS };

    const res = await enviarEstoqueManualShopee(
      asDb(db),
      { integracaoId: INT, produtoIds: ['prod-1'], reenviarComErro: false },
      comRelogio,
    );

    expect(chamadas).toHaveLength(1);
    expect(res.listings[0]?.outcome).toBe('enviado');
  });
});

/* ------------------------------ the concurrency ---------------------------- */

describe('concorrenciaEnvioManual', () => {
  it('14 — é LIMITADA pela concorrência da fila, nunca apenas default dela', () => {
    vi.stubEnv('SHOPEE_STOCK_MANUAL_CONCURRENCY', '25');
    vi.stubEnv('SHOPEE_STOCK_CONCURRENT_DISPATCHES', '3');
    expect(concorrenciaEnvioManual()).toBe(3);
  });

  it('15 — nunca 0: um valor zerado ou negativo daria deadlock no pool', () => {
    vi.stubEnv('SHOPEE_STOCK_MANUAL_CONCURRENCY', '0');
    vi.stubEnv('SHOPEE_STOCK_CONCURRENT_DISPATCHES', '0');
    expect(concorrenciaEnvioManual()).toBe(1);
  });

  it('16 — abaixo do teto o valor pedido vale', () => {
    vi.stubEnv('SHOPEE_STOCK_MANUAL_CONCURRENCY', '1');
    vi.stubEnv('SHOPEE_STOCK_CONCURRENT_DISPATCHES', '4');
    expect(concorrenciaEnvioManual()).toBe(1);
  });
});

/* -------------------------------- the abort -------------------------------- */

describe('enviarEstoqueManualShopee — os limites de taxa', () => {
  it('17 — uma RAJADA aborta o resto como nao-tentado/conta-pausada e carimba pausadoAte', async () => {
    const db = new FakeDb();
    semear(db, ['prod-1', 'prod-2']);
    db.seed(`estoqueShopeeSync/${INT}`, { pausadoAte: AGORA_MS + 300_000 });
    const { deps } = montarDeps(db, [familia('prod-1'), familia('prod-2')], () =>
      Promise.reject(
        new ShopeeRateLimitError('limite', {
          code: 'error_rate_limit',
          kind: SHOPEE_ERROR_KIND.burst,
          httpStatus: 429,
          path: '/api/v2/product/update_stock',
          retryAfterSeconds: 60,
        }),
      ),
    );

    const res = await enviarEstoqueManualShopee(
      asDb(db),
      { integracaoId: INT, produtoIds: ['prod-1', 'prod-2'], reenviarComErro: false },
      // Largura 1 para que a segunda linha veja o aborto da primeira.
      { ...deps },
    );

    expect(res.pausadoAte).toBe(new Date(AGORA_MS + 300_000).toISOString());
    for (const l of res.listings) {
      expect(l.outcome).toBe('nao-tentado');
      expect(l.motivo).toBe(MOTIVO_ESTOQUE_SHOPEE.contaPausada);
    }
  });

  it('18 — a COTA DIÁRIA usa a virada importada, não o cabeçalho', async () => {
    const db = new FakeDb();
    semear(db, ['prod-1']);
    const { deps } = montarDeps(db, [familia('prod-1')], () =>
      Promise.reject(
        new ShopeeRateLimitError('cota', {
          code: 'error_quota',
          kind: SHOPEE_ERROR_KIND.daily,
          httpStatus: 429,
          path: '/api/v2/product/update_stock',
          retryAfterSeconds: 5,
        }),
      ),
    );

    const res = await enviarEstoqueManualShopee(
      asDb(db),
      { integracaoId: INT, produtoIds: ['prod-1'], reenviarComErro: false },
      deps,
    );

    expect(res.pausadoAte).not.toBeNull();
    // Muito além dos 5 s do cabeçalho: é a virada diária.
    expect(new Date(res.pausadoAte ?? '').getTime() - AGORA_MS).toBeGreaterThan(5 * 60 * 1000);
  });

  it('19 — a válvula de filas fechada vira nao-tentado/conta-pausada e aborta', async () => {
    const db = new FakeDb();
    semear(db, ['prod-1']);
    const { deps } = montarDeps(db, [familia('prod-1')], () =>
      Promise.resolve(
        resultadoEnviado({
          outcome: OUTCOME_ENVIO_ESTOQUE.descartado,
          motivo: MOTIVO_ESTOQUE_SHOPEE.tasksDesabilitadas,
          modelos: [],
          quantidadeEnviada: 0,
          pausadoAte: AGORA_MS + 60_000,
        }),
      ),
    );

    const res = await enviarEstoqueManualShopee(
      asDb(db),
      { integracaoId: INT, produtoIds: ['prod-1'], reenviarComErro: false },
      deps,
    );

    expect(res.listings[0]?.outcome).toBe('nao-tentado');
    expect(res.listings[0]?.motivo).toBe(MOTIVO_ESTOQUE_SHOPEE.contaPausada);
    expect(res.pausadoAte).toBe(new Date(AGORA_MS + 60_000).toISOString());
  });
});

/* ------------------------------ the skip bypass ---------------------------- */

describe('enviarEstoqueManualShopee — reenviarComErro', () => {
  const linkRecusado = {
    estoqueRecusaEm: AGORA_MS - 1_000,
    estoqueRecusaEstado: ESTADO_ANUNCIO_SHOPEE.ativo,
    estoqueRecusaItemStatus: 'NORMAL',
  };

  it('20 — desligado, a impressão digital da recusa anterior PULA o anúncio', async () => {
    const db = new FakeDb();
    semear(db, ['prod-1']);
    const { deps, chamadas } = montarDeps(db, [familia('prod-1', { link: linkRecusado })], () =>
      Promise.resolve(resultadoEnviado()),
    );

    const res = await enviarEstoqueManualShopee(
      asDb(db),
      { integracaoId: INT, produtoIds: ['prod-1'], reenviarComErro: false },
      deps,
    );

    expect(chamadas).toHaveLength(0);
    expect(res.listings[0]?.motivo).toBe(MOTIVO_ESTOQUE_SHOPEE.recusaAnterior);
  });

  it('21 — ligado, o mesmo anúncio É enviado (a opção chega ao planejador)', async () => {
    const db = new FakeDb();
    semear(db, ['prod-1']);
    const { deps, chamadas } = montarDeps(db, [familia('prod-1', { link: linkRecusado })], () =>
      Promise.resolve(resultadoEnviado()),
    );

    const res = await enviarEstoqueManualShopee(
      asDb(db),
      { integracaoId: INT, produtoIds: ['prod-1'], reenviarComErro: true },
      deps,
    );

    expect(chamadas).toHaveLength(1);
    expect(res.listings[0]?.outcome).toBe('enviado');
  });

  it('22 — mesmo ligado, um anúncio REMOVIDO continua recusando', async () => {
    const db = new FakeDb();
    semear(db, ['prod-1']);
    const { deps, chamadas } = montarDeps(
      db,
      [familia('prod-1', { link: { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.removido } })],
      () => Promise.resolve(resultadoEnviado()),
    );

    const res = await enviarEstoqueManualShopee(
      asDb(db),
      { integracaoId: INT, produtoIds: ['prod-1'], reenviarComErro: true },
      deps,
    );

    expect(chamadas).toHaveLength(0);
    expect(res.listings[0]?.motivo).toBe(MOTIVO_ESTOQUE_SHOPEE.anuncioRemovido);
  });
});

/* ------------------------------- the outcomes ------------------------------ */

describe('paraOutcomeDeEnvio', () => {
  it('23 — a tabela inteira', () => {
    const base = resultadoEnviado({ modelos: [] });
    expect(paraOutcomeDeEnvio(base)).toEqual({ outcome: 'enviado', motivo: null });
    expect(paraOutcomeDeEnvio({ ...base, outcome: OUTCOME_ENVIO_ESTOQUE.enviadoParcial })).toEqual({
      outcome: 'falha',
      motivo: MOTIVO_ESTOQUE_SHOPEE.envioParcial,
    });
    expect(
      paraOutcomeDeEnvio({
        ...base,
        outcome: OUTCOME_ENVIO_ESTOQUE.pulado,
        motivo: MOTIVO_ESTOQUE_SHOPEE.syncDesabilitado,
      }),
    ).toEqual({ outcome: 'pulado', motivo: MOTIVO_ESTOQUE_SHOPEE.syncDesabilitado });
    expect(
      paraOutcomeDeEnvio({
        ...base,
        outcome: OUTCOME_ENVIO_ESTOQUE.erroRegistrado,
        motivo: MOTIVO_ESTOQUE_SHOPEE.reauth,
      }),
    ).toEqual({ outcome: 'falha', motivo: MOTIVO_ESTOQUE_SHOPEE.reauth });
    expect(
      paraOutcomeDeEnvio({
        ...base,
        outcome: OUTCOME_ENVIO_ESTOQUE.descartado,
        motivo: MOTIVO_ESTOQUE_SHOPEE.tasksDesabilitadas,
      }),
    ).toEqual({ outcome: 'nao-tentado', motivo: MOTIVO_ESTOQUE_SHOPEE.contaPausada });
    expect(
      paraOutcomeDeEnvio({
        ...base,
        outcome: OUTCOME_ENVIO_ESTOQUE.descartado,
        motivo: MOTIVO_ESTOQUE_SHOPEE.cotaDiaria,
      }),
    ).toEqual({ outcome: 'nao-tentado', motivo: MOTIVO_ESTOQUE_SHOPEE.cotaDiaria });
    expect(
      paraOutcomeDeEnvio({ ...base, outcome: OUTCOME_ENVIO_ESTOQUE.pausadoReenfileirado }),
    ).toEqual({ outcome: 'nao-tentado', motivo: MOTIVO_ESTOQUE_SHOPEE.contaPausada });
  });

  it('24 — PAR: um envio CLAMPADO continua sendo `enviado` e o motivo NÃO é recusa', () => {
    const r = paraOutcomeDeEnvio(
      resultadoEnviado({ motivo: MOTIVO_ESTOQUE_SHOPEE.clampadoNaReserva, modelos: [] }),
    );
    expect(r.outcome).toBe('enviado');
    expect(r.motivo).not.toBeNull();
    expect(ehRecusa(r.motivo ?? MOTIVO_ESTOQUE_SHOPEE.semLink)).toBe(false);
  });

  it('25 — QUASE-PAR: um envio PARCIAL é recusa e vira falha', () => {
    const r = paraOutcomeDeEnvio(
      resultadoEnviado({ outcome: OUTCOME_ENVIO_ESTOQUE.enviadoParcial, modelos: [] }),
    );
    expect(r.outcome).toBe('falha');
    expect(ehRecusa(r.motivo ?? MOTIVO_ESTOQUE_SHOPEE.clampadoNaReserva)).toBe(true);
  });
});

/* -------------------------------- the shape -------------------------------- */

describe('enviarEstoqueManualShopee — o envelope', () => {
  async function envelopeCompleto() {
    const db = new FakeDb();
    semear(db, ['prod-1', 'prod-2']);
    const { deps } = montarDeps(db, [familia('prod-1')], () =>
      Promise.resolve(
        resultadoEnviado({
          modelos: [
            linhaDeModelo(),
            linhaDeModelo({ modelId: MODEL_ID + 1, clampado: true, piso: 12 }),
            linhaDeModelo({
              modelId: MODEL_ID + 2,
              resultado: RESULTADO_MODELO.recusado,
              quantidadeEnviada: null,
            }),
          ],
        }),
      ),
    );
    return enviarEstoqueManualShopee(
      asDb(db),
      { integracaoId: INT, produtoIds: ['prod-1', 'prod-2'], reenviarComErro: false },
      deps,
    );
  }

  it('26 — os conjuntos de chaves são exatamente as constantes exportadas', async () => {
    const res = await envelopeCompleto();
    expect(Object.keys(res).sort()).toEqual([...CHAVES_DO_ENVELOPE].sort());
    expect(Object.keys(res.resumo).sort()).toEqual([...CHAVES_DO_RESUMO].sort());
    expect(Object.keys(res.listings[0] as EnvioEstoqueListing).sort()).toEqual(
      [...CHAVES_DA_LISTAGEM].sort(),
    );
    expect(Object.keys(res.produtosSemEnvio[0] ?? {}).sort()).toEqual([...CHAVES_SEM_ENVIO].sort());
  });

  it('27 — clampados e modelosRecusados vêm das linhas de modelo do remetente', async () => {
    const res = await envelopeCompleto();
    expect(res.listings[0]?.clampados).toBe(1);
    expect(res.listings[0]?.modelosRecusados).toBe(1);
    expect(res.listings[0]?.variacoes).toHaveLength(3);
  });

  it('28 — variacaoProdutoId e rearme são null em TODA linha', async () => {
    const res = await envelopeCompleto();
    for (const l of res.listings) {
      expect(l.variacaoProdutoId).toBeNull();
      expect(l.rearme).toBeNull();
    }
  });

  it('29 — toda mensagem é o texto do mapa (ou a frase do envio limpo), nunca o slug', async () => {
    const db = new FakeDb();
    semear(db, ['prod-1', 'prod-2', 'prod-3']);
    const { deps } = montarDeps(
      db,
      [
        familia('prod-1'),
        familia('prod-2', { link: { estadoAnuncio: ESTADO_ANUNCIO_SHOPEE.banido } }),
      ],
      () => Promise.resolve(resultadoEnviado()),
    );

    const res = await enviarEstoqueManualShopee(
      asDb(db),
      { integracaoId: INT, produtoIds: ['prod-1', 'prod-2', 'prod-3'], reenviarComErro: false },
      deps,
    );

    const textos = [
      ...res.listings.map((l) => [l.motivo, l.mensagem] as const),
      ...res.produtosSemEnvio.map((p) => [p.motivo, p.mensagem] as const),
    ];
    expect(textos.length).toBeGreaterThan(2);
    for (const [motivo, mensagem] of textos) {
      expect(mensagem).not.toBe(motivo);
      expect(mensagem).toBe(
        motivo === null
          ? MENSAGEM_ENVIO_LIMPO
          : MENSAGEM_POR_MOTIVO[motivo as keyof typeof MENSAGEM_POR_MOTIVO],
      );
    }
  });

  it('30 — o resumo conta as quatro categorias sobre as linhas', async () => {
    const res = await envelopeCompleto();
    expect(res.resumo).toEqual({ enviados: 1, pulados: 0, falhas: 0, naoTentados: 0 });
    expect(res.listings[0]?.quantidade).toBe(7);
  });

  it('31 — o nome do produto vem do documento, e um produto sem nome lê null', async () => {
    const db = new FakeDb();
    db.seed('produtos/prod-1', { nome: 'Camiseta prod-1', paiId: null });
    db.seed('produtos/prod-2', { nome: '   ', paiId: null });
    const { deps } = montarDeps(db, [familia('prod-1')], () => Promise.resolve(resultadoEnviado()));

    const res = await enviarEstoqueManualShopee(
      asDb(db),
      { integracaoId: INT, produtoIds: ['prod-1', 'prod-2'], reenviarComErro: false },
      deps,
    );

    expect(res.listings[0]?.produtoNome).toBe('Camiseta prod-1');
    expect(res.produtosSemEnvio[0]?.produtoNome).toBeNull();
  });
});
