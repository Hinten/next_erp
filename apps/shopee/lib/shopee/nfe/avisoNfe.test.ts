import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CANAL_AVISO,
  ESTADO_FRETE,
  ESTADOS_FRETE_REMOVE_ESTOQUE,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  type EstadoFrete,
} from '@delfrance/schemas';

// ⚠️ The REAL `escreverAviso` / `resolverAviso` over the shared fake Firestore,
// never a mock of them — the property under test is the PLANO this producer
// hands over (which fields it states, which it OMITS), and a mocked writer
// cannot show that. `avisos/reservaTravada.test.ts` is the harness precedent.
import { SHOPEE_ORDER_STATUS } from '../pedidos/orderStatusMaps';
import { FakeDb, asDb, grpc, increment } from '../testing/fakeDb';
import {
  RESOLUCAO_AVISO_NFE_SHOPEE,
  avisarNfeShopee,
  chaveAvisoNfeShopee,
  resolverAvisoNfeSeEncerrado,
  resolverAvisoNfeShopee,
  type EventoAvisoNfeShopee,
} from './avisoNfe';
import {
  FRASE_DO_MOTIVO_NFE,
  MOTIVO_NFE_SHOPEE,
  MOTIVOS_QUE_AVISAM,
  fraseDoErroDoAviso,
  type MotivoNfeShopee,
} from './errosNfe';

/* -------------------------------------------------------------------------- */
/*  Fixtures — invented ids only. Never a real conta, order, key or CNPJ.      */
/* -------------------------------------------------------------------------- */

const AGORA_MS = 1_789_000_000_000;
const INTEGRACAO = 'int-1';
/** A 64-hex digest shape, like `makePedidoIdShopee`'s output. Fixture only. */
const PEDIDO_ID = 'a'.repeat(64);
const ORDER_SN = '260910KJBHUJDM';

const CHAVE = chaveAvisoNfeShopee(INTEGRACAO, PEDIDO_ID);
const PATH = `avisos/${CHAVE}`;

const deps = (nowMs = AGORA_MS) => ({ increment, nowMs });

/**
 * A SYNTHETIC access key, visibly fake: cUF `99` (no such UF), a CNPJ of
 * repeated digits, model 55. Same recipe as `notaNaShopee.test.ts`.
 */
function montarChave(cnpj = '11111111111111', nNF = '000000001'): string {
  return `99${'2609'}${cnpj}55${'000'}${nNF}1${'00000000'}0`;
}

function evento(over: Partial<EventoAvisoNfeShopee> = {}): EventoAvisoNfeShopee {
  return {
    integracaoId: INTEGRACAO,
    pedidoId: PEDIDO_ID,
    numero: ORDER_SN,
    motivo: MOTIVO_NFE_SHOPEE.cnpjDivergente,
    excerto: null,
    ...over,
  };
}

function armazenado(db: FakeDb): Record<string, unknown> {
  return db.store[PATH]?.data ?? {};
}

function paramsDe(db: FakeDb): Record<string, unknown> {
  return (armazenado(db).params ?? {}) as Record<string, unknown>;
}

/* -------------------------------------------------------------------------- */
/*  (1) a chave                                                                */
/* -------------------------------------------------------------------------- */

describe('1 — a chave', () => {
  it('é nfeUploadRejeitado:<conta>:<pedido>, sem janela e sem id de NF-e', () => {
    expect(CHAVE).toBe(`${TIPO_AVISO.nfeUploadRejeitado}:${INTEGRACAO}:${PEDIDO_ID}`);
    expect(CHAVE.split(':')).toHaveLength(3);
  });

  it('PAR IGUAL: duas NF-e (dois slots) do MESMO pedido caem na MESMA linha — mutante 54', async () => {
    // ⚠️ Uma chave por NF-e deixaria a linha que a nota cancelada abriu de pé
    // depois que a substituta validou: o resolvedor calcularia a chave da NOVA
    // nota, que nunca foi criada. Duas recusas do mesmo pedido, vindas de duas
    // notas diferentes, são UMA linha com duas ocorrências.
    const db = new FakeDb();

    const primeira = await avisarNfeShopee(asDb(db), evento(), deps());
    const segunda = await avisarNfeShopee(
      asDb(db),
      evento({ motivo: MOTIVO_NFE_SHOPEE.nfeCancelada }),
      deps(AGORA_MS + 60_000),
    );

    expect(primeira).toBe('criado');
    expect(segunda).toBe('repetido');
    expect(Object.keys(db.store)).toEqual([PATH]);
    expect(armazenado(db)).toMatchObject({
      ocorrencias: 2,
      // A recusa mais nova é a que o operador lê.
      motivo: MOTIVO_NFE_SHOPEE.nfeCancelada,
      criadoEm: AGORA_MS * 1000,
      atualizadoEm: (AGORA_MS + 60_000) * 1000,
    });
    expect(paramsDe(db).erro).toBe(FRASE_DO_MOTIVO_NFE['nfe-cancelada']);
  });

  it('QUASE-ERRO: outro pedido ou outra conta são linhas DIFERENTES', () => {
    expect(chaveAvisoNfeShopee(INTEGRACAO, 'b'.repeat(64))).not.toBe(CHAVE);
    expect(chaveAvisoNfeShopee('int-2', PEDIDO_ID)).not.toBe(CHAVE);
  });
});

/* -------------------------------------------------------------------------- */
/*  (2) a escrita                                                              */
/* -------------------------------------------------------------------------- */

describe('2 — a escrita', () => {
  it('severidade atencao, canal shopee, motivo kebab, rota /pedidos/<id>/editar', async () => {
    const db = new FakeDb();

    await avisarNfeShopee(asDb(db), evento(), deps());

    expect(armazenado(db)).toMatchObject({
      tipo: TIPO_AVISO.nfeUploadRejeitado,
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.shopee,
      motivo: MOTIVO_NFE_SHOPEE.cnpjDivergente,
      // ⚠️ `/pedidos/[id]` cru NÃO é navegável — o builder responde `…/editar`.
      urlInterna: { rota: `/pedidos/${PEDIDO_ID}/editar`, campo: null },
      ocorrencias: 1,
      resolvidoEm: null,
    });
  });

  it('params são EXATAMENTE { pedido, erro } — nenhum `codigo` da Shopee', async () => {
    const db = new FakeDb();

    await avisarNfeShopee(asDb(db), evento(), deps());

    const params = paramsDe(db);
    expect(Object.keys(params).sort()).toEqual(['erro', 'pedido']);
    expect(params.pedido).toBe(ORDER_SN);
    expect(params.erro).toBe(fraseDoErroDoAviso(MOTIVO_NFE_SHOPEE.cnpjDivergente, null));
  });

  it('o relógio de evento nunca é enviado, nem o prazo — mutante 55', async () => {
    // ⚠️ O guard do `escreverAviso` é `<=`: um relógio IGUAL ao guardado
    // descartaria a repetição como `ignorado`. A criação preenche todo opcional,
    // então a omissão só aparece no PATCH cru da repetição.
    const db = new FakeDb();

    await avisarNfeShopee(asDb(db), evento(), deps());
    const repetida = await avisarNfeShopee(asDb(db), evento(), deps());

    // Mesmo instante, mesma recusa: uma REPETIÇÃO, nunca um `ignorado`.
    expect(repetida).toBe('repetido');
    expect(armazenado(db).ocorrencias).toBe(2);
    const patch = db.patches.at(-1)?.patch ?? {};
    expect('relogioEvento' in patch).toBe(false);
    expect('prazo' in patch).toBe(false);
    expect(armazenado(db).relogioEvento).toBeNull();
    expect(armazenado(db).prazo).toBeNull();
  });

  it('um motivo FORA de MOTIVOS_QUE_AVISAM é recusado com RangeError, e nada é escrito', async () => {
    const db = new FakeDb();
    const foraDoConjunto: MotivoNfeShopee[] = [
      MOTIVO_NFE_SHOPEE.contaInativa,
      MOTIVO_NFE_SHOPEE.nfeValidada,
      MOTIVO_NFE_SHOPEE.pedidoInexistenteNoCanal,
      MOTIVO_NFE_SHOPEE.limiteDeTaxa,
    ];

    for (const motivo of foraDoConjunto) {
      // ÂNCORA: o caso só significa algo se o motivo estiver mesmo fora do conjunto.
      expect(MOTIVOS_QUE_AVISAM.has(motivo)).toBe(false);
      await expect(avisarNfeShopee(asDb(db), evento({ motivo }), deps())).rejects.toBeInstanceOf(
        RangeError,
      );
    }
    expect(db.writes).toEqual([]);
    expect(db.caminhos).toEqual([]);
  });

  it('todo membro de MOTIVOS_QUE_AVISAM é aceito e grava a sua frase', async () => {
    for (const motivo of MOTIVOS_QUE_AVISAM) {
      const db = new FakeDb();
      await expect(avisarNfeShopee(asDb(db), evento({ motivo }), deps())).resolves.toBe('criado');
      expect(armazenado(db).motivo).toBe(motivo);
      expect(paramsDe(db).erro).toBe(fraseDoErroDoAviso(motivo, null));
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  (3) o excerto da Shopee                                                    */
/* -------------------------------------------------------------------------- */

describe('3 — o excerto da Shopee', () => {
  const chave = montarChave();
  const excertoCru = `Rejeicao 539: Duplicidade de NF-e, com diferenca na Chave de Acesso [chNFe:${chave}]`;

  it('sefaz-pendente carrega o excerto RE-SANITIZADO: o cStat fica, a chave some', async () => {
    const db = new FakeDb();

    await avisarNfeShopee(
      asDb(db),
      evento({ motivo: MOTIVO_NFE_SHOPEE.sefazPendente, excerto: excertoCru }),
      deps(),
    );

    const erro = String(paramsDe(db).erro);
    expect(erro).toBe(fraseDoErroDoAviso(MOTIVO_NFE_SHOPEE.sefazPendente, excertoCru));
    expect(erro.startsWith(`${FRASE_DO_MOTIVO_NFE['sefaz-pendente']}: `)).toBe(true);
    expect(erro).toContain('539');
    expect(erro).not.toContain(chave);
    expect(erro).not.toContain('11111111111111');
    // Nada do texto cru atravessa para outro campo do documento.
    expect(JSON.stringify(armazenado(db))).not.toContain(chave);
  });

  it('QUASE-ERRO: cnpj-divergente com o MESMO excerto não carrega texto nenhum da Shopee', async () => {
    const db = new FakeDb();

    await avisarNfeShopee(
      asDb(db),
      evento({ motivo: MOTIVO_NFE_SHOPEE.cnpjDivergente, excerto: excertoCru }),
      deps(),
    );

    expect(paramsDe(db).erro).toBe(FRASE_DO_MOTIVO_NFE['cnpj-divergente']);
    expect(JSON.stringify(armazenado(db))).not.toContain('Rejeicao');
    expect(JSON.stringify(armazenado(db))).not.toContain('539');
  });

  it('sefaz-pendente SEM excerto grava só a frase, sem `: ` pendurado', async () => {
    const db = new FakeDb();

    await avisarNfeShopee(asDb(db), evento({ motivo: MOTIVO_NFE_SHOPEE.sefazPendente }), deps());

    expect(paramsDe(db).erro).toBe(FRASE_DO_MOTIVO_NFE['sefaz-pendente']);
  });
});

/* -------------------------------------------------------------------------- */
/*  (4) o resolvedor do passo 14                                               */
/* -------------------------------------------------------------------------- */

describe('4 — resolverAvisoNfeShopee', () => {
  it('fecha uma linha ABERTA, grava o motivo da resolução e responde true', async () => {
    const db = new FakeDb();
    await avisarNfeShopee(asDb(db), evento(), deps());

    const r = await resolverAvisoNfeShopee(
      asDb(db),
      INTEGRACAO,
      PEDIDO_ID,
      RESOLUCAO_AVISO_NFE_SHOPEE.nfeValidada,
      { nowMs: AGORA_MS + 1000 },
    );

    expect(r).toBe(true);
    expect(armazenado(db)).toMatchObject({
      resolvidoEm: (AGORA_MS + 1000) * 1000,
      resolucaoMotivo: 'nfe-validada',
    });
  });

  it('linha AUSENTE ⇒ false e ZERO escritas', async () => {
    const db = new FakeDb();

    const r = await resolverAvisoNfeShopee(
      asDb(db),
      INTEGRACAO,
      PEDIDO_ID,
      RESOLUCAO_AVISO_NFE_SHOPEE.nfeValidada,
      { nowMs: AGORA_MS },
    );

    expect(r).toBe(false);
    expect(db.writes).toEqual([]);
  });

  it('linha JÁ resolvida ⇒ false, e `resolvidoEm` não é re-carimbado', async () => {
    const db = new FakeDb();
    await avisarNfeShopee(asDb(db), evento(), deps());
    await resolverAvisoNfeShopee(
      asDb(db),
      INTEGRACAO,
      PEDIDO_ID,
      RESOLUCAO_AVISO_NFE_SHOPEE.nfeValidada,
      { nowMs: AGORA_MS + 1000 },
    );
    const escritas = db.writes.length;

    const r = await resolverAvisoNfeShopee(
      asDb(db),
      INTEGRACAO,
      PEDIDO_ID,
      RESOLUCAO_AVISO_NFE_SHOPEE.freteDespachado,
      { nowMs: AGORA_MS + 9000 },
    );

    expect(r).toBe(false);
    expect(db.writes).toHaveLength(escritas);
    expect(armazenado(db).resolvidoEm).toBe((AGORA_MS + 1000) * 1000);
  });

  it('os três motivos de resolução são os slugs persistidos', () => {
    expect(RESOLUCAO_AVISO_NFE_SHOPEE).toEqual({
      nfeValidada: 'nfe-validada',
      freteDespachado: 'frete-despachado',
      pedidoCancelado: 'pedido-cancelado',
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  (5) o gancho entre passos                                                  */
/* -------------------------------------------------------------------------- */

async function comAvisoAberto(): Promise<FakeDb> {
  const db = new FakeDb();
  await avisarNfeShopee(asDb(db), evento(), deps());
  db.caminhos.length = 0;
  db.opLog.length = 0;
  db.writes.length = 0;
  return db;
}

function encerramento(over: {
  estadoFreteEscrito?: EstadoFrete | null;
  orderStatus?: string | null;
}): Parameters<typeof resolverAvisoNfeSeEncerrado>[1] {
  return {
    integracaoId: INTEGRACAO,
    pedidoId: PEDIDO_ID,
    estadoFreteEscrito: over.estadoFreteEscrito ?? null,
    orderStatus: over.orderStatus ?? null,
  };
}

describe('5 — resolverAvisoNfeSeEncerrado (tabela-verdade)', () => {
  it('frete ESCRITO no conjunto de remoção ⇒ resolve `frete-despachado`', async () => {
    const db = await comAvisoAberto();

    const r = await resolverAvisoNfeSeEncerrado(
      asDb(db),
      encerramento({ estadoFreteEscrito: ESTADO_FRETE.postado }),
      { nowMs: AGORA_MS + 1000 },
    );

    expect(r).toBe(true);
    expect(armazenado(db).resolucaoMotivo).toBe('frete-despachado');
  });

  it('PAR IGUAL: TODO membro do conjunto de remoção resolve', async () => {
    for (const estado of ESTADOS_FRETE_REMOVE_ESTOQUE) {
      const db = await comAvisoAberto();
      await expect(
        resolverAvisoNfeSeEncerrado(asDb(db), encerramento({ estadoFreteEscrito: estado }), {
          nowMs: AGORA_MS + 1000,
        }),
      ).resolves.toBe(true);
    }
  });

  it('QUASE-ERRO: um estado FORA do conjunto (inclusive `error` e `cancelado`) não resolve e não LÊ nada', async () => {
    const fora: EstadoFrete[] = [
      ESTADO_FRETE.despachoAutorizado,
      ESTADO_FRETE.aguardandoNFe,
      ESTADO_FRETE.emSeparacao,
      ESTADO_FRETE.error,
      ESTADO_FRETE.cancelado,
    ];
    for (const estado of fora) {
      // ÂNCORA: o caso só significa algo se o estado estiver mesmo fora.
      expect(ESTADOS_FRETE_REMOVE_ESTOQUE.has(estado)).toBe(false);
      const db = await comAvisoAberto();

      const r = await resolverAvisoNfeSeEncerrado(
        asDb(db),
        encerramento({ estadoFreteEscrito: estado, orderStatus: SHOPEE_ORDER_STATUS.shipped }),
        { nowMs: AGORA_MS + 1000 },
      );

      expect(r).toBe(false);
      expect(db.opLog).toEqual([]);
      expect(db.caminhos).toEqual([]);
      expect(armazenado(db).resolvidoEm).toBeNull();
    }
  });

  it('order CANCELLED (a constante do importador) ⇒ resolve `pedido-cancelado`, mesmo sem frete escrito', async () => {
    const db = await comAvisoAberto();

    const r = await resolverAvisoNfeSeEncerrado(
      asDb(db),
      encerramento({ orderStatus: SHOPEE_ORDER_STATUS.cancelled }),
      { nowMs: AGORA_MS + 1000 },
    );

    expect(r).toBe(true);
    expect(armazenado(db).resolucaoMotivo).toBe('pedido-cancelado');
  });

  it('QUASE-ERRO: IN_CANCEL, `cancelled` minúsculo e um CANCELLED com espaço NÃO resolvem e não leem nada', async () => {
    for (const orderStatus of [
      SHOPEE_ORDER_STATUS.inCancel,
      'cancelled',
      ` ${SHOPEE_ORDER_STATUS.cancelled}`,
      SHOPEE_ORDER_STATUS.toReturn,
    ]) {
      const db = await comAvisoAberto();

      const r = await resolverAvisoNfeSeEncerrado(asDb(db), encerramento({ orderStatus }), {
        nowMs: AGORA_MS + 1000,
      });

      expect(r, orderStatus).toBe(false);
      expect(db.opLog).toEqual([]);
    }
  });

  it('frete no conjunto E order cancelada ⇒ UMA resolução, `frete-despachado`', async () => {
    const db = await comAvisoAberto();

    const r = await resolverAvisoNfeSeEncerrado(
      asDb(db),
      encerramento({
        estadoFreteEscrito: ESTADO_FRETE.devolvido,
        orderStatus: SHOPEE_ORDER_STATUS.cancelled,
      }),
      { nowMs: AGORA_MS + 1000 },
    );

    expect(r).toBe(true);
    expect(armazenado(db).resolucaoMotivo).toBe('frete-despachado');
    expect(db.writes).toHaveLength(1);
  });

  it('nada a encerrar (frete null, status null) ⇒ false e ZERO leituras', async () => {
    const db = await comAvisoAberto();

    const r = await resolverAvisoNfeSeEncerrado(asDb(db), encerramento({}), { nowMs: AGORA_MS });

    expect(r).toBe(false);
    expect(db.opLog).toEqual([]);
    expect(db.caminhos).toEqual([]);
  });

  it('sem aviso aberto ⇒ false, UMA leitura e ZERO escritas', async () => {
    const db = new FakeDb();

    const r = await resolverAvisoNfeSeEncerrado(
      asDb(db),
      encerramento({ estadoFreteEscrito: ESTADO_FRETE.entregue }),
      { nowMs: AGORA_MS },
    );

    expect(r).toBe(false);
    expect(db.opLog).toEqual([{ op: 'get', path: PATH }]);
    expect(db.writes).toEqual([]);
  });

  it('⚠️ uma falha do Firestore na resolução SOBE — nada a engole (mutante 57)', async () => {
    const db = await comAvisoAberto();
    const falha = grpc(14, 'UNAVAILABLE');
    db.falhasDeUpdate.set(PATH, falha);

    await expect(
      resolverAvisoNfeSeEncerrado(
        asDb(db),
        encerramento({ estadoFreteEscrito: ESTADO_FRETE.postado }),
        { nowMs: AGORA_MS + 1000 },
      ),
    ).rejects.toBe(falha);
    expect(armazenado(db).resolvidoEm).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*  (6) o texto-fonte                                                          */
/* -------------------------------------------------------------------------- */

describe('6 — o texto-fonte do módulo', () => {
  const fonte = readFileSync(fileURLToPath(new URL('./avisoNfe.ts', import.meta.url)), 'utf8');

  it('não importa nada de `pedidos/` — a dependência é de mão única (o gancho importa ESTE módulo)', () => {
    // ÂNCORA: o módulo importa outras pastas, então o negativo não é vácuo.
    expect(fonte).toMatch(/from '\.\.\/avisos\/autorizacao'/);
    expect(fonte).not.toMatch(/from '\.\.\/pedidos\//);
  });

  it('não converte relógio nem lê o relógio, e nunca nomeia o relógio de evento', () => {
    for (const proibido of [
      'relogioEvento',
      'millisToMicros',
      'Date.now(',
      'new Date()',
      'runTransaction',
    ]) {
      expect(fonte, proibido).not.toContain(proibido);
    }
  });

  it('o único token de status comparado é o CANCELLED do importador', () => {
    // O literal existe exatamente uma vez, e é o mesmo valor da tabela do
    // importador — a tabela-verdade acima o dirige por ela.
    expect(fonte.match(/'CANCELLED'/g)).toHaveLength(1);
    expect(SHOPEE_ORDER_STATUS.cancelled).toBe('CANCELLED');
  });
});
