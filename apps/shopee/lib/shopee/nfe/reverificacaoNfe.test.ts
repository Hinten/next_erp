/**
 * The NF-e recheck (#1522, step 14) — the verdict table of reconcile §2.8
 * "Recheck", driven through `reverificarNfeShopee` over the REAL aviso writer,
 * the REAL frete stamp and the shared fake Firestore.
 *
 * Every row has a PAIR that must come out equal and a NEAR-MISS that must stay
 * distinct (root CLAUDE.md, the fold's scope). The mutants this suite kills
 * (reconcile §4): 63 — the recheck uploads (the client is a Proxy that records
 * every property touched, and every enqueue is asserted to be a recheck); 68 —
 * the recheck resolves on an absent/unknown status.
 *
 * ⚠️ Fixture keys are SYNTHETIC and visibly fake: cUF `99` (no such UF) and a
 * CNPJ of repeated digits, assembled field by field, never a literal copied
 * from anywhere. Ids are the step's fixture ids.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  shopeeInvoiceDataSchema,
  type ShopeeClient,
  type ShopeeOrderDetailRow,
} from '@delfrance/integrations-shopee';
import { nfev4Collection } from '@delfrance/data/admin/collections';
import {
  ESTADO_FRETE,
  ESTADO_NFE,
  ESTADO_PEDIDO,
  INTEGRACAO_FRETE,
  MODALIDADE_FRETE,
  freteDoPedidoSchema,
  seedFreteInicial,
} from '@delfrance/schemas';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makePedidoIdShopee } from '../pedidos/orderIds';
import { FakeDb, asDb, grpc, increment, type DocData } from '../testing/fakeDb';
import { avisarNfeShopee, chaveAvisoNfeShopee } from './avisoNfe';
import { ATRASOS_REVERIFICACAO_S } from './constantesNfe';
import {
  DESFECHO_NFE_SHOPEE,
  FRASE_DO_MOTIVO_NFE,
  MOTIVO_NFE_SHOPEE,
  MOTIVOS_QUE_AVISAM,
  MOTIVOS_QUE_CARIMBAM,
  ShopeeNfeUploadTasksDisabledError,
  type MotivoNfeShopee,
} from './errosNfe';
import { reverificarNfeShopee } from './reverificacaoNfe';
import {
  FASE_NFE_SHOPEE,
  tarefaNfeShopeeSchema,
  type AgendadorNfeShopee,
  type OpcoesDeEnfileiramentoNfe,
  type TarefaNfeShopee,
} from './tarefaNfe';

/* -------------------------------------------------------------------------- */
/*  Fixtures — invented ids only. Never a real conta, order, key or CNPJ.      */
/* -------------------------------------------------------------------------- */

const AGORA_MS = 1_789_000_000_000;
const AGORA_US = AGORA_MS * 1000;
const INTEGRACAO = 'int-1';
const ORDER_SN = '260910KJBHUJDM';
const PEDIDO_ID = makePedidoIdShopee(INTEGRACAO, ORDER_SN);
const NFE_ID = 's1';
const PEDIDO_PATH = `pedidos/${PEDIDO_ID}`;
const AVISO_PATH = `avisos/${chaveAvisoNfeShopee(INTEGRACAO, PEDIDO_ID)}`;

/** A synthetic key: cUF 99 + AAMM + CNPJ + mod 55 + série + nNF + tpEmis + cNF + DV. */
function montarChave(cnpj = '1'.repeat(14), nNF = '000000001'): string {
  return `99${'2609'}${cnpj}55${'000'}${nNF}1${'00000000'}0`;
}

/** OUR key — what the prefix read from our own XML. */
const K = montarChave();
/** Another legible key: the same, with a different nNF. */
const K_OUTRA = montarChave(undefined, '000000002');

type Linha = Pick<ShopeeOrderDetailRow, 'region' | 'invoice_data'>;

/** One `get_order_detail` row, as the prefix hands it over. */
function linha(invoice: Record<string, unknown> | null, region: string | null = 'BR'): Linha {
  return {
    region,
    invoice_data: invoice === null ? null : shopeeInvoiceDataSchema.parse(invoice),
  };
}

/** The pedido, with a Shopee-owned frete in a STAMPABLE estado. */
function pedidoCru(): DocData {
  return {
    estado: ESTADO_PEDIDO.pago,
    numero: ORDER_SN,
    itens: {},
    itensIds: [],
    valorCobrado: 31.99,
    ultimaModificacao: AGORA_US - 5_000_000,
    freteInicial: freteDoPedidoSchema.parse({
      ...seedFreteInicial(MODALIDADE_FRETE.fob, true),
      externalOptionIntegracao: INTEGRACAO_FRETE.shopee,
      estado: ESTADO_FRETE.despachoAutorizado,
    }),
  };
}

/**
 * A client that RECORDS every property anybody touches. The recheck must touch
 * none: it makes no Shopee call of its own (W3-2), and above all it never
 * uploads (mutant 63).
 */
function clienteEspiao(): { client: ShopeeClient; acessos: PropertyKey[] } {
  const acessos: PropertyKey[] = [];
  const client = new Proxy(
    {},
    {
      get(_alvo, prop) {
        acessos.push(prop);
        return vi.fn();
      },
    },
  ) as unknown as ShopeeClient;
  return { client, acessos };
}

interface Enfileiramento {
  readonly payload: TarefaNfeShopee;
  readonly opcoes: OpcoesDeEnfileiramentoNfe | undefined;
}

/** A recording scheduler that validates like the real one; `falha` makes it throw. */
function agendador(falha: Error | null = null): {
  scheduler: AgendadorNfeShopee;
  chamadas: Enfileiramento[];
} {
  const chamadas: Enfileiramento[] = [];
  return {
    chamadas,
    scheduler: {
      enqueue: async (payload, opcoes) => {
        chamadas.push({ payload: tarefaNfeShopeeSchema.parse(payload), opcoes });
        if (falha !== null) throw falha;
      },
    },
  };
}

function tarefa(over: Partial<TarefaNfeShopee> = {}): TarefaNfeShopee {
  return tarefaNfeShopeeSchema.parse({
    pedidoId: PEDIDO_ID,
    nfeId: NFE_ID,
    fase: FASE_NFE_SHOPEE.reverificacao,
    ...over,
  });
}

interface Cenario {
  readonly invoice: Record<string, unknown> | null;
  readonly region?: string | null;
  readonly payload?: TarefaNfeShopee;
  readonly falhaDoAgendador?: Error | null;
  /** Open the pedido's aviso BEFORE the recheck runs. */
  readonly avisoAberto?: boolean;
  /** Sibling NF-e documents of the pedido, by id (the cancelled-sibling rule reads them). */
  readonly irmaos?: Readonly<Record<string, DocData>>;
}

/** A CANCELLED sibling NF-e whose stored key is `K_OUTRA` (no proc stored). */
const IRMAO_CANCELADO: Readonly<Record<string, DocData>> = {
  s4: { estado: ESTADO_NFE.cancelada, chave: K_OUTRA },
};

async function abrirAviso(db: FakeDb): Promise<void> {
  await avisarNfeShopee(
    asDb(db),
    {
      integracaoId: INTEGRACAO,
      pedidoId: PEDIDO_ID,
      numero: ORDER_SN,
      motivo: MOTIVO_NFE_SHOPEE.naoAnexada,
      excerto: null,
    },
    { increment, nowMs: AGORA_MS - 60_000 },
  );
}

async function rodar(c: Cenario, db = new FakeDb()) {
  if (db.store[PEDIDO_PATH] === undefined) db.seed(PEDIDO_PATH, pedidoCru());
  for (const [id, raw] of Object.entries(c.irmaos ?? {})) {
    db.seed(nfev4Collection.docPath({ pedidoId: PEDIDO_ID }, id), raw);
  }
  if (c.avisoAberto === true) await abrirAviso(db);
  const escritasAntes = db.writes.length;
  const { client, acessos } = clienteEspiao();
  const { scheduler, chamadas } = agendador(c.falhaDoAgendador ?? null);
  const r = await reverificarNfeShopee(
    {
      pedidoId: PEDIDO_ID,
      nfeId: NFE_ID,
      integracaoId: INTEGRACAO,
      numero: ORDER_SN,
      nossaChave: K,
      client,
    },
    { db: asDb(db), scheduler, nowMs: AGORA_MS, increment, jitterSec: () => 0 },
    c.payload ?? tarefa(),
    linha(c.invoice, c.region === undefined ? 'BR' : c.region),
  );
  return { r, db, chamadas, acessos, escritas: db.writes.slice(escritasAntes) };
}

function aviso(db: FakeDb): DocData | undefined {
  return db.store[AVISO_PATH]?.data;
}

function estadoDoFrete(db: FakeDb): unknown {
  return (db.store[PEDIDO_PATH]?.data.freteInicial as DocData | undefined)?.estado;
}

/** The result every write-free outcome shares. */
function semEfeito(desfecho: string, motivo: MotivoNfeShopee) {
  return {
    desfecho,
    motivo,
    fase: FASE_NFE_SHOPEE.reverificacao,
    substituicao: false,
    carimbo: null,
    avisado: false,
    resolvido: false,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/*  (1) our key, valid                                                          */
/* -------------------------------------------------------------------------- */

describe('1 — nossa + valid ⇒ validada', () => {
  it('sem aviso aberto: validada/nfe-validada, ZERO escritas, nenhum enfileiramento', async () => {
    const { r, db, chamadas } = await rodar({ invoice: { access_key: K, status: 'valid' } });

    expect(r).toEqual(semEfeito(DESFECHO_NFE_SHOPEE.validada, MOTIVO_NFE_SHOPEE.nfeValidada));
    expect(db.writes).toEqual([]);
    expect(chamadas).toEqual([]);
  });

  it('com aviso aberto: resolve com nfe-validada (resolvido true), sem aviso novo nem carimbo', async () => {
    const { r, db, escritas } = await rodar({
      invoice: { access_key: K, status: 'valid' },
      avisoAberto: true,
    });

    expect(r).toMatchObject({
      desfecho: DESFECHO_NFE_SHOPEE.validada,
      resolvido: true,
      avisado: false,
      carimbo: null,
    });
    expect(aviso(db)).toMatchObject({ resolvidoEm: AGORA_US, resolucaoMotivo: 'nfe-validada' });
    expect(escritas.map((e) => e.path)).toEqual([AVISO_PATH]);
    expect(estadoDoFrete(db)).toBe(ESTADO_FRETE.despachoAutorizado);
  });

  it('PAR IGUAL: " VALID " ≡ "valid" — o mesmo desfecho, a mesma resolução', async () => {
    const a = await rodar({ invoice: { access_key: K, status: 'valid' }, avisoAberto: true });
    const b = await rodar({ invoice: { access_key: K, status: ' VALID ' }, avisoAberto: true });

    expect(b.r).toEqual(a.r);
    expect(b.r.resolvido).toBe(true);
  });

  it('⛔ QUASE-ERRO: "invalid" ⇒ status-desconhecido, e o aviso aberto FICA aberto — mutante 68', async () => {
    const { r, db, escritas } = await rodar({
      invoice: { access_key: K, status: 'invalid' },
      avisoAberto: true,
    });

    expect(r).toEqual(
      semEfeito(DESFECHO_NFE_SHOPEE.descartado, MOTIVO_NFE_SHOPEE.statusDesconhecido),
    );
    expect(aviso(db)?.resolvidoEm).toBeNull();
    expect(escritas).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  (2) our key, pending with a reason                                          */
/* -------------------------------------------------------------------------- */

describe('2 — nossa + pending + motivo ⇒ sefaz-pendente', () => {
  it('recusado: aviso com o excerto SANITIZADO, carimbo, e o aviso ANTES do carimbo', async () => {
    const { r, db, escritas, chamadas } = await rodar({
      invoice: {
        access_key: K,
        status: 'pending',
        pending_reason: `Rejeição 539: Duplicidade de NF-e [chNFe:${K}]`,
      },
    });

    expect(r).toEqual({
      desfecho: DESFECHO_NFE_SHOPEE.recusado,
      motivo: MOTIVO_NFE_SHOPEE.sefazPendente,
      fase: FASE_NFE_SHOPEE.reverificacao,
      substituicao: false,
      carimbo: 'carimbado',
      avisado: true,
      resolvido: false,
    });
    // The cStat survives; the key never reaches the stored row.
    const erro = String((aviso(db)?.params as DocData).erro);
    expect(erro).toContain(FRASE_DO_MOTIVO_NFE['sefaz-pendente']);
    expect(erro).toContain('539');
    expect(JSON.stringify(aviso(db))).not.toContain(K);
    expect(aviso(db)?.motivo).toBe(MOTIVO_NFE_SHOPEE.sefazPendente);
    // Write order: aviso, then the stamp (W3-3).
    expect(escritas.map((e) => e.path)).toEqual([AVISO_PATH, PEDIDO_PATH]);
    expect(estadoDoFrete(db)).toBe(ESTADO_FRETE.error);
    expect(chamadas).toEqual([]);
  });

  it('o aviso e o carimbo usam o MESMO instante em µs (um só "agora")', async () => {
    const { db } = await rodar({
      invoice: { access_key: K, status: 'pending', pending_reason: 'Rejeição 539' },
    });

    expect(aviso(db)?.criadoEm).toBe(AGORA_US);
    expect(db.store[PEDIDO_PATH]?.data.ultimaModificacao).toBe(AGORA_US);
  });

  it('PAR IGUAL: pending com motivo "" ≡ "   " ≡ SEM motivo — os três olham de novo, nenhum aviso', async () => {
    const semMotivo = await rodar({ invoice: { access_key: K, status: 'pending' } });
    const vazio = await rodar({
      invoice: { access_key: K, status: 'pending', pending_reason: '' },
    });
    const branco = await rodar({
      invoice: { access_key: K, status: 'pending', pending_reason: '   ' },
    });

    for (const x of [semMotivo, vazio, branco]) {
      expect(x.r).toEqual(
        semEfeito(DESFECHO_NFE_SHOPEE.reverificacaoAgendada, MOTIVO_NFE_SHOPEE.validacaoPendente),
      );
      expect(x.db.writes).toEqual([]);
      expect(x.chamadas).toHaveLength(1);
    }
  });

  it('⛔ QUASE-ERRO: um motivo curto mas VISÍVEL ("539") já é motivo ⇒ sefaz-pendente', async () => {
    const { r, chamadas } = await rodar({
      invoice: { access_key: K, status: 'pending', pending_reason: '539' },
    });

    expect(r).toMatchObject({ motivo: MOTIVO_NFE_SHOPEE.sefazPendente, avisado: true });
    expect(chamadas).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  (3) our key, pending without a reason — the ladder                          */
/* -------------------------------------------------------------------------- */

describe('3 — nossa + pending sem motivo: a escada [900, 1800]', () => {
  const pendenteSemMotivo = { access_key: K, status: 'pending' };

  it('a escada é [900, 1800] — 900 s é o da ENVIO, 1800 s o único que a reverificação agenda', () => {
    expect(ATRASOS_REVERIFICACAO_S).toEqual([900, 1800]);
  });

  it('1ª reverificação (reverificacoes 0) ⇒ reagenda UMA vez, com 1800 s e reverificacoes 1; zero escritas', async () => {
    const payload = tarefa({ reverificacoes: 0 });
    const { r, db, chamadas } = await rodar({ invoice: pendenteSemMotivo, payload });

    expect(r).toEqual(
      semEfeito(DESFECHO_NFE_SHOPEE.reverificacaoAgendada, MOTIVO_NFE_SHOPEE.validacaoPendente),
    );
    expect(chamadas).toEqual([
      {
        payload: { ...payload, fase: FASE_NFE_SHOPEE.reverificacao, reverificacoes: 1 },
        opcoes: { scheduleDelaySeconds: 1800 },
      },
    ]);
    expect(db.writes).toEqual([]);
  });

  it('⛔ 2ª reverificação (reverificacoes 1) ⇒ descartado validacao-pendente: NENHUM enfileiramento, nenhum aviso', async () => {
    const { r, db, chamadas } = await rodar({
      invoice: pendenteSemMotivo,
      payload: tarefa({ reverificacoes: 1 }),
    });

    expect(r).toEqual(
      semEfeito(DESFECHO_NFE_SHOPEE.descartado, MOTIVO_NFE_SHOPEE.validacaoPendente),
    );
    expect(chamadas).toEqual([]);
    expect(db.writes).toEqual([]);
  });

  it('um contador além da escada (7) ⇒ descartado — nunca um índice fora da lista', async () => {
    const { r, chamadas } = await rodar({
      invoice: pendenteSemMotivo,
      payload: tarefa({ reverificacoes: 7 }),
    });

    expect(r.motivo).toBe(MOTIVO_NFE_SHOPEE.validacaoPendente);
    expect(r.desfecho).toBe(DESFECHO_NFE_SHOPEE.descartado);
    expect(chamadas).toEqual([]);
  });

  it('o reagendamento carrega os OUTROS contadores intactos', async () => {
    const payload = tarefa({ adiamentosSerpro: 2, pausas: 3 });
    const { chamadas } = await rodar({ invoice: pendenteSemMotivo, payload });

    expect(chamadas[0]?.payload).toMatchObject({ adiamentosSerpro: 2, pausas: 3 });
  });

  it('pending sem motivo NUNCA resolve um aviso aberto', async () => {
    const { r, db } = await rodar({ invoice: pendenteSemMotivo, avisoAberto: true });

    expect(r.resolvido).toBe(false);
    expect(aviso(db)?.resolvidoEm).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*  (4) our key, no status / an unknown one                                     */
/* -------------------------------------------------------------------------- */

describe('4 — nossa sem status ou com status desconhecido ⇒ status-desconhecido, NUNCA resolve (mutante 68)', () => {
  it.each([
    ['ausente (null)', null],
    ['ausente ("")', ''],
    ['ausente ("   ")', '   '],
    ['desconhecido ("invalid")', 'invalid'],
    ['desconhecido ("validated")', 'validated'],
    ['desconhecido ("pending_review")', 'pending_review'],
  ])('%s ⇒ log só; o aviso aberto FICA aberto e nada é escrito', async (_nome, status) => {
    const { r, db, escritas, chamadas } = await rodar({
      invoice: { access_key: K, status },
      avisoAberto: true,
    });

    expect(r).toEqual(
      semEfeito(DESFECHO_NFE_SHOPEE.descartado, MOTIVO_NFE_SHOPEE.statusDesconhecido),
    );
    expect(aviso(db)?.resolvidoEm).toBeNull();
    expect(escritas).toEqual([]);
    expect(chamadas).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  (5) no key                                                                  */
/* -------------------------------------------------------------------------- */

describe('5 — sem-nota', () => {
  it('status valid SEM chave ⇒ nota-dispensada: log só, zero escritas, nunca resolve', async () => {
    const { r, db, escritas } = await rodar({
      invoice: { access_key: '', status: 'valid' },
      avisoAberto: true,
    });

    expect(r).toEqual(semEfeito(DESFECHO_NFE_SHOPEE.descartado, MOTIVO_NFE_SHOPEE.notaDispensada));
    expect(escritas).toEqual([]);
    expect(aviso(db)?.resolvidoEm).toBeNull();
  });

  it.each([
    ['pending', 'pending'],
    ['sem status', null],
    ['status desconhecido', 'invalid'],
  ])(
    '⛔ QUASE-ERRO: %s SEM chave ⇒ nao-anexada: aviso SEM carimbo (ausência de evidência) e SEM excerto',
    async (_nome, status) => {
      const { r, db, escritas } = await rodar({
        invoice: { access_key: null, status, pending_reason: 'Rejeição 539' },
      });

      expect(r).toEqual({
        ...semEfeito(DESFECHO_NFE_SHOPEE.recusado, MOTIVO_NFE_SHOPEE.naoAnexada),
        avisado: true,
      });
      expect((aviso(db)?.params as DocData).erro).toBe(FRASE_DO_MOTIVO_NFE['nao-anexada']);
      expect(escritas.map((e) => e.path)).toEqual([AVISO_PATH]);
      expect(estadoDoFrete(db)).toBe(ESTADO_FRETE.despachoAutorizado);
    },
  );

  it('invoice_data AUSENTE num pedido BR ⇒ nao-anexada (nunca pedido-nao-br)', async () => {
    const { r } = await rodar({ invoice: null });

    expect(r.motivo).toBe(MOTIVO_NFE_SHOPEE.naoAnexada);
    expect(r.avisado).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  (6) another key                                                             */
/* -------------------------------------------------------------------------- */

describe('6 — outra', () => {
  it('chave LEGÍVEL de outra nota ⇒ outra-nfe-anexada: aviso, SEM carimbo', async () => {
    const { r, db, escritas } = await rodar({ invoice: { access_key: K_OUTRA, status: 'valid' } });

    expect(r).toEqual({
      ...semEfeito(DESFECHO_NFE_SHOPEE.recusado, MOTIVO_NFE_SHOPEE.outraNfeAnexada),
      avisado: true,
    });
    expect(escritas.map((e) => e.path)).toEqual([AVISO_PATH]);
    expect(estadoDoFrete(db)).toBe(ESTADO_FRETE.despachoAutorizado);
    expect(JSON.stringify(aviso(db))).not.toContain(K_OUTRA);
  });

  it('um valor que NÃO é chave ("-") ⇒ chave-ilegivel: aviso, SEM carimbo', async () => {
    const { r, db } = await rodar({ invoice: { access_key: '-', status: 'valid' } });

    expect(r).toEqual({
      ...semEfeito(DESFECHO_NFE_SHOPEE.recusado, MOTIVO_NFE_SHOPEE.chaveIlegivel),
      avisado: true,
    });
    expect(estadoDoFrete(db)).toBe(ESTADO_FRETE.despachoAutorizado);
  });

  it('PAR IGUAL: a NOSSA chave com espaços em volta ≡ a nossa ⇒ validada, nunca outra', async () => {
    const { r } = await rodar({ invoice: { access_key: `  ${K}\n`, status: 'valid' } });

    expect(r.desfecho).toBe(DESFECHO_NFE_SHOPEE.validada);
  });

  it('⛔ QUASE-ERRO: um dígito trocado no meio ⇒ outra, e nada é resolvido', async () => {
    const trocada = `${K.slice(0, 30)}${K[30] === '9' ? '8' : '9'}${K.slice(31)}`;
    const { r, db } = await rodar({
      invoice: { access_key: trocada, status: 'valid' },
      avisoAberto: true,
    });

    expect(r.motivo).toBe(MOTIVO_NFE_SHOPEE.outraNfeAnexada);
    expect(r.resolvido).toBe(false);
    expect(aviso(db)?.resolvidoEm).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*  (6b) a CANCELLED sibling's key — read-your-write lag (R1-2 / R5-4)          */
/* -------------------------------------------------------------------------- */

describe('6b — a chave de um irmão CANCELADO ainda à mostra ⇒ nao-refletida-ainda', () => {
  const chaveDoIrmao = { access_key: K_OUTRA, status: 'valid' };

  it('PAR: 1ª reverificação ⇒ reagenda UMA vez (1800 s, reverificacoes 1), SEM aviso e sem escrita', async () => {
    const payload = tarefa({ reverificacoes: 0, pausas: 2 });
    const { r, db, chamadas } = await rodar({
      invoice: chaveDoIrmao,
      irmaos: IRMAO_CANCELADO,
      payload,
    });

    expect(r).toEqual(
      semEfeito(DESFECHO_NFE_SHOPEE.reverificacaoAgendada, MOTIVO_NFE_SHOPEE.naoRefletidaAinda),
    );
    expect(chamadas).toEqual([
      {
        payload: { ...payload, fase: FASE_NFE_SHOPEE.reverificacao, reverificacoes: 1 },
        opcoes: { scheduleDelaySeconds: ATRASOS_REVERIFICACAO_S[1] },
      },
    ]);
    expect(db.writes).toEqual([]);
    expect(aviso(db)).toBeUndefined();
  });

  it('PAR: além da escada (reverificacoes 1) ⇒ descartado nao-refletida-ainda — log só, NADA enfileirado', async () => {
    const { r, db, chamadas } = await rodar({
      invoice: chaveDoIrmao,
      irmaos: IRMAO_CANCELADO,
      payload: tarefa({ reverificacoes: 1 }),
    });

    expect(r).toEqual(
      semEfeito(DESFECHO_NFE_SHOPEE.descartado, MOTIVO_NFE_SHOPEE.naoRefletidaAinda),
    );
    expect(chamadas).toEqual([]);
    expect(db.writes).toEqual([]);
  });

  it('PAR: a chave do irmão lida com espaços em volta ≡ a mesma ⇒ também nao-refletida-ainda', async () => {
    const { r } = await rodar({
      invoice: { access_key: `  ${K_OUTRA}\t`, status: 'valid' },
      irmaos: IRMAO_CANCELADO,
    });
    expect(r.motivo).toBe(MOTIVO_NFE_SHOPEE.naoRefletidaAinda);
  });

  it('⛔ QUASE-ERRO: uma TERCEIRA chave (nem a nossa nem a do irmão cancelado) ⇒ outra-nfe-anexada, com aviso', async () => {
    const { r, db, chamadas } = await rodar({
      invoice: { access_key: montarChave(undefined, '000000003'), status: 'valid' },
      irmaos: IRMAO_CANCELADO,
    });

    expect(r).toEqual({
      ...semEfeito(DESFECHO_NFE_SHOPEE.recusado, MOTIVO_NFE_SHOPEE.outraNfeAnexada),
      avisado: true,
    });
    expect(aviso(db)?.motivo).toBe(MOTIVO_NFE_SHOPEE.outraNfeAnexada);
    expect(chamadas).toEqual([]);
  });

  it('⛔ QUASE-ERRO: a MESMA chave num irmão que NÃO está cancelado ⇒ outra-nfe-anexada, com aviso', async () => {
    const { r } = await rodar({
      invoice: chaveDoIrmao,
      irmaos: { s4: { estado: ESTADO_NFE.aprovada, chave: K_OUTRA } },
    });
    expect(r).toMatchObject({ motivo: MOTIVO_NFE_SHOPEE.outraNfeAnexada, avisado: true });
  });

  it('válvula fechada no reagendamento ⇒ descartado tasks-desabilitadas (aviso pelo conjunto), sem carimbo', async () => {
    const { r, db } = await rodar({
      invoice: chaveDoIrmao,
      irmaos: IRMAO_CANCELADO,
      falhaDoAgendador: new ShopeeNfeUploadTasksDisabledError(),
    });
    expect(r).toEqual({
      ...semEfeito(DESFECHO_NFE_SHOPEE.descartado, MOTIVO_NFE_SHOPEE.tasksDesabilitadas),
      avisado: true,
    });
    expect(estadoDoFrete(db)).toBe(ESTADO_FRETE.despachoAutorizado);
  });
});

/* -------------------------------------------------------------------------- */
/*  (7) a foreign order                                                         */
/* -------------------------------------------------------------------------- */

describe('7 — nao-br', () => {
  it('pedido fora do Brasil ⇒ pedido-nao-br: log só, zero escritas', async () => {
    const { r, db } = await rodar({ invoice: { access_key: K, status: 'valid' }, region: 'SG' });

    expect(r).toEqual(semEfeito(DESFECHO_NFE_SHOPEE.descartado, MOTIVO_NFE_SHOPEE.pedidoNaoBr));
    expect(db.writes).toEqual([]);
  });

  it('⛔ QUASE-ERRO: região AUSENTE não é estrangeira ⇒ lê a nota normalmente', async () => {
    const { r } = await rodar({ invoice: { access_key: K, status: 'valid' }, region: null });

    expect(r.desfecho).toBe(DESFECHO_NFE_SHOPEE.validada);
  });
});

/* -------------------------------------------------------------------------- */
/*  (8) it never uploads — mutant 63                                            */
/* -------------------------------------------------------------------------- */

/** Every row of the table, for the properties that must hold across all of them. */
const TODOS: readonly Cenario[] = [
  { invoice: { access_key: K, status: 'valid' } },
  { invoice: { access_key: K, status: 'valid' }, avisoAberto: true },
  { invoice: { access_key: K, status: 'pending', pending_reason: 'Rejeição 539' } },
  { invoice: { access_key: K, status: 'pending' } },
  { invoice: { access_key: K, status: 'pending' }, payload: tarefa({ reverificacoes: 1 }) },
  { invoice: { access_key: K, status: null } },
  { invoice: { access_key: K, status: 'invalid' } },
  { invoice: { access_key: '', status: 'valid' } },
  { invoice: { access_key: '', status: 'pending' } },
  { invoice: null },
  { invoice: { access_key: K_OUTRA, status: 'valid' } },
  { invoice: { access_key: K_OUTRA, status: 'valid' }, irmaos: IRMAO_CANCELADO },
  { invoice: { access_key: '-', status: null } },
  { invoice: { access_key: K, status: 'valid' }, region: 'SG' },
  {
    invoice: { access_key: K, status: 'pending' },
    falhaDoAgendador: new ShopeeNfeUploadTasksDisabledError(),
  },
];

describe('8 — a reverificação NUNCA envia (mutante 63)', () => {
  it('nenhum veredito toca o cliente, e todo enfileiramento é outra REVERIFICAÇÃO', async () => {
    let enfileiramentos = 0;
    for (const c of TODOS) {
      const { acessos, chamadas } = await rodar(c);
      expect(acessos).toEqual([]);
      for (const ch of chamadas) {
        expect(ch.payload.fase).toBe(FASE_NFE_SHOPEE.reverificacao);
        enfileiramentos += 1;
      }
    }
    // ÂNCORA: the table does enqueue, so the loop above is not vacuous.
    expect(enfileiramentos).toBeGreaterThan(0);
  });

  it('mesmo um payload que chegasse com fase envio só agenda REVERIFICAÇÃO — a fase é fixada', async () => {
    const { chamadas } = await rodar({
      invoice: { access_key: K, status: 'pending' },
      payload: tarefa({ fase: FASE_NFE_SHOPEE.envio }),
    });

    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]?.payload.fase).toBe(FASE_NFE_SHOPEE.reverificacao);
  });

  describe('a fonte (texto cru)', () => {
    const fonte = readFileSync(
      fileURLToPath(new URL('./reverificacaoNfe.ts', import.meta.url)),
      'utf8',
    );

    it('não nomeia método de envio nem de leitura do cliente, nem a fase de envio', () => {
      // ÂNCORA: the module does name its reader and its phase constant.
      expect(fonte).toMatch(/from '\.\/notaNaShopee'/);
      expect(fonte).toContain('FASE_NFE_SHOPEE.reverificacao');
      expect(fonte).not.toMatch(/uploadInvoiceDoc|upload_invoice|getOrderDetail/);
      expect(fonte).not.toContain('FASE_NFE_SHOPEE.envio');
      expect(fonte).not.toMatch(/fase:\s*'envio'/);
    });

    it('não importa o módulo do handler (nenhum ciclo — W3-2)', () => {
      expect(fonte).toMatch(/from '\.\/tarefaNfe'/);
      expect(fonte).not.toMatch(/from '\.\/processarNfe'/);
    });

    it('F-2: os tipos de deps e de resultado vêm do CONTRATO da tarefa — nenhuma cópia estrutural local', () => {
      const texto = fonte.replace(/\r\n/g, '\n');
      const importDoContrato = /import \{([^}]*)\} from '\.\/tarefaNfe';/.exec(texto)?.[1] ?? '';
      expect(importDoContrato).toMatch(/\btype DepsNfeShopee\b/);
      expect(importDoContrato).toMatch(/\btype ResultadoNfeShopee\b/);
      // No interface of its own that restates a deps or a result shape.
      expect(texto).not.toMatch(/\binterface \w*(Deps|Resultado)\w*/);
    });

    it('cada conjunto é consultado em UM só lugar (W3-4)', () => {
      const vezes = (s: string) => fonte.split(s).length - 1;
      expect(vezes('MOTIVOS_QUE_AVISAM.has(')).toBe(1);
      expect(vezes('MOTIVOS_QUE_CARIMBAM.has(')).toBe(1);
      expect(vezes('MOTIVOS_COM_EXCERTO.has(')).toBe(1);
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  (9) effects come ONLY from the sets — W3-4                                  */
/* -------------------------------------------------------------------------- */

describe('9 — os efeitos vêm SÓ dos conjuntos', () => {
  it('em toda a tabela: avisado ⇔ MOTIVOS_QUE_AVISAM, carimbado ⇔ MOTIVOS_QUE_CARIMBAM', async () => {
    const vistos = new Set<MotivoNfeShopee>();
    for (const c of TODOS) {
      const { r } = await rodar(c);
      const motivo = r.motivo;
      expect(motivo).not.toBeNull();
      if (motivo === null) continue;
      vistos.add(motivo);
      expect(r.avisado).toBe(MOTIVOS_QUE_AVISAM.has(motivo));
      expect(r.carimbo !== null).toBe(MOTIVOS_QUE_CARIMBAM.has(motivo));
    }
    // ÂNCORA: the table reaches every motivo this module can produce.
    expect([...vistos].sort()).toEqual(
      [
        MOTIVO_NFE_SHOPEE.nfeValidada,
        MOTIVO_NFE_SHOPEE.sefazPendente,
        MOTIVO_NFE_SHOPEE.validacaoPendente,
        MOTIVO_NFE_SHOPEE.statusDesconhecido,
        MOTIVO_NFE_SHOPEE.notaDispensada,
        MOTIVO_NFE_SHOPEE.naoAnexada,
        MOTIVO_NFE_SHOPEE.outraNfeAnexada,
        MOTIVO_NFE_SHOPEE.chaveIlegivel,
        MOTIVO_NFE_SHOPEE.pedidoNaoBr,
        MOTIVO_NFE_SHOPEE.tasksDesabilitadas,
        MOTIVO_NFE_SHOPEE.naoRefletidaAinda,
      ].sort(),
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  (10) the closed valve and the failures                                      */
/* -------------------------------------------------------------------------- */

describe('10 — válvula fechada e falhas', () => {
  it('válvula fechada no reagendamento ⇒ descartado tasks-desabilitadas; aviso (pelo conjunto), sem carimbo; um warn sem chave nem order_sn', async () => {
    const { r, db } = await rodar({
      invoice: { access_key: K, status: 'pending' },
      falhaDoAgendador: new ShopeeNfeUploadTasksDisabledError(),
    });

    expect(r).toEqual({
      ...semEfeito(DESFECHO_NFE_SHOPEE.descartado, MOTIVO_NFE_SHOPEE.tasksDesabilitadas),
      avisado: true,
    });
    expect(aviso(db)?.motivo).toBe(MOTIVO_NFE_SHOPEE.tasksDesabilitadas);
    expect(estadoDoFrete(db)).toBe(ESTADO_FRETE.despachoAutorizado);

    const warn = vi.mocked(console.warn);
    expect(warn).toHaveBeenCalledTimes(1);
    const linhaDeLog = JSON.stringify(warn.mock.calls[0]);
    expect(linhaDeLog).toContain(PEDIDO_ID);
    expect(linhaDeLog).not.toContain(K);
    expect(linhaDeLog).not.toContain(ORDER_SN);
  });

  it('⛔ QUASE-ERRO: qualquer OUTRA falha do agendador PROPAGA (regra 6) e nada é escrito', async () => {
    const falha = grpc(14, 'UNAVAILABLE');
    const db = new FakeDb();

    await expect(
      rodar({ invoice: { access_key: K, status: 'pending' }, falhaDoAgendador: falha }, db),
    ).rejects.toBe(falha);
    expect(db.writes).toEqual([]);
  });

  it('uma falha do aviso PROPAGA, e o frete NÃO é carimbado', async () => {
    const falha = grpc(14, 'UNAVAILABLE');
    const db = new FakeDb();
    db.falhasDeCriacao.set(AVISO_PATH, falha);

    await expect(
      rodar({ invoice: { access_key: K, status: 'pending', pending_reason: 'Rejeição 539' } }, db),
    ).rejects.toBe(falha);
    expect(estadoDoFrete(db)).toBe(ESTADO_FRETE.despachoAutorizado);
  });

  it('uma falha do carimbo PROPAGA — e o aviso já está gravado (aviso ANTES do carimbo)', async () => {
    const falha = grpc(14, 'UNAVAILABLE');
    const db = new FakeDb();
    vi.spyOn(db, 'runTransaction').mockRejectedValue(falha);

    await expect(
      rodar({ invoice: { access_key: K, status: 'pending', pending_reason: 'Rejeição 539' } }, db),
    ).rejects.toBe(falha);
    expect(aviso(db)?.motivo).toBe(MOTIVO_NFE_SHOPEE.sefazPendente);
    expect(estadoDoFrete(db)).toBe(ESTADO_FRETE.despachoAutorizado);
  });

  it('uma falha do RESOLVE (não de precondição) PROPAGA', async () => {
    const falha = grpc(14, 'UNAVAILABLE');
    const db = new FakeDb();
    db.seed(PEDIDO_PATH, pedidoCru());
    await abrirAviso(db);
    db.falhasDeUpdate.set(AVISO_PATH, falha);

    await expect(rodar({ invoice: { access_key: K, status: 'valid' } }, db)).rejects.toBe(falha);
  });
});
