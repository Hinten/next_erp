import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { INTEGRACAO_FRETE } from '@delfrance/schemas';

import {
  ShopeeClientHttpError,
  ShopeeClientNetworkError,
  ShopeeClientRespostaInvalidaError,
  type ShopeeClient,
  type ShopeeEtiquetaPedido,
  type ShopeeEtiquetaResposta,
} from '@/lib/shopee/client';
import type { EnderecoDeColeta, Progresso } from '@/lib/shopee/wire';

import {
  SHOPEE_ETIQUETA_LIMITES,
  TAMANHO_DO_PDF_SHOPEE,
  avisoDeFormato,
  createShopeeProvider,
  mimeParaAgente,
  shopeeProvider,
  tamanhoParaAgente,
} from './shopee';
import type { EtiquetaProviderInput } from '../types';

/* -------------------------------- fixtures -------------------------------- */

// Fixture ids only (step-15 rules): package numbers `OFG…0001/0002`, an
// address `2001` and a slot `slot-1`, as the backend's own route tests use.
const PACOTE_A = 'OFG000000000001';
const PACOTE_B = 'OFG000000000002';

const TEMPO_JA_ORGANIZADO =
  'O envio JÁ ESTÁ ORGANIZADO na Shopee e não será organizado de novo — a etiqueta ainda ' +
  'não ficou pronta. Clique em Imprimir de novo em alguns minutos.';
const TEMPO_SEM_RESPOSTA =
  'A Shopee ainda não respondeu. Clique em Imprimir de novo em alguns minutos — o envio ' +
  'nunca é organizado duas vezes.';
const PERGUNTAS_DEMAIS =
  'A Shopee continuou perguntando como enviar este pedido depois de respondida — organize o ' +
  'envio na Central do Vendedor e clique em Imprimir de novo.';

const NENHUM: Progresso = { total: 1, organizados: 0, comRastreio: 0, prontos: 0 };
const ORGANIZADO: Progresso = { total: 1, organizados: 1, comRastreio: 0, prontos: 0 };

type Resposta = ShopeeEtiquetaResposta;
type Pendente = Extract<Resposta, { tipo: 'pendente' }>;

function aguardar(over: Partial<Extract<Pendente, { acao: 'aguardar' }>> = {}): Resposta {
  return {
    tipo: 'pendente',
    acao: 'aguardar',
    fase: 'aguardando-rastreio',
    tentarEmMs: 5_000,
    mensagem: 'Envio organizado; aguardando o código de rastreio da transportadora.',
    progresso: ORGANIZADO,
    ...over,
  };
}

const ENDERECOS: EnderecoDeColeta[] = [
  {
    id: '2001',
    rotulo: 'Rua do Vendedor, 100',
    principal: true,
    horarios: [
      { id: 'slot-1', rotulo: '09:00', recomendado: true },
      { id: 'slot-2', rotulo: '14:00', recomendado: false },
    ],
  },
];

function escolher(over: Partial<Extract<Pendente, { acao: 'escolher-envio' }>> = {}): Resposta {
  return {
    tipo: 'pendente',
    acao: 'escolher-envio',
    fase: 'programando',
    pacote: PACOTE_A,
    pacoteRotulo: null,
    mensagem:
      'Escolha como enviar o pacote: o endereço e o horário da coleta, ou a postagem na agência.',
    enderecos: ENDERECOS,
    permiteDropoff: true,
    escolhaInvalida: false,
    progresso: NENHUM,
    ...over,
  };
}

function porPacote(pacotes: string[]): Resposta {
  return {
    tipo: 'pendente',
    acao: 'baixar-por-pacote',
    fase: 'baixando',
    pacotes,
    mensagem:
      'Os pacotes deste pedido vão por transportadoras diferentes; cada etiqueta é baixada separadamente.',
    progresso: { total: pacotes.length, organizados: pacotes.length, comRastreio: 2, prontos: 2 },
  };
}

function arquivo(contentType = 'application/pdf', filename = 'etiqueta-shopee-1234.pdf'): Resposta {
  return { tipo: 'arquivo', blob: new Blob(['%PDF-1.4 bytes']), filename, contentType };
}

/** One scripted answer: a response, an error to throw, or a function of the call. */
type Passo =
  | Resposta
  | Error
  | ((p: ShopeeEtiquetaPedido, opts?: { signal?: AbortSignal }) => Promise<Resposta>);

function fakeClient(passos: Passo[]) {
  const fila = [...passos];
  const etiqueta = vi.fn(
    async (p: ShopeeEtiquetaPedido, opts?: { signal?: AbortSignal }): Promise<Resposta> => {
      const passo = fila.shift();
      if (passo === undefined) throw new Error('chamada a mais ao fake');
      if (typeof passo === 'function') return passo(p, opts);
      if (passo instanceof Error) throw passo;
      return passo;
    },
  );
  const client: ShopeeClient = { oauthStart: vi.fn(), conta: vi.fn(), etiqueta };
  return { client, etiqueta };
}

/** The bodies each call carried, in order. */
const corpos = (etiqueta: ReturnType<typeof fakeClient>['etiqueta']) =>
  etiqueta.mock.calls.map((c) => c[0]);

function makeInput(over: {
  client: ShopeeClient | null;
  formato?: 'pdf' | 'zpl2';
  /** The pedido's `numero`; `'1234'` unless a test says otherwise. */
  numero?: string | null;
  printJob?: EtiquetaProviderInput['deps']['printJob'];
  sleep?: (ms: number) => Promise<void>;
  ui?: Partial<EtiquetaProviderInput['ui']>;
}): EtiquetaProviderInput {
  return {
    db: {} as never,
    pedido: { numero: over.numero === undefined ? '1234' : over.numero } as never,
    pedidoId: 'p1',
    // W18: step 5 writes `externalId: null` on every multi-package order.
    frete: { externalId: null, externalOptionIntegracao: 'shopee' } as never,
    // The realistic shape: a Shopee pedido has no `int_frete` document.
    intFrete: { fonte: 'bloco', id: null, tipo: INTEGRACAO_FRETE.shopee, data: null },
    formato: over.formato ?? 'pdf',
    deps: {
      freightClient: null,
      nfeClient: null,
      mercadoLivreClient: null,
      shopeeClient: over.client,
      printJob: over.printJob ?? vi.fn(async () => 'printed' as const),
      sleep: over.sleep ?? vi.fn(async () => undefined),
    },
    ui: {
      confirmRisk: vi.fn(async () => true),
      notify: vi.fn(),
      openUrl: vi.fn(),
      comprarEtiqueta: vi.fn(),
      escolherEnvio: vi.fn(async () => null),
      ...over.ui,
    },
  };
}

/** A clock the test moves: calls and dialogs advance it on purpose. */
function relogio() {
  const r = { t: 0, agora: () => r.t };
  return r;
}

/* ------------------------------ the agent side ------------------------------ */

describe('mimeParaAgente — the essence, and only the three types the agent routes', () => {
  it('passes pdf, zip and plain text, mapping x-zip-compressed to zip', () => {
    expect(mimeParaAgente('application/pdf')).toBe('application/pdf');
    expect(mimeParaAgente('application/zip')).toBe('application/zip');
    expect(mimeParaAgente('application/x-zip-compressed')).toBe('application/zip');
    expect(mimeParaAgente('text/plain')).toBe('text/plain');
  });

  it('W13 — folds a charset parameter, case and spaces to the BARE type (equal pairs)', () => {
    expect(mimeParaAgente('text/plain; charset=utf-8')).toBe('text/plain');
    expect(mimeParaAgente('TEXT/PLAIN;charset=UTF-8')).toBe('text/plain');
    expect(mimeParaAgente(' application/pdf ; name=x')).toBe('application/pdf');
  });

  it('W13 near-misses — a type that only LOOKS like one of the three is not one', () => {
    expect(mimeParaAgente('text/plainx')).toBeNull();
    expect(mimeParaAgente('application/pdfx')).toBeNull();
    expect(mimeParaAgente('text/html')).toBeNull();
    expect(mimeParaAgente('application/octet-stream')).toBeNull();
    expect(mimeParaAgente('application/json')).toBeNull();
    expect(mimeParaAgente('')).toBeNull();
    expect(mimeParaAgente(null)).toBeNull();
    // A plain-object lookup would answer `Object.prototype.constructor` here.
    expect(mimeParaAgente('constructor')).toBeNull();
  });
});

describe('tamanhoParaAgente — W14', () => {
  it('sends a PDF at TAMANHO_DO_PDF_SHOPEE (legacy parity: A4) and the thermal files at etq', () => {
    expect(TAMANHO_DO_PDF_SHOPEE).toBe('a4');
    expect(tamanhoParaAgente('application/pdf')).toBe(TAMANHO_DO_PDF_SHOPEE);
    expect(tamanhoParaAgente('application/zip')).toBe('etq');
    expect(tamanhoParaAgente('text/plain')).toBe('etq');
  });
});

describe('avisoDeFormato — the substitution notice (R-u)', () => {
  it('warns when zpl2 was asked and a PDF came back', () => {
    expect(avisoDeFormato('zpl2', 'application/pdf')).toContain('em PDF, não em ZPL2');
  });

  it('warns when a PDF was asked and a thermal file came back', () => {
    expect(avisoDeFormato('pdf', 'application/zip')).toContain('em ZIP');
    expect(avisoDeFormato('pdf', 'text/plain; charset=utf-8')).toContain('em ZPL');
  });

  it('stays silent on the format asked for — a charset suffix included', () => {
    expect(avisoDeFormato('pdf', 'application/pdf')).toBeNull();
    expect(avisoDeFormato('pdf', 'application/pdf; charset=binary')).toBeNull();
    expect(avisoDeFormato('zpl2', 'application/zip')).toBeNull();
    expect(avisoDeFormato('zpl2', 'text/plain')).toBeNull();
  });

  it('stays silent on a type the agent cannot print (announced on its own)', () => {
    expect(avisoDeFormato('zpl2', 'application/octet-stream')).toBeNull();
  });
});

/* -------------------------------- the provider ------------------------------- */

describe('shopeeProvider — registration', () => {
  it('claims shopee and declares a reprint to be the same document', () => {
    expect(shopeeProvider.tipos).toEqual([INTEGRACAO_FRETE.shopee]);
    expect(shopeeProvider.reimpressao).toBe('mesmo-documento');
  });

  it('pins the frozen bounds', () => {
    expect(SHOPEE_ETIQUETA_LIMITES).toEqual({
      totalMs: 120_000,
      porChamadaMs: 75_000,
      pisoPorChamadaMs: 45_000,
      esperaMinMs: 2_000,
      esperaMaxMs: 15_000,
      maxPerguntas: 8,
    });
  });
});

describe('shopeeProvider — the file', () => {
  it('errors with "faça login" and makes no call when the client is null', async () => {
    const out = await createShopeeProvider().emitirOuImprimir(makeInput({ client: null }));
    expect(out).toEqual({
      status: 'error',
      message: 'Cliente da Shopee indisponível. Faça login novamente e tente de novo.',
    });
  });

  it('prints a 200 PDF at the PDF sheet, with the route filename; the body carries no absent key', async () => {
    const { client, etiqueta } = fakeClient([arquivo()]);
    const printJob = vi.fn(async () => 'printed' as const);
    const input = makeInput({ client, printJob });

    expect(await createShopeeProvider().emitirOuImprimir(input)).toEqual({ status: 'printed' });
    expect(corpos(etiqueta)).toEqual([{ pedidoId: 'p1', formato: 'pdf' }]);
    expect(Object.keys(corpos(etiqueta)[0] ?? {})).toEqual(['pedidoId', 'formato']);
    expect(printJob).toHaveBeenCalledTimes(1);
    expect(printJob).toHaveBeenCalledWith(expect.any(Blob), {
      fileName: 'etiqueta-shopee-1234.pdf',
      contentType: 'application/pdf',
      tamanho: TAMANHO_DO_PDF_SHOPEE,
    });
    expect(input.ui.notify).not.toHaveBeenCalled();
  });

  it('W18 — never reads `frete.externalId`: a split order with `externalId: null` still calls', async () => {
    const { client, etiqueta } = fakeClient([arquivo()]);
    const input = makeInput({ client });
    expect(input.frete.externalId).toBeNull();
    expect(await createShopeeProvider().emitirOuImprimir(input)).toEqual({ status: 'printed' });
    expect(etiqueta).toHaveBeenCalledTimes(1);
  });

  it('passes a per-call AbortSignal, and clears its timer once the call answers', async () => {
    const { client, etiqueta } = fakeClient([arquivo()]);
    await createShopeeProvider({ limites: { porChamadaMs: 5 } }).emitirOuImprimir(
      makeInput({ client }),
    );
    const sinal = etiqueta.mock.calls[0]?.[1]?.signal;
    expect(sinal).toBeInstanceOf(AbortSignal);
    await new Promise((r) => setTimeout(r, 25));
    expect(sinal?.aborted).toBe(false);
  });

  it('sends a zip at etq', async () => {
    const { client } = fakeClient([arquivo('application/zip', 'etiqueta-shopee-1234.zip')]);
    const printJob = vi.fn(async () => 'printed' as const);
    await createShopeeProvider().emitirOuImprimir(makeInput({ client, printJob, formato: 'zpl2' }));
    expect(printJob).toHaveBeenCalledWith(expect.any(Blob), {
      fileName: 'etiqueta-shopee-1234.zip',
      contentType: 'application/zip',
      tamanho: 'etq',
    });
  });

  it('W13 — a charset-suffixed text/plain reaches the agent BARE (round-trip check 2)', async () => {
    const { client } = fakeClient([
      arquivo('text/plain; charset=utf-8', 'etiqueta-shopee-1234.txt'),
    ]);
    const printJob = vi.fn(async () => 'printed' as const);
    await createShopeeProvider().emitirOuImprimir(makeInput({ client, printJob, formato: 'zpl2' }));
    expect(printJob).toHaveBeenCalledWith(expect.any(Blob), {
      fileName: 'etiqueta-shopee-1234.txt',
      contentType: 'text/plain',
      tamanho: 'etq',
    });
  });

  it('W13 near-miss — `text/plainx` is DOWNLOADED, never sent to the agent', async () => {
    const { client } = fakeClient([arquivo('text/plainx', 'etiqueta-shopee-1234.txt')]);
    const printJob = vi.fn(async () => 'printed' as const);
    const salvarArquivo = vi.fn();
    const input = makeInput({ client, printJob, formato: 'zpl2' });
    await createShopeeProvider({ salvarArquivo }).emitirOuImprimir(input);
    expect(printJob).not.toHaveBeenCalled();
    expect(salvarArquivo).toHaveBeenCalledWith(expect.any(Blob), 'etiqueta-shopee-1234.txt');
  });

  it('downloads an unknown type (octet-stream) with a yellow notice naming the file', async () => {
    const { client } = fakeClient([
      arquivo('application/octet-stream', 'etiqueta-shopee-1234.pdf'),
    ]);
    const printJob = vi.fn(async () => 'printed' as const);
    const salvarArquivo = vi.fn();
    const input = makeInput({ client, printJob });

    expect(await createShopeeProvider({ salvarArquivo }).emitirOuImprimir(input)).toEqual({
      status: 'printed',
    });
    expect(printJob).not.toHaveBeenCalled();
    expect(salvarArquivo).toHaveBeenCalledTimes(1);
    expect(input.ui.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        color: 'yellow',
        message: expect.stringContaining('"etiqueta-shopee-1234.pdf"'),
      }),
    );
  });

  it('warns when zpl2 was asked and a PDF came back — and still prints it', async () => {
    const { client } = fakeClient([arquivo()]);
    const printJob = vi.fn(async () => 'printed' as const);
    const input = makeInput({ client, printJob, formato: 'zpl2' });
    expect(await createShopeeProvider().emitirOuImprimir(input)).toEqual({ status: 'printed' });
    expect(printJob).toHaveBeenCalledTimes(1);
    expect(input.ui.notify).toHaveBeenCalledWith(
      expect.objectContaining({ color: 'yellow', message: expect.stringContaining('em PDF') }),
    );
  });

  it('says where a label went when the agent is down (the ZIP gets its own instruction)', async () => {
    const { client } = fakeClient([arquivo('application/zip', 'etiqueta-shopee-1234.zip')]);
    const printJob = vi.fn(async () => 'downloaded' as const);
    const input = makeInput({ client, printJob, formato: 'zpl2' });
    expect(await createShopeeProvider().emitirOuImprimir(input)).toEqual({ status: 'printed' });
    expect(input.ui.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        color: 'yellow',
        message: expect.stringMatching(/"etiqueta-shopee-1234\.zip".*abra o ZIP/),
      }),
    );
  });
});

describe('shopeeProvider — the waits', () => {
  it('polls through two waits: three calls, two clamped sleeps, ONE toast per phase', async () => {
    const { client, etiqueta } = fakeClient([aguardar(), aguardar(), arquivo()]);
    const sleep = vi.fn(async () => undefined);
    const input = makeInput({ client, sleep });

    expect(await createShopeeProvider().emitirOuImprimir(input)).toEqual({ status: 'printed' });
    expect(etiqueta).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[5_000], [5_000]]);
    expect(input.ui.notify).toHaveBeenCalledTimes(1);
    expect(input.ui.notify).toHaveBeenCalledWith({
      title: 'Etiqueta Shopee',
      message: 'Envio organizado; aguardando o código de rastreio da transportadora.',
      color: 'blue',
    });
  });

  it('near-miss — a NEW phase gets its own toast', async () => {
    const { client } = fakeClient([
      aguardar({ fase: 'programando', mensagem: 'Organizando o envio na Shopee…' }),
      aguardar(),
      arquivo(),
    ]);
    const input = makeInput({ client });
    await createShopeeProvider().emitirOuImprimir(input);
    expect(input.ui.notify).toHaveBeenCalledTimes(2);
  });

  it('shows a generic sentence for a phase this build does not know (a newer backend)', async () => {
    const { client } = fakeClient([
      aguardar({ fase: 'fase-nova', mensagem: 'Texto de um backend mais novo.' }),
      arquivo(),
    ]);
    const input = makeInput({ client });
    expect(await createShopeeProvider().emitirOuImprimir(input)).toEqual({ status: 'printed' });
    expect(input.ui.notify).toHaveBeenCalledWith({
      title: 'Etiqueta Shopee',
      message: 'Aguardando a Shopee…',
      color: 'blue',
    });
  });

  // PR 1 review 2 (F5): a read that dropped reports `consultando`. This build KNOWS
  // that phase, so the operator sees the server's own sentence, never the generic
  // one (and never "Organizando o envio…", which reads as a second arrange).
  it('shows the server sentence for the neutral read phase `consultando`', async () => {
    const { client } = fakeClient([
      aguardar({ fase: 'consultando', mensagem: 'Consultando a Shopee…' }),
      arquivo(),
    ]);
    const input = makeInput({ client });
    expect(await createShopeeProvider().emitirOuImprimir(input)).toEqual({ status: 'printed' });
    expect(input.ui.notify).toHaveBeenCalledWith({
      title: 'Etiqueta Shopee',
      message: 'Consultando a Shopee…',
      color: 'blue',
    });
  });

  it('W10 — `tentarEmMs: 0` sleeps the floor, a huge one the ceiling, a mid one as sent', async () => {
    const { client } = fakeClient([
      aguardar({ tentarEmMs: 0 }),
      aguardar({ tentarEmMs: 1_000_000_000 }),
      aguardar({ tentarEmMs: 7_000 }),
      arquivo(),
    ]);
    const sleep = vi.fn(async () => undefined);
    await createShopeeProvider().emitirOuImprimir(makeInput({ client, sleep }));
    expect(sleep.mock.calls).toEqual([[2_000], [15_000], [7_000]]);
  });

  // Review 2 (Q2-F2) moved this from "before a 4th call" to "before a 3rd": the
  // old rule started a call whenever ANY budget was left (104 s spent → a 3rd
  // call, 154 s of machine time); a call now needs the floor (45 s) left, and
  // 120 − 104 = 16 s is not it.
  it('W9 — stops before a 3rd call when the CALLS leave less than the floor (50 s each)', async () => {
    const r = relogio();
    const lento = (resposta: Resposta) => async () => {
      r.t += 50_000;
      return resposta;
    };
    const { client, etiqueta } = fakeClient([
      lento(aguardar({ tentarEmMs: 2_000 })),
      lento(aguardar({ tentarEmMs: 2_000 })),
      lento(aguardar({ tentarEmMs: 2_000 })),
      arquivo(),
    ]);
    const out = await createShopeeProvider({ agora: r.agora }).emitirOuImprimir(
      makeInput({ client }),
    );
    expect(out).toEqual({ status: 'error', message: TEMPO_JA_ORGANIZADO });
    expect(etiqueta).toHaveBeenCalledTimes(2);
    expect(r.t).toBe(100_000);
  });

  it('W9 near-miss — 100 s of DIALOG time does not count: the flow still completes', async () => {
    const r = relogio();
    const lento = (resposta: Resposta) => async () => {
      r.t += 10_000;
      return resposta;
    };
    const { client, etiqueta } = fakeClient([
      lento(escolher()),
      lento(aguardar({ tentarEmMs: 2_000 })),
      lento(arquivo()),
    ]);
    const escolherEnvio = vi.fn(async () => {
      r.t += 100_000; // the operator reads the dialog for 100 s
      return { modo: 'pickup' as const, enderecoId: '2001', horarioId: 'slot-1' };
    });
    const out = await createShopeeProvider({ agora: r.agora }).emitirOuImprimir(
      makeInput({ client, ui: { escolherEnvio } }),
    );
    expect(out).toEqual({ status: 'printed' });
    expect(etiqueta).toHaveBeenCalledTimes(3);
  });

  it('W12 — the give-up sentence says ORGANIZADO only when every package is arranged', async () => {
    // The floor shrinks with the budget, or the FIRST call would never start.
    const semTempo = { limites: { totalMs: 1_000, pisoPorChamadaMs: 500 } };
    const casos: [Progresso, string][] = [
      [{ total: 2, organizados: 2, comRastreio: 1, prontos: 0 }, TEMPO_JA_ORGANIZADO],
      // near-misses: one of two arranged; and nothing to count at all
      [{ total: 2, organizados: 1, comRastreio: 0, prontos: 0 }, TEMPO_SEM_RESPOSTA],
      [{ total: 0, organizados: 0, comRastreio: 0, prontos: 0 }, TEMPO_SEM_RESPOSTA],
    ];
    for (const [progresso, esperado] of casos) {
      const { client } = fakeClient([aguardar({ progresso })]);
      const out = await createShopeeProvider(semTempo).emitirOuImprimir(makeInput({ client }));
      expect(out).toEqual({ status: 'error', message: esperado });
    }
  });
});

/* ------------------------ the budget contract (review 2) ------------------------ */

describe('shopeeProvider — the budget contract (Q2-F2, Q2-F5)', () => {
  const { totalMs, pisoPorChamadaMs, porChamadaMs } = SHOPEE_ETIQUETA_LIMITES;

  it('a call without an answer is NOT started with less than the floor left: give-up, no call', async () => {
    // 80 s on the first call; the per-package run's first call would start with
    // 40 s left — under the 45 s floor.
    const r = relogio();
    const { client, etiqueta } = fakeClient([
      async () => {
        r.t += 80_000;
        return porPacote([PACOTE_A, PACOTE_B]);
      },
      arquivo(),
      arquivo(),
    ]);
    const out = await createShopeeProvider({ agora: r.agora }).emitirOuImprimir(
      makeInput({ client }),
    );
    expect(out).toEqual({ status: 'error', message: `Etiqueta 1 de 2: ${TEMPO_JA_ORGANIZADO}` });
    expect(etiqueta).toHaveBeenCalledTimes(1);
  });

  it('near-miss — EXACTLY the floor left: the call starts', async () => {
    const r = relogio();
    const { client, etiqueta } = fakeClient([
      async () => {
        r.t += totalMs - pisoPorChamadaMs;
        return porPacote([PACOTE_A, PACOTE_B]);
      },
      arquivo(),
      arquivo(),
    ]);
    // The first package's call takes no clock time, so the second starts with
    // the same 45 s — the floor again, not under it.
    const out = await createShopeeProvider({ agora: r.agora }).emitirOuImprimir(
      makeInput({ client }),
    );
    expect(out).toEqual({ status: 'printed' });
    expect(etiqueta).toHaveBeenCalledTimes(3);
  });

  it('the call carrying the operator’s ANSWER is exempt: it starts with 20 s left', async () => {
    const r = relogio();
    const { client, etiqueta } = fakeClient([
      async () => {
        r.t += 100_000;
        return escolher();
      },
      arquivo(),
    ]);
    const out = await createShopeeProvider({ agora: r.agora }).emitirOuImprimir(
      makeInput({
        client,
        ui: { escolherEnvio: vi.fn(async () => ({ modo: 'dropoff' as const })) },
      }),
    );
    expect(out).toEqual({ status: 'printed' });
    expect(corpos(etiqueta).map((c) => c.envio)).toEqual([
      undefined,
      { pacote: PACOTE_A, modo: 'dropoff' },
    ]);
  });

  it('Q2-F5 — a wait that leaves less than the floor: give-up at once, no sleep, no phase toast', async () => {
    const r = relogio();
    const { client, etiqueta } = fakeClient([
      async () => {
        r.t += 80_000;
        return aguardar({ fase: 'gerando-documento', tentarEmMs: 2_000 });
      },
      arquivo(),
    ]);
    const sleep = vi.fn(async () => undefined);
    const input = makeInput({ client, sleep });
    const out = await createShopeeProvider({ agora: r.agora }).emitirOuImprimir(input);
    expect(out).toEqual({ status: 'error', message: TEMPO_JA_ORGANIZADO });
    expect(input.ui.notify).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(etiqueta).toHaveBeenCalledTimes(1);
  });

  it('near-miss — a wait that leaves EXACTLY the floor is slept, with its toast', async () => {
    const r = relogio();
    const { client } = fakeClient([
      async () => {
        r.t += totalMs - pisoPorChamadaMs - 2_000;
        return aguardar({ fase: 'gerando-documento', tentarEmMs: 2_000 });
      },
      arquivo(),
    ]);
    const input = makeInput({ client });
    const out = await createShopeeProvider({ agora: r.agora }).emitirOuImprimir(input);
    expect(out).toEqual({ status: 'printed' });
    expect(input.ui.notify).toHaveBeenCalledTimes(1);
  });

  describe('on a fake clock — the AbortSignal and the honest bound', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Dialog time the operator spends on each question — EXCLUDED from the budget. */
    const DIALOGO_MS = 100_000;

    /**
     * A server that answers each scripted step after `apos` ms and, once the
     * script runs out, hangs until OUR abort. It records, in MACHINE time (the
     * dialogs taken out), when each call started and how long it ran before
     * its signal fired.
     */
    function servidor(passos: readonly { apos: number; resposta: Resposta }[]) {
      const fila = [...passos];
      const estado = { dialogoMs: 0 };
      const inicios: number[] = [];
      const abortosMs: number[] = [];
      const etiqueta = vi.fn(
        (_p: ShopeeEtiquetaPedido, opts?: { signal?: AbortSignal }): Promise<Resposta> =>
          new Promise<Resposta>((resolve, reject) => {
            const sinal = opts?.signal;
            if (sinal === undefined) throw new Error('sem sinal');
            const inicio = Date.now();
            inicios.push(inicio - estado.dialogoMs);
            const passo = fila.shift();
            const t =
              passo === undefined
                ? undefined
                : setTimeout(() => {
                    resolve(passo.resposta);
                  }, passo.apos);
            sinal.addEventListener('abort', () => {
              clearTimeout(t);
              abortosMs.push(Date.now() - inicio);
              reject(new ShopeeClientNetworkError('This operation was aborted', sinal.reason));
            });
          }),
      );
      const client: ShopeeClient = { oauthStart: vi.fn(), conta: vi.fn(), etiqueta };
      const escolherEnvio = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, DIALOGO_MS));
        estado.dialogoMs += DIALOGO_MS;
        return { modo: 'dropoff' as const };
      });
      return { client, etiqueta, estado, inicios, abortosMs, escolherEnvio };
    }

    async function rodarNoRelogio(s: ReturnType<typeof servidor>) {
      const input = makeInput({
        client: s.client,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        ui: { escolherEnvio: s.escolherEnvio },
      });
      const promessa = createShopeeProvider({ agora: () => Date.now() }).emitirOuImprimir(input);
      await vi.runAllTimersAsync();
      const out = await promessa;
      return { out, maquinaMs: Date.now() - s.estado.dialogoMs };
    }

    it('the signal fires at min(porChamadaMs, max(restante, piso)) — three regimes', async () => {
      // (a) a fresh click: restante 120 s ⇒ the ceiling, 75 s.
      const a = servidor([]);
      await rodarNoRelogio(a);
      expect(a.abortosMs).toEqual([porChamadaMs]);

      // (b) 62 s spent (a 60 s call + a 2 s wait): restante 58 s, between the
      //     floor and the ceiling ⇒ 58 s, so the call ends AT the budget.
      vi.setSystemTime(0);
      const b = servidor([{ apos: 60_000, resposta: aguardar({ tentarEmMs: 2_000 }) }]);
      await rodarNoRelogio(b);
      expect(b.abortosMs).toEqual([58_000]);

      // (c) the ANSWER's call with 20 s left (60 s + a 2 s wait + 38 s) ⇒ the
      //     floor, 45 s — never 20 s.
      vi.setSystemTime(0);
      const c = servidor([
        { apos: 60_000, resposta: aguardar({ tentarEmMs: 2_000 }) },
        { apos: 38_000, resposta: escolher() },
      ]);
      await rodarNoRelogio(c);
      expect(c.escolherEnvio).toHaveBeenCalledTimes(1);
      expect(c.abortosMs).toEqual([pisoPorChamadaMs]);
    });

    it('the honest bound holds for EVERY script: no call starts after totalMs, machine time ≤ totalMs + piso', async () => {
      // Steps a slow server may answer with, each just under a deadline it
      // could meet (44 s < the floor, 74 s < the ceiling); every script ends in
      // a hang, so the LAST call always runs until its signal fires.
      const alfabeto: { apos: number; resposta: Resposta }[] = [];
      for (const apos of [44_000, 74_000]) {
        alfabeto.push({ apos, resposta: aguardar({ tentarEmMs: 2_000 }) });
        // Re-asked as stale, so a re-ask is legitimate rather than "ignored".
        alfabeto.push({ apos, resposta: escolher({ escolhaInvalida: true }) });
        alfabeto.push({ apos, resposta: porPacote([PACOTE_A, PACOTE_B]) });
      }
      const roteiros: { apos: number; resposta: Resposta }[][] = [[]];
      for (let tamanho = 0; tamanho < 3; tamanho += 1) {
        for (const roteiro of roteiros.filter((x) => x.length === tamanho)) {
          for (const passo of alfabeto) roteiros.push([...roteiro, passo]);
        }
      }
      expect(roteiros).toHaveLength(1 + 6 + 36 + 216);

      let pior = 0;
      for (const roteiro of roteiros) {
        vi.setSystemTime(0);
        const s = servidor(roteiro);
        const { maquinaMs } = await rodarNoRelogio(s);
        for (const inicio of s.inicios) expect(inicio).toBeLessThan(totalMs);
        expect(maquinaMs).toBeLessThanOrEqual(totalMs + pisoPorChamadaMs);
        pior = Math.max(pior, maquinaMs);
      }
      // Not vacuous: the answer's exemption really does run past `totalMs`
      // (74 s question, 44 s question, then the answer's 45 s floor = 163 s).
      expect(pior).toBeGreaterThan(totalMs);
    });
  });
});

describe('shopeeProvider — the question', () => {
  it('W11 — asks with the server options, sends the answer ONCE, never on the call after', async () => {
    const { client, etiqueta } = fakeClient([
      escolher({ pacoteRotulo: 'Pacote 1 de 2' }),
      aguardar({ tentarEmMs: 2_000 }),
      arquivo(),
    ]);
    const escolherEnvio = vi.fn(async () => ({
      modo: 'pickup' as const,
      enderecoId: '2001',
      horarioId: 'slot-1',
    }));
    const input = makeInput({ client, ui: { escolherEnvio } });

    expect(await createShopeeProvider().emitirOuImprimir(input)).toEqual({ status: 'printed' });
    expect(escolherEnvio).toHaveBeenCalledWith({
      pedidoRotulo: '1234',
      pacoteRotulo: 'Pacote 1 de 2',
      mensagem:
        'Escolha como enviar o pacote: o endereço e o horário da coleta, ou a postagem na agência.',
      enderecos: ENDERECOS,
      permiteDropoff: true,
      escolhaInvalida: false,
    });
    expect(corpos(etiqueta)).toEqual([
      { pedidoId: 'p1', formato: 'pdf' },
      {
        pedidoId: 'p1',
        formato: 'pdf',
        envio: { pacote: PACOTE_A, modo: 'pickup', enderecoId: '2001', horarioId: 'slot-1' },
      },
      { pedidoId: 'p1', formato: 'pdf' },
    ]);
  });

  it('answers a dropoff and a zero-slot pickup with exactly their own keys', async () => {
    const { client, etiqueta } = fakeClient([
      escolher(),
      escolher({ pacote: PACOTE_B }),
      arquivo(),
    ]);
    const escolherEnvio = vi
      .fn()
      .mockResolvedValueOnce({ modo: 'dropoff' })
      .mockResolvedValueOnce({ modo: 'pickup', enderecoId: '2001', horarioId: null });
    await createShopeeProvider().emitirOuImprimir(makeInput({ client, ui: { escolherEnvio } }));
    expect(corpos(etiqueta).map((c) => c.envio)).toEqual([
      undefined,
      { pacote: PACOTE_A, modo: 'dropoff' },
      { pacote: PACOTE_B, modo: 'pickup', enderecoId: '2001', horarioId: null },
    ]);
  });

  it('Q2-F3 — the question names its pedido: the número, or null when absent or blank', async () => {
    const casos: [string | null, string | null][] = [
      ['1234', '1234'],
      [null, null],
      ['   ', null],
    ];
    for (const [numero, esperado] of casos) {
      const { client } = fakeClient([escolher()]);
      const escolherEnvio = vi.fn(
        async (_p: Parameters<EtiquetaProviderInput['ui']['escolherEnvio']>[0]) => null,
      );
      await createShopeeProvider().emitirOuImprimir(
        makeInput({ client, numero, ui: { escolherEnvio } }),
      );
      expect(escolherEnvio.mock.calls[0]?.[0].pedidoRotulo).toBe(esperado);
    }
  });

  it('a cancelled dialog skips, with no further call', async () => {
    const { client, etiqueta } = fakeClient([escolher()]);
    const out = await createShopeeProvider().emitirOuImprimir(
      makeInput({ client, ui: { escolherEnvio: vi.fn(async () => null) } }),
    );
    expect(out).toEqual({ status: 'skipped' });
    expect(etiqueta).toHaveBeenCalledTimes(1);
  });

  it('Q2-F4 — a cancelled dialog is NOT silent: ONE yellow toast pointing to where to reprint', async () => {
    const { client } = fakeClient([escolher()]);
    const input = makeInput({ client, ui: { escolherEnvio: vi.fn(async () => null) } });
    expect(await createShopeeProvider().emitirOuImprimir(input)).toEqual({ status: 'skipped' });
    expect(input.ui.notify).toHaveBeenCalledTimes(1);
    expect(input.ui.notify).toHaveBeenCalledWith({
      title: 'Etiqueta Shopee',
      message:
        'Etiqueta não impressa: a escolha de como enviar foi cancelada. Para imprimir, use a ' +
        'etiqueta na linha do pedido (Pedidos) ou "Outros Checkouts".',
      color: 'yellow',
    });
  });

  it('near-miss — an ANSWERED question raises no cancel toast', async () => {
    const { client } = fakeClient([escolher(), arquivo()]);
    const input = makeInput({
      client,
      ui: { escolherEnvio: vi.fn(async () => ({ modo: 'dropoff' as const })) },
    });
    expect(await createShopeeProvider().emitirOuImprimir(input)).toEqual({ status: 'printed' });
    expect(input.ui.notify).not.toHaveBeenCalled();
  });

  it('errors when the call CARRYING the answer asks the same package again (the answer was ignored)', async () => {
    const { client, etiqueta } = fakeClient([escolher(), escolher()]);
    const escolherEnvio = vi.fn(async () => ({ modo: 'dropoff' as const }));
    const out = await createShopeeProvider().emitirOuImprimir(
      makeInput({ client, ui: { escolherEnvio } }),
    );
    expect(out).toEqual({ status: 'error', message: PERGUNTAS_DEMAIS });
    expect(escolherEnvio).toHaveBeenCalledTimes(1);
    expect(etiqueta).toHaveBeenCalledTimes(2);
  });

  it('near-miss — the same package re-asked as STALE (`escolhaInvalida`) is asked again', async () => {
    const { client } = fakeClient([escolher(), escolher({ escolhaInvalida: true }), arquivo()]);
    const escolherEnvio = vi.fn(
      async (_p: Parameters<EtiquetaProviderInput['ui']['escolherEnvio']>[0]) => ({
        modo: 'dropoff' as const,
      }),
    );
    const out = await createShopeeProvider().emitirOuImprimir(
      makeInput({ client, ui: { escolherEnvio } }),
    );
    expect(out).toEqual({ status: 'printed' });
    expect(escolherEnvio).toHaveBeenCalledTimes(2);
    expect(escolherEnvio.mock.calls[1]?.[0]).toMatchObject({ escolhaInvalida: true });
  });

  it('near-miss — a re-ask on a LATER call (the answer’s call ended in a wait) is asked again', async () => {
    const { client } = fakeClient([escolher(), aguardar(), escolher(), arquivo()]);
    const escolherEnvio = vi.fn(async () => ({ modo: 'dropoff' as const }));
    const out = await createShopeeProvider().emitirOuImprimir(
      makeInput({ client, ui: { escolherEnvio } }),
    );
    expect(out).toEqual({ status: 'printed' });
    expect(escolherEnvio).toHaveBeenCalledTimes(2);
  });

  // Review 2 (Q2-F6) made the cap per PACKAGE: this used to ask A, B, A and
  // stop at the 3rd question of the CLICK; the same package must now be asked
  // past the cap (re-asked as stale, so the "answer ignored" check stays out).
  it('stops at maxPerguntas questions about the SAME package', async () => {
    const { client } = fakeClient([
      escolher({ pacote: PACOTE_A }),
      escolher({ pacote: PACOTE_A, escolhaInvalida: true }),
      escolher({ pacote: PACOTE_A, escolhaInvalida: true }),
    ]);
    const escolherEnvio = vi.fn(async () => ({ modo: 'dropoff' as const }));
    const out = await createShopeeProvider({ limites: { maxPerguntas: 2 } }).emitirOuImprimir(
      makeInput({ client, ui: { escolherEnvio } }),
    );
    expect(out).toEqual({ status: 'error', message: PERGUNTAS_DEMAIS });
    expect(escolherEnvio).toHaveBeenCalledTimes(2);
  });

  it('Q2-F6 — a split order with MORE packages than the cap, each asked once, prints', async () => {
    const pacotes = Array.from(
      { length: SHOPEE_ETIQUETA_LIMITES.maxPerguntas + 1 },
      (_, i) => `OFG${String(i + 1).padStart(12, '0')}`,
    );
    const { client, etiqueta } = fakeClient([
      ...pacotes.map((pacote) => escolher({ pacote })),
      arquivo(),
    ]);
    const escolherEnvio = vi.fn(async () => ({ modo: 'dropoff' as const }));
    const out = await createShopeeProvider().emitirOuImprimir(
      makeInput({ client, ui: { escolherEnvio } }),
    );
    expect(out).toEqual({ status: 'printed' });
    expect(escolherEnvio).toHaveBeenCalledTimes(pacotes.length);
    // Each answer rode the call right after its own question, for its own package.
    expect(corpos(etiqueta).map((c) => c.envio?.pacote)).toEqual([undefined, ...pacotes]);
  });

  it('never opens a dialog once the budget is spent', async () => {
    const r = relogio();
    const { client } = fakeClient([
      async () => {
        r.t += 130_000;
        return escolher();
      },
    ]);
    const escolherEnvio = vi.fn(async () => ({ modo: 'dropoff' as const }));
    const out = await createShopeeProvider({ agora: r.agora }).emitirOuImprimir(
      makeInput({ client, ui: { escolherEnvio } }),
    );
    expect(out).toEqual({ status: 'error', message: TEMPO_SEM_RESPOSTA });
    expect(escolherEnvio).not.toHaveBeenCalled();
  });

  // Review 2 (P9): the boundary of the check above. A budget spent EXACTLY is
  // spent — `>=`, not `>`: under `>` the dialog opens and the answer's call
  // (floor-exempt) starts with 0 ms of the click left, past the honest bound's
  // "no call starts after totalMs".
  it('near-miss — EXACTLY totalMs spent when the question arrives: no dialog, the time sentence', async () => {
    const r = relogio();
    const { client, etiqueta } = fakeClient([
      async () => {
        r.t += SHOPEE_ETIQUETA_LIMITES.totalMs;
        return escolher();
      },
      arquivo(),
    ]);
    const escolherEnvio = vi.fn(async () => ({ modo: 'dropoff' as const }));
    const out = await createShopeeProvider({ agora: r.agora }).emitirOuImprimir(
      makeInput({ client, ui: { escolherEnvio } }),
    );
    expect(out).toEqual({ status: 'error', message: TEMPO_SEM_RESPOSTA });
    expect(escolherEnvio).not.toHaveBeenCalled();
    expect(etiqueta).toHaveBeenCalledTimes(1);
  });

  it('near-miss — 1 ms UNDER totalMs: the dialog opens and the answer’s call still starts', async () => {
    const r = relogio();
    const { client, etiqueta } = fakeClient([
      async () => {
        r.t += SHOPEE_ETIQUETA_LIMITES.totalMs - 1;
        return escolher();
      },
      arquivo(),
    ]);
    const escolherEnvio = vi.fn(async () => ({ modo: 'dropoff' as const }));
    const out = await createShopeeProvider({ agora: r.agora }).emitirOuImprimir(
      makeInput({ client, ui: { escolherEnvio } }),
    );
    expect(out).toEqual({ status: 'printed' });
    expect(escolherEnvio).toHaveBeenCalledTimes(1);
    expect(corpos(etiqueta).map((c) => c.envio)).toEqual([
      undefined,
      { pacote: PACOTE_A, modo: 'dropoff' },
    ]);
  });
});

describe('shopeeProvider — per package', () => {
  it('downloads each package on its own call, and prints each file', async () => {
    const { client, etiqueta } = fakeClient([
      porPacote([PACOTE_A, PACOTE_B]),
      arquivo('application/pdf', 'etiqueta-shopee-1234-p1de2.pdf'),
      aguardar({ fase: 'gerando-documento', tentarEmMs: 3_000 }),
      arquivo('application/pdf', 'etiqueta-shopee-1234-p2de2.pdf'),
    ]);
    const printJob = vi.fn(async () => 'printed' as const);
    const out = await createShopeeProvider().emitirOuImprimir(makeInput({ client, printJob }));

    expect(out).toEqual({ status: 'printed' });
    expect(corpos(etiqueta)).toEqual([
      { pedidoId: 'p1', formato: 'pdf' },
      { pedidoId: 'p1', formato: 'pdf', pacote: PACOTE_A },
      { pedidoId: 'p1', formato: 'pdf', pacote: PACOTE_B },
      { pedidoId: 'p1', formato: 'pdf', pacote: PACOTE_B },
    ]);
    expect(printJob.mock.calls.map((c) => (c as unknown[])[1])).toEqual([
      expect.objectContaining({ fileName: 'etiqueta-shopee-1234-p1de2.pdf' }),
      expect.objectContaining({ fileName: 'etiqueta-shopee-1234-p2de2.pdf' }),
    ]);
  });

  // Q1-4: "Etiqueta i de n", never "pacote i de n" — `i` counts this 202's
  // download list, while the server numbers a package by its place in the FULL
  // order (a cancelled P2 of 3 makes the list's 2nd the server's `-p3de3`).
  it('names the failing label (i of the LIST); after the first, says the earlier ones were sent', async () => {
    const recusa = new ShopeeClientHttpError(
      'Tente de novo mais tarde — a Shopee reteve o envio do pacote temporariamente.',
      409,
      'SHOPEE_ETIQUETA_RECUSADA',
    );
    const { client } = fakeClient([porPacote([PACOTE_A, PACOTE_B]), arquivo(), recusa]);
    const out = await createShopeeProvider().emitirOuImprimir(makeInput({ client }));
    expect(out).toEqual({
      status: 'error',
      message:
        'Etiqueta 2 de 2: Tente de novo mais tarde — a Shopee reteve o envio do pacote ' +
        'temporariamente. As anteriores foram enviadas; clique em Imprimir de novo para reimprimir todas.',
    });
  });

  it('near-miss — the FIRST package failing claims no earlier one', async () => {
    const recusa = new ShopeeClientHttpError('Recusado.', 409, 'SHOPEE_ETIQUETA_RECUSADA');
    const { client } = fakeClient([porPacote([PACOTE_A, PACOTE_B]), recusa]);
    const out = await createShopeeProvider().emitirOuImprimir(makeInput({ client }));
    expect(out).toEqual({ status: 'error', message: 'Etiqueta 1 de 2: Recusado.' });
  });

  it('errors when a per-package call asks for a per-package download again', async () => {
    const { client, etiqueta } = fakeClient([
      porPacote([PACOTE_A, PACOTE_B]),
      porPacote([PACOTE_A, PACOTE_B]),
    ]);
    const out = await createShopeeProvider().emitirOuImprimir(makeInput({ client }));
    expect(out.status).toBe('error');
    if (out.status === 'error') expect(out.message).toMatch(/^Etiqueta 1 de 2: /);
    expect(etiqueta).toHaveBeenCalledTimes(2);
  });
});

describe('shopeeProvider — the failures', () => {
  it('a 409 refusal: the backend’s sentence verbatim, ONE call (no retry, no NF-e re-drive)', async () => {
    const mensagem =
      'Envie a NF-e do pedido à Shopee antes de imprimir a etiqueta — a Shopee só libera o envio ' +
      'com a nota fiscal anexada. O ERP reenviou a NF-e à Shopee; clique em Imprimir de novo em alguns minutos.';
    const { client, etiqueta } = fakeClient([
      new ShopeeClientHttpError(mensagem, 409, 'SHOPEE_ETIQUETA_RECUSADA'),
    ]);
    const out = await createShopeeProvider().emitirOuImprimir(makeInput({ client }));
    expect(out).toEqual({ status: 'error', message: mensagem });
    expect(etiqueta).toHaveBeenCalledTimes(1);
  });

  it('a 403 and a 2xx that was not a label end the same way', async () => {
    for (const err of [
      new ShopeeClientHttpError('Você não tem permissão.', 403, 'SHOPEE_ETIQUETA_SEM_PERMISSAO'),
      new ShopeeClientRespostaInvalidaError('Resposta inválida.', 200, []),
    ]) {
      const { client } = fakeClient([err]);
      expect(await createShopeeProvider().emitirOuImprimir(makeInput({ client }))).toEqual({
        status: 'error',
        message: err.message,
      });
    }
  });

  it('a network failure (not our deadline): the resumable sentence, no automatic retry', async () => {
    const { client, etiqueta } = fakeClient([new ShopeeClientNetworkError('Failed to fetch')]);
    const out = await createShopeeProvider().emitirOuImprimir(makeInput({ client }));
    expect(out).toEqual({
      status: 'error',
      message:
        'Falha de comunicação com a Shopee: Failed to fetch. O envio pode já ter sido organizado — ' +
        'clique em Imprimir de novo para continuar; a Shopee nunca organiza o mesmo pacote duas vezes.',
    });
    expect(etiqueta).toHaveBeenCalledTimes(1);
  });

  /** A call that hangs until the provider's own deadline aborts it. */
  const pendura =
    (falha: (sinal: AbortSignal) => unknown) =>
    (_p: ShopeeEtiquetaPedido, opts?: { signal?: AbortSignal }) =>
      new Promise<Resposta>((_resolve, reject) => {
        const sinal = opts?.signal;
        if (sinal === undefined) throw new Error('sem sinal');
        sinal.addEventListener('abort', () => {
          reject(falha(sinal));
        });
      });

  it('the per-call deadline, in flight (a network error carrying the abort): the give-up sentence', async () => {
    const { client } = fakeClient([
      pendura((s) => new ShopeeClientNetworkError('This operation was aborted', s.reason)),
    ]);
    const out = await createShopeeProvider({ limites: { porChamadaMs: 5 } }).emitirOuImprimir(
      makeInput({ client }),
    );
    expect(out).toEqual({ status: 'error', message: TEMPO_SEM_RESPOSTA });
  });

  it('the per-call deadline during the BODY read (the raw abort) after an arrange: ORGANIZADO', async () => {
    const { client } = fakeClient([aguardar({ progresso: ORGANIZADO }), pendura((s) => s.reason)]);
    const out = await createShopeeProvider({ limites: { porChamadaMs: 5 } }).emitirOuImprimir(
      makeInput({ client }),
    );
    expect(out).toEqual({ status: 'error', message: TEMPO_JA_ORGANIZADO });
  });

  it('rethrows an error class it does not own (no generic catch)', async () => {
    const { client } = fakeClient([new TypeError('boom')]);
    await expect(
      createShopeeProvider().emitirOuImprimir(makeInput({ client })),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('near-miss — an abort-shaped rejection is NOT our deadline unless our signal fired: rethrown', async () => {
    const alheio = new DOMException('abortado por outro sinal', 'AbortError');
    const { client } = fakeClient([
      async () => {
        throw alheio;
      },
    ]);
    await expect(createShopeeProvider().emitirOuImprimir(makeInput({ client }))).rejects.toBe(
      alheio,
    );
  });
});
