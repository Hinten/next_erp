import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CANAL_AVISO, SEVERIDADE_AVISO, TIPO_AVISO } from '@delfrance/schemas';

// ⚠️ The REAL `escreverAviso` / `resolverAviso` over the shared fake Firestore,
// never a mock of them: the property under test is the PLANO this producer hands
// over — which fields it states, which it deliberately OMITS — and a mocked
// writer cannot show that. `avisos/pushSaude.test.ts` is the harness precedent.
import { VEREDITO_RESERVA_TRAVADA } from '../pedidos/reservaTravadaMapping';
import { FakeDb, asDb, increment } from '../testing/fakeDb';
import {
  type EventoReservaTravada,
  type SituacaoReservaTravadaArgs,
  MOTIVO_RESOLUCAO_RESERVA_TRAVADA,
  SITUACAO_MAX,
  avisarReservaTravada,
  chaveReservaTravada,
  pedidoIdDaChaveReservaTravada,
  resolverReservaTravada,
  situacaoReservaTravada,
} from './reservaTravada';

const AGORA_MS = 1_760_000_000_000;
const DIA_MS = 86_400_000;

const INTEGRACAO = 'int-1';
/** A 64-hex digest shape, like `makePedidoIdShopee`'s output. Fixture only. */
const PEDIDO_ID = 'a'.repeat(64);
const ORDER_SN = '260910KJBHUJDM';

const CHAVE = chaveReservaTravada(INTEGRACAO, PEDIDO_ID);
const PATH = `avisos/${CHAVE}`;

const deps = (nowMs = AGORA_MS) => ({ increment, nowMs });

function evento(over: Partial<EventoReservaTravada> = {}): EventoReservaTravada {
  return {
    veredito: VEREDITO_RESERVA_TRAVADA.aindaNaoPago,
    pedidoId: PEDIDO_ID,
    integracaoId: INTEGRACAO,
    numero: ORDER_SN,
    orderStatus: 'UNPAID',
    pendingTerms: null,
    motivoInexistente: null,
    idadeDias: 12,
    ...over,
  };
}

function paramsDe(db: FakeDb): Record<string, string> {
  return (db.store[PATH]?.data.params ?? {}) as Record<string, string>;
}

/* -------------------------------------------------------------------------- */
/*  (1) a chave                                                                */
/* -------------------------------------------------------------------------- */

describe('1 — a chave', () => {
  it('a chave é pedidoPrecisaDecisao:<conta>:<pedido>, sem janela', async () => {
    // ⚠️ Uma janela semanal criaria um documento NOVO toda segunda-feira, cada um
    // de pé até a retenção, e `ocorrencias` nunca sairia de 1 — apagando a única
    // memória entre ticks que este desenho tem.
    expect(CHAVE).toBe(`${TIPO_AVISO.pedidoPrecisaDecisao}:${INTEGRACAO}:${PEDIDO_ID}`);
    expect(CHAVE.split(':')).toHaveLength(3);

    // E é a MESMA chave que `escreverAviso` deriva do plano — uma definição só.
    const db = new FakeDb();
    const { chave } = await avisarReservaTravada(asDb(db), evento(), deps());
    expect(chave).toBe(CHAVE);
    expect(Object.keys(db.store)).toEqual([PATH]);

    // QUASE-ERRO: a dedup não pode atravessar integrações nem pedidos.
    expect(chaveReservaTravada('int-2', PEDIDO_ID)).not.toBe(CHAVE);
    expect(chaveReservaTravada(INTEGRACAO, 'b'.repeat(64))).not.toBe(CHAVE);
  });

  it('pedidoIdDaChaveReservaTravada faz a volta e recusa as quase-iguais', () => {
    expect(pedidoIdDaChaveReservaTravada(CHAVE)).toBe(PEDIDO_ID);

    // ⚠️ Este parser é o ÚNICO filtro de "esta linha é nossa" da passada (b), e a
    // página que ela varre carrega TODA linha aberta de TODO tipo e canal — não
    // existe índice que discrimine. Um parser frouxo resolveria linha alheia numa
    // coleção `serverOwned` que ninguém desfaz à mão.
    const tipo = TIPO_AVISO.pedidoPrecisaDecisao;
    const quaseIguais = [
      // quatro partes: um produtor futuro que adotou uma `janela`.
      `${tipo}:${INTEGRACAO}:${PEDIDO_ID}:2026-W38`,
      // outro tipo, mesma forma.
      `${TIPO_AVISO.shopeeAutorizacaoExpirando}:${INTEGRACAO}:${PEDIDO_ID}`,
      // duas partes.
      `${tipo}:${PEDIDO_ID}`,
      // uma parte só, e a string vazia.
      tipo,
      '',
      // três partes, mas com um segmento vazio: não é uma chave que escrevemos.
      `${tipo}::${PEDIDO_ID}`,
      `${tipo}:${INTEGRACAO}:`,
    ];
    for (const chave of quaseIguais) {
      expect(pedidoIdDaChaveReservaTravada(chave)).toBeNull();
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  (2) a escrita                                                              */
/* -------------------------------------------------------------------------- */

describe('2 — a escrita', () => {
  it('o aviso é escrito UMA vez e a segunda escrita incrementa ocorrencias sem mover criadoEm', async () => {
    const db = new FakeDb();

    const primeira = await avisarReservaTravada(asDb(db), evento(), deps());
    const segunda = await avisarReservaTravada(
      asDb(db),
      evento({ idadeDias: 19 }),
      deps(AGORA_MS + 7 * DIA_MS),
    );

    expect(primeira.resultado).toBe('criado');
    expect(segunda.resultado).toBe('repetido');
    expect(Object.keys(db.store)).toEqual([PATH]);

    // `ocorrencias` sobe por sentinela de incremento, não por leitura-e-escrita.
    const patch = db.patches.at(-1)?.patch ?? {};
    expect(patch.ocorrencias).toEqual(increment(1));

    expect(db.store[PATH]?.data).toMatchObject({
      // ⚠️ `criadoEm` NÃO se move num repeat: um aviso recorrente sobre o mesmo
      // problema pendente não pode re-alertar — é para isso que a dedup existe.
      criadoEm: AGORA_MS * 1000,
      atualizadoEm: (AGORA_MS + 7 * DIA_MS) * 1000,
      ocorrencias: 2,
      resolvidoEm: null,
    });
    // A situação acompanha a idade — é por isso que nenhum relógio de evento pode
    // ser enviado: com um, a segunda tick seria `ignorado` e o texto congelaria.
    expect(paramsDe(db).situacao).toContain('há 19 dia(s)');
  });

  it('relogioEvento nunca é enviado', async () => {
    // ⚠️ O guard do `escreverAviso` é `<=`, e o resíduo é POR DEFINIÇÃO a
    // população cujo `update_time` parou de andar: mandar o relógio da Shopee
    // congelaria `ocorrencias` em 1, `atualizadoEm` e a idade no texto — tudo em
    // silêncio. A CRIAÇÃO preenche todo opcional (o documento tem de ser
    // completo), então a omissão só é visível no PATCH cru do repeat.
    const db = new FakeDb();

    await avisarReservaTravada(asDb(db), evento(), deps());
    await avisarReservaTravada(asDb(db), evento(), deps(AGORA_MS + 7 * DIA_MS));

    const patch = db.patches.at(-1)?.patch ?? {};
    expect('relogioEvento' in patch).toBe(false);
    expect('prazo' in patch).toBe(false);
    expect('destinatarioUid' in patch).toBe(false);
    // E o documento criado carrega os três em `null`, nunca um número nem um uid.
    expect(db.store[PATH]?.data.relogioEvento).toBeNull();
    expect(db.store[PATH]?.data.prazo).toBeNull();
    expect(db.store[PATH]?.data.destinatarioUid).toBeNull();
  });

  it('params carregam só pedido e situacao, e nenhum dado do comprador', async () => {
    const db = new FakeDb();
    // Uma linha de fixture que TAMBÉM carrega campos com cara de comprador ao
    // lado: nada disso pode atravessar para o plano.
    const linha = {
      comprador: { username: 'comprador_fixture', telefone: 'fone_fixture' },
      evento: evento({ pendingTerms: ['ARRANGE_SHIPMENT_PENDING'] }),
    };

    await avisarReservaTravada(asDb(db), linha.evento, deps());

    const params = paramsDe(db);
    expect(Object.keys(params).sort()).toEqual(['pedido', 'situacao']);
    expect(params.pedido).toBe(ORDER_SN);
    const gravado = JSON.stringify(db.store[PATH]?.data);
    expect(gravado).not.toContain('comprador_fixture');
    expect(gravado).not.toContain('fone_fixture');
  });

  it('severidade atencao, canal shopee, rota /pedidos/<id>/editar', async () => {
    const db = new FakeDb();

    await avisarReservaTravada(asDb(db), evento(), deps());

    expect(db.store[PATH]?.data).toMatchObject({
      tipo: TIPO_AVISO.pedidoPrecisaDecisao,
      // `critico` é a única faixa que escala para fora do app; uma reserva presa
      // é uma venda bloqueada, então também não é `informativo`.
      severidade: SEVERIDADE_AVISO.atencao,
      canal: CANAL_AVISO.shopee,
      // ⚠️ `/pedidos/[id]` cru NÃO é navegável — o builder responde `…/editar`.
      urlInterna: { rota: `/pedidos/${PEDIDO_ID}/editar`, campo: null },
      ocorrencias: 1,
    });
  });

  it('a mensagem do apps/web lê exatamente pedido e situacao', async () => {
    // `apps/web/lib/avisos/mensagens.ts:80-84` renderiza
    // `O pedido {pedido} precisa de uma decisão manual: {situacao}.`
    // `apps/shopee` NÃO tem aresta de dependência para `apps/web` (e nenhuma é
    // possível), então os dois nomes ficam presos aqui como literais, do mesmo
    // jeito que `autorizacao.test.ts` prende `loja` e `dias`.
    const db = new FakeDb();
    await avisarReservaTravada(asDb(db), evento(), deps());

    const params = paramsDe(db);
    expect(Object.keys(params).sort()).toEqual(['pedido', 'situacao']);
    expect(typeof params.pedido).toBe('string');
    expect(typeof params.situacao).toBe('string');
    // E a situação é um FRAGMENTO minúsculo sem ponto final: ela entra no meio da
    // frase renderizada, logo depois de "decisão manual: ".
    expect(params.situacao?.endsWith('.')).toBe(false);
    expect(params.situacao?.[0]).toBe(params.situacao?.[0]?.toLowerCase());
  });
});

/* -------------------------------------------------------------------------- */
/*  (3) a situação                                                             */
/* -------------------------------------------------------------------------- */

interface CasoSituacao {
  readonly nome: string;
  readonly args: SituacaoReservaTravadaArgs;
  readonly contem: readonly string[];
  readonly naoContem: readonly string[];
}

const CASOS: readonly CasoSituacao[] = [
  {
    nome: 'ainda-nao-pago (UNPAID)',
    args: {
      veredito: VEREDITO_RESERVA_TRAVADA.aindaNaoPago,
      orderStatus: 'UNPAID',
      pendingTerms: null,
      motivoInexistente: null,
      idadeDias: 12,
    },
    contem: ['"UNPAID"', 'há 12 dia(s)', 'sem confirmação de pagamento', 'decisão humana'],
    // Sem `pending_terms`, nenhum parêntese de termos entra na frase.
    naoContem: ['não cancele', 'PENDING'],
  },
  {
    nome: 'ainda-nao-pago (PENDING sem pay_time)',
    args: {
      veredito: VEREDITO_RESERVA_TRAVADA.aindaNaoPago,
      orderStatus: 'PENDING',
      pendingTerms: ['SYSTEM_PENDING'],
      motivoInexistente: null,
      idadeDias: 12,
    },
    contem: ['"PENDING"', '(SYSTEM_PENDING)', 'há 12 dia(s)', 'sem confirmação de pagamento'],
    naoContem: ['não cancele'],
  },
  {
    nome: 'pendente-pago',
    args: {
      veredito: VEREDITO_RESERVA_TRAVADA.pendentePago,
      orderStatus: 'PENDING',
      pendingTerms: ['ARRANGE_SHIPMENT_PENDING'],
      motivoInexistente: null,
      idadeDias: 12,
    },
    contem: ['(ARRANGE_SHIPMENT_PENDING)', 'não cancele', 'Open Platform', 'há 12 dia(s)'],
    naoContem: ['sem confirmação de pagamento'],
  },
  {
    nome: 'inexistente (order_not_found)',
    args: {
      veredito: VEREDITO_RESERVA_TRAVADA.inexistente,
      orderStatus: null,
      pendingTerms: null,
      motivoInexistente: 'order_not_found',
      idadeDias: 12,
    },
    contem: ['(order_not_found)', 'não reconhece mais este pedido', 'há 12 dia(s)'],
    naoContem: ['desconhecido'],
  },
  {
    nome: 'inexistente (ausente-na-resposta)',
    args: {
      veredito: VEREDITO_RESERVA_TRAVADA.inexistente,
      orderStatus: null,
      pendingTerms: null,
      // ⚠️ Grafia deliberadamente DIFERENTE do `ausente-no-order_list` do step 5:
      // a nossa leitura é um `get_order_detail`, e reaproveitar a palavra dele
      // afirmaria uma contradição do provedor que não observamos.
      motivoInexistente: 'ausente-na-resposta',
      idadeDias: 12,
    },
    contem: ['(ausente-na-resposta)', 'há 12 dia(s)'],
    naoContem: ['ausente-no-order_list'],
  },
  {
    nome: 'manter-devolucao',
    args: {
      veredito: VEREDITO_RESERVA_TRAVADA.manterDevolucao,
      orderStatus: 'TO_RETURN',
      pendingTerms: null,
      motivoInexistente: null,
      idadeDias: 12,
    },
    contem: ['"TO_RETURN"', 'nenhuma releitura corrige o estado', 'há 12 dia(s)'],
    naoContem: ['não cancele'],
  },
];

describe('3 — situacaoReservaTravada', () => {
  it.each(CASOS)('$nome fala o status, a idade e o remédio', ({ args, contem, naoContem }) => {
    const texto = situacaoReservaTravada(args);

    for (const trecho of contem) expect(texto).toContain(trecho);
    for (const trecho of naoContem) expect(texto).not.toContain(trecho);

    // Fragmento minúsculo, sem ponto final — entra no meio da frase do `apps/web`.
    expect(texto[0]).toBe(texto[0]?.toLowerCase());
    expect(texto.endsWith('.')).toBe(false);
    expect(texto.length).toBeLessThanOrEqual(SITUACAO_MAX);
    // Nenhuma das cinco carrega dado do comprador — só status, terms e motivo.
    expect(texto).not.toContain('comprador');
  });

  it('o texto do pendente-pago manda NÃO cancelar — é uma venda paga retida', () => {
    // O near-miss dos outros quatro: aqui a ação óbvia (cancelar) ENCERRA uma
    // venda viva, e `ARRANGE_SHIPMENT_PENDING` é documentado como pós-pagamento.
    const texto = situacaoReservaTravada({
      veredito: VEREDITO_RESERVA_TRAVADA.pendentePago,
      orderStatus: 'PENDING',
      pendingTerms: ['ARRANGE_SHIPMENT_PENDING'],
      motivoInexistente: null,
      idadeDias: 3,
    });

    expect(texto).toContain('não cancele');
    expect(texto).toContain('JÁ foi registrado');
    expect(texto).toContain('Open Platform');
  });

  it('um pending_terms de 600 caracteres é truncado com reticências', () => {
    // `order_status` e `pending_terms` são strings NÃO confiáveis do provedor que
    // caem dentro da frase de um operador; o precedente é o `MOTIVO_MAX` do
    // `sincronizarEstoquePedido.ts`.
    const texto = situacaoReservaTravada({
      veredito: VEREDITO_RESERVA_TRAVADA.aindaNaoPago,
      orderStatus: 'PENDING',
      pendingTerms: ['X'.repeat(600)],
      motivoInexistente: null,
      idadeDias: 12,
    });

    expect(texto).toHaveLength(SITUACAO_MAX);
    expect(texto.endsWith('…')).toBe(true);
    // QUASE-ERRO: o texto curto NÃO ganha reticências.
    expect(
      situacaoReservaTravada({
        veredito: VEREDITO_RESERVA_TRAVADA.aindaNaoPago,
        orderStatus: 'UNPAID',
        pendingTerms: null,
        motivoInexistente: null,
        idadeDias: 12,
      }).endsWith('…'),
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  (4) o motivo, e o veredito recusado                                        */
/* -------------------------------------------------------------------------- */

interface LinhaMotivo {
  readonly nome: string;
  readonly over: Partial<EventoReservaTravada>;
  readonly motivo: string;
}

const LINHAS_MOTIVO: readonly LinhaMotivo[] = [
  {
    nome: 'ainda-nao-pago',
    over: { veredito: VEREDITO_RESERVA_TRAVADA.aindaNaoPago, orderStatus: 'UNPAID' },
    motivo: 'UNPAID',
  },
  {
    nome: 'pendente-pago',
    over: {
      veredito: VEREDITO_RESERVA_TRAVADA.pendentePago,
      orderStatus: 'PENDING',
      pendingTerms: ['ARRANGE_SHIPMENT_PENDING'],
    },
    motivo: 'PENDING',
  },
  {
    nome: 'inexistente',
    over: {
      veredito: VEREDITO_RESERVA_TRAVADA.inexistente,
      orderStatus: null,
      motivoInexistente: 'order_not_found',
    },
    motivo: 'order_not_found',
  },
  {
    nome: 'manter-devolucao',
    // ⚠️ `TO_RETURN` por construção: é o único token para o qual a escada
    // responde `manter`, então o `order_status` vivo JÁ é esta palavra.
    over: { veredito: VEREDITO_RESERVA_TRAVADA.manterDevolucao, orderStatus: 'TO_RETURN' },
    motivo: 'TO_RETURN',
  },
];

describe('4 — motivo por veredito', () => {
  it.each(LINHAS_MOTIVO)('$nome grava o código do provedor em motivo', async ({ over, motivo }) => {
    const db = new FakeDb();

    await avisarReservaTravada(asDb(db), evento(over), deps());

    // Um `tipo`, quatro AÇÕES do operador — que é exatamente por que o motivo
    // fica ao lado do tipo em vez de dobrado dentro dele.
    expect(db.store[PATH]?.data.motivo).toBe(motivo);
  });

  it('recusa um veredito que não superficializa', () => {
    // O produtor nunca pode ser alcançado por um braço que não vira aviso:
    // `redirecionado-avancou` enfileira uma re-leitura e `nao-verificavel` é a
    // AUSÊNCIA de uma observação. A Set `VEREDITOS_QUE_AVISAM` é a fonte única —
    // o classificador calcula o `surfacar` dele a partir da MESMA Set.
    const db = new FakeDb();
    const fora = {
      ...evento(),
      veredito: VEREDITO_RESERVA_TRAVADA.redirecionadoAvancou,
    } as unknown as EventoReservaTravada;

    expect(() => avisarReservaTravada(asDb(db), fora, deps())).toThrow(RangeError);
    expect(Object.keys(db.store)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  (5) o resolvedor                                                           */
/* -------------------------------------------------------------------------- */

describe('5 — resolverReservaTravada', () => {
  it('resolve um aviso aberto e responde false para um ausente', async () => {
    const db = new FakeDb();
    await avisarReservaTravada(asDb(db), evento(), deps());

    const fechou = await resolverReservaTravada(
      asDb(db),
      CHAVE,
      MOTIVO_RESOLUCAO_RESERVA_TRAVADA.estadoSaiuDoConjunto,
      { nowMs: AGORA_MS + DIA_MS },
    );

    expect(fechou).toBe(true);
    expect(db.store[PATH]?.data).toMatchObject({
      resolvidoEm: (AGORA_MS + DIA_MS) * 1000,
      resolucaoMotivo: MOTIVO_RESOLUCAO_RESERVA_TRAVADA.estadoSaiuDoConjunto,
    });

    // ⚠️ Reporta uma TRANSIÇÃO, não a existência do documento: contar de novo
    // inflaria o contador `reconciliados` para sempre e re-carimbaria
    // `resolvidoEm`, empurrando a linha para além do corte de 90 dias da
    // varredura de retenção — ela nunca envelheceria.
    await expect(
      resolverReservaTravada(asDb(db), CHAVE, MOTIVO_RESOLUCAO_RESERVA_TRAVADA.vendaViva, {
        nowMs: AGORA_MS + 2 * DIA_MS,
      }),
    ).resolves.toBe(false);
    expect(db.store[PATH]?.data.resolucaoMotivo).toBe(
      MOTIVO_RESOLUCAO_RESERVA_TRAVADA.estadoSaiuDoConjunto,
    );

    // Uma chave que nunca existiu responde false e NÃO cria nada — um `merge`
    // de admin é um UPSERT e ressuscitaria uma linha que a retenção apagou.
    const outra = chaveReservaTravada(INTEGRACAO, 'c'.repeat(64));
    await expect(
      resolverReservaTravada(asDb(db), outra, MOTIVO_RESOLUCAO_RESERVA_TRAVADA.pedidoInexistente, {
        nowMs: AGORA_MS,
      }),
    ).resolves.toBe(false);
    expect(Object.keys(db.store)).toEqual([PATH]);
  });

  it('os seis motivos são os que os dois passes usam, e nada mais', () => {
    expect(Object.values(MOTIVO_RESOLUCAO_RESERVA_TRAVADA)).toEqual([
      // passada (a), em linha: exatamente estes DOIS.
      'assumido-por-humano',
      'venda-viva',
      // passada (b), a reconciliação: o pedido saiu do conjunto de candidatos.
      'pedido-inexistente',
      'estado-saiu-do-conjunto',
      'fora-da-posse',
      'dentro-do-horizonte',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*  (6) a fonte                                                                */
/* -------------------------------------------------------------------------- */

describe('6 — a fonte', () => {
  it('não nomeia a API de transação, o conversor de unidade nem o relógio de evento', () => {
    // `firestore-transaction-inventory.test.js` faz grep de texto CRU sobre
    // `*.ts` (comentários inclusive) e exclui `*.test.ts` — por isso este arquivo
    // pode escrever a palavra e o módulo não pode. E a conversão ms → µs funila
    // por `agoraUsDe` / `depsDeEscrita`, como manda `autorizacao.ts`.
    const fonte = readFileSync(
      fileURLToPath(new URL('./reservaTravada.ts', import.meta.url)),
      'utf8',
    );

    expect(fonte).not.toContain('runTransaction');
    expect(fonte).not.toContain('millisToMicros');
    expect(fonte).not.toContain('relogioEvento');
    // ÂNCORA: o arquivo realmente foi lido e realmente contém o módulo.
    expect(fonte).toContain('export function avisarReservaTravada');
  });
});
