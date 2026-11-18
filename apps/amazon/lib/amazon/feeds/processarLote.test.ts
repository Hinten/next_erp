/**
 * The jobs queue's DISPATCHER (step 12a, PR 12-c): P0 and the routing by
 * `tipo`. The four feed handlers and the bound reconcile page are SPIED (each
 * is proved end to end in its own
 * suite, and `resultadoFeed.test.ts` drives send → result → recovery through
 * this dispatcher with the real ones): here only what reaches which handler,
 * with which provider of the BOUND seam rows, and what a refused payload writes.
 *
 * ⚠️ D11: nothing here reaches a handler body that could call Amazon, and the
 * global `fetch` refuses. PLACEHOLDERS ONLY (public repository).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLUXO_FEED_AMAZON, MOTIVO_CONTA_AMAZON } from '@delfrance/schemas';

import { FakeDb, asDb, increment } from '../testing/fakeDb';
import { AGORA_MS, AMBIENTE_LIGADO, loggerEspiao } from '../testing/fixtures';
import type { AgendadorLotesAmazon } from './agendadorLotes';
import type { ProvedoresLoteAmazon } from './destinosLote';
import type { ProvedorLoteAmazon } from './provedorLote';
import {
  TIPO_TAREFA_LOTE_AMAZON,
  type TarefaLoteAmazon,
  tarefaLoteAmazonSchema,
} from './tarefaLote';

const espioes = vi.hoisted(() => ({
  enviar: vi.fn(),
  resultado: vi.fn(),
  incerto: vi.fn(),
  recuperar: vi.fn(),
  reconciliacao: vi.fn(),
}));
vi.mock('./enviarFeed', () => ({ enviarFeedAmazon: espioes.enviar }));
vi.mock('./resultadoFeed', () => ({ processarResultadoFeedAmazon: espioes.resultado }));
vi.mock('./incertoFeed', () => ({ processarIncertoFeedAmazon: espioes.incerto }));
vi.mock('./recuperarFeed', () => ({ processarRecuperacaoFeedAmazon: espioes.recuperar }));

const { processarLoteAmazon, RECUSA_DO_LOTE } = await import('./processarLote');

const CONTA = 'conta-amz-despacho';
const FEED = '50001234567';
const EXEC = 'exec-despacho-teste';

const PAYLOADS = {
  'feed-enviar': {
    v: 1,
    tipo: 'feed-enviar',
    fluxo: 'preco',
    contaId: CONTA,
    execucaoId: EXEC,
    origem: 'delta',
    lote: { tipo: 'blocos', partes: 1, esperaAteMs: AGORA_MS },
  },
  'feed-resultado': {
    v: 1,
    tipo: 'feed-resultado',
    contaId: null,
    feedId: FEED,
    rodada: 0,
    origem: 'notificacao',
  },
  'feed-incerto': {
    v: 1,
    tipo: 'feed-incerto',
    fluxo: 'estoque',
    contaId: CONTA,
    execucaoId: EXEC,
  },
  'feed-recuperar': {
    v: 1,
    tipo: 'feed-recuperar',
    fluxo: 'preco',
    contaId: CONTA,
    desfecho: 'concluido',
    feedId: FEED,
    execucaoId: EXEC,
    snapshotEmMs: AGORA_MS,
    pendenteDesdeMs: null,
    janela: null,
  },
  reconciliacao: {
    v: 1,
    tipo: 'reconciliacao',
    contaId: CONTA,
    execucaoId: EXEC,
    pagina: 3,
  },
} as const satisfies Record<TarefaLoteAmazon['tipo'], Record<string, unknown>>;

function provedor<F extends 'estoque' | 'preco'>(fluxo: F): ProvedorLoteAmazon<F, unknown> {
  return {
    fluxo,
    membros: () => Promise.reject(new Error('não chamado')),
    montar: () => Promise.reject(new Error('não chamado')),
    gravarResultado: () => Promise.reject(new Error('não chamado')),
    recuperar: () => Promise.reject(new Error('não chamado')),
    repassarParaPatches: () => Promise.reject(new Error('não chamado')),
    motivoFalha: MOTIVO_CONTA_AMAZON.contaSemOperacao,
  };
}

function mundo() {
  const fake = new FakeDb();
  const log = loggerEspiao();
  // The rows as the jobs root BOUND them (a fresh object per world, so a case may null one).
  const provedores: { -readonly [F in keyof ProvedoresLoteAmazon]: ProvedoresLoteAmazon[F] } = {
    estoque: provedor('estoque'),
    preco: provedor('preco'),
  };
  const agendador = (): AgendadorLotesAmazon => ({
    enfileirarLote: () => Promise.reject(new Error('não enfileira')),
  });
  const deps = {
    ambiente: AMBIENTE_LIGADO,
    agora: () => AGORA_MS,
    logger: log.logger,
    increment,
    agendador,
    provedores,
    registro: { tentativa: 2, idTarefa: 'tarefa-despacho-1' },
    fetch: () => Promise.reject(new Error('teste: nenhuma chamada de rede')),
    paginaReconciliacao: espioes.reconciliacao,
  };
  return {
    fake,
    log,
    provedores,
    deps,
    rodar: (dados: unknown) => processarLoteAmazon(asDb(fake), dados, deps),
  };
}

const rede: string[] = [];
beforeEach(() => {
  for (const espiao of Object.values(espioes)) {
    espiao.mockReset();
    espiao.mockResolvedValue({ acao: 'espiado' });
  }
  vi.stubGlobal('fetch', (input: unknown) => {
    rede.push(String(input));
    return Promise.reject(new Error('teste: nenhuma chamada de rede'));
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(rede).toEqual([]);
  rede.length = 0;
});

/* ------------------------------------------------------------------------------ */

describe('P0 — the strict payload', () => {
  it('every fixture here IS a valid payload of its tipo (the routing tests below mean something)', () => {
    for (const [tipo, payload] of Object.entries(PAYLOADS)) {
      expect(tarefaLoteAmazonSchema.parse(payload).tipo).toBe(tipo);
    }
  });

  it('★ an unknown tipo ⇒ ONE ERROR line, NO throw, nothing read, no handler', async () => {
    const m = mundo();
    const r = await m.rodar({ v: 1, tipo: 'feed-outro', contaId: CONTA, segredo: 'nao-logar' });
    expect(r).toEqual({ tipo: null, recusa: RECUSA_DO_LOTE.tipoDesconhecido });
    expect(m.log.linhas).toEqual([
      expect.objectContaining({
        nivel: 'error',
        meta: expect.objectContaining({
          evento: 'feed',
          fase: 'despacho',
          recusa: 'tipo-desconhecido',
          tipo: null,
          tentativa: 2,
          idTarefa: 'tarefa-despacho-1',
        }),
      }),
    ]);
    expect(JSON.stringify(m.log.linhas)).not.toContain('nao-logar');
    expect(JSON.stringify(m.log.linhas)).not.toContain('feed-outro');
    expect(m.fake.operacoes).toBe(0);
    for (const espiao of Object.values(espioes)) expect(espiao).not.toHaveBeenCalled();
  });

  it.each<[string, unknown]>([
    ['no payload at all', undefined],
    ['a string', 'feed-enviar'],
    ['null', null],
  ])('%s ⇒ tipo-desconhecido, ERROR, no throw', async (_caso, dados) => {
    const m = mundo();
    expect(await m.rodar(dados)).toEqual({ tipo: null, recusa: 'tipo-desconhecido' });
    expect(m.log.linhas.at(-1)).toMatchObject({ nivel: 'error' });
  });

  it('a known tipo whose field fails its grammar ⇒ payload-invalido naming the tipo and the FIELD, never its value', async () => {
    const m = mundo();
    const r = await m.rodar({ ...PAYLOADS['feed-resultado'], feedId: 'nao-digitos-sentinela' });
    expect(r).toEqual({ tipo: null, recusa: RECUSA_DO_LOTE.payloadInvalido });
    expect(m.log.linhas.at(-1)).toMatchObject({
      nivel: 'error',
      meta: { recusa: 'payload-invalido', tipo: 'feed-resultado', campos: 'feedId' },
    });
    expect(JSON.stringify(m.log.linhas)).not.toContain('sentinela');
    expect(espioes.resultado).not.toHaveBeenCalled();
  });

  it('an unknown key (strict) ⇒ payload-invalido, no handler', async () => {
    const m = mundo();
    const r = await m.rodar({ ...PAYLOADS['feed-incerto'], extra: 1 });
    expect(r).toEqual({ tipo: null, recusa: 'payload-invalido' });
    expect(espioes.incerto).not.toHaveBeenCalled();
  });
});

describe('the routing on tipo, with the provider read from the BOUND seam rows', () => {
  it('feed-enviar ⇒ the send handler, with the PAYLOAD’s fluxo’s provider', async () => {
    const m = mundo();
    const r = await m.rodar(PAYLOADS['feed-enviar']);
    expect(r).toEqual({ tipo: 'feed-enviar', r: { acao: 'espiado' } });
    expect(PAYLOADS['feed-enviar'].fluxo).toBe(FLUXO_FEED_AMAZON.preco);
    const [db, t, deps] = espioes.enviar.mock.calls[0] as [
      unknown,
      unknown,
      Record<string, unknown>,
    ];
    expect(db).toBe(asDb(m.fake));
    expect(t).toEqual(PAYLOADS['feed-enviar']);
    expect(deps.provedor).toBe(m.provedores.preco);
    expect(deps).toMatchObject({ registro: m.deps.registro, fetch: m.deps.fetch });
  });

  it('feed-resultado ⇒ the result handler, with a reader of the bound rows (the record names the fluxo)', async () => {
    const m = mundo();
    await m.rodar(PAYLOADS['feed-resultado']);
    const [, t, deps] = espioes.resultado.mock.calls[0] as [
      unknown,
      unknown,
      { readonly provedorDe: (fluxo: 'estoque' | 'preco') => unknown },
    ];
    expect(t).toEqual(PAYLOADS['feed-resultado']);
    expect(deps.provedorDe(FLUXO_FEED_AMAZON.estoque)).toBe(m.provedores.estoque);
    expect(deps.provedorDe(FLUXO_FEED_AMAZON.preco)).toBe(m.provedores.preco);
    // NEAR-MISS: the reader reads the rows at CALL time, never a copy taken per dispatch.
    m.provedores.preco = null;
    expect(deps.provedorDe(FLUXO_FEED_AMAZON.preco)).toBeNull();
  });

  it('feed-incerto ⇒ the uncertain path, with its fluxo’s provider', async () => {
    const m = mundo();
    await m.rodar(PAYLOADS['feed-incerto']);
    const [, , deps] = espioes.incerto.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
    expect(deps.provedor).toBe(m.provedores.estoque);
  });

  it('NEAR-MISS: a PRICE feed-incerto gets the price row, never the stock one', async () => {
    const m = mundo();
    await m.rodar({ ...PAYLOADS['feed-incerto'], fluxo: 'preco' });
    const [, , deps] = espioes.incerto.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
    expect(deps.provedor).toBe(m.provedores.preco);
    expect(deps.provedor).not.toBe(m.provedores.estoque);
  });

  it('feed-recuperar ⇒ the recovery handler, with its fluxo’s provider', async () => {
    const m = mundo();
    await m.rodar(PAYLOADS['feed-recuperar']);
    const [, , deps] = espioes.recuperar.mock.calls[0] as [
      unknown,
      unknown,
      Record<string, unknown>,
    ];
    expect(deps.provedor).toBe(m.provedores.preco);
  });

  it('reconciliacao ⇒ the BOUND page handler, with this dispatch’s db, payload and deps whole', async () => {
    const m = mundo();
    const r = await m.rodar(PAYLOADS.reconciliacao);
    expect(r).toEqual({ tipo: 'reconciliacao', r: { acao: 'espiado' } });
    const [db, t, deps] = espioes.reconciliacao.mock.calls[0] as [unknown, unknown, unknown];
    expect(db).toBe(asDb(m.fake));
    expect(t).toEqual(PAYLOADS.reconciliacao);
    expect(deps).toBe(m.deps);
    // NEAR-MISS: no feed handler sees a page.
    for (const espiao of [espioes.enviar, espioes.resultado, espioes.incerto, espioes.recuperar]) {
      expect(espiao).not.toHaveBeenCalled();
    }
  });

  it('a reconcile page with an unknown key or a negative page ⇒ payload-invalido naming the tipo, no handler', async () => {
    const m = mundo();
    expect(await m.rodar({ ...PAYLOADS.reconciliacao, extra: 1 })).toEqual({
      tipo: null,
      recusa: 'payload-invalido',
    });
    expect(await m.rodar({ ...PAYLOADS.reconciliacao, pagina: -1 })).toEqual({
      tipo: null,
      recusa: 'payload-invalido',
    });
    expect(m.log.linhas.at(-1)).toMatchObject({
      nivel: 'error',
      meta: { tipo: 'reconciliacao', campos: 'pagina' },
    });
    expect(espioes.reconciliacao).not.toHaveBeenCalled();
  });

  it('a null seam row is handed through as null (each handler answers it)', async () => {
    const m = mundo();
    m.provedores.preco = null;
    await m.rodar(PAYLOADS['feed-enviar']);
    const [, , deps] = espioes.enviar.mock.calls[0] as [unknown, unknown, Record<string, unknown>];
    expect(deps.provedor).toBeNull();
  });

  it('exactly ONE handler per dispatch, and the dispatcher writes no line of its own', async () => {
    const m = mundo();
    for (const tipo of Object.values(TIPO_TAREFA_LOTE_AMAZON)) await m.rodar(PAYLOADS[tipo]);
    for (const espiao of Object.values(espioes)) expect(espiao).toHaveBeenCalledTimes(1);
    expect(m.log.linhas).toEqual([]);
  });

  it('a handler’s throw is the queue’s retry: rethrown as it came', async () => {
    const m = mundo();
    const erro = new Error('do handler');
    espioes.recuperar.mockRejectedValueOnce(erro);
    await expect(m.rodar(PAYLOADS['feed-recuperar'])).rejects.toBe(erro);
  });
});
