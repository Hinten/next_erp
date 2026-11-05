/**
 * The NF-e trigger's body (step 14, PR 14-c), T1–T5 and the a→c arm, against
 * the fake Firestore and a recording queue: the edges cost zero reads and no
 * line, the sale gate and the proof stop read-only, the ONE named enqueue
 * answers a redelivery `ja-enfileirada`, and only the NF-e queue's own valve is
 * caught (the aviso clocked by the pedido read's `readTime`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MissingRegionError } from '@delfrance/core/region';
import {
  ESTADO_NFE,
  ESTADO_PEDIDO,
  MARKETPLACE_PEDIDO_TIPO,
  TIPO_AVISO,
  chaveDeAviso,
} from '@delfrance/schemas';

import { relogioDoDocumentoUs } from '../avisos/avisos';
import { AmazonTarefasTransitoriasError } from '../core/filaTarefas';
import { FLUXO_AMAZON } from '../core/valvulas';
import { AmazonTarefasDesligadasError } from '../notificacoes/agendador';
import { makePedidoIdAmazon } from '../pedidos/orderIds';
import { FakeDb, asDb, increment } from '../testing/fakeDb';
import { falhaDeTarefaJaExistente, falhaDoFunctions } from '../testing/falhaDeEnfileiramento';
import { AGORA_MS, caminhoAviso, loggerEspiao } from '../testing/fixtures';
import {
  type AgendadorNfeAmazon,
  type FilaNfeAmazon,
  criarAgendadorNfeAmazon,
  idDaTarefaDoGatilhoNfeAmazon,
} from './agendadorNfe';
import {
  type DepsGatilhoNfeAmazon,
  type EscritaNfeAmazon,
  FLUXO_DO_GATILHO_NFE_AMAZON,
  bordaDaEscritaNfeAmazon,
  tratarEscritaNfeAmazon,
} from './gatilhoNfe';
import { tarefaInicialNfeAmazon } from './tarefaNfe';

const CONTA = 'conta-teste';
const ORDER = '171-9876543-2109876';
const PEDIDO_ID = makePedidoIdAmazon(CONTA, ORDER);
const NFE_ID = 's1';
const EVENTO = 'evento-0001-sintetico';
const CHAVE_AVISO = chaveDeAviso({
  tipo: TIPO_AVISO.nfeUploadRejeitado,
  conta: CONTA,
  entidade: PEDIDO_ID,
});

/** A synthetic proc: `tpNF`/`finNFe` and `tpAmb`; no real party, no access key. */
function proc(tpNF = '1', finNFe = '1', tpAmb = '1'): string {
  return (
    `<nfeProc><NFe><infNFe><ide><tpAmb>${tpAmb}</tpAmb><tpNF>${tpNF}</tpNF>` +
    `<finNFe>${finNFe}</finNFe></ide></infNFe></NFe></nfeProc>`
  );
}

/** A raw `nfev4` document, approved and ready by default. */
function nfe(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { estado: ESTADO_NFE.aprovada, xml_nfe_proc: proc(), ...extra };
}

/** A raw pedido the Amazon importer could have written. */
function pedido(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    numero: ORDER,
    integracaoPedidoOuterRef: `documents/integracao/${CONTA}`,
    estado: ESTADO_PEDIDO.pago,
    ...extra,
  };
}

let fake: FakeDb;
let espiao: ReturnType<typeof loggerEspiao>;
let lerDb: ReturnType<typeof vi.fn>;
let criarAgendador: ReturnType<typeof vi.fn>;
let agendador: AgendadorNfeAmazon & {
  enfileirarDoGatilho: ReturnType<typeof vi.fn>;
  enfileirar: ReturnType<typeof vi.fn>;
};

function deps(): DepsGatilhoNfeAmazon {
  return {
    db: lerDb as unknown as DepsGatilhoNfeAmazon['db'],
    agendador: criarAgendador as unknown as DepsGatilhoNfeAmazon['agendador'],
    logger: espiao.logger,
    increment,
    agoraMs: () => AGORA_MS,
  };
}

/** Bind the trigger to the REAL producer over a queue that, like Cloud Tasks, holds ids. */
function comProdutorReal(opcoes: { desligado?: boolean; falha?: () => unknown } = {}) {
  const ids = new Set<string>();
  const enqueue = vi.fn((...args: unknown[]): Promise<void> => {
    if (opcoes.falha !== undefined) return Promise.reject(opcoes.falha());
    const id = (args[1] as { id?: string } | undefined)?.id;
    if (id !== undefined) {
      if (ids.has(id)) return Promise.reject(falhaDeTarefaJaExistente(id));
      ids.add(id);
    }
    return Promise.resolve();
  });
  const fila: FilaNfeAmazon = {
    enqueue: (...a: Parameters<FilaNfeAmazon['enqueue']>) => enqueue(...a),
  };
  criarAgendador.mockImplementation(() =>
    criarAgendadorNfeAmazon({ fila: () => fila, desligado: opcoes.desligado ?? false }),
  );
  return enqueue;
}

function escrita(over: Partial<EscritaNfeAmazon> = {}): EscritaNfeAmazon {
  return {
    eventId: EVENTO,
    pedidoId: PEDIDO_ID,
    nfeId: NFE_ID,
    before: undefined,
    after: nfe(),
    ...over,
  };
}

/** Seed the pedido, then one more stamp, so the read's `readTime` is NOT the pedido's `updateTime`. */
function semearPedido(p: Record<string, unknown> | null = pedido()): { leituraUs: number } {
  if (p !== null) fake.seed(`pedidos/${PEDIDO_ID}`, p);
  const ultimo = fake.seed('marcador/relogio', { x: 1 });
  return { leituraUs: relogioDoDocumentoUs(ultimo) };
}

beforeEach(() => {
  fake = new FakeDb();
  espiao = loggerEspiao();
  lerDb = vi.fn(() => asDb(fake));
  agendador = {
    enfileirarDoGatilho: vi.fn(() => Promise.resolve('enfileirada' as const)),
    enfileirar: vi.fn(() => Promise.resolve()),
  };
  criarAgendador = vi.fn(() => agendador);
});

describe('T1 — the two edges: zero reads and no line outside them', () => {
  it.each<[string, Record<string, unknown> | undefined, Record<string, unknown> | undefined]>([
    ['a ja-pronta rewrite (a → a)', nfe(), nfe({ outro: 1 })],
    ['a totais backfill on an approved doc', nfe(), nfe({ totais: { vNF: 10 } })],
    ['an e → c write', nfe({ estado: ESTADO_NFE.error }), nfe({ estado: ESTADO_NFE.cancelada })],
    ['a c → c write', nfe({ estado: ESTADO_NFE.cancelada }), nfe({ estado: ESTADO_NFE.cancelada })],
    ['the placeholder create', undefined, nfe({ estado: ESTADO_NFE.gerado, xml_nfe_proc: null })],
    [
      'the enviando anchor',
      nfe({ estado: ESTADO_NFE.gerado }),
      nfe({ estado: ESTADO_NFE.enviando }),
    ],
    ['a delete of an approved doc', nfe(), undefined],
    ['an approved homologação proc', undefined, nfe({ xml_nfe_proc: proc('1', '1', '2') })],
    [
      'a cancelled NON-sale note (a devolução)',
      nfe({ xml_nfe_proc: proc('0', '4') }),
      nfe({ estado: ESTADO_NFE.cancelada, xml_nfe_proc: proc('0', '4') }),
    ],
  ])('★ %s ⇒ nothing: no db, no read, no enqueue, no line', async (_caso, before, after) => {
    semearPedido();
    expect(await tratarEscritaNfeAmazon(deps(), escrita({ before, after }))).toEqual({
      acao: 'fora-da-borda',
    });
    expect(lerDb).not.toHaveBeenCalled();
    expect(fake.operacoes).toBe(0);
    expect(criarAgendador).not.toHaveBeenCalled();
    expect(espiao.linhas).toEqual([]);
  });

  it('the edges: a create of an approved doc, the late proc, and p → a are uploads; a → c is the cancel edge', () => {
    expect(bordaDaEscritaNfeAmazon(undefined, nfe())).toBe('envio');
    expect(bordaDaEscritaNfeAmazon(nfe({ xml_nfe_proc: null }), nfe())).toBe('envio');
    expect(bordaDaEscritaNfeAmazon(nfe({ estado: ESTADO_NFE.epecAprovado }), nfe())).toBe('envio');
    expect(bordaDaEscritaNfeAmazon(nfe(), nfe({ estado: ESTADO_NFE.cancelada }))).toBe(
      'cancelamento',
    );
    expect(bordaDaEscritaNfeAmazon(nfe(), nfe())).toBeNull();
  });

  it('★ the p → a (pós-EPEC) edge enqueues', async () => {
    semearPedido();
    expect(
      await tratarEscritaNfeAmazon(
        deps(),
        escrita({ before: nfe({ estado: ESTADO_NFE.epecAprovado }), after: nfe() }),
      ),
    ).toEqual({ acao: 'enfileirada' });
    expect(agendador.enfileirarDoGatilho).toHaveBeenCalledTimes(1);
  });
});

describe('T1b — the sale gate', () => {
  it.each([
    ['a devolução (1/4)', proc('1', '4')],
    ['an entrada (0/1)', proc('0', '1')],
    ['a complementar (1/2)', proc('1', '2')],
  ])('★ %s ⇒ ONE INFO line nfe-nao-e-de-venda, zero reads, nothing enqueued', async (_c, xml) => {
    semearPedido();
    expect(
      await tratarEscritaNfeAmazon(deps(), escrita({ after: nfe({ xml_nfe_proc: xml }) })),
    ).toEqual({
      acao: 'descartado',
      motivo: 'nfe-nao-e-de-venda',
    });
    expect(lerDb).not.toHaveBeenCalled();
    expect(fake.operacoes).toBe(0);
    expect(criarAgendador).not.toHaveBeenCalled();
    expect(espiao.linhas).toHaveLength(1);
    expect(espiao.linhas[0]).toMatchObject({
      nivel: 'info',
      meta: { evento: 'nfe', motivo: 'nfe-nao-e-de-venda', pedidoId: PEDIDO_ID, nfeId: NFE_ID },
    });
  });

  it('NEAR-MISS: an ILLEGIBLE proc goes on — the task judges it loudly', async () => {
    semearPedido();
    expect(
      await tratarEscritaNfeAmazon(
        deps(),
        escrita({ after: nfe({ xml_nfe_proc: proc('', '1') }) }),
      ),
    ).toEqual({ acao: 'enfileirada' });
  });
});

describe('T2/T3 — one pedido read, the proof, the block, the stored pre-filter', () => {
  it.each<[string, Record<string, unknown> | null, string, 'info' | 'warn']>([
    ['a Shopee-shaped pedido', pedido({ numero: '240901ABCDEFGH' }), 'nao-amazon', 'info'],
    [
      'another conta’s ref',
      pedido({ integracaoPedidoOuterRef: 'integracao/outra' }),
      'nao-amazon',
      'info',
    ],
    ['a missing pedido', null, 'nao-amazon', 'info'],
    ['the emission block', pedido({ bloquearEmissaoNFe: true }), 'emissao-bloqueada', 'warn'],
    [
      'stored evidence that says NOT DBA',
      pedido({ marketplace: { tipo: MARKETPLACE_PEDIDO_TIPO.amazon, fulfilledBy: 'AMAZON' } }),
      'nao-dba',
      'warn',
    ],
  ])(
    '★ %s ⇒ ONE read, ONE line at the reason’s own level, nothing enqueued or written',
    async (_c, p, motivo, nivel) => {
      semearPedido(p);
      expect(await tratarEscritaNfeAmazon(deps(), escrita())).toEqual({
        acao: 'descartado',
        motivo,
      });
      expect(fake.leituras).toEqual([`pedidos/${PEDIDO_ID}`]);
      expect(fake.escritas).toEqual([]);
      expect(criarAgendador).not.toHaveBeenCalled();
      expect(espiao.linhas).toHaveLength(1);
      expect(espiao.linhas[0]?.nivel).toBe(nivel);
      expect(espiao.linhas[0]?.meta).toMatchObject({ evento: 'nfe', motivo, fluxo: 'nfe' });
    },
  );

  it('NEAR-MISS: a migrated pedido with NO stored marketplace block passes (DBA is decided live, by the task)', async () => {
    semearPedido(pedido());
    expect(await tratarEscritaNfeAmazon(deps(), escrita())).toEqual({ acao: 'enfileirada' });
  });
});

describe('T4 — the ONE named enqueue', () => {
  it('★ enqueues the INITIAL payload with the event id, writes nothing, and logs one INFO line naming the task', async () => {
    semearPedido();
    expect(await tratarEscritaNfeAmazon(deps(), escrita())).toEqual({ acao: 'enfileirada' });
    expect(agendador.enfileirarDoGatilho.mock.calls).toEqual([
      [tarefaInicialNfeAmazon(PEDIDO_ID, NFE_ID), EVENTO],
    ]);
    expect(agendador.enfileirar).not.toHaveBeenCalled();
    expect(fake.escritas).toEqual([]);
    expect(fake.leituras).toEqual([`pedidos/${PEDIDO_ID}`]);
    expect(espiao.linhas).toHaveLength(1);
    expect(espiao.linhas[0]).toMatchObject({
      nivel: 'info',
      meta: {
        evento: 'nfe',
        acao: 'enfileirada',
        conta: CONTA,
        pedido: ORDER,
        idTarefa: idDaTarefaDoGatilhoNfeAmazon(EVENTO),
      },
    });
  });

  it('★ through the REAL producer: the task id is derived from event.id, and a redelivered event answers ja-enfileirada with no error', async () => {
    semearPedido();
    const enqueue = comProdutorReal();
    expect(await tratarEscritaNfeAmazon(deps(), escrita())).toEqual({ acao: 'enfileirada' });
    expect(await tratarEscritaNfeAmazon(deps(), escrita())).toEqual({ acao: 'ja-enfileirada' });
    expect(enqueue.mock.calls[0]).toEqual([
      tarefaInicialNfeAmazon(PEDIDO_ID, NFE_ID),
      { id: idDaTarefaDoGatilhoNfeAmazon(EVENTO) },
    ]);
    expect(enqueue.mock.calls[1]?.[1]).toEqual({ id: idDaTarefaDoGatilhoNfeAmazon(EVENTO) });
    expect(espiao.linhas.map((l) => l.meta?.acao)).toEqual(['enfileirada', 'ja-enfileirada']);
    expect(fake.escritas).toEqual([]);
  });
});

describe('T5 — only the NF-e queue’s valve is caught', () => {
  it('★ the valve ⇒ the aviso tarefas-desligadas, clocked by T2’s readTime, and a WARNING line', async () => {
    const { leituraUs } = semearPedido();
    comProdutorReal({ desligado: true });
    const r = await tratarEscritaNfeAmazon(deps(), escrita());
    expect(r).toEqual({ acao: 'avisado', motivo: 'tarefas-desligadas', resultado: 'criado' });
    expect(fake.ler(caminhoAviso(CHAVE_AVISO))).toMatchObject({
      motivo: 'tarefas-desligadas',
      relogioEvento: leituraUs,
      params: { pedido: ORDER },
    });
    expect(espiao.linhas).toHaveLength(1);
    expect(espiao.linhas[0]).toMatchObject({
      nivel: 'warn',
      meta: { evento: 'nfe', motivo: 'tarefas-desligadas', aviso: 'criado', conta: CONTA },
    });
  });

  it.each<[string, () => unknown]>([
    ['a named transient', () => falhaDoFunctions('unknown-error')],
    ['a deploy failure', () => falhaDoFunctions('permission-denied', 403)],
    ['a missing region', () => new MissingRegionError('sem região', ['AMAZON_TASKS_REGION'])],
    // NEAR-MISS of T5's one catch: the READS queue's valve class is a sibling,
    // never the NF-e queue's — it reaches here only through a wrong root.
    ['the reads queue’s valve class', () => new AmazonTarefasDesligadasError()],
  ])('★ %s PROPAGATES to the Eventarc retry — no aviso, no line', async (_c, falha) => {
    semearPedido();
    comProdutorReal({ falha });
    await expect(tratarEscritaNfeAmazon(deps(), escrita())).rejects.toBeDefined();
    expect(fake.escritas).toEqual([]);
    expect(espiao.linhas).toEqual([]);
  });

  it('the transient really is the named class (anti-vacuity of the row above)', async () => {
    semearPedido();
    comProdutorReal({ falha: () => falhaDoFunctions('unknown-error') });
    await expect(tratarEscritaNfeAmazon(deps(), escrita())).rejects.toBeInstanceOf(
      AmazonTarefasTransitoriasError,
    );
  });
});

describe('the a→c arm (T3c)', () => {
  const cancelamento = () =>
    escrita({ before: nfe(), after: nfe({ estado: ESTADO_NFE.cancelada }) });

  it('★ a live, proved pedido ⇒ the aviso nfe-cancelada (clocked by T2’s readTime), NO enqueue, NO stamp', async () => {
    const { leituraUs } = semearPedido();
    const r = await tratarEscritaNfeAmazon(deps(), cancelamento());
    expect(r).toEqual({ acao: 'avisado', motivo: 'nfe-cancelada', resultado: 'criado' });
    expect(criarAgendador).not.toHaveBeenCalled();
    expect(fake.ler(caminhoAviso(CHAVE_AVISO))).toMatchObject({
      motivo: 'nfe-cancelada',
      relogioEvento: leituraUs,
    });
    // The only write is the aviso: the pedido (its freight) is untouched.
    expect(fake.escritas.map((w) => w.caminho)).toEqual([caminhoAviso(CHAVE_AVISO)]);
    expect(espiao.linhas[0]).toMatchObject({ nivel: 'warn', meta: { borda: 'cancelamento' } });
  });

  it.each([ESTADO_PEDIDO.cancelado, ESTADO_PEDIDO.estornadoIntegralmente])(
    '★ a stored cancelled SALE (%s) ⇒ one line, nothing else (the incidente path owns it)',
    async (estado) => {
      semearPedido(pedido({ estado }));
      expect(await tratarEscritaNfeAmazon(deps(), cancelamento())).toEqual({
        acao: 'descartado',
        motivo: 'pedido-cancelado',
      });
      expect(fake.escritas).toEqual([]);
      expect(criarAgendador).not.toHaveBeenCalled();
      expect(espiao.linhas).toHaveLength(1);
    },
  );

  it('NEAR-MISS: the a→c edge of another channel’s pedido ⇒ nao-amazon, nothing written', async () => {
    semearPedido(pedido({ numero: '240901ABCDEFGH' }));
    expect(await tratarEscritaNfeAmazon(deps(), cancelamento())).toEqual({
      acao: 'descartado',
      motivo: 'nao-amazon',
    });
    expect(fake.escritas).toEqual([]);
  });
});

describe('the lines', () => {
  it('no line carries the XML, its content or a 44-digit run; the flow is valvulas.ts’s own', async () => {
    const xml = `${proc()}<chNFe>${'3'.repeat(44)}</chNFe>`;
    semearPedido();
    await tratarEscritaNfeAmazon(deps(), escrita({ after: nfe({ xml_nfe_proc: xml }) }));
    comProdutorReal({ desligado: true });
    await tratarEscritaNfeAmazon(
      deps(),
      escrita({ eventId: `${EVENTO}-2`, after: nfe({ xml_nfe_proc: xml }) }),
    );
    const texto = JSON.stringify(espiao.linhas);
    expect(espiao.linhas.length).toBeGreaterThanOrEqual(2);
    expect(texto).not.toContain('nfeProc');
    expect(texto).not.toContain('<tpNF>');
    expect(texto).not.toMatch(/\d{44}/);
    expect(FLUXO_DO_GATILHO_NFE_AMAZON).toBe(FLUXO_AMAZON.nfe);
  });
});
