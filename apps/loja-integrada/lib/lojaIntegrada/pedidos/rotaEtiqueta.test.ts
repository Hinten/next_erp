/**
 * The label routing route's core (master plan step 15, #1825), against `testing/fakeDb.ts`, which
 * models the `lastUpdateTime` precondition as the server applies it (a stale stamp, and a removed
 * document, both fail 9). `rotaEtiqueta.firestore.test.ts` proves on the emulator what the fake
 * cannot: the server's own 9 on a stale stamp, and a whole-block update keeping an unmodelled key
 * and a nested Timestamp byte for byte.
 *
 * Every document is spelled out here, never built through the code under test, so a change to what
 * the route writes is a visible diff. `fetch` is stubbed to THROW for the whole file: the route
 * makes no call outside the ERP, and every case ends by asserting that nothing called it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pedidoCollection } from '@delfrance/data/admin/collections';
import { respostaRotaEtiquetaLiSchema } from '@delfrance/schemas';

import { type DocData, FakeDb, asDb, grpc } from '../testing/fakeDb';
import {
  LiRotaEtiquetaEmConflitoError,
  MAX_TENTATIVAS_ROTA_ETIQUETA_LI,
  rotearEtiquetaLi,
} from './rotaEtiqueta';

const PEDIDO = 'pedido-li-rota';
const CAMINHO = `pedidos/${PEDIDO}`;
const CONTA = 'conta-li-rota';
const CONTA_REF = `documents/integracao/${CONTA}`;
const DOC_LI = `lojaIntegrada-${CONTA}`;
const CAMINHO_DOC_LI = `int_frete/${DOC_LI}`;
const REF_DOC_LI = `documents/${CAMINHO_DOC_LI}`;
const ME = 'me-1';
const MOTOBOY = 'motoboy-1';
const RETIRADA = 'retirada-1';
const ENDERECO = 'documents/clientes/cliente-1/enderecos/endereco-1';
/** A credential a Melhor Envio target holds: it must never ride along in an answer. */
const SEGREDO = 'segredo-do-melhor-envio-0123456789';

const PAC = { id: 141909, code: 'PAC', nome: 'Gateway A', tipo: 'Transportadora' } as const;
const MOTO = { id: 777, code: 'MOTO', nome: 'Entrega local', tipo: 'Motoboy' } as const;
const RETIRA = { id: 888, code: 'RETIRA', nome: 'Retirada na loja', tipo: 'Retirada' } as const;

/** A stored `mapa` row, the 7 keys the importer writes, mapped by hand. */
function linhaMapa(
  forma: { readonly id: number; readonly code: string },
  integracaoUid: string,
  targetTipoIntegracao: string,
  targetData: DocData | null = null,
): DocData {
  return {
    nomeOriginal: `forma ${forma.code}`,
    idOriginal: `${String(forma.id)}---${forma.code}`,
    observacao: 'Origem: Pedido 100',
    nomeTarget: null,
    targetData,
    integracaoUid,
    targetTipoIntegracao,
  };
}

/** The conta's Loja Integrada freight doc, with three mapped methods. */
function docLi(over: DocData = {}): DocData {
  return {
    tipo: 'lojaIntegrada',
    nome: 'Loja de teste',
    ativo: true,
    contaLojaIntegradaEnviosOuterRef: CONTA_REF,
    filialIntegracaoFreteOuterRef: 'documents/filiais/f1',
    mapa: [
      linhaMapa(PAC, ME, 'melhorEnvios', { id: 3 }),
      linhaMapa(MOTO, MOTOBOY, 'motoboy'),
      linhaMapa(RETIRA, RETIRADA, 'retiradaNaLoja'),
    ],
    ...over,
  };
}

const ALVOS: Readonly<Record<string, DocData>> = {
  [ME]: { tipo: 'melhorEnvios', nome: 'Melhor Envio A', ativo: true, tokenDeAcesso: SEGREDO },
  [MOTOBOY]: { tipo: 'motoboy', nome: 'Motoboy da loja', ativo: true },
  [RETIRADA]: { tipo: 'retiradaNaLoja', nome: 'Balcão', ativo: true },
};

/** A pedido's `freteInicial` as the importer leaves one still on the conta's doc. */
function frete(over: DocData = {}): DocData {
  return {
    estado: 'iniciado',
    integracaoFreteOuterRef: REF_DOC_LI,
    integracaoTargetOuterRef: null,
    externalOptionId: null,
    externalOptionIntegracao: null,
    externalOptionData: PAC,
    externalId: '987654',
    printLabelId: null,
    codRastreio: null,
    modalidade: '0',
    enderecoFreteOuterReference: ENDERECO,
    clienteRecebedorOuterReference: 'documents/clientes/cliente-1',
    valorCobrado: 25.9,
    custoFrete: 21.5,
    ...over,
  };
}

function pedido(over: DocData = {}, freteOver: DocData = {}): DocData {
  return {
    estado: 'pago',
    integracaoPedidoOuterRef: CONTA_REF,
    numero: '165',
    ultimaModificacao: 1_800_000_000_000_000,
    freteInicial: frete(freteOver),
    ...over,
  };
}

interface Semente {
  readonly pedido?: DocData | null;
  readonly docLi?: DocData | null;
  readonly alvos?: Readonly<Record<string, DocData>>;
}

function semear(db: FakeDb, s: Semente = {}): void {
  const doc = s.docLi === undefined ? docLi() : s.docLi;
  if (doc !== null) db.seed(CAMINHO_DOC_LI, doc);
  for (const [id, alvo] of Object.entries(s.alvos ?? ALVOS)) db.seed(`int_frete/${id}`, alvo);
  const p = s.pedido === undefined ? pedido() : s.pedido;
  if (p !== null) db.seed(CAMINHO, p);
}

function rotear(db: FakeDb, escolha: string | null = null) {
  return rotearEtiquetaLi({ db: asDb(db) }, PEDIDO, escolha);
}

/** The pedido through its admin handle — the same ref the route builds. */
function refPedido(db: FakeDb) {
  return pedidoCollection.docRef(asDb(db), {}, PEDIDO);
}

const refAlvo = (id: string) => `documents/int_frete/${id}`;

let db: FakeDb;
let fetchFalso: ReturnType<typeof vi.fn>;

beforeEach(() => {
  db = new FakeDb();
  fetchFalso = vi.fn(() => {
    throw new Error('a rota de etiqueta não chama nada fora do ERP');
  });
  vi.stubGlobal('fetch', fetchFalso);
});

afterEach(() => {
  expect(fetchFalso).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe('rotearEtiquetaLi — a route through the mapa', () => {
  it('a pago pedido on its Loja Integrada doc routes through its mapa row: ONE write, the raw block with only the routing keys replaced', async () => {
    semear(db);

    const r = await rotear(db);

    expect(r).toEqual({
      tipo: 'resposta',
      tentativas: 1,
      resposta: {
        tipo: 'roteado',
        alvo: { id: ME, tipo: 'melhorEnvios', nome: 'Melhor Envio A' },
        rota: {
          integracaoFreteOuterRef: refAlvo(ME),
          externalOptionId: '3',
          integracaoTargetOuterRef: null,
          estado: 'iniciado',
        },
      },
    });
    // Exactly one write anywhere, an `update` of the pedido carrying ONLY `freteInicial`.
    expect(db.escritas).toHaveLength(1);
    expect(db.escritasEm(CAMINHO)).toEqual([
      expect.objectContaining({
        verbo: 'update',
        dados: {
          freteInicial: frete({ integracaoFreteOuterRef: refAlvo(ME), externalOptionId: '3' }),
        },
      }),
    ]);
    // Nothing outside `freteInicial` moved — `ultimaModificacao` included — and inside it only the
    // two routing keys did: `valorCobrado`, the cost, `externalOptionData` (the mapa key),
    // `externalOptionIntegracao` and `codRastreio` are as they were.
    expect(db.ler(CAMINHO)).toEqual(
      pedido({}, { integracaoFreteOuterRef: refAlvo(ME), externalOptionId: '3' }),
    );
  });

  it('the answer is the shared wire contract, and never carries the target document', async () => {
    semear(db);

    const r = await rotear(db);

    if (r.tipo !== 'resposta') throw new Error('esperava uma resposta');
    expect(respostaRotaEtiquetaLiSchema.parse(r.resposta)).toEqual(r.resposta);
    expect(JSON.stringify(r)).not.toContain(SEGREDO);
    expect(JSON.stringify(r)).not.toContain(ENDERECO);
  });

  it('every read precedes the write, and nothing is read after it — at most the pedido, the Loja Integrada doc and the target', async () => {
    semear(db);
    let lidasAoEscrever: string[] = [];
    db.antesDaProximaEscrita(CAMINHO, () => {
      lidasAoEscrever = [...db.leituras];
    });

    await rotear(db);

    expect(lidasAoEscrever).toEqual([CAMINHO, CAMINHO_DOC_LI, `int_frete/${ME}`]);
    expect(db.leituras).toEqual(lidasAoEscrever);
  });

  it('⚠️ NEAR-MISS: the block is written back RAW, never re-parsed — an unmodelled key and an estado the schema does not know survive', async () => {
    const extras = {
      campoNaoModelado: { aninhado: [1, 'dois', { tres: null }] },
      integracao_path: 'int_frete/legado',
      estado: 'estadoQueOSchemaNaoConhece',
    };
    semear(db, { pedido: pedido({}, extras) });

    const r = await rotear(db);

    expect(db.ler(CAMINHO)?.freteInicial).toEqual(
      frete({ ...extras, integracaoFreteOuterRef: refAlvo(ME), externalOptionId: '3' }),
    );
    // The answer cannot carry an estado it does not know: `null`, never the raw string.
    expect(r).toMatchObject({ resposta: { rota: { estado: null } } });
  });

  it('EQUAL pair: the pedido’s conta ref in its bare form is the same conta as the Loja Integrada doc’s canonical back-ref', async () => {
    semear(db, { pedido: pedido({ integracaoPedidoOuterRef: `integracao/${CONTA}` }) });

    expect(await rotear(db)).toMatchObject({ resposta: { tipo: 'roteado' } });
    expect(db.escritasEm(CAMINHO)).toHaveLength(1);
  });
});

describe('rotearEtiquetaLi — every guard refuses with ZERO writes', () => {
  async function recusa(s: Semente, escolha: string | null = null): Promise<unknown> {
    semear(db, s);
    const r = await rotear(db, escolha);
    expect(db.escritas).toEqual([]);
    return r.tipo === 'resposta' ? r.resposta : r;
  }

  it.each(['carrinho', 'processandoCancelamento', 'cancelado', 'iniciado'])(
    '⚠️ NEAR-MISS: a pedido in estado %s ⇒ estado-nao-pago (only `pago` routes)',
    async (estado) => {
      expect(await recusa({ pedido: pedido({ estado }) })).toEqual({
        tipo: 'recusado',
        motivo: 'estado-nao-pago',
      });
    },
  );

  it('a bought label ⇒ etiqueta-ja-comprada; an EMPTY printLabelId names none and routes', async () => {
    expect(await recusa({ pedido: pedido({}, { printLabelId: 'etiqueta-1' }) })).toEqual({
      tipo: 'recusado',
      motivo: 'etiqueta-ja-comprada',
    });
    db = new FakeDb();
    semear(db, { pedido: pedido({}, { printLabelId: '' }) });
    expect(await rotear(db)).toMatchObject({ resposta: { tipo: 'roteado' } });
  });

  it('⚠️ NEAR-MISS: modalidade 9 ⇒ sem-frete; modalidade 1 routes', async () => {
    expect(await recusa({ pedido: pedido({}, { modalidade: '9' }) })).toEqual({
      tipo: 'recusado',
      motivo: 'sem-frete',
    });
    db = new FakeDb();
    semear(db, { pedido: pedido({}, { modalidade: '1' }) });
    expect(await rotear(db)).toMatchObject({ resposta: { tipo: 'roteado' } });
  });

  it('an INACTIVE Loja Integrada doc ⇒ doc-li-divergente; an absent `ativo` routes', async () => {
    expect(await recusa({ docLi: docLi({ ativo: false }) })).toEqual({
      tipo: 'recusado',
      motivo: 'doc-li-divergente',
    });
    const semAtivo = docLi();
    delete semAtivo.ativo;
    db = new FakeDb();
    semear(db, { docLi: semAtivo });
    expect(await rotear(db)).toMatchObject({ resposta: { tipo: 'roteado' } });
  });

  it('⚠️ NEAR-MISS: another conta’s Loja Integrada doc ⇒ doc-li-divergente', async () => {
    expect(
      await recusa({
        docLi: docLi({ contaLojaIntegradaEnviosOuterRef: `documents/integracao/${CONTA}2` }),
      }),
    ).toEqual({ tipo: 'recusado', motivo: 'doc-li-divergente' });
  });

  it('⚠️ NEAR-MISS: no endereço + a MOTOBOY target ⇒ sem-endereco', async () => {
    expect(
      await recusa({
        pedido: pedido({}, { enderecoFreteOuterReference: null, externalOptionData: MOTO }),
      }),
    ).toEqual({ tipo: 'recusado', motivo: 'sem-endereco' });
  });

  it('EQUAL pair: no endereço + a PICKUP target routes — the target needs no address', async () => {
    semear(db, {
      pedido: pedido({}, { enderecoFreteOuterReference: null, externalOptionData: RETIRA }),
    });

    expect(await rotear(db)).toMatchObject({
      resposta: {
        tipo: 'roteado',
        alvo: { id: RETIRADA, tipo: 'retiradaNaLoja' },
        rota: { integracaoFreteOuterRef: refAlvo(RETIRADA), externalOptionId: null },
      },
    });
    expect(db.escritasEm(CAMINHO)).toHaveLength(1);
  });

  it('the method unmapped ⇒ sem-mapeamento; the same id under another code is NOT the sibling row', async () => {
    expect(
      await recusa({ pedido: pedido({}, { externalOptionData: { ...PAC, code: 'SEDEX' } }) }),
    ).toEqual({ tipo: 'recusado', motivo: 'sem-mapeamento' });
  });

  it('a mapped target that is inactive ⇒ alvo-inativo; one that is gone ⇒ alvo-ausente', async () => {
    expect(await recusa({ alvos: { ...ALVOS, [ME]: { ...ALVOS[ME], ativo: false } } })).toEqual({
      tipo: 'recusado',
      motivo: 'alvo-inativo',
    });
    db = new FakeDb();
    const semMe = Object.fromEntries(Object.entries(ALVOS).filter(([id]) => id !== ME));
    expect(await recusa({ alvos: semMe })).toEqual({ tipo: 'recusado', motivo: 'alvo-ausente' });
  });

  it('nothing is read beyond the pedido and its freight doc before a refusal the two decide', async () => {
    await recusa({ pedido: pedido({ estado: 'carrinho' }) });
    expect(db.leituras).toEqual([CAMINHO, CAMINHO_DOC_LI]);
  });
});

describe('rotearEtiquetaLi — a pedido that is not on its Loja Integrada doc', () => {
  it.each([
    ['no ref', null],
    ['a ref to another collection', CONTA_REF],
    ['a naked id', DOC_LI],
  ])(
    '%s ⇒ sem-rota-li, with ONLY the pedido read (nothing of another collection is read)',
    async (_caso, ref) => {
      semear(db, { pedido: pedido({}, { integracaoFreteOuterRef: ref }) });

      expect(await rotear(db)).toEqual({
        tipo: 'resposta',
        tentativas: 1,
        resposta: { tipo: 'recusado', motivo: 'sem-rota-li' },
      });
      expect(db.leituras).toEqual([CAMINHO]);
      expect(db.escritas).toEqual([]);
    },
  );

  it.each([
    ['an absent doc', null],
    ['a marketplace’s freight doc', { tipo: 'shopee', nome: 'Shopee', ativo: true }],
  ])('a ref naming %s ⇒ sem-rota-li, with no write', async (_caso, doc) => {
    semear(db, { docLi: doc });

    expect(await rotear(db)).toMatchObject({
      resposta: { tipo: 'recusado', motivo: 'sem-rota-li' },
    });
    expect(db.leituras).toEqual([CAMINHO, CAMINHO_DOC_LI]);
    expect(db.escritas).toEqual([]);
  });

  it('a pedido that does not exist ⇒ pedido-nao-encontrado, after one read', async () => {
    semear(db, { pedido: null });

    expect(await rotear(db)).toEqual({ tipo: 'pedido-nao-encontrado', tentativas: 1 });
    expect(db.leituras).toEqual([CAMINHO]);
    expect(db.escritas).toEqual([]);
  });

  it.each([null, ME])(
    'already routed (the ref names a label target) ⇒ ja-roteado, NOTHING written — escolha %s',
    async (escolha) => {
      const roteado = { integracaoFreteOuterRef: `int_frete/${MOTOBOY}`, externalOptionId: null };
      semear(db, { pedido: pedido({}, roteado) });

      expect(await rotear(db, escolha)).toEqual({
        tipo: 'resposta',
        tentativas: 1,
        resposta: {
          tipo: 'ja-roteado',
          alvo: { id: MOTOBOY, tipo: 'motoboy', nome: 'Motoboy da loja' },
          // As FOUND, every ref canonical.
          rota: {
            integracaoFreteOuterRef: refAlvo(MOTOBOY),
            externalOptionId: null,
            integracaoTargetOuterRef: null,
            estado: 'iniciado',
          },
        },
      });
      expect(db.escritas).toEqual([]);
      // An escolha never re-points a routed pedido: there is no Loja Integrada doc to check.
      expect(db.leituras).toEqual([CAMINHO, `int_frete/${MOTOBOY}`]);
    },
  );

  it('already routed to a target that was deactivated since ⇒ still ja-roteado (the route stays)', async () => {
    semear(db, {
      pedido: pedido({}, { integracaoFreteOuterRef: refAlvo(MOTOBOY) }),
      alvos: { ...ALVOS, [MOTOBOY]: { ...ALVOS[MOTOBOY], ativo: false } },
    });

    expect(await rotear(db)).toMatchObject({ resposta: { tipo: 'ja-roteado' } });
    expect(db.escritas).toEqual([]);
  });
});

describe('rotearEtiquetaLi — the operator’s choice and the stored override', () => {
  it('an escolha WRITES integracaoTargetOuterRef beside the route; a mapa route never does', async () => {
    semear(db);

    const r = await rotear(db, MOTOBOY);

    const esperado = {
      integracaoFreteOuterRef: refAlvo(MOTOBOY),
      externalOptionId: null,
      integracaoTargetOuterRef: refAlvo(MOTOBOY),
    };
    expect(db.escritasEm(CAMINHO).map((e) => e.dados)).toEqual([{ freteInicial: frete(esperado) }]);
    expect(r).toMatchObject({
      resposta: {
        tipo: 'roteado',
        alvo: { id: MOTOBOY, tipo: 'motoboy' },
        rota: { ...esperado, estado: 'iniciado' },
      },
    });
    // Four reads at most: the pedido, its doc, the chosen target and the method row's own target.
    expect(db.leituras).toEqual([
      CAMINHO,
      CAMINHO_DOC_LI,
      `int_frete/${MOTOBOY}`,
      `int_frete/${ME}`,
    ]);
  });

  it('EQUAL pair: a hand-chosen Melhor Envio target takes the service of the method’s own Melhor Envio row — read ONCE when it is the target', async () => {
    semear(db);

    const r = await rotear(db, ME);

    expect(db.escritasEm(CAMINHO).map((e) => e.dados)).toEqual([
      {
        freteInicial: frete({
          integracaoFreteOuterRef: refAlvo(ME),
          externalOptionId: '3',
          integracaoTargetOuterRef: refAlvo(ME),
        }),
      },
    ]);
    expect(r).toMatchObject({ resposta: { rota: { externalOptionId: '3' } } });
    expect(db.leituras).toEqual([CAMINHO, CAMINHO_DOC_LI, `int_frete/${ME}`]);
  });

  it('⚠️ NEAR-MISS: a hand-chosen Melhor Envio target on a MOTOBOY method row ⇒ alvo-sem-servico, nothing written', async () => {
    semear(db, { pedido: pedido({}, { externalOptionData: MOTO }) });

    expect(await rotear(db, ME)).toMatchObject({
      resposta: { tipo: 'recusado', motivo: 'alvo-sem-servico' },
    });
    expect(db.escritas).toEqual([]);
  });

  it('a stored override (bare form) is honoured before the mapa, and left exactly as stored', async () => {
    const override = { integracaoTargetOuterRef: `int_frete/${MOTOBOY}` };
    semear(db, { pedido: pedido({}, override) });

    const r = await rotear(db);

    expect(db.escritasEm(CAMINHO).map((e) => e.dados)).toEqual([
      {
        freteInicial: frete({
          ...override,
          integracaoFreteOuterRef: refAlvo(MOTOBOY),
          externalOptionId: null,
        }),
      },
    ]);
    // The answer gives the override canonical.
    expect(r).toMatchObject({ resposta: { rota: { integracaoTargetOuterRef: refAlvo(MOTOBOY) } } });
  });

  it('⚠️ NEAR-MISS: an override naming another collection ⇒ override-invalido — the mapa is NOT consulted', async () => {
    semear(db, { pedido: pedido({}, { integracaoTargetOuterRef: `integracao/${MOTOBOY}` }) });

    expect(await rotear(db)).toMatchObject({
      resposta: { tipo: 'recusado', motivo: 'override-invalido' },
    });
    expect(db.escritas).toEqual([]);
    expect(db.leituras).toEqual([CAMINHO, CAMINHO_DOC_LI]);
  });
});

describe('rotearEtiquetaLi — the retirada hand-off (B9)', () => {
  it('a checked-out pedido routed to a PICKUP target moves to aguardandoRetirada in the same write', async () => {
    semear(db, { pedido: pedido({}, { externalOptionData: RETIRA, estado: 'checkFinalizado' }) });

    const r = await rotear(db);

    expect(db.escritasEm(CAMINHO).map((e) => e.dados)).toEqual([
      {
        freteInicial: frete({
          externalOptionData: RETIRA,
          integracaoFreteOuterRef: refAlvo(RETIRADA),
          externalOptionId: null,
          estado: 'aguardandoRetirada',
        }),
      },
    ]);
    expect(r).toMatchObject({ resposta: { rota: { estado: 'aguardandoRetirada' } } });
  });

  it.each([
    ['emSeparacao, to a pickup', RETIRA, 'emSeparacao'],
    ['checkFinalizado, to a motoboy', MOTO, 'checkFinalizado'],
  ])('⚠️ NEAR-MISS: %s ⇒ the estado stays', async (_caso, forma, estado) => {
    semear(db, { pedido: pedido({}, { externalOptionData: forma, estado }) });

    await rotear(db);

    const escrito = db.escritasEm(CAMINHO)[0]?.dados?.freteInicial as DocData | undefined;
    expect(escrito?.estado).toBe(estado);
  });
});

describe('rotearEtiquetaLi — a lost race re-reads and re-decides, never re-applies', () => {
  it('a label bought between our read and our write ⇒ 9 ⇒ the second attempt refuses etiqueta-ja-comprada', async () => {
    semear(db);
    const comEtiqueta = frete({ printLabelId: 'etiqueta-concorrente' });
    db.antesDaProximaEscrita(CAMINHO, async () => {
      await refPedido(db).update({ freteInicial: comEtiqueta });
    });

    expect(await rotear(db)).toEqual({
      tipo: 'resposta',
      tentativas: 2,
      resposta: { tipo: 'recusado', motivo: 'etiqueta-ja-comprada' },
    });
    // Only the concurrent write landed: the pedido still names its Loja Integrada doc.
    expect(db.escritasEm(CAMINHO).map((e) => e.dados)).toEqual([{ freteInicial: comEtiqueta }]);
    expect(db.ler(CAMINHO)?.freteInicial).toEqual(comEtiqueta);
  });

  it.each([null, ME])(
    'another tab routed it first ⇒ 9 ⇒ the second attempt answers ja-roteado — escolha %s',
    async (escolha) => {
      semear(db);
      const daOutraAba = frete({ integracaoFreteOuterRef: refAlvo(MOTOBOY) });
      db.antesDaProximaEscrita(CAMINHO, async () => {
        await refPedido(db).update({ freteInicial: daOutraAba });
      });

      expect(await rotear(db, escolha)).toMatchObject({
        tentativas: 2,
        resposta: { tipo: 'ja-roteado', alvo: { id: MOTOBOY } },
      });
      expect(db.ler(CAMINHO)?.freteInicial).toEqual(daOutraAba);
    },
  );

  it(`three straight losses ⇒ LiRotaEtiquetaEmConflitoError after ${String(MAX_TENTATIVAS_ROTA_ETIQUETA_LI)} attempts, ZERO landed writes of ours`, async () => {
    expect(MAX_TENTATIVAS_ROTA_ETIQUETA_LI).toBe(3);
    semear(db);
    // A writer that bumps the stamp before each of our writes (a fixture write: it consumes no
    // other hook, so each one lands in front of its own attempt).
    for (let i = 1; i <= 3; i += 1) {
      db.antesDaProximaEscrita(CAMINHO, () => {
        db.seed(CAMINHO, pedido({ observacoesInternas: `edição ${String(i)}` }));
      });
    }

    const err: unknown = await rotear(db).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(LiRotaEtiquetaEmConflitoError);
    expect(err).toMatchObject({ pedidoId: PEDIDO, tentativas: 3 });
    // Three attempts, each from its own read; none of our writes landed — the pedido is the
    // last concurrent edit, still on its Loja Integrada doc.
    expect(db.leituras.filter((c) => c === CAMINHO)).toHaveLength(3);
    expect(db.escritas).toEqual([]);
    expect(db.ler(CAMINHO)).toEqual(pedido({ observacoesInternas: 'edição 3' }));
  });

  it('the pedido removed between our read and our write ⇒ 9 ⇒ pedido-nao-encontrado, and it is never resurrected', async () => {
    semear(db);
    db.antesDaProximaEscrita(CAMINHO, async () => {
      await refPedido(db).delete();
    });

    expect(await rotear(db)).toEqual({ tipo: 'pedido-nao-encontrado', tentativas: 2 });
    expect(db.ler(CAMINHO)).toBeUndefined();
  });

  it('a NOT_FOUND (5) is handled exactly like a 9: re-read, re-decide', async () => {
    semear(db);
    db.antesDaProximaEscrita(CAMINHO, () => {
      throw grpc(5, 'NOT_FOUND');
    });

    expect(await rotear(db)).toMatchObject({ tentativas: 2, resposta: { tipo: 'roteado' } });
    expect(db.escritasEm(CAMINHO)).toHaveLength(1);
  });

  it('any other failure is rethrown untouched, after ONE attempt, with nothing written', async () => {
    semear(db);
    const indisponivel = grpc(14, 'UNAVAILABLE');
    db.antesDaProximaEscrita(CAMINHO, () => {
      throw indisponivel;
    });

    await expect(rotear(db)).rejects.toBe(indisponivel);
    expect(db.leituras.filter((c) => c === CAMINHO)).toHaveLength(1);
    expect(db.escritas).toEqual([]);
  });
});
