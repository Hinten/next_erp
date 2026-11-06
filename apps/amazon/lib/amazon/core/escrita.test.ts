/**
 * The write engine (step 14, PR 14-b), end to end against the REAL package
 * write client with an injected `fetch` — no network (D11): the valve gates,
 * the one diff line, the one write through the caller's own deps, and the
 * forced-refresh-once rule on a write. Step 15 (PR 15-b): the scheduling flow,
 * the restricted-client factory and the one client builder.
 */
import {
  AmazonAuthError,
  AmazonHttpError,
  type CredencialSpApi,
  type OpcoesClienteSpApi,
  type SpApiEscritaClient,
  enviarNotaFiscal,
} from '@delfrance/integrations-amazon-sp-api';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { agendarNaAmazon } from '../agendamento/easyShipAmazon';
import { conteudoDaNfeAmazon } from '../nfe/conteudoNfe';
import { AGORA_MS, REF_VERSIONADA, linhasDeChamada, loggerEspiao } from '../testing/fixtures';
import {
  EVENTO_DA_ESCRITA_AMAZON,
  type PlanoEscritaAmazon,
  executarEscritaAmazon,
} from './escrita';
import { CANARIO_ENV_AMAZON, FLUXO_AMAZON, VALVULA_ENV_AMAZON, lerValvula } from './valvulas';

/**
 * Every write client the engine builds, recorded (its options, the observer
 * included) and then built for real: the constructor is named only by the
 * engine's one builder, so this counts the builder's calls.
 */
const construcoes = vi.hoisted(() => [] as unknown[]);
vi.mock('@delfrance/integrations-amazon-sp-api', async (original) => {
  const real = await original<typeof import('@delfrance/integrations-amazon-sp-api')>();
  return {
    ...real,
    criarClienteEscritaSpApi: (opts: OpcoesClienteSpApi) => {
      construcoes.push(opts);
      return real.criarClienteEscritaSpApi(opts);
    },
  };
});

beforeEach(() => {
  construcoes.length = 0;
});

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

/* ------------------------------------------------------------------------------ */
/*              step 15 (PR 15-b): the scheduling flow and its clients             */
/* ------------------------------------------------------------------------------ */

const ACESSO_LWA = 'tok|TESTE-acesso-escrita-naoreal';
const RDT_1 = 'Atz.TESTE-rdt-um-sintetico-naoreal';
const RDT_2 = 'Atz.TESTE-rdt-dois-sintetico-naoreal';
const CAMINHO_MINT = '/tokens/2021-03-01/restrictedDataToken';
const CAMINHO_BULK = '/easyShip/2022-03-23/packages/bulk';

/** The mint's 200, the model's shape. */
const rdt = (token: string) => json(200, { restrictedDataToken: token, expiresIn: 3600 });

/** The bulk's 200 for our order (no URL: the URL is not this suite's subject). */
const bulkOk = json(200, {
  scheduledPackages: [
    {
      scheduledPackageId: { amazonOrderId: ORDER, packageId: 'PKG-TESTE-1' },
      packageStatus: 'ReadyForPickup',
    },
  ],
});

/** The scheduling valve as one environment states it. */
function valvulaAgendamento(
  modo: string | undefined,
  canario: string | undefined = `${CONTA}:${ORDER}`,
) {
  return lerValvula(FLUXO_AMAZON.agendamento, {
    [VALVULA_ENV_AMAZON.agendamento]: modo,
    [CANARIO_ENV_AMAZON.agendamento]: canario,
  });
}

type Restrito = Parameters<typeof agendarNaAmazon>[1];

/** One engine run of the scheduling shape: the REAL mint and bulk through `agendarNaAmazon`. */
function montarAgendamento(o: { modo?: string; respostas?: (() => Response)[] } = {}) {
  const { logger, linhas } = loggerEspiao();
  const f = fetchRoteirizado(...(o.respostas ?? []));
  const ctx = contexto();
  const lerAtual = vi.fn(() => Promise.resolve('agendar'));
  const escrever = vi.fn(
    (cliente: SpApiEscritaClient, _plano: PlanoEscritaAmazon, restrito: Restrito) =>
      agendarNaAmazon(cliente, restrito, ORDER),
  );
  const run = () =>
    executarEscritaAmazon({
      valvula: valvulaAgendamento(o.modo),
      contaId: CONTA,
      alvo: ORDER,
      contexto: ctx,
      deps: {
        logger,
        fetch: f.fetch,
        agora: () => AGORA_MS,
        gerarCorrelationId: () => 'corr-teste',
      },
      registro: { fluxo: 'agendamento', tentativa: 0, idTarefa: 'tarefa-agendamento-1' },
      lerAtual,
      planejar: (atual: string): PlanoEscritaAmazon => ({
        escrever: true,
        diff: { acao: atual, escreveria: true },
      }),
      escrever,
    });
  return { run, linhas, f, ctx, lerAtual, escrever };
}

const forcadas = (ctx: ReturnType<typeof contexto>) =>
  ctx.obterAcesso.mock.calls.filter((c) => c[0]?.forcarRenovacao === true);

const caminhos = (f: ReturnType<typeof fetchRoteirizado>) =>
  f.pedidos.map((p) => new URL(p.url).pathname);

describe('executarEscritaAmazon — the scheduling flow (step 15, PR 15-b)', () => {
  it('★ the flow has its own event row: agendamento', () => {
    expect(EVENTO_DA_ESCRITA_AMAZON).toEqual({ nfe: 'nfe', agendamento: 'agendamento' });
  });

  it('★ agendamento under off never calls lerAtual, and nothing reaches the network', async () => {
    const m = montarAgendamento({ modo: 'off' });
    await expect(m.run()).resolves.toEqual({ tipo: 'desligado' });
    expect(m.lerAtual).not.toHaveBeenCalled();
    expect(m.escrever).not.toHaveBeenCalled();
    expect(m.f.chamadas).not.toHaveBeenCalled();
    expect(m.linhas).toEqual([]);
  });

  it('★ agendamento under dry-run writes ONE line, evento agendamento, and never calls escrever', async () => {
    const m = montarAgendamento({ modo: 'dry-run' });
    await expect(m.run()).resolves.toMatchObject({ tipo: 'simulado', motivo: 'valvula' });
    expect(m.lerAtual).toHaveBeenCalledTimes(1);
    expect(m.escrever).not.toHaveBeenCalled();
    expect(m.f.chamadas).not.toHaveBeenCalled();
    expect(m.linhas).toHaveLength(1);
    expect(m.linhas[0]?.meta).toMatchObject({
      evento: 'agendamento',
      fluxo: 'agendamento',
      conta: CONTA,
      modo: 'dry-run',
      escreveria: true,
    });
  });

  it('★ on + canary: escrever gets a restricted factory — the mint carries the LWA token, the bulk the RDT and never the LWA token', async () => {
    const m = montarAgendamento({ modo: 'on', respostas: [rdt(RDT_1), bulkOk] });
    await expect(m.run()).resolves.toMatchObject({ tipo: 'escrito' });
    expect(m.escrever).toHaveBeenCalledTimes(1);
    expect(typeof m.escrever.mock.calls[0]?.[2]).toBe('function');
    expect(m.f.pedidos.map((p) => p.metodo)).toEqual(['POST', 'POST']);
    expect(caminhos(m.f)).toEqual([CAMINHO_MINT, CAMINHO_BULK]);
    const [mint, bulk] = m.f.pedidos;
    expect(mint?.cabecalhos.get('x-amz-access-token')).toBe(ACESSO_LWA);
    expect(bulk?.cabecalhos.get('x-amz-access-token')).toBe(RDT_1);
    for (const [, valor] of bulk?.cabecalhos ?? []) expect(valor).not.toContain(ACESSO_LWA);
    // The bulk body is the package's three keys; the engine added nothing.
    expect(Object.keys(JSON.parse(bulk?.corpo ?? '{}') as object).sort()).toEqual(
      ['labelFormat', 'marketplaceId', 'orderScheduleDetailsList'].sort(),
    );
    // One getter read for the LWA request (the mint), one for the factory's
    // ref; the restricted client never reads it (it sends the token handed in).
    expect(m.ctx.obterAcesso.mock.calls).toEqual([[], []]);
  });

  it('★ the call lines: the mint says lwa-acesso, the bulk rdt — both labelled with the LWA ref’s version; no line holds either token', async () => {
    const m = montarAgendamento({ modo: 'on', respostas: [rdt(RDT_1), bulkOk] });
    await m.run();
    const chamadas = linhasDeChamada(m.linhas);
    expect(chamadas.map((l) => [l.operacao, l.credencial])).toEqual([
      ['createRestrictedDataToken', 'lwa-acesso'],
      ['createScheduledPackageBulk', 'rdt'],
    ]);
    for (const l of chamadas) {
      expect(l).toMatchObject({
        conta: CONTA,
        fluxo: 'agendamento',
        tentativa: 0,
        idTarefa: 'tarefa-agendamento-1',
        versaoCredencial: Number(REF_VERSIONADA.split('.')[1]),
      });
    }
    const tudo = JSON.stringify(m.linhas);
    expect(tudo).not.toContain(RDT_1);
    expect(tudo).not.toContain(ACESSO_LWA);
  });

  it('★ mutation 11: a 401 on the BULK ⇒ ONE forced refresh, and the retry MINTS A NEW token (two mints, two bulks)', async () => {
    const m = montarAgendamento({
      modo: 'on',
      respostas: [rdt(RDT_1), json(401, {}), rdt(RDT_2), bulkOk],
    });
    await expect(m.run()).resolves.toMatchObject({ tipo: 'escrito' });
    expect(m.escrever).toHaveBeenCalledTimes(2);
    expect(caminhos(m.f)).toEqual([CAMINHO_MINT, CAMINHO_BULK, CAMINHO_MINT, CAMINHO_BULK]);
    expect(m.f.pedidos[1]?.cabecalhos.get('x-amz-access-token')).toBe(RDT_1);
    expect(m.f.pedidos[3]?.cabecalhos.get('x-amz-access-token')).toBe(RDT_2);
    expect(forcadas(m.ctx)).toHaveLength(1);
  });

  it('NEAR-MISS: a 401/403 on the SECOND bulk propagates — no third mint, one refresh', async () => {
    const m = montarAgendamento({
      modo: 'on',
      respostas: [rdt(RDT_1), json(401, {}), rdt(RDT_2), json(403, {}), rdt(RDT_1), bulkOk],
    });
    await expect(m.run()).rejects.toBeInstanceOf(AmazonAuthError);
    expect(m.f.pedidos).toHaveLength(4);
    expect(forcadas(m.ctx)).toHaveLength(1);
  });

  it('a 401 on the MINT refreshes once too: then one mint and one bulk', async () => {
    const m = montarAgendamento({ modo: 'on', respostas: [json(401, {}), rdt(RDT_1), bulkOk] });
    await expect(m.run()).resolves.toMatchObject({ tipo: 'escrito' });
    expect(caminhos(m.f)).toEqual([CAMINHO_MINT, CAMINHO_MINT, CAMINHO_BULK]);
    expect(forcadas(m.ctx)).toHaveLength(1);
  });

  it('a 5xx on the bulk propagates after ONE bulk — never repeated, never refreshed', async () => {
    const m = montarAgendamento({ modo: 'on', respostas: [rdt(RDT_1), json(503, {}), bulkOk] });
    await expect(m.run()).rejects.toBeInstanceOf(AmazonHttpError);
    expect(caminhos(m.f)).toEqual([CAMINHO_MINT, CAMINHO_BULK]);
    expect(forcadas(m.ctx)).toHaveLength(0);
  });
});

describe('the one client builder (step 15, PR 15-b)', () => {
  it('★ mutation 10: a scheduling run builds TWO clients through the builder, each with its OWN observer; an NF-e run builds ONE', async () => {
    await montarAgendamento({ modo: 'on', respostas: [rdt(RDT_1), bulkOk] }).run();
    expect(construcoes).toHaveLength(2);
    const [lwa, restrito] = construcoes as OpcoesClienteSpApi[];
    expect(typeof lwa?.onChamada).toBe('function');
    expect(typeof restrito?.onChamada).toBe('function');
    expect(lwa?.onChamada).not.toBe(restrito?.onChamada);
    // The SAME deps reach both.
    expect(restrito?.fetch).toBe(lwa?.fetch);
    expect(restrito?.userAgent).toBe(lwa?.userAgent);
    expect(restrito?.agora).toBe(lwa?.agora);
    expect(restrito?.gerarCorrelationId).toBe(lwa?.gerarCorrelationId);

    construcoes.length = 0;
    await montar({ modo: 'on', respostas: [json(200, {})] }).run();
    expect(construcoes).toHaveLength(1);
  });

  it('a retried escrever builds a fresh restricted client: a run refreshed once builds THREE (the LWA client once per run)', async () => {
    await montarAgendamento({
      modo: 'on',
      respostas: [rdt(RDT_1), json(401, {}), rdt(RDT_2), bulkOk],
    }).run();
    expect(construcoes).toHaveLength(3);
  });

  it('dry-run and off build no client at all', async () => {
    await montarAgendamento({ modo: 'dry-run' }).run();
    await montarAgendamento({ modo: 'off' }).run();
    expect(construcoes).toHaveLength(0);
  });
});
