/**
 * The write engine (step 14, PR 14-b), end to end against the REAL package
 * write client with an injected `fetch` — no network (D11): the valve gates,
 * the one diff line, the one write through the caller's own deps, and the
 * forced-refresh-once rule on a write.
 */
import {
  AmazonAuthError,
  AmazonHttpError,
  type CredencialSpApi,
  type SpApiEscritaClient,
  enviarNotaFiscal,
} from '@delfrance/integrations-amazon-sp-api';
import { describe, expect, it, vi } from 'vitest';

import { conteudoDaNfeAmazon } from '../nfe/conteudoNfe';
import { AGORA_MS, REF_VERSIONADA, linhasDeChamada, loggerEspiao } from '../testing/fixtures';
import {
  EVENTO_DA_ESCRITA_AMAZON,
  type PlanoEscritaAmazon,
  executarEscritaAmazon,
} from './escrita';
import { CANARIO_ENV_AMAZON, FLUXO_AMAZON, VALVULA_ENV_AMAZON, lerValvula } from './valvulas';

const CONTA = 'conta-teste';
const ORDER = '171-9876543-2109876';
const SENTINELA = 'SENTINELA-DO-CORPO-0123';
const XML = `<nfeProc><NFe>${SENTINELA}</NFe></nfeProc>`;

/** The NF-e valve as one environment states it. */
function valvula(modo: string | undefined, canario: string | undefined = `${CONTA}:${ORDER}`) {
  return lerValvula(FLUXO_AMAZON.nfe, {
    [VALVULA_ENV_AMAZON.nfe]: modo,
    [CANARIO_ENV_AMAZON.nfe]: canario,
  });
}

interface Pedido {
  readonly url: string;
  readonly metodo: string;
  readonly corpo: string | null;
  readonly cabecalhos: Headers;
}

/** A `fetch` that records each request (its body and headers included) and answers from a script. */
function fetchRoteirizado(...respostas: (() => Response)[]) {
  const pedidos: Pedido[] = [];
  const fila = [...respostas];
  const fetch = vi.fn((input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    pedidos.push({
      url,
      metodo: init.method ?? 'GET',
      corpo: typeof init.body === 'string' ? init.body : null,
      cabecalhos: new Headers(init.headers),
    });
    const proxima = fila.shift();
    if (proxima === undefined) return Promise.reject(new Error('fetch não esperado'));
    return Promise.resolve(proxima());
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, pedidos, chamadas: fetch };
}

const json = (status: number, corpo: unknown) => () =>
  new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } });

/** A context: the conta id and a recording credential getter. */
function contexto(integracaoId = CONTA) {
  const obterAcesso = vi.fn(
    (_opts?: { readonly forcarRenovacao?: boolean }): Promise<CredencialSpApi> =>
      Promise.resolve({ accessToken: 'tok|TESTE-acesso-escrita-naoreal', ref: REF_VERSIONADA }),
  );
  return { integracaoId, obterAcesso };
}

interface Plano extends PlanoEscritaAmazon {
  readonly nota: string;
}

/** One engine run of the NF-e submit shape; every seam a spy. */
function montar(
  o: {
    modo?: string;
    canario?: string;
    escrever?: boolean;
    respostas?: (() => Response)[];
    contaId?: string;
  } = {},
) {
  const { logger, linhas } = loggerEspiao();
  const f = fetchRoteirizado(...(o.respostas ?? []));
  const ctx = contexto();
  const lerAtual = vi.fn(() => Promise.resolve('sem-nota'));
  const planejar = vi.fn(
    (atual: string): Plano => ({
      escrever: o.escrever ?? true,
      diff: { acao: o.escrever === false ? 'aceita' : 'enviaria', statusAmazon: atual },
      nota: XML,
    }),
  );
  const escrever = vi.fn((cliente: SpApiEscritaClient, plano: Plano) =>
    enviarNotaFiscal(cliente, { orderId: ORDER, ...conteudoDaNfeAmazon(plano.nota) }),
  );
  const run = () =>
    executarEscritaAmazon({
      valvula: valvula(o.modo, o.canario),
      contaId: o.contaId ?? CONTA,
      alvo: ORDER,
      contexto: ctx,
      deps: {
        logger,
        fetch: f.fetch,
        agora: () => AGORA_MS,
        gerarCorrelationId: () => 'corr-teste',
      },
      registro: { fluxo: 'nfe', tentativa: 0, idTarefa: 'tarefa-1' },
      lerAtual,
      planejar,
      escrever,
    });
  return { run, linhas, f, ctx, lerAtual, planejar, escrever };
}

describe('executarEscritaAmazon — the valve', () => {
  it.each([undefined, '', 'off', 'ON', ' on', 'true'])(
    '★ mutation 18: valve %j (off) ⇒ nothing read, nothing planned, nothing written, no line',
    async (modo) => {
      const m = montar({ modo });
      await expect(m.run()).resolves.toEqual({ tipo: 'desligado' });
      expect(m.lerAtual).not.toHaveBeenCalled();
      expect(m.planejar).not.toHaveBeenCalled();
      expect(m.escrever).not.toHaveBeenCalled();
      expect(m.f.chamadas).not.toHaveBeenCalled();
      expect(m.ctx.obterAcesso).not.toHaveBeenCalled();
      expect(m.linhas).toEqual([]);
    },
  );

  it('★ mutation 19: dry-run ⇒ read and planned, escrever NEVER called, exactly ONE diff line', async () => {
    const m = montar({ modo: 'dry-run' });
    const r = await m.run();
    expect(r).toMatchObject({ tipo: 'simulado', motivo: 'valvula', atual: 'sem-nota' });
    expect(m.lerAtual).toHaveBeenCalledTimes(1);
    expect(m.escrever).not.toHaveBeenCalled();
    expect(m.f.chamadas).not.toHaveBeenCalled();
    expect(m.linhas).toHaveLength(1);
    expect(m.linhas[0]).toEqual({
      nivel: 'info',
      mensagem: '[amazon] nfe: dry-run (valvula)',
      meta: {
        acao: 'enviaria',
        statusAmazon: 'sem-nota',
        modo: 'dry-run',
        motivoDryRun: 'valvula',
        escreveria: true,
        evento: 'nfe',
        conta: CONTA,
        fluxo: 'nfe',
        tentativa: 0,
        idTarefa: 'tarefa-1',
      },
    });
  });

  it('dry-run of a plan that would not write still logs its one line (escreveria false)', async () => {
    const m = montar({ modo: 'dry-run', escrever: false });
    await m.run();
    expect(m.linhas).toHaveLength(1);
    expect(m.linhas[0]?.meta).toMatchObject({ acao: 'aceita', escreveria: false });
  });

  it('★ on OUTSIDE the canary ⇒ dry-run (fora-do-canario): no write, one line', async () => {
    const m = montar({ modo: 'on', canario: `${CONTA}:171-0000000-0000001` });
    await expect(m.run()).resolves.toMatchObject({ tipo: 'simulado', motivo: 'fora-do-canario' });
    expect(m.escrever).not.toHaveBeenCalled();
    expect(m.f.chamadas).not.toHaveBeenCalled();
    expect(m.linhas.map((l) => l.meta?.motivoDryRun)).toEqual(['fora-do-canario']);
  });

  it('on with no canary list ⇒ dry-run (sem-canario)', async () => {
    const m = montar({ modo: 'on', canario: '' });
    await expect(m.run()).resolves.toMatchObject({ tipo: 'simulado', motivo: 'sem-canario' });
    expect(m.escrever).not.toHaveBeenCalled();
  });

  it('a diff campo can never relabel the line: the engine’s own campos and the envelope win', async () => {
    const { logger, linhas } = loggerEspiao();
    await executarEscritaAmazon({
      valvula: valvula('dry-run'),
      contaId: CONTA,
      alvo: ORDER,
      contexto: contexto(),
      deps: { logger, agora: () => AGORA_MS },
      registro: { fluxo: 'outro' },
      lerAtual: () => Promise.resolve(null),
      planejar: () => ({
        escrever: true,
        diff: { modo: 'on', evento: 'chamada', conta: 'x', fluxo: 'y', escreveria: false },
      }),
      escrever: () => Promise.resolve(null),
    });
    expect(linhas[0]?.meta).toMatchObject({
      modo: 'dry-run',
      evento: EVENTO_DA_ESCRITA_AMAZON.nfe,
      conta: CONTA,
      fluxo: 'nfe',
      escreveria: true,
    });
  });
});

describe('executarEscritaAmazon — the one write', () => {
  it('★ on + canary ⇒ escrever called exactly ONCE, through a client built with the injected fetch', async () => {
    const m = montar({ modo: 'on', respostas: [json(200, {})] });
    const r = await m.run();
    expect(r).toEqual({
      tipo: 'escrito',
      atual: 'sem-nota',
      plano: expect.objectContaining({ escrever: true }) as unknown,
      resposta: { tipo: 'aceito-para-processamento' },
    });
    expect(m.escrever).toHaveBeenCalledTimes(1);
    expect(m.f.pedidos).toHaveLength(1);
    expect(m.f.pedidos[0]?.metodo).toBe('POST');
    expect(m.f.pedidos[0]?.url).toContain('/delivery/2022-07-01/invoice?orderId=');
    // The body is the package's five keys; the engine added nothing.
    const corpo = JSON.parse(m.f.pedidos[0]?.corpo ?? '{}') as Record<string, unknown>;
    expect(Object.keys(corpo).sort()).toEqual(
      ['contentMD5Value', 'invoiceContent', 'invoiceType', 'marketplaceId', 'programType'].sort(),
    );
    // The credential getter is the context's, re-read per request (no forced refresh).
    expect(m.ctx.obterAcesso.mock.calls).toEqual([[]]);
    // The caller's clock reached the client: `x-amz-date` is AGORA_MS's, never
    // the wall clock's (2027-01-15T15:00:00Z in ISO-8601 basic).
    expect(m.f.pedidos[0]?.cabecalhos.get('x-amz-date')).toBe('20270115T150000Z');
  });

  it('★ the write’s call line: one, labelled by the context’s conta and the registro, never carrying the body', async () => {
    const m = montar({ modo: 'on', respostas: [json(200, {})] });
    await m.run();
    const chamadas = linhasDeChamada(m.linhas);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]).toMatchObject({
      evento: 'chamada',
      conta: CONTA,
      fluxo: 'nfe',
      tentativa: 0,
      idTarefa: 'tarefa-1',
      operacao: 'submitInvoice',
      metodo: 'POST',
      status: 200,
      correlationId: 'corr-teste',
    });
    // A real write logs its call line and NOTHING else — never a dry-run line.
    expect(m.linhas.map((l) => l.meta?.evento)).toEqual(['chamada']);
    expect(m.linhas.some((l) => l.meta?.modo === 'dry-run')).toBe(false);
    const tudo = JSON.stringify(m.linhas);
    expect(tudo).not.toContain(SENTINELA);
    expect(tudo).not.toContain(conteudoDaNfeAmazon(XML).invoiceContent);
    expect(tudo).not.toContain(conteudoDaNfeAmazon(XML).contentMD5Value);
    expect(tudo).not.toContain('tok|TESTE-acesso-escrita-naoreal');
  });

  it('on + canary and a plan that writes nothing ⇒ sem-escrita: no client call, no line', async () => {
    const m = montar({ modo: 'on', escrever: false });
    await expect(m.run()).resolves.toMatchObject({ tipo: 'sem-escrita', atual: 'sem-nota' });
    expect(m.escrever).not.toHaveBeenCalled();
    expect(m.f.chamadas).not.toHaveBeenCalled();
    expect(m.linhas).toEqual([]);
  });

  it('on with canary * writes too', async () => {
    const m = montar({ modo: 'on', canario: '*', respostas: [json(200, {})] });
    await expect(m.run()).resolves.toMatchObject({ tipo: 'escrito' });
    expect(m.escrever).toHaveBeenCalledTimes(1);
  });

  it('★ a 401 on the write ⇒ ONE forced refresh and ONE retry', async () => {
    const m = montar({ modo: 'on', respostas: [json(401, {}), json(200, {})] });
    await expect(m.run()).resolves.toMatchObject({ tipo: 'escrito' });
    expect(m.escrever).toHaveBeenCalledTimes(2);
    expect(m.f.pedidos).toHaveLength(2);
    expect(m.ctx.obterAcesso.mock.calls.filter((c) => c[0]?.forcarRenovacao === true)).toHaveLength(
      1,
    );
  });

  it('★ a SECOND 401 propagates: no third call, one refresh', async () => {
    const m = montar({ modo: 'on', respostas: [json(401, {}), json(403, {}), json(200, {})] });
    await expect(m.run()).rejects.toBeInstanceOf(AmazonAuthError);
    expect(m.f.pedidos).toHaveLength(2);
    expect(m.ctx.obterAcesso.mock.calls.filter((c) => c[0]?.forcarRenovacao === true)).toHaveLength(
      1,
    );
  });

  it('★ mutation 20: a 5xx (the write MAY have landed) propagates after ONE call — never repeated', async () => {
    const m = montar({ modo: 'on', respostas: [json(503, {}), json(200, {})] });
    await expect(m.run()).rejects.toBeInstanceOf(AmazonHttpError);
    expect(m.escrever).toHaveBeenCalledTimes(1);
    expect(m.f.pedidos).toHaveLength(1);
    expect(m.ctx.obterAcesso.mock.calls.filter((c) => c[0]?.forcarRenovacao === true)).toHaveLength(
      0,
    );
  });

  it('a failing current-state read propagates, and nothing is planned or written', async () => {
    const m = montar({ modo: 'on' });
    const falha = new Error('leitura');
    m.lerAtual.mockRejectedValueOnce(falha);
    await expect(m.run()).rejects.toBe(falha);
    expect(m.planejar).not.toHaveBeenCalled();
    expect(m.escrever).not.toHaveBeenCalled();
  });

  it('a target of another conta than the context’s is a programming error, before any read', async () => {
    const m = montar({ modo: 'on', contaId: 'outra-conta' });
    await expect(m.run()).rejects.toBeInstanceOf(TypeError);
    expect(m.lerAtual).not.toHaveBeenCalled();
  });
});
