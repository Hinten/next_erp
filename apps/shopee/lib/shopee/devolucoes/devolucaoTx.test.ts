import { describe, expect, it } from 'vitest';
import { coerceToMicros } from '@delfrance/core/datetime';
import { deferred } from '@delfrance/data/testing';
import { ORIGEM_INCIDENTE, STATUS_CLAIM, TIPO_INCIDENTE } from '@delfrance/schemas';
import type { ShopeeReturnDetail } from '@delfrance/integrations-shopee';

import { FIXTURE_RETURN_DETAIL_DOC, lerDevolucaoDetalhe } from '../fixtures/wireCorpus';
import { makePedidoIdShopee } from '../pedidos/orderIds';
import { microsDeSegundosShopee } from '../pedidos/orderMapping';
import { FakeDb, asDb, type DocData } from '../testing/fakeDb';
import {
  mapearDevolucaoShopee,
  pendenciaDoVendedor,
  type DevolucaoMapeada,
} from './devolucaoMapping';
import {
  preverIncidenteDevolucaoShopee,
  salvarIncidenteDevolucaoShopee,
  type PrevisaoDevolucao,
} from './devolucaoTx';
import { idIncidenteDevolucaoShopee } from './idsDevolucao';

/* -------------------------------------------------------------------------- */
/*  Fixtures — invented ids only. Never a real partner, shop, order or buyer.  */
/* -------------------------------------------------------------------------- */

const CONTA = 'int-1';
const ORDER_SN = '260910KJBHUJDM';
/** The corpus detail's own return_sn — ALPHANUMERIC, like Shopee's samples. */
const RETURN_SN = '260910ABCDE0001';
const PEDIDO_ID = makePedidoIdShopee(CONTA, ORDER_SN);
const PEDIDO_PATH = `pedidos/${PEDIDO_ID}`;
const INCIDENTE_ID = idIncidenteDevolucaoShopee(RETURN_SN);
const INCIDENTE_PATH = `${PEDIDO_PATH}/incidentes/${INCIDENTE_ID}`;

/** The keys the importer owns on an UPDATE — and nothing else, ever (R-4, §2.4). */
const CHAVES_DO_IMPORTADOR = [
  'claimStage',
  'claimStatus',
  'devolucaoShopee',
  'entregue',
  'externalId',
  'origem',
  'relogioProvedorUs',
  'tipo',
  'ultimaModificacao',
];

/** Operator turf on an imported row — survives every refresh byte for byte. */
const TURNO_DO_OPERADOR: DocData = {
  timestamp: 1_600_000_000_000_000,
  motivoDoIncidente: 'Texto que o operador reescreveu',
  comentarios: 'Liguei para a transportadora',
  resolucao: { data: null, valor: 0, tipo: 3, comentarios: 'Aguardando a Shopee', frete: null },
  overrideBloqueio: {
    acoes: ['finalizar'],
    data: 1_600_000_000_000_000,
    usuarioOuterRef: 'documents/usuario/uid-op',
    motivo: 'liberado na mão',
  },
};

function base(): ShopeeReturnDetail {
  return lerDevolucaoDetalhe(FIXTURE_RETURN_DETAIL_DOC).response;
}

/** The corpus detail with top-level overrides. */
function detalhe(over: Partial<ShopeeReturnDetail> = {}): ShopeeReturnDetail {
  return { ...base(), ...over };
}

function mapear(over: Partial<ShopeeReturnDetail> = {}): DevolucaoMapeada {
  return mapearDevolucaoShopee(detalhe(over));
}

/** The corpus's own `update_time`, in wire SECONDS. */
const T0_S = base().update_time;
const T0_US = microsDeSegundosShopee(T0_S);

function dbComPedido(): FakeDb {
  const db = new FakeDb();
  db.seed(PEDIDO_PATH, { numero: ORDER_SN });
  return db;
}

function salvar(db: FakeDb, mapeada: DevolucaoMapeada): Promise<PrevisaoDevolucao> {
  return salvarIncidenteDevolucaoShopee(asDb(db), {
    pedidoId: PEDIDO_ID,
    incidenteId: INCIDENTE_ID,
    mapeada,
  });
}

function incidente(db: FakeDb): DocData {
  const doc = db.store[INCIDENTE_PATH];
  if (!doc) throw new Error('incidente ausente');
  return doc.data;
}

/** A db holding the incidente exactly as a first import of `over` wrote it. */
async function dbImportado(over: Partial<ShopeeReturnDetail> = {}): Promise<FakeDb> {
  const db = dbComPedido();
  const r = await salvar(db, mapear(over));
  expect(r.acao).toBe('criado');
  db.writes.length = 0;
  db.patches.length = 0;
  db.opLog.length = 0;
  db.occ.txLog.length = 0;
  return db;
}

/** Every key at every depth of a value. */
function todasAsChaves(v: unknown, saida: string[] = []): string[] {
  if (Array.isArray(v)) {
    for (const x of v) todasAsChaves(x, saida);
  } else if (typeof v === 'object' && v !== null) {
    for (const [k, x] of Object.entries(v)) {
      saida.push(k);
      todasAsChaves(x, saida);
    }
  }
  return saida;
}

function todosOsTextos(v: unknown, saida: string[] = []): string[] {
  if (typeof v === 'string') saida.push(v);
  else if (Array.isArray(v)) for (const x of v) todosOsTextos(x, saida);
  else if (typeof v === 'object' && v !== null)
    for (const x of Object.values(v)) todosOsTextos(x, saida);
  return saida;
}

/* -------------------------------------------------------------------------- */
/*                          the decision, R-4 (pure)                           */
/* -------------------------------------------------------------------------- */

describe('preverIncidenteDevolucaoShopee — a guarda é relogioProvedorUs (R-4)', () => {
  it('incidente ausente ⇒ `criado`: revisão 1, os campos create-only e o relógio nos DOIS carimbos', () => {
    const m = mapear();
    const p = preverIncidenteDevolucaoShopee(undefined, m);
    expect(p.acao).toBe('criado');
    expect(p.anterior).toBeNull();
    expect(p.patch).toMatchObject({
      origem: ORIGEM_INCIDENTE.pedidoShopee,
      tipo: TIPO_INCIDENTE.devolucao,
      externalId: RETURN_SN,
      claimStatus: m.claimStatus,
      claimStage: null,
      entregue: null,
      timestamp: m.timestampUs,
      motivoDoIncidente: m.motivoInicial,
      ultimaModificacao: m.relogioProvedorUs,
      relogioProvedorUs: m.relogioProvedorUs,
      devolucaoShopee: { ...m.bloco, revisao: 1 },
    });
    expect(p.confirmado).toEqual({ claimStatus: m.claimStatus, bloco: { ...m.bloco, revisao: 1 } });
    // `overrideBloqueio` is `.optional()` on purpose — a create never adds the key.
    expect(Object.hasOwn(p.patch ?? {}, 'overrideBloqueio')).toBe(false);
  });

  it('replay IDÊNTICO ⇒ `ignorado-sem-mudanca`, nenhum patch, aviso intocado', async () => {
    const db = await dbImportado();
    const p = preverIncidenteDevolucaoShopee(incidente(db), mapear());
    expect(p.acao).toBe('ignorado-sem-mudanca');
    expect(p.patch).toBeNull();
    expect(p.mudouAviso).toBe(false);
    expect(p.confirmado).toEqual(p.anterior);
  });

  it('detalhe MAIS VELHO ⇒ `ignorado-obsoleto`, zero escrita, confirmado = o ARMAZENADO — mesmo com conteúdo diferente', async () => {
    const db = await dbImportado({ status: 'CLOSED', update_time: T0_S + 60 });
    const antes = incidente(db);
    // An older detail that would REOPEN the return.
    const p = preverIncidenteDevolucaoShopee(antes, mapear({ status: 'REQUESTED' }));
    expect(p.acao).toBe('ignorado-obsoleto');
    expect(p.patch).toBeNull();
    expect(p.mudouAviso).toBe(false);
    expect(p.confirmado.claimStatus).toBe(STATUS_CLAIM.fechada);
    expect(p.confirmado.bloco?.status).toBe('CLOSED');
    expect(p.confirmado).toEqual(p.anterior);
  });

  it('relógio IGUAL e conteúdo DIFERENTE ⇒ `atualizado` com revisão 2 (a resolução de 1 s da Shopee)', async () => {
    const db = await dbImportado();
    const p = preverIncidenteDevolucaoShopee(incidente(db), mapear({ status: 'CLOSED' }));
    expect(p.acao).toBe('atualizado');
    expect(p.patch).toMatchObject({
      relogioProvedorUs: T0_US,
      claimStatus: STATUS_CLAIM.fechada,
      devolucaoShopee: { status: 'CLOSED', revisao: 2 },
    });
  });

  it('relógio MAIS NOVO e conteúdo IGUAL ⇒ `relogio-avancado`: SÓ os dois carimbos, revisão e bloco intocados', async () => {
    const db = await dbImportado();
    const p = preverIncidenteDevolucaoShopee(incidente(db), mapear({ update_time: T0_S + 1 }));
    expect(p.acao).toBe('relogio-avancado');
    expect(p.patch).toEqual({
      relogioProvedorUs: microsDeSegundosShopee(T0_S + 1),
      ultimaModificacao: microsDeSegundosShopee(T0_S + 1),
    });
    expect(p.mudouAviso).toBe(false);
    expect(p.confirmado).toEqual(p.anterior);
    expect(p.confirmado.bloco?.revisao).toBe(1);
  });

  it('relógio MAIS NOVO e conteúdo DIFERENTE ⇒ `atualizado`, revisão +1, o relógio avança', async () => {
    const db = await dbImportado();
    const p = preverIncidenteDevolucaoShopee(
      incidente(db),
      mapear({ status: 'CLOSED', update_time: T0_S + 1 }),
    );
    expect(p.acao).toBe('atualizado');
    expect(p.patch).toMatchObject({
      relogioProvedorUs: microsDeSegundosShopee(T0_S + 1),
      ultimaModificacao: microsDeSegundosShopee(T0_S + 1),
      devolucaoShopee: { revisao: 2 },
    });
  });

  it.each([
    ['ausente', undefined],
    ['null', null],
    ['texto', '1655219544000000'],
    ['NaN', Number.NaN],
  ])(
    'relógio armazenado %s lê como MAIS VELHO: conteúdo igual avança, diferente escreve',
    async (_, valor) => {
      const db = await dbImportado();
      const raw: DocData = { ...incidente(db) };
      if (valor === undefined) delete raw.relogioProvedorUs;
      else raw.relogioProvedorUs = valor;

      const igual = preverIncidenteDevolucaoShopee(raw, mapear());
      expect(igual.acao).toBe('relogio-avancado');
      expect(igual.patch).toEqual({ relogioProvedorUs: T0_US, ultimaModificacao: T0_US });

      const diferente = preverIncidenteDevolucaoShopee(raw, mapear({ status: 'CLOSED' }));
      expect(diferente.acao).toBe('atualizado');
    },
  );

  it('⚠️ `ultimaModificacao` NÃO é a guarda: o carimbo de parede do operador não bloqueia a importação', async () => {
    const db = await dbImportado();
    // An operator saved AFTER the import: the web stamps wall-clock µs there,
    // far ahead of Shopee's clock.
    const salvoPeloOperador = { ...incidente(db), ultimaModificacao: T0_US + 86_400_000_000 };
    const p = preverIncidenteDevolucaoShopee(
      salvoPeloOperador,
      mapear({ status: 'CLOSED', update_time: T0_S + 60 }),
    );
    expect(p.acao).toBe('atualizado');
  });

  it('⚠️ QUASE-ERRO do caso acima: um `ultimaModificacao` VELHO não deixa passar um detalhe obsoleto', async () => {
    const db = await dbImportado({ update_time: T0_S + 60 });
    const atrasado = { ...incidente(db), ultimaModificacao: 1 };
    const p = preverIncidenteDevolucaoShopee(atrasado, mapear({ status: 'CLOSED' }));
    expect(p.acao).toBe('ignorado-obsoleto');
  });

  it.each([
    ['NaN', Number.NaN],
    ['zero', 0],
    ['negativo', -1],
    ['fracionário', T0_US + 0.5],
    ['infinito', Number.POSITIVE_INFINITY],
  ])(
    'um relógio mapeado %s é RECUSADO (RangeError) — nunca vira uma marca d’água imbatível',
    (_, valor) => {
      const m = { ...mapear(), relogioProvedorUs: valor };
      expect(() => preverIncidenteDevolucaoShopee(undefined, m)).toThrow(RangeError);
    },
  );
});

/* -------------------------------------------------------------------------- */
/*                        the content: field by field                          */
/* -------------------------------------------------------------------------- */

describe('preverIncidenteDevolucaoShopee — o conteúdo, campo a campo', () => {
  const RETIPAGENS: [string, DocData][] = [
    ['origem 99 (outros)', { origem: ORIGEM_INCIDENTE.outros }],
    ['origem 2 (Mercado Livre)', { origem: ORIGEM_INCIDENTE.pedidoMercadoLivre }],
    ['origem null', { origem: null }],
    ['tipo `o`', { tipo: TIPO_INCIDENTE.outros }],
    ['tipo `mediations`', { tipo: TIPO_INCIDENTE.mediacaoDoMarketplace }],
    ['externalId trocado', { externalId: '260910ABCDE0002' }],
    ['claimStatus invertido', { claimStatus: STATUS_CLAIM.fechada }],
    ['claimStatus null', { claimStatus: null }],
    ['claimStage `dispute`', { claimStage: 'dispute' }],
    ['entregue true', { entregue: true }],
    ['bloco ausente', { devolucaoShopee: undefined }],
    ['bloco ilegível', { devolucaoShopee: 'lixo' }],
  ];

  it('a tabela de retipagens não é vazia (um it.each vazio passa calado)', () => {
    expect(RETIPAGENS.length).toBe(12);
  });

  it.each(RETIPAGENS)(
    'uma retipagem do operador (%s) no MESMO relógio é RE-AFIRMADA pelo importador',
    async (_, retipagem) => {
      const db = await dbImportado();
      const raw: DocData = { ...incidente(db), ...retipagem };
      for (const [k, v] of Object.entries(retipagem)) if (v === undefined) delete raw[k];
      const m = mapear();
      const p = preverIncidenteDevolucaoShopee(raw, m);
      expect(p.acao).toBe('atualizado');
      expect(p.patch).toMatchObject({
        origem: ORIGEM_INCIDENTE.pedidoShopee,
        tipo: TIPO_INCIDENTE.devolucao,
        externalId: RETURN_SN,
        claimStatus: m.claimStatus,
        claimStage: null,
        entregue: null,
      });
    },
  );

  it('⚠️ QUASE-ERRO: `claimStage`/`entregue` AUSENTES valem o mesmo que `null` (R-9) — nenhuma escrita', async () => {
    const db = await dbImportado();
    const raw: DocData = { ...incidente(db) };
    delete raw.claimStage;
    delete raw.entregue;
    expect(preverIncidenteDevolucaoShopee(raw, mapear()).acao).toBe('ignorado-sem-mudanca');
  });

  it('⚠️ QUASE-ERRO: chaves do OPERADOR diferentes não são conteúdo — nenhuma escrita', async () => {
    const db = await dbImportado();
    const raw: DocData = { ...incidente(db), ...TURNO_DO_OPERADOR };
    expect(preverIncidenteDevolucaoShopee(raw, mapear()).acao).toBe('ignorado-sem-mudanca');
  });

  it('a revisão NÃO é conteúdo: um bloco armazenado com outra revisão e o mesmo resto não escreve', async () => {
    const db = await dbImportado();
    const raw = incidente(db);
    const bloco = raw.devolucaoShopee as Record<string, unknown>;
    const p = preverIncidenteDevolucaoShopee(
      { ...raw, devolucaoShopee: { ...bloco, revisao: 7 } },
      mapear(),
    );
    expect(p.acao).toBe('ignorado-sem-mudanca');
  });

  it('a revisão segue a ARMAZENADA (+1), e recomeça em 1 quando a armazenada é ilegível', async () => {
    const db = await dbImportado();
    const raw = incidente(db);
    const bloco = raw.devolucaoShopee as Record<string, unknown>;
    const segue = preverIncidenteDevolucaoShopee(
      { ...raw, devolucaoShopee: { ...bloco, revisao: 7 } },
      mapear({ status: 'CLOSED' }),
    );
    expect(segue.confirmado.bloco?.revisao).toBe(8);
    const recomeca = preverIncidenteDevolucaoShopee(
      { ...raw, devolucaoShopee: 'lixo' },
      mapear({ status: 'CLOSED' }),
    );
    expect(recomeca.confirmado.bloco?.revisao).toBe(1);
  });

  it('o patch de atualização carrega EXATAMENTE as chaves do importador — nunca o turno do operador', async () => {
    const db = await dbImportado();
    const p = preverIncidenteDevolucaoShopee(
      { ...incidente(db), ...TURNO_DO_OPERADOR },
      mapear({ status: 'CLOSED', update_time: T0_S + 1 }),
    );
    expect(p.acao).toBe('atualizado');
    expect(Object.keys(p.patch ?? {}).sort()).toEqual(CHAVES_DO_IMPORTADOR);
  });
});

/* -------------------------------------------------------------------------- */
/*                              the aviso hint                                 */
/* -------------------------------------------------------------------------- */

describe('preverIncidenteDevolucaoShopee — `mudouAviso`', () => {
  it('um create sempre pede o efeito (não havia estado anterior)', () => {
    expect(preverIncidenteDevolucaoShopee(undefined, mapear()).mudouAviso).toBe(true);
  });

  it('o STATUS muda com a MESMA pendência (REQUESTED → PROCESSING) ⇒ true', async () => {
    const db = await dbImportado({ status: 'REQUESTED' });
    const m = mapear({ status: 'PROCESSING', update_time: T0_S + 1 });
    const p = preverIncidenteDevolucaoShopee(incidente(db), m);
    expect(p.acao).toBe('atualizado');
    // The premise, read through the ONE pendência rule: same pendência, same prazo.
    const antes = pendenciaDoVendedor(p.anterior?.claimStatus ?? null, p.anterior!.bloco!);
    const depois = pendenciaDoVendedor(p.confirmado.claimStatus, p.confirmado.bloco!);
    expect(depois).toEqual(antes);
    expect(p.mudouAviso).toBe(true);
  });

  it('SÓ o PRAZO muda (1 s no `due_date`) ⇒ true', async () => {
    const db = await dbImportado({ status: 'REQUESTED' });
    // `due_date` is the NEARER of the two deadlines this pendência reads in the
    // corpus, so moving it is what moves the prazo.
    const b = base();
    const m = mapear({
      status: 'REQUESTED',
      due_date: (b.due_date ?? 0) - 1,
      update_time: T0_S + 1,
    });
    const p = preverIncidenteDevolucaoShopee(incidente(db), m);
    expect(p.acao).toBe('atualizado');
    const antes = pendenciaDoVendedor(p.anterior?.claimStatus ?? null, p.anterior!.bloco!);
    const depois = pendenciaDoVendedor(p.confirmado.claimStatus, p.confirmado.bloco!);
    expect(depois?.pendencia).toBe(antes?.pendencia);
    expect(depois?.prazoUs).not.toBe(antes?.prazoUs);
    expect(p.confirmado.bloco?.status).toBe(p.anterior?.bloco?.status);
    expect(p.mudouAviso).toBe(true);
  });

  it('SÓ a PENDÊNCIA muda (proposta → evidências, mesmo prazo, mesmo status) ⇒ true', async () => {
    // The corpus holds a negotiation PENDING_RESPOND and a proof PENDING whose
    // deadlines are the SAME second — so ending the negotiation moves the
    // pendência and nothing the other two clauses read.
    const b = base();
    const db = await dbImportado();
    const m = mapear({
      negotiation: { ...b.negotiation!, negotiation_status: 'TERMINATED' },
      update_time: T0_S + 1,
    });
    const p = preverIncidenteDevolucaoShopee(incidente(db), m);
    const antes = pendenciaDoVendedor(p.anterior?.claimStatus ?? null, p.anterior!.bloco!);
    const depois = pendenciaDoVendedor(p.confirmado.claimStatus, p.confirmado.bloco!);
    expect(antes?.pendencia).not.toBe(depois?.pendencia);
    expect(depois?.prazoUs).toBe(antes?.prazoUs);
    expect(p.confirmado.bloco?.status).toBe(p.anterior?.bloco?.status);
    expect(p.mudouAviso).toBe(true);
  });

  it('⚠️ QUASE-ERRO: um conteúdo novo que não toca pendência, prazo nem status ⇒ escreve, mas false', async () => {
    const db = await dbImportado();
    const p = preverIncidenteDevolucaoShopee(
      incidente(db),
      mapear({ refund_amount: 13.98, update_time: T0_S + 1 }),
    );
    expect(p.acao).toBe('atualizado');
    expect(p.mudouAviso).toBe(false);
  });

  it('⚠️ um detalhe OBSOLETO que fecharia a devolução não pede efeito nenhum', async () => {
    const db = await dbImportado({ status: 'REQUESTED', update_time: T0_S + 60 });
    const p = preverIncidenteDevolucaoShopee(incidente(db), mapear({ status: 'CLOSED' }));
    expect(p.acao).toBe('ignorado-obsoleto');
    expect(p.mudouAviso).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                            the transaction itself                           */
/* -------------------------------------------------------------------------- */

describe('salvarIncidenteDevolucaoShopee — a transação', () => {
  it('sem pedido ⇒ `ignorado-sem-pedido`: zero escritas, nem o incidente é lido', async () => {
    const db = new FakeDb();
    const p = await salvar(db, mapear());
    expect(p.acao).toBe('ignorado-sem-pedido');
    expect(p.patch).toBeNull();
    expect(p.mudouAviso).toBe(false);
    expect(db.writes).toEqual([]);
    expect(db.opLog).toEqual([{ op: 'get', path: PEDIDO_PATH }]);
    expect(db.store[INCIDENTE_PATH]).toBeUndefined();
  });

  it('a primeira entrega CRIA com `tx.create` — nunca `set` — e grava o que a previsão diz', async () => {
    const db = dbComPedido();
    const m = mapear();
    const p = await salvar(db, m);
    expect(p.acao).toBe('criado');
    expect(db.opLog).toEqual([
      { op: 'get', path: PEDIDO_PATH },
      { op: 'get', path: INCIDENTE_PATH },
      { op: 'create', path: INCIDENTE_PATH },
    ]);
    expect(incidente(db)).toEqual(p.patch);
    // The dry-run parity: the pure function on a plain "absent" read prints the
    // very bytes the transaction wrote.
    expect(preverIncidenteDevolucaoShopee(undefined, m).patch).toEqual(incidente(db));
  });

  it('o replay idêntico não escreve NADA: opLog só com leituras, updateTime intocado', async () => {
    const db = await dbImportado();
    const antes = db.store[INCIDENTE_PATH]!.updateTime;
    const p = await salvar(db, mapear());
    expect(p.acao).toBe('ignorado-sem-mudanca');
    expect(db.writes).toEqual([]);
    expect(db.opLog.map((o) => o.op)).toEqual(['get', 'get']);
    expect(db.store[INCIDENTE_PATH]!.updateTime.isEqual(antes)).toBe(true);
  });

  it('um detalhe obsoleto não escreve NADA', async () => {
    const db = await dbImportado({ update_time: T0_S + 60 });
    const p = await salvar(db, mapear({ status: 'CLOSED' }));
    expect(p.acao).toBe('ignorado-obsoleto');
    expect(db.writes).toEqual([]);
  });

  it('a atualização é `tx.update` e o turno do operador sobrevive byte a byte', async () => {
    const db = await dbImportado();
    db.seed(INCIDENTE_PATH, { ...incidente(db), ...TURNO_DO_OPERADOR });
    const p = await salvar(db, mapear({ status: 'CLOSED', update_time: T0_S + 1 }));
    expect(p.acao).toBe('atualizado');
    expect(db.opLog.map((o) => o.op)).toEqual(['get', 'get', 'update']);
    expect(Object.keys(db.patches[0]!.patch).sort()).toEqual(CHAVES_DO_IMPORTADOR);
    expect(incidente(db)).toMatchObject(TURNO_DO_OPERADOR);
    expect(incidente(db)).toMatchObject({
      claimStatus: STATUS_CLAIM.fechada,
      relogioProvedorUs: microsDeSegundosShopee(T0_S + 1),
      ultimaModificacao: microsDeSegundosShopee(T0_S + 1),
      devolucaoShopee: { status: 'CLOSED', revisao: 2 },
    });
  });

  it('o avanço só de relógio grava DUAS chaves e deixa o bloco (e a revisão) como estavam', async () => {
    const db = await dbImportado();
    const blocoAntes = incidente(db).devolucaoShopee;
    const p = await salvar(db, mapear({ update_time: T0_S + 1 }));
    expect(p.acao).toBe('relogio-avancado');
    expect(db.patches.map((x) => Object.keys(x.patch).sort())).toEqual([
      ['relogioProvedorUs', 'ultimaModificacao'],
    ]);
    expect(incidente(db).devolucaoShopee).toEqual(blocoAntes);
  });
});

/* -------------------------------------------------------------------------- */
/*                 the race — the decision is re-derived in-tx                 */
/* -------------------------------------------------------------------------- */

describe('salvarIncidenteDevolucaoShopee — a corrida de duas entregas', () => {
  /** Holds the first attempt whose write is about `status`, until released. */
  function segurar(db: FakeDb, status: string) {
    const portao = deferred();
    let segurou = false;
    // ⚠️ The held run is identified by WHAT IT IS ABOUT TO WRITE, never by
    // `ctx.label` (transaction-open order is an artefact of the await chain).
    db.occ.beforeCommit = (ctx) => {
      const eDele = ctx.writes.some(
        (w) => (w.data.devolucaoShopee as { status?: unknown } | undefined)?.status === status,
      );
      if (!eDele || segurou) return undefined;
      segurou = true;
      return portao.promise;
    };
    return portao;
  }

  it('a entrega VELHA segurada enquanto a NOVA cria ⇒ re-lê e cai em `ignorado-obsoleto`', async () => {
    const db = dbComPedido();
    const portao = segurar(db, 'REQUESTED');
    const velha = salvar(db, mapear({ status: 'REQUESTED' }));
    const nova = await salvar(db, mapear({ status: 'CLOSED', update_time: T0_S + 60 }));
    portao.resolve();
    const r = await velha;

    expect(nova.acao).toBe('criado');
    // A stale closure would have re-sent its `create` and died on ALREADY_EXISTS.
    expect(r.acao).toBe('ignorado-obsoleto');
    expect(db.occ.txLog.filter((e) => e.phase === 'abort')).toHaveLength(1);
    expect(incidente(db)).toMatchObject({
      claimStatus: STATUS_CLAIM.fechada,
      devolucaoShopee: { status: 'CLOSED', revisao: 1 },
    });
  });

  it('a entrega NOVA segurada enquanto a VELHA cria ⇒ re-lê e ATUALIZA para a revisão 2', async () => {
    const db = dbComPedido();
    const portao = segurar(db, 'CLOSED');
    const nova = salvar(db, mapear({ status: 'CLOSED', update_time: T0_S + 60 }));
    const velha = await salvar(db, mapear({ status: 'REQUESTED' }));
    portao.resolve();
    const r = await nova;

    expect(velha.acao).toBe('criado');
    expect(r.acao).toBe('atualizado');
    expect(r.anterior?.bloco?.status).toBe('REQUESTED');
    expect(r.mudouAviso).toBe(true);
    expect(incidente(db)).toMatchObject({
      claimStatus: STATUS_CLAIM.fechada,
      relogioProvedorUs: microsDeSegundosShopee(T0_S + 60),
      devolucaoShopee: { status: 'CLOSED', revisao: 2 },
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                      the unit, and what is never stored                     */
/* -------------------------------------------------------------------------- */

describe('salvarIncidenteDevolucaoShopee — a unidade é a guarda', () => {
  it('⚠️ QUASE-ERRO: coerceToMicros num `update_time` em SEGUNDOS responde 1970 e a guarda morre', () => {
    expect(mapear().relogioProvedorUs).toBe(T0_S * 1_000_000);
    const errado = coerceToMicros(T0_S)!;
    expect(errado).toBe(T0_S * 1_000);
    expect(new Date(errado / 1000).getUTCFullYear()).toBe(1970);
  });

  it('uma marca d’água em µs semeada à mão ainda perde para um detalhe 60 s mais novo', async () => {
    // Seeded independently of the mapper, so a mapper that converted with the
    // wrong helper (ms magnitude) would read as OLDER and drop the change.
    const db = await dbImportado();
    db.seed(INCIDENTE_PATH, { ...incidente(db), relogioProvedorUs: T0_US });
    const p = await salvar(db, mapear({ status: 'CLOSED', update_time: T0_S + 60 }));
    expect(p.acao).toBe('atualizado');
  });

  it('o documento gravado não tem NENHUM dado do comprador — chave nem valor', async () => {
    const db = dbComPedido();
    await salvar(db, mapear());
    const chaves = new Set(todasAsChaves(incidente(db)));
    for (const proibida of [
      'user',
      'username',
      'email',
      'portrait',
      'image',
      'images',
      'buyer_videos',
      'text_reason',
      'dispute_text_reason',
      'return_pickup_address',
      'tracking_number',
      'latest_offer_creator',
      'virtual_contact_number',
      'package_query_number',
      'item',
      'activity',
    ]) {
      expect(chaves.has(proibida), proibida).toBe(false);
    }
    expect(todosOsTextos(incidente(db))).not.toContain('REDACTED');
  });
});
