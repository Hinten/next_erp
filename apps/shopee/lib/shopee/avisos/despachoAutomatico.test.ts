import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FieldValue } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import {
  shopeePackageDetailRowSchema,
  type ShopeePackageDetailRow,
} from '@delfrance/integrations-shopee';
import {
  CANAL_AVISO,
  ESTADO_FRETE,
  ROTAS_AVISO,
  SEVERIDADE_AVISO,
  TIPO_AVISO,
  avisoSchema,
  chaveDeAviso,
  estadoFreteSchema,
  type EstadoFrete,
} from '@delfrance/schemas';

// ⚠️ O `escreverAviso` / `resolverAviso` REAIS sobre o Firestore falso
// compartilhado, nunca um mock deles — a propriedade sob teste é o PLANO que
// este produtor entrega (quais campos ele declara, quais OMITE) e a chave que
// ele escreve, e um escritor mockado não mostra nenhuma das duas.
// `nfe/avisoNfe.test.ts` é o precedente do arnês.
import { CANAIS_ARRANJO_AUTOMATICO, type FasePacote } from '../etiqueta/faseEtiqueta';
import { MOTIVO_ETIQUETA_SHOPEE, fraseDoMotivoEtiqueta } from '../etiqueta/motivosEtiqueta';
import type {
  DesfechoArranjoAutomatico,
  EntradaArranjoAutomatico,
  ResultadoArranjoAutomatico,
} from '../pedidos/arranjoAutomatico';
import { ESCADA_FRETE_SHOPEE, ESTADO_FRETE_DE_TOKEN_SHOPEE } from '../pedidos/freteShopeeMapping';
import { SHOPEE_ORDER_STATUS } from '../pedidos/orderStatusMaps';
import { FakeDb, asDb, grpc, increment } from '../testing/fakeDb';
import {
  CLASSE_DESPACHO_PENDENTE,
  ESTADOS_FRETE_CANCELADO_SHOPEE,
  ESTADOS_FRETE_POS_COLETA_SHOPEE,
  MOTIVO_DESPACHO_PROPRIO,
  RESOLUCAO_AVISO_DESPACHO,
  acoesDeAvisoDoDespacho,
  avisarArranjoAutomatico,
  chaveAvisoDespachoPendente,
  chaveAvisoEtiquetaComPrazo,
  executarAcoesDeAvisoDoDespacho,
  fraseDoDespachoPendente,
  resolverAvisosDeDespachoSeEncerrado,
  type AcaoDeAvisoDespacho,
  type ClasseDespachoPendente,
  type EncerramentoDespachoShopee,
  type MotivoDespachoPendente,
  type ResolucaoAvisoDespacho,
} from './despachoAutomatico';

/* -------------------------------------------------------------------------- */
/*  Fixtures — ids inventados. Nunca uma conta, pedido ou pacote real.         */
/* -------------------------------------------------------------------------- */

const AGORA_MS = 1_789_000_000_000;
const INTEGRACAO = 'int-1';
/** Um digest de 64 hex, como `makePedidoIdShopee`. O MESMO de `mensagens.test.ts`. */
const PEDIDO_ID = '0123456789abcdef'.repeat(4);
const ORDER_SN = '260910KJBHUJDM';
const PACOTE = 'OFG000000000001';
const PACOTE_2 = 'OFG000000000002';

/** Canais: dois com prazo de etiqueta, um só de arranjo, e um fora dos dois. */
const TURBO = 90011;
const TURBO_2 = 90012;
const SO_ARRANJO = 90026;
const FORA = 90021;

const CHAVE_NFE = chaveAvisoDespachoPendente(INTEGRACAO, PEDIDO_ID, PACOTE, 'nfe');
const CHAVE_MANUAL = chaveAvisoDespachoPendente(INTEGRACAO, PEDIDO_ID, PACOTE, 'manual');
const CHAVE_ETIQUETA = chaveAvisoEtiquetaComPrazo(INTEGRACAO, PEDIDO_ID);
const PATH_NFE = `avisos/${CHAVE_NFE}`;
const PATH_MANUAL = `avisos/${CHAVE_MANUAL}`;
const PATH_ETIQUETA = `avisos/${CHAVE_ETIQUETA}`;

const deps = (nowMs = AGORA_MS) => ({ increment, nowMs });

/** Todo desfecho do gancho — e o compilador recusa a lista se faltar um. */
const DESFECHOS = [
  'fora-do-canal',
  'nao-elegivel',
  'retido',
  'nfe-pendente',
  'ja-programado',
  'desligado',
  'programado',
  'verificar',
  'aguardando',
  'precisa-escolha',
  'recusado',
  'credencial',
  'resposta-ilegivel',
] as const satisfies readonly DesfechoArranjoAutomatico[];
const desfechosCompletos: [Exclude<DesfechoArranjoAutomatico, (typeof DESFECHOS)[number]>] extends [
  never,
]
  ? true
  : false = true;

/** Toda fase de pacote — idem. */
const FASES = [
  'nfe-pendente',
  'nao-pronto',
  'retido',
  'programar',
  'arranjado',
  'janela-fechada',
  'inelegivel',
  'desconhecido',
] as const satisfies readonly FasePacote[];
const fasesCompletas: [Exclude<FasePacote, (typeof FASES)[number]>] extends [never] ? true : false =
  true;

function linha(canal: number = TURBO): ShopeePackageDetailRow {
  return shopeePackageDetailRowSchema.parse({
    order_sn: ORDER_SN,
    package_number: PACOTE,
    logistics_channel_id: canal,
    fulfillment_status: 'LOGISTICS_READY',
  });
}

function entrada(over: Partial<EntradaArranjoAutomatico> = {}): EntradaArranjoAutomatico {
  return {
    integracaoId: INTEGRACAO,
    pedidoId: PEDIDO_ID,
    orderSn: ORDER_SN,
    packageNumber: PACOTE,
    linha: linha(),
    nowMs: AGORA_MS,
    ...over,
  };
}

function resultado(
  desfecho: DesfechoArranjoAutomatico,
  over: Partial<ResultadoArranjoAutomatico> = {},
): ResultadoArranjoAutomatico {
  return {
    desfecho,
    canalId: TURBO,
    fase: 'programar',
    motivo: null,
    shopeeCode: null,
    operacao: null,
    semPacote: false,
    ...over,
  };
}

function acoes(
  desfecho: DesfechoArranjoAutomatico,
  over: Partial<ResultadoArranjoAutomatico> = {},
): readonly AcaoDeAvisoDespacho[] {
  return acoesDeAvisoDoDespacho(entrada(), resultado(desfecho, over));
}

const abrirNfe: AcaoDeAvisoDespacho = {
  tipo: 'abrir-despacho',
  classe: 'nfe',
  motivo: MOTIVO_ETIQUETA_SHOPEE.nfePendente,
};
const abrirManual = (motivo: MotivoDespachoPendente) =>
  ({ tipo: 'abrir-despacho', classe: 'manual', motivo }) as const;
const resolver = (classe: ClasseDespachoPendente, resolucao: ResolucaoAvisoDespacho) =>
  ({ tipo: 'resolver-despacho', classe, resolucao }) as const;
const NFE_VALIDADA = resolver('nfe', RESOLUCAO_AVISO_DESPACHO.nfeValidada);

function armazenado(db: FakeDb, path: string): Record<string, unknown> {
  return db.store[path]?.data ?? {};
}

/** Os caminhos de DOCUMENTO de aviso tocados, em ordem (sem o da coleção). */
function docsTocados(db: FakeDb): string[] {
  return db.caminhos.filter((c) => c.startsWith('avisos/'));
}

function zerarLogs(db: FakeDb): void {
  db.caminhos.length = 0;
  db.opLog.length = 0;
  db.writes.length = 0;
  db.patches.length = 0;
}

/* -------------------------------------------------------------------------- */
/*  Os planos esperados, como LITERAIS (RT7). Copiáveis para                   */
/*  `apps/web/lib/avisos/mensagens.test.ts` — que já os tem, idênticos.        */
/* -------------------------------------------------------------------------- */

const SITUACAO_NFE_PENDENTE =
  'emita a NF-e do pedido — a Shopee só libera o envio com a nota validada, e o despacho ' +
  'automático é feito assim que ela validar';
const SITUACAO_PRECISA_ESCOLHA =
  'organize o envio pelo checkout ou pela Central do Vendedor — a Shopee pede uma escolha de ' +
  'endereço, horário ou modalidade que o despacho automático não faz sozinho';
const SITUACAO_DESLIGADO =
  'organize o envio pelo checkout ou pela Central do Vendedor — o despacho automático está ' +
  'desligado neste ambiente';
const SITUACAO_ILEGIVEL =
  'organize o envio pelo checkout ou pela Central do Vendedor — o despacho automático não ' +
  'conseguiu ler a resposta da Shopee';

const URL_INTERNA = { rota: `/despacho/checkout?pedido=${PEDIDO_ID}`, campo: null };

const PLANO_DESPACHO_NFE = {
  tipo: TIPO_AVISO.despachoAutomaticoPendente,
  severidade: SEVERIDADE_AVISO.atencao,
  canal: CANAL_AVISO.shopee,
  params: { pedido: ORDER_SN, situacao: SITUACAO_NFE_PENDENTE },
  motivo: 'nfe-pendente',
  urlInterna: URL_INTERNA,
};
const PLANO_DESPACHO_MANUAL = {
  tipo: TIPO_AVISO.despachoAutomaticoPendente,
  severidade: SEVERIDADE_AVISO.critico,
  canal: CANAL_AVISO.shopee,
  params: { pedido: ORDER_SN, situacao: SITUACAO_PRECISA_ESCOLHA },
  motivo: 'precisa-escolha',
  urlInterna: URL_INTERNA,
};
const PLANO_ETIQUETA = {
  tipo: TIPO_AVISO.etiquetaComPrazo,
  severidade: SEVERIDADE_AVISO.atencao,
  canal: CANAL_AVISO.shopee,
  params: { pedido: ORDER_SN },
  urlInterna: URL_INTERNA,
};

/** Os únicos campos que um REPETIDO pode escrever — nada de prazo, relógio ou link externo. */
const PATCH_DE_REPETICAO_DESPACHO = [
  'atualizadoEm',
  'canal',
  'motivo',
  'ocorrencias',
  'params',
  'resolucaoMotivo',
  'resolvidoEm',
  'severidade',
  'tipo',
  'urlInterna',
];
const PATCH_DE_REPETICAO_ETIQUETA = PATCH_DE_REPETICAO_DESPACHO.filter((k) => k !== 'motivo');

/* -------------------------------------------------------------------------- */
/*  (1) as chaves                                                              */
/* -------------------------------------------------------------------------- */

describe('1 — as chaves', () => {
  it('A é despachoAutomaticoPendente:<conta>:<pedido>_<pacote>:<classe> — mutantes 51 e 52', () => {
    expect(CHAVE_NFE).toBe(`despachoAutomaticoPendente:int-1:${PEDIDO_ID}_${PACOTE}:nfe`);
    expect(CHAVE_MANUAL).toBe(`despachoAutomaticoPendente:int-1:${PEDIDO_ID}_${PACOTE}:manual`);
    // ÂNCORA: a dobra de `:` é a do `chaveDeAviso`, não uma do produtor.
    expect(CHAVE_NFE).toBe(
      chaveDeAviso({
        tipo: TIPO_AVISO.despachoAutomaticoPendente,
        conta: INTEGRACAO,
        entidade: `${PEDIDO_ID}:${PACOTE}`,
        janela: 'nfe',
      }),
    );
  });

  it('QUASE-ERRO: duas classes, dois pacotes, dois pedidos, duas contas — sempre linhas DIFERENTES', () => {
    const ids = new Set([
      CHAVE_NFE,
      CHAVE_MANUAL,
      chaveAvisoDespachoPendente(INTEGRACAO, PEDIDO_ID, PACOTE_2, 'nfe'),
      chaveAvisoDespachoPendente(INTEGRACAO, PEDIDO_ID, PACOTE_2, 'manual'),
      chaveAvisoDespachoPendente(INTEGRACAO, 'f'.repeat(64), PACOTE, 'nfe'),
      chaveAvisoDespachoPendente('int-2', PEDIDO_ID, PACOTE, 'nfe'),
      CHAVE_ETIQUETA,
    ]);
    expect(ids.size).toBe(7);
  });

  it('PAR IGUAL: as mesmas entradas são sempre a MESMA linha', () => {
    expect(chaveAvisoDespachoPendente(INTEGRACAO, PEDIDO_ID, PACOTE, 'nfe')).toBe(CHAVE_NFE);
    expect(chaveAvisoEtiquetaComPrazo(INTEGRACAO, PEDIDO_ID)).toBe(CHAVE_ETIQUETA);
  });

  it('B é etiquetaComPrazo:<conta>:<pedido> — por PEDIDO, sem pacote e sem janela', () => {
    expect(CHAVE_ETIQUETA).toBe(`etiquetaComPrazo:int-1:${PEDIDO_ID}`);
    // QUASE-ERRO: o segundo pacote do mesmo pedido NÃO abre uma segunda linha B.
    expect(CHAVE_ETIQUETA.includes(PACOTE)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  (2) as frases                                                              */
/* -------------------------------------------------------------------------- */

describe('2 — fraseDoDespachoPendente', () => {
  it('as quatro frases próprias, LITERAIS (§2.6)', () => {
    expect(fraseDoDespachoPendente(MOTIVO_ETIQUETA_SHOPEE.nfePendente)).toBe(SITUACAO_NFE_PENDENTE);
    expect(fraseDoDespachoPendente(MOTIVO_DESPACHO_PROPRIO.precisaEscolha)).toBe(
      SITUACAO_PRECISA_ESCOLHA,
    );
    expect(fraseDoDespachoPendente(MOTIVO_DESPACHO_PROPRIO.arranjoDesligado)).toBe(
      SITUACAO_DESLIGADO,
    );
    expect(fraseDoDespachoPendente(MOTIVO_DESPACHO_PROPRIO.respostaIlegivel)).toBe(
      SITUACAO_ILEGIVEL,
    );
  });

  it('os slugs próprios são os persistidos', () => {
    expect(MOTIVO_DESPACHO_PROPRIO).toEqual({
      precisaEscolha: 'precisa-escolha',
      arranjoDesligado: 'arranjo-automatico-desligado',
      respostaIlegivel: 'resposta-ilegivel',
    });
  });

  it('nenhum slug próprio colide com um motivo do fluxo de etiqueta', () => {
    const daEtiqueta = new Set<string>(Object.values(MOTIVO_ETIQUETA_SHOPEE));
    for (const proprio of Object.values(MOTIVO_DESPACHO_PROPRIO)) {
      expect(daEtiqueta.has(proprio), proprio).toBe(false);
    }
  });

  it('PAR IGUAL: todo outro motivo é a frase do fluxo de etiqueta, verbatim', () => {
    const outros = Object.values(MOTIVO_ETIQUETA_SHOPEE).filter(
      (m) => m !== MOTIVO_ETIQUETA_SHOPEE.nfePendente,
    );
    // ÂNCORA anti-vacuidade.
    expect(outros.length).toBeGreaterThanOrEqual(20);
    for (const motivo of outros) {
      expect(fraseDoDespachoPendente(motivo), motivo).toBe(fraseDoMotivoEtiqueta(motivo));
    }
  });

  it('QUASE-ERRO: `nfe-pendente` tem frase PRÓPRIA — a do clique fala em imprimir a etiqueta', () => {
    expect(fraseDoDespachoPendente(MOTIVO_ETIQUETA_SHOPEE.nfePendente)).not.toBe(
      fraseDoMotivoEtiqueta(MOTIVO_ETIQUETA_SHOPEE.nfePendente),
    );
  });

  it('toda frase é um FRAGMENTO: minúscula no início, sem ponto final, sem espaço nas pontas', () => {
    const todos = [
      ...Object.values(MOTIVO_ETIQUETA_SHOPEE),
      ...Object.values(MOTIVO_DESPACHO_PROPRIO),
    ];
    for (const motivo of todos) {
      const frase = fraseDoDespachoPendente(motivo);
      expect(frase.charAt(0), motivo).toBe(frase.charAt(0).toLocaleLowerCase('pt-BR'));
      expect(frase.charAt(0), motivo).not.toBe(frase.charAt(0).toLocaleUpperCase('pt-BR'));
      expect(frase.endsWith('.'), motivo).toBe(false);
      expect(frase.trim(), motivo).toBe(frase);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  (3) a tabela do gancho (pura)                                              */
/* -------------------------------------------------------------------------- */

describe('3 — acoesDeAvisoDoDespacho (a tabela)', () => {
  it('fora-do-canal ⇒ [] (o gancho nem chama; a tabela é total mesmo assim)', () => {
    expect(acoes('fora-do-canal')).toEqual([]);
  });

  it('nfe-pendente ⇒ ABRE só a classe nfe', () => {
    expect(acoes('nfe-pendente', { fase: 'nfe-pendente' })).toEqual([abrirNfe]);
  });

  it('⚠️ nfe-pendente vindo do ENVIO (fase programar) não resolve a nfe pela regra N — mutante 57', () => {
    // A leitura achou a nota liberada, mas a Shopee recusou o ship pela nota:
    // abrir E resolver a mesma linha na mesma rodada a fecharia na hora.
    expect(acoes('nfe-pendente', { fase: 'programar' })).toEqual([abrirNfe]);
  });

  it('programado ⇒ resolve as DUAS classes (`arranjado`) e ABRE a etiqueta num canal com prazo', () => {
    expect(acoes('programado')).toEqual([
      resolver('nfe', 'arranjado'),
      resolver('manual', 'arranjado'),
      { tipo: 'abrir-etiqueta' },
    ]);
  });

  it('⚠️ ja-programado ABRE a etiqueta também — ACD e a reentrega depois do ship — mutante 55', () => {
    for (const canalId of [TURBO, TURBO_2]) {
      expect(acoes('ja-programado', { canalId, fase: 'arranjado' })).toEqual([
        resolver('nfe', 'arranjado'),
        resolver('manual', 'arranjado'),
        { tipo: 'abrir-etiqueta' },
      ]);
    }
  });

  it('QUASE-ERRO: 90026 é arranjo automático SEM prazo de etiqueta — nunca abre B — mutante 56', () => {
    for (const desfecho of ['programado', 'ja-programado'] as const) {
      expect(acoes(desfecho, { canalId: SO_ARRANJO })).toEqual([
        resolver('nfe', 'arranjado'),
        resolver('manual', 'arranjado'),
      ]);
    }
  });

  it('recusado ⇒ regra N + ABRE manual com o motivo da recusa', () => {
    expect(
      acoes('recusado', { motivo: MOTIVO_ETIQUETA_SHOPEE.semEnderecoDeColeta, fase: 'programar' }),
    ).toEqual([NFE_VALIDADA, abrirManual(MOTIVO_ETIQUETA_SHOPEE.semEnderecoDeColeta)]);
  });

  it('recusado sem motivo (impossível pelo gancho) ainda abre, como recusa-desconhecida', () => {
    expect(acoes('recusado', { motivo: null })).toEqual([
      NFE_VALIDADA,
      abrirManual(MOTIVO_ETIQUETA_SHOPEE.recusaDesconhecida),
    ]);
  });

  it('precisa-escolha / desligado / resposta-ilegivel ⇒ regra N + ABRE manual com o motivo PRÓPRIO', () => {
    expect(acoes('precisa-escolha')).toEqual([
      NFE_VALIDADA,
      abrirManual(MOTIVO_DESPACHO_PROPRIO.precisaEscolha),
    ]);
    expect(acoes('desligado')).toEqual([
      NFE_VALIDADA,
      abrirManual(MOTIVO_DESPACHO_PROPRIO.arranjoDesligado),
    ]);
    expect(acoes('resposta-ilegivel')).toEqual([
      NFE_VALIDADA,
      abrirManual(MOTIVO_DESPACHO_PROPRIO.respostaIlegivel),
    ]);
  });

  it('nao-elegivel por pedido-cancelado ⇒ resolve TUDO (`pedido-cancelado`), B só num canal com prazo', () => {
    expect(acoes('nao-elegivel', { motivo: MOTIVO_ETIQUETA_SHOPEE.pedidoCancelado })).toEqual([
      resolver('nfe', 'pedido-cancelado'),
      resolver('manual', 'pedido-cancelado'),
      { tipo: 'resolver-etiqueta', resolucao: 'pedido-cancelado' },
    ]);
    expect(
      acoes('nao-elegivel', {
        motivo: MOTIVO_ETIQUETA_SHOPEE.pedidoCancelado,
        canalId: SO_ARRANJO,
      }),
    ).toEqual([resolver('nfe', 'pedido-cancelado'), resolver('manual', 'pedido-cancelado')]);
  });

  it('QUASE-ERRO: nao-elegivel por OUTRO motivo (FBS, IN_CANCEL…) só cai na regra N', () => {
    for (const motivo of [
      MOTIVO_ETIQUETA_SHOPEE.pedidoFbs,
      MOTIVO_ETIQUETA_SHOPEE.pedidoEmCancelamento,
      MOTIVO_ETIQUETA_SHOPEE.statusDesconhecido,
      null,
    ]) {
      expect(acoes('nao-elegivel', { motivo, fase: 'nao-pronto' }), String(motivo)).toEqual([
        NFE_VALIDADA,
      ]);
      expect(acoes('nao-elegivel', { motivo, fase: 'janela-fechada' }), String(motivo)).toEqual([]);
    }
  });

  it('⚠️ retido NÃO abre manual — a retenção é da Shopee, temporária — mutante 58', () => {
    expect(
      acoes('retido', { fase: 'retido', motivo: MOTIVO_ETIQUETA_SHOPEE.retidoPelaShopee }),
    ).toEqual([NFE_VALIDADA]);
  });

  it('⚠️ credencial NÃO abre linha nenhuma — o aviso da conta é o produtor — mutante 59', () => {
    expect(acoes('credencial')).toEqual([NFE_VALIDADA]);
    expect(acoes('credencial', { fase: 'arranjado' })).toEqual([]);
  });

  it('aguardando / verificar (transitórios) só caem na regra N', () => {
    expect(acoes('aguardando')).toEqual([NFE_VALIDADA]);
    expect(acoes('verificar')).toEqual([NFE_VALIDADA]);
  });

  it('regra N: resolve a nfe só nas fases pré-arranjo em que o portão da nota PASSOU — mutante 57', () => {
    for (const fase of FASES) {
      const esperado = fase === 'nao-pronto' || fase === 'programar' || fase === 'retido';
      expect(
        acoes('aguardando', { fase }).some(
          (a) => a.tipo === 'resolver-despacho' && a.resolucao === 'nfe-validada',
        ),
        fase,
      ).toBe(esperado);
    }
  });

  it('VARREDURA: desfecho × fase × canal contra a tabela reescrita como predicados', () => {
    expect(desfechosCompletos && fasesCompletas).toBe(true);
    const comAbrirManual = new Set<string>([
      'recusado',
      'precisa-escolha',
      'desligado',
      'resposta-ilegivel',
    ]);
    const daRegraN = new Set<string>([
      ...comAbrirManual,
      'retido',
      'aguardando',
      'verificar',
      'credencial',
      'nao-elegivel',
    ]);
    let casos = 0;
    for (const desfecho of DESFECHOS) {
      for (const fase of FASES) {
        for (const canalId of [TURBO, TURBO_2, SO_ARRANJO]) {
          const lista = acoes(desfecho, {
            fase,
            canalId,
            motivo: MOTIVO_ETIQUETA_SHOPEE.pedidoFbs,
          });
          const rotulo = `${desfecho}/${fase}/${String(canalId)}`;
          casos += 1;

          expect(
            lista.some((a) => a.tipo === 'abrir-etiqueta'),
            rotulo,
          ).toBe(
            (desfecho === 'programado' || desfecho === 'ja-programado') && canalId !== SO_ARRANJO,
          );
          expect(
            lista.some((a) => a.tipo === 'abrir-despacho' && a.classe === 'nfe'),
            rotulo,
          ).toBe(desfecho === 'nfe-pendente');
          expect(
            lista.some((a) => a.tipo === 'abrir-despacho' && a.classe === 'manual'),
            rotulo,
          ).toBe(comAbrirManual.has(desfecho));
          expect(
            lista.some((a) => a.tipo === 'resolver-despacho' && a.resolucao === 'nfe-validada'),
            rotulo,
          ).toBe(
            daRegraN.has(desfecho) &&
              (fase === 'nao-pronto' || fase === 'programar' || fase === 'retido'),
          );
          expect(
            lista.some((a) => a.tipo === 'resolver-despacho' && a.resolucao === 'arranjado'),
            rotulo,
          ).toBe(desfecho === 'programado' || desfecho === 'ja-programado');
          if (desfecho === 'fora-do-canal') expect(lista, rotulo).toEqual([]);
          // Nunca duas ações sobre a mesma linha numa rodada.
          const alvos = lista.map((a) =>
            a.tipo === 'abrir-despacho' || a.tipo === 'resolver-despacho' ? a.classe : 'etiqueta',
          );
          expect(new Set(alvos).size, rotulo).toBe(alvos.length);
        }
      }
    }
    expect(casos).toBe(13 * 8 * 3);
  });

  it('é PURA: a mesma entrada dá a mesma lista, e a entrada não é alterada', () => {
    const e = entrada();
    const r = resultado('programado');
    const antes = JSON.stringify({ e, r });
    expect(acoesDeAvisoDoDespacho(e, r)).toEqual(acoesDeAvisoDoDespacho(e, r));
    expect(JSON.stringify({ e, r })).toBe(antes);
  });
});

/* -------------------------------------------------------------------------- */
/*  (4) o executor e os planos                                                 */
/* -------------------------------------------------------------------------- */

describe('4 — executarAcoesDeAvisoDoDespacho', () => {
  it('[] ⇒ ZERO leituras e ZERO escritas', async () => {
    const db = new FakeDb();

    const r = await executarAcoesDeAvisoDoDespacho(asDb(db), entrada(), [], deps());

    expect(r).toEqual({ abertos: 0, resolvidos: 0 });
    expect(db.opLog).toEqual([]);
    expect(db.caminhos).toEqual([]);
    expect(db.writes).toEqual([]);
  });

  it('RT7: o plano A/nfe gravado é o LITERAL esperado e passa no avisoSchema — mutante 53', async () => {
    const db = new FakeDb();

    const r = await executarAcoesDeAvisoDoDespacho(asDb(db), entrada(), [abrirNfe], deps());

    expect(r).toEqual({ abertos: 1, resolvidos: 0 });
    expect(Object.keys(db.store)).toEqual([PATH_NFE]);
    const doc = armazenado(db, PATH_NFE);
    expect(doc).toMatchObject({
      ...PLANO_DESPACHO_NFE,
      criadoEm: AGORA_MS * 1000,
      atualizadoEm: AGORA_MS * 1000,
      ocorrencias: 1,
      resolvidoEm: null,
    });
    expect(avisoSchema.parse(doc)).toMatchObject(PLANO_DESPACHO_NFE);
  });

  it('RT7: o plano A/manual é `critico`, com a frase própria — mutante 54', async () => {
    const db = new FakeDb();

    await executarAcoesDeAvisoDoDespacho(
      asDb(db),
      entrada(),
      [abrirManual(MOTIVO_DESPACHO_PROPRIO.precisaEscolha)],
      deps(),
    );

    const doc = armazenado(db, PATH_MANUAL);
    expect(doc).toMatchObject(PLANO_DESPACHO_MANUAL);
    expect(avisoSchema.parse(doc)).toMatchObject(PLANO_DESPACHO_MANUAL);
    expect(doc.severidade).toBe(SEVERIDADE_AVISO.critico);
  });

  it('RT7: o plano B é `atencao`, params só { pedido }, sem motivo', async () => {
    const db = new FakeDb();

    await executarAcoesDeAvisoDoDespacho(asDb(db), entrada(), [{ tipo: 'abrir-etiqueta' }], deps());

    const doc = armazenado(db, PATH_ETIQUETA);
    expect(doc).toMatchObject(PLANO_ETIQUETA);
    expect(doc.motivo).toBeNull();
    expect(avisoSchema.parse(doc)).toMatchObject(PLANO_ETIQUETA);
  });

  it('params são EXATAMENTE os declarados, e a rota é o CHECKOUT do pedido — mutantes 60 e 62', async () => {
    const db = new FakeDb();

    await executarAcoesDeAvisoDoDespacho(
      asDb(db),
      entrada(),
      [abrirNfe, abrirManual(MOTIVO_ETIQUETA_SHOPEE.modoNaoSuportado), { tipo: 'abrir-etiqueta' }],
      deps(),
    );

    expect(Object.keys(armazenado(db, PATH_NFE).params as object).sort()).toEqual([
      'pedido',
      'situacao',
    ]);
    expect(Object.keys(armazenado(db, PATH_MANUAL).params as object).sort()).toEqual([
      'pedido',
      'situacao',
    ]);
    expect(armazenado(db, PATH_MANUAL).params).toEqual({
      pedido: ORDER_SN,
      situacao: fraseDoMotivoEtiqueta(MOTIVO_ETIQUETA_SHOPEE.modoNaoSuportado),
    });
    expect(Object.keys(armazenado(db, PATH_ETIQUETA).params as object)).toEqual(['pedido']);
    for (const path of [PATH_NFE, PATH_MANUAL, PATH_ETIQUETA]) {
      expect(armazenado(db, path).urlInterna, path).toEqual({
        rota: ROTAS_AVISO.despachoCheckout.build(PEDIDO_ID),
        campo: null,
      });
      // QUASE-ERRO: o formulário do pedido não tem ação de etiqueta.
      expect(armazenado(db, path).urlInterna, path).not.toEqual({
        rota: ROTAS_AVISO.pedido.build(PEDIDO_ID),
        campo: null,
      });
      expect(armazenado(db, path).canal, path).toBe(CANAL_AVISO.shopee);
      expect(armazenado(db, path).urlExterna, path).toBeNull();
    }
  });

  it('⚠️ uma REPETIÇÃO não escreve prazo, relógio de evento nem link externo — mutantes 60 e 61', async () => {
    // A criação preenche todo opcional com null; só o PATCH cru da repetição
    // mostra o que o produtor declarou. E um relógio IGUAL ao guardado faria o
    // `escreverAviso` descartar a repetição como `ignorado`.
    const db = new FakeDb();
    const lista = [abrirNfe, { tipo: 'abrir-etiqueta' } as const];
    await executarAcoesDeAvisoDoDespacho(asDb(db), entrada(), lista, deps());
    zerarLogs(db);

    const r = await executarAcoesDeAvisoDoDespacho(asDb(db), entrada(), lista, deps());

    expect(r).toEqual({ abertos: 0, resolvidos: 0 });
    expect(armazenado(db, PATH_NFE).ocorrencias).toBe(2);
    expect(armazenado(db, PATH_ETIQUETA).ocorrencias).toBe(2);
    const patchNfe = db.patches.find((p) => p.path === PATH_NFE)?.patch ?? {};
    const patchEtiqueta = db.patches.find((p) => p.path === PATH_ETIQUETA)?.patch ?? {};
    expect(Object.keys(patchNfe).sort()).toEqual(PATCH_DE_REPETICAO_DESPACHO);
    expect(Object.keys(patchEtiqueta).sort()).toEqual(PATCH_DE_REPETICAO_ETIQUETA);
    for (const doc of [armazenado(db, PATH_NFE), armazenado(db, PATH_ETIQUETA)]) {
      expect(doc.prazo).toBeNull();
      expect(doc.relogioEvento).toBeNull();
      // Repetição não move `criadoEm` (não re-alerta).
      expect(doc.criadoEm).toBe(AGORA_MS * 1000);
    }
  });

  it('⚠️ a transição perigosa: nota validada e arranjo RECUSADO abre uma linha NOVA, não repete a lida', async () => {
    const db = new FakeDb();
    await executarAcoesDeAvisoDoDespacho(
      asDb(db),
      entrada(),
      acoesDeAvisoDoDespacho(entrada(), resultado('nfe-pendente', { fase: 'nfe-pendente' })),
      deps(),
    );

    const r = await executarAcoesDeAvisoDoDespacho(
      asDb(db),
      entrada(),
      acoesDeAvisoDoDespacho(
        entrada(),
        resultado('recusado', { motivo: MOTIVO_ETIQUETA_SHOPEE.semHorarioOuAgencia }),
      ),
      deps(AGORA_MS + 60_000),
    );

    expect(r).toEqual({ abertos: 1, resolvidos: 1 });
    expect(armazenado(db, PATH_NFE)).toMatchObject({
      resolvidoEm: (AGORA_MS + 60_000) * 1000,
      resolucaoMotivo: 'nfe-validada',
    });
    expect(armazenado(db, PATH_MANUAL)).toMatchObject({
      severidade: SEVERIDADE_AVISO.critico,
      motivo: MOTIVO_ETIQUETA_SHOPEE.semHorarioOuAgencia,
      criadoEm: (AGORA_MS + 60_000) * 1000,
      ocorrencias: 1,
      resolvidoEm: null,
    });
  });

  it('os contadores contam TRANSIÇÕES: reabrir conta, resolver o ausente não conta', async () => {
    const db = new FakeDb();
    await executarAcoesDeAvisoDoDespacho(asDb(db), entrada(), [abrirNfe], deps());

    const fechou = await executarAcoesDeAvisoDoDespacho(
      asDb(db),
      entrada(),
      acoes('programado', { canalId: SO_ARRANJO }),
      deps(AGORA_MS + 1000),
    );
    expect(fechou).toEqual({ abertos: 0, resolvidos: 1 });

    const reabriu = await executarAcoesDeAvisoDoDespacho(
      asDb(db),
      entrada(),
      [abrirNfe],
      deps(AGORA_MS + 2000),
    );
    expect(reabriu).toEqual({ abertos: 1, resolvidos: 0 });
    expect(armazenado(db, PATH_NFE)).toMatchObject({
      criadoEm: (AGORA_MS + 2000) * 1000,
      resolvidoEm: null,
      ocorrencias: 2,
    });
  });

  it('executa NA ORDEM da lista, uma escrita de cada vez', async () => {
    const db = new FakeDb();

    await executarAcoesDeAvisoDoDespacho(asDb(db), entrada(), acoes('programado'), deps());

    expect(docsTocados(db)).toEqual([PATH_NFE, PATH_MANUAL, PATH_ETIQUETA]);
    // As duas resoluções acharam nada (duas leituras), e só B foi criado.
    expect(db.opLog).toEqual([
      { op: 'get', path: PATH_NFE },
      { op: 'get', path: PATH_MANUAL },
    ]);
    expect(Object.keys(db.store)).toEqual([PATH_ETIQUETA]);
  });

  it('⚠️ uma falha do Firestore SOBE — o gancho a transforma no throw da entrega', async () => {
    const falha = grpc(14, 'UNAVAILABLE');

    const db = new FakeDb();
    db.falhasDeCriacao.set(PATH_ETIQUETA, falha);
    await expect(
      executarAcoesDeAvisoDoDespacho(asDb(db), entrada(), acoes('programado'), deps()),
    ).rejects.toBe(falha);

    const db2 = new FakeDb();
    await executarAcoesDeAvisoDoDespacho(asDb(db2), entrada(), [abrirNfe], deps());
    db2.falhasDeUpdate.set(PATH_NFE, falha);
    await expect(
      executarAcoesDeAvisoDoDespacho(asDb(db2), entrada(), acoes('programado'), deps()),
    ).rejects.toBe(falha);
    expect(armazenado(db2, PATH_NFE).resolvidoEm).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*  (5) o `avisar` padrão do gancho                                            */
/* -------------------------------------------------------------------------- */

describe('5 — avisarArranjoAutomatico', () => {
  it('fora-do-canal ⇒ ZERO leituras', async () => {
    const db = new FakeDb();

    await avisarArranjoAutomatico(
      asDb(db),
      entrada(),
      resultado('fora-do-canal', { canalId: FORA }),
    );

    expect(db.opLog).toEqual([]);
    expect(db.caminhos).toEqual([]);
  });

  it('usa o relógio DA TAREFA (e.nowMs), convertido só pelo seam µs', async () => {
    const db = new FakeDb();

    await avisarArranjoAutomatico(
      asDb(db),
      entrada({ nowMs: AGORA_MS + 7 }),
      resultado('programado'),
    );

    expect(armazenado(db, PATH_ETIQUETA)).toMatchObject({
      ...PLANO_ETIQUETA,
      criadoEm: (AGORA_MS + 7) * 1000,
    });
  });

  it('a repetição usa o FieldValue.increment de verdade (o sentinela que justifica o import)', async () => {
    const db = new FakeDb();
    await avisarArranjoAutomatico(asDb(db), entrada(), resultado('ja-programado'));
    zerarLogs(db);

    await avisarArranjoAutomatico(asDb(db), entrada(), resultado('ja-programado'));

    const patch = db.patches.find((p) => p.path === PATH_ETIQUETA)?.patch ?? {};
    expect(FieldValue.increment(1).isEqual(patch.ocorrencias as FieldValue)).toBe(true);
    // QUASE-ERRO: não é um número cru, nem outro incremento.
    expect(FieldValue.increment(2).isEqual(patch.ocorrencias as FieldValue)).toBe(false);
  });

  it('pedido cancelado fecha as TRÊS linhas que uma rodada anterior abriu', async () => {
    const db = new FakeDb();
    await executarAcoesDeAvisoDoDespacho(
      asDb(db),
      entrada(),
      [abrirNfe, abrirManual(MOTIVO_DESPACHO_PROPRIO.precisaEscolha), { tipo: 'abrir-etiqueta' }],
      deps(),
    );

    await avisarArranjoAutomatico(
      asDb(db),
      entrada({ nowMs: AGORA_MS + 1000 }),
      resultado('nao-elegivel', { motivo: MOTIVO_ETIQUETA_SHOPEE.pedidoCancelado }),
    );

    for (const path of [PATH_NFE, PATH_MANUAL, PATH_ETIQUETA]) {
      expect(armazenado(db, path), path).toMatchObject({
        resolvidoEm: (AGORA_MS + 1000) * 1000,
        resolucaoMotivo: 'pedido-cancelado',
      });
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  (6) os conjuntos de estado                                                 */
/* -------------------------------------------------------------------------- */

describe('6 — os conjuntos de estado de frete', () => {
  it('pós-coleta = a escada de `postado` para cima + falha na entrega + extraviado — mutante 63', () => {
    expect([...ESTADOS_FRETE_POS_COLETA_SHOPEE].sort()).toEqual(
      [
        ESTADO_FRETE.postado,
        ESTADO_FRETE.recebidoPelaTransportadora,
        ESTADO_FRETE.aCaminho,
        ESTADO_FRETE.tentandoRealizarEntrega,
        ESTADO_FRETE.entregue,
        ESTADO_FRETE.falhaNaEntrega,
        ESTADO_FRETE.objetoExtraviado,
      ].sort(),
    );
  });

  it('QUASE-ERRO: aguardandoPostagem, checkFinalizado e suspenso NÃO são pós-coleta', () => {
    for (const estado of [
      ESTADO_FRETE.aguardandoPostagem,
      ESTADO_FRETE.checkFinalizado,
      ESTADO_FRETE.suspenso,
      ESTADO_FRETE.despachoAutorizado,
    ]) {
      expect(ESTADOS_FRETE_POS_COLETA_SHOPEE.has(estado), estado).toBe(false);
    }
    // ÂNCORA: a derivação é da escada do passo 7 — os dois vizinhos de `postado`.
    const i = (ESCADA_FRETE_SHOPEE as readonly EstadoFrete[]).indexOf(ESTADO_FRETE.postado);
    expect(ESCADA_FRETE_SHOPEE[i - 1]).toBe(ESTADO_FRETE.checkFinalizado);
    expect(ESTADOS_FRETE_POS_COLETA_SHOPEE.has(ESCADA_FRETE_SHOPEE[i] as EstadoFrete)).toBe(true);
  });

  it('cancelado = { cancelado, despachoNegado }, disjunto do pós-coleta', () => {
    expect([...ESTADOS_FRETE_CANCELADO_SHOPEE].sort()).toEqual(
      [ESTADO_FRETE.cancelado, ESTADO_FRETE.despachoNegado].sort(),
    );
    for (const estado of ESTADOS_FRETE_CANCELADO_SHOPEE) {
      expect(ESTADOS_FRETE_POS_COLETA_SHOPEE.has(estado), estado).toBe(false);
    }
  });

  it('todo estado dos dois conjuntos é um estado de frete válido', () => {
    for (const estado of [...ESTADOS_FRETE_POS_COLETA_SHOPEE, ...ESTADOS_FRETE_CANCELADO_SHOPEE]) {
      expect(estadoFreteSchema.safeParse(estado).success, estado).toBe(true);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  (7) o resolvedor entre passos                                              */
/* -------------------------------------------------------------------------- */

type Pacote = EncerramentoDespachoShopee['pacotes'][number];

function pacote(
  fulfillmentStatus: string | null,
  logisticsChannelId: number | null = TURBO,
  packageNumber = PACOTE,
): Pacote {
  return { packageNumber, fulfillmentStatus, logisticsChannelId };
}

function encerramento(over: Partial<EncerramentoDespachoShopee> = {}): EncerramentoDespachoShopee {
  return {
    integracaoId: INTEGRACAO,
    pedidoId: PEDIDO_ID,
    estadoConfirmado: null,
    orderStatus: null,
    pacotes: [pacote('LOGISTICS_READY')],
    ...over,
  };
}

/** Abre as três linhas do pacote 1 (e as duas do pacote 2, se pedido) e zera os logs. */
async function comTudoAberto(comPacote2 = false): Promise<FakeDb> {
  const db = new FakeDb();
  const lista = [
    abrirNfe,
    abrirManual(MOTIVO_DESPACHO_PROPRIO.precisaEscolha),
    { tipo: 'abrir-etiqueta' } as const,
  ];
  await executarAcoesDeAvisoDoDespacho(asDb(db), entrada(), lista, deps());
  if (comPacote2) {
    await executarAcoesDeAvisoDoDespacho(
      asDb(db),
      entrada({ packageNumber: PACOTE_2 }),
      lista.slice(0, 2),
      deps(),
    );
  }
  zerarLogs(db);
  return db;
}

const DEPOIS = { nowMs: AGORA_MS + 5000 };

describe('7 — resolverAvisosDeDespachoSeEncerrado', () => {
  it('⚠️ PORTÃO DO CANAL PRIMEIRO: um pedido fora do arranjo custa ZERO leituras — mutante 64', async () => {
    const db = await comTudoAberto();

    // Tudo que fecharia uma linha de um pedido Turbo: token arranjado, pedido
    // CANCELLED, frete coletado. Fora do canal, nada disso lê um aviso.
    const r = await resolverAvisosDeDespachoSeEncerrado(
      asDb(db),
      encerramento({
        pacotes: [pacote('LOGISTICS_REQUEST_CREATED', FORA), pacote('LOGISTICS_LOST', null)],
        orderStatus: SHOPEE_ORDER_STATUS.cancelled,
        estadoConfirmado: ESTADO_FRETE.entregue,
      }),
      DEPOIS,
    );

    expect(r).toEqual({ despachoResolvidos: 0, etiquetaResolvida: false });
    expect(db.opLog).toEqual([]);
    expect(db.caminhos).toEqual([]);
    expect(db.writes).toEqual([]);
  });

  it('QUASE-ERRO do portão: o MESMO encerramento num canal Turbo fecha tudo', async () => {
    const db = await comTudoAberto();

    const r = await resolverAvisosDeDespachoSeEncerrado(
      asDb(db),
      encerramento({
        pacotes: [pacote('LOGISTICS_REQUEST_CREATED', TURBO)],
        orderStatus: SHOPEE_ORDER_STATUS.cancelled,
        estadoConfirmado: ESTADO_FRETE.entregue,
      }),
      DEPOIS,
    );

    expect(r).toEqual({ despachoResolvidos: 2, etiquetaResolvida: true });
  });

  it('nada a encerrar (pré-arranjo) ⇒ ZERO leituras, mesmo num canal Turbo', async () => {
    for (const token of ['LOGISTICS_READY', 'LOGISTICS_NOT_START', 'LOGISTICS_X', null]) {
      const db = await comTudoAberto();

      const r = await resolverAvisosDeDespachoSeEncerrado(
        asDb(db),
        encerramento({
          pacotes: [pacote(token)],
          estadoConfirmado: ESTADO_FRETE.despachoAutorizado,
        }),
        DEPOIS,
      );

      expect(r, String(token)).toEqual({ despachoResolvidos: 0, etiquetaResolvida: false });
      expect(db.opLog, String(token)).toEqual([]);
    }
  });

  it('RT8: token arranjado fecha as DUAS classes que o abridor escreveu — as MESMAS chaves', async () => {
    const db = await comTudoAberto();

    const r = await resolverAvisosDeDespachoSeEncerrado(
      asDb(db),
      encerramento({ pacotes: [pacote('LOGISTICS_REQUEST_CREATED')] }),
      DEPOIS,
    );

    expect(r).toEqual({ despachoResolvidos: 2, etiquetaResolvida: false });
    // O resolvedor recalculou EXATAMENTE os ids que o abridor criou.
    expect(db.opLog).toEqual([
      { op: 'get', path: PATH_NFE },
      { op: 'get', path: PATH_MANUAL },
    ]);
    for (const path of [PATH_NFE, PATH_MANUAL]) {
      expect(armazenado(db, path), path).toMatchObject({
        resolvidoEm: DEPOIS.nowMs * 1000,
        resolucaoMotivo: 'arranjado',
      });
    }
    // B fica: arranjado não é coletado.
    expect(armazenado(db, PATH_ETIQUETA).resolvidoEm).toBeNull();
  });

  it('PAR IGUAL: todo token que passou do arranjo (arranjado / janela fechada) ⇒ `arranjado`', async () => {
    for (const token of [
      'LOGISTICS_REQUEST_CREATED',
      'LOGISTICS_PICKUP_RETRY',
      'LOGISTICS_PICKUP_DONE',
      'LOGISTICS_DELIVERY_DONE',
      'LOGISTICS_DELIVERY_FAILED',
      'LOGISTICS_LOST',
    ]) {
      const db = await comTudoAberto();
      await resolverAvisosDeDespachoSeEncerrado(
        asDb(db),
        encerramento({ pacotes: [pacote(token)] }),
        DEPOIS,
      );
      expect(armazenado(db, PATH_NFE).resolucaoMotivo, token).toBe('arranjado');
      expect(armazenado(db, PATH_MANUAL).resolucaoMotivo, token).toBe('arranjado');
    }
  });

  it('⚠️ token cancelado/inválido ⇒ `envio-encerrado` — REQUEST_CANCELED incluído — mutante 67', async () => {
    for (const token of [
      'LOGISTICS_REQUEST_CANCELED',
      'LOGISTICS_REQUEST_CANCELLED',
      'LOGISTICS_INVALID',
      'LOGISTICS_PICKUP_FAILED',
      'LOGISTICS_COD_REJECTED',
    ]) {
      // ÂNCORA: o token é um que o passo 7 conhece.
      expect(Object.hasOwn(ESTADO_FRETE_DE_TOKEN_SHOPEE, token), token).toBe(true);
      const db = await comTudoAberto();

      const r = await resolverAvisosDeDespachoSeEncerrado(
        asDb(db),
        encerramento({ pacotes: [pacote(token)] }),
        DEPOIS,
      );

      expect(r.despachoResolvidos, token).toBe(2);
      expect(armazenado(db, PATH_NFE).resolucaoMotivo, token).toBe('envio-encerrado');
      expect(armazenado(db, PATH_MANUAL).resolucaoMotivo, token).toBe('envio-encerrado');
    }
  });

  it('QUASE-ERRO: um token parecido mas desconhecido não fecha nada', async () => {
    const db = await comTudoAberto();

    const r = await resolverAvisosDeDespachoSeEncerrado(
      asDb(db),
      encerramento({ pacotes: [pacote('LOGISTICS_REQUEST_CANCELLED_X')] }),
      DEPOIS,
    );

    expect(r).toEqual({ despachoResolvidos: 0, etiquetaResolvida: false });
    expect(db.opLog).toEqual([]);
  });

  it('order CANCELLED (a constante do importador) ⇒ `pedido-cancelado` em A e em B', async () => {
    const db = await comTudoAberto();

    const r = await resolverAvisosDeDespachoSeEncerrado(
      asDb(db),
      encerramento({ orderStatus: SHOPEE_ORDER_STATUS.cancelled }),
      DEPOIS,
    );

    expect(r).toEqual({ despachoResolvidos: 2, etiquetaResolvida: true });
    for (const path of [PATH_NFE, PATH_MANUAL, PATH_ETIQUETA]) {
      expect(armazenado(db, path).resolucaoMotivo, path).toBe('pedido-cancelado');
    }
  });

  it('o token do PACOTE vem antes do status da order: UMA resolução por linha, a do token', async () => {
    // O motivo persistido diz o fato mais específico — o do próprio pacote —
    // como o `frete-despachado` vem antes do `pedido-cancelado` no passo 14.
    for (const [token, esperado] of [
      ['LOGISTICS_REQUEST_CREATED', 'arranjado'],
      ['LOGISTICS_REQUEST_CANCELED', 'envio-encerrado'],
    ] as const) {
      const db = await comTudoAberto();

      const r = await resolverAvisosDeDespachoSeEncerrado(
        asDb(db),
        encerramento({ pacotes: [pacote(token)], orderStatus: SHOPEE_ORDER_STATUS.cancelled }),
        DEPOIS,
      );

      expect(r.despachoResolvidos, token).toBe(2);
      expect(armazenado(db, PATH_NFE).resolucaoMotivo, token).toBe(esperado);
      expect(armazenado(db, PATH_MANUAL).resolucaoMotivo, token).toBe(esperado);
      // Uma escrita por linha (as duas de A + a de B), nunca uma segunda resolução.
      expect(db.writes, token).toHaveLength(3);
    }
  });

  it('⚠️ QUASE-ERRO: IN_CANCEL, `cancelled` minúsculo e um CANCELLED com espaço NÃO fecham e não leem — mutante 66', async () => {
    for (const orderStatus of [
      SHOPEE_ORDER_STATUS.inCancel,
      'cancelled',
      ` ${SHOPEE_ORDER_STATUS.cancelled}`,
      SHOPEE_ORDER_STATUS.toReturn,
    ]) {
      const db = await comTudoAberto();

      const r = await resolverAvisosDeDespachoSeEncerrado(
        asDb(db),
        encerramento({ orderStatus }),
        DEPOIS,
      );

      expect(r, orderStatus).toEqual({ despachoResolvidos: 0, etiquetaResolvida: false });
      expect(db.opLog, orderStatus).toEqual([]);
    }
  });

  it('B: estado confirmado pós-coleta ⇒ `coletado`', async () => {
    for (const estado of ESTADOS_FRETE_POS_COLETA_SHOPEE) {
      const db = await comTudoAberto();

      const r = await resolverAvisosDeDespachoSeEncerrado(
        asDb(db),
        encerramento({ estadoConfirmado: estado }),
        DEPOIS,
      );

      expect(r, estado).toEqual({ despachoResolvidos: 0, etiquetaResolvida: true });
      expect(armazenado(db, PATH_ETIQUETA).resolucaoMotivo, estado).toBe('coletado');
      expect(db.opLog, estado).toEqual([{ op: 'get', path: PATH_ETIQUETA }]);
    }
  });

  it('⚠️ QUASE-ERRO B: aguardandoPostagem, checkFinalizado e suspenso deixam B ABERTO, sem ler — mutante 63', async () => {
    for (const estado of [
      ESTADO_FRETE.aguardandoPostagem,
      ESTADO_FRETE.checkFinalizado,
      ESTADO_FRETE.suspenso,
      ESTADO_FRETE.error,
    ]) {
      const db = await comTudoAberto();

      const r = await resolverAvisosDeDespachoSeEncerrado(
        asDb(db),
        encerramento({ estadoConfirmado: estado }),
        DEPOIS,
      );

      expect(r.etiquetaResolvida, estado).toBe(false);
      expect(armazenado(db, PATH_ETIQUETA).resolvidoEm, estado).toBeNull();
      expect(db.opLog, estado).toEqual([]);
    }
  });

  it('B: frete cancelado ou despacho negado ⇒ `pedido-cancelado`', async () => {
    for (const estado of ESTADOS_FRETE_CANCELADO_SHOPEE) {
      const db = await comTudoAberto();

      await resolverAvisosDeDespachoSeEncerrado(
        asDb(db),
        encerramento({ estadoConfirmado: estado }),
        DEPOIS,
      );

      expect(armazenado(db, PATH_ETIQUETA).resolucaoMotivo, estado).toBe('pedido-cancelado');
    }
  });

  it('QUASE-ERRO B: um pedido só em 90026 considera A, mas NUNCA lê B', async () => {
    const db = await comTudoAberto();

    const r = await resolverAvisosDeDespachoSeEncerrado(
      asDb(db),
      encerramento({
        pacotes: [pacote('LOGISTICS_REQUEST_CREATED', SO_ARRANJO)],
        estadoConfirmado: ESTADO_FRETE.entregue,
      }),
      DEPOIS,
    );

    expect(r).toEqual({ despachoResolvidos: 2, etiquetaResolvida: false });
    expect(docsTocados(db)).toEqual([PATH_NFE, PATH_MANUAL]);
  });

  it('import (N pacotes): cada pacote Turbo pela SUA chave; o de fora do canal custa nada', async () => {
    const db = await comTudoAberto(true);
    const nfe2 = `avisos/${chaveAvisoDespachoPendente(INTEGRACAO, PEDIDO_ID, PACOTE_2, 'nfe')}`;
    const manual2 = `avisos/${chaveAvisoDespachoPendente(INTEGRACAO, PEDIDO_ID, PACOTE_2, 'manual')}`;

    const r = await resolverAvisosDeDespachoSeEncerrado(
      asDb(db),
      encerramento({
        orderStatus: SHOPEE_ORDER_STATUS.readyToShip,
        pacotes: [
          pacote('LOGISTICS_READY', TURBO, PACOTE),
          pacote('LOGISTICS_REQUEST_CREATED', TURBO, PACOTE_2),
          pacote('LOGISTICS_REQUEST_CREATED', FORA, 'OFG000000000003'),
        ],
      }),
      DEPOIS,
    );

    expect(r).toEqual({ despachoResolvidos: 2, etiquetaResolvida: false });
    expect(docsTocados(db)).toEqual([nfe2, manual2]);
    expect(armazenado(db, nfe2).resolucaoMotivo).toBe('arranjado');
    // O pacote 1, ainda a arranjar, mantém as suas linhas.
    expect(armazenado(db, PATH_NFE).resolvidoEm).toBeNull();
    expect(armazenado(db, PATH_MANUAL).resolvidoEm).toBeNull();
  });

  it('sem aviso aberto ⇒ lê, mas não escreve nada, e responde zero', async () => {
    const db = new FakeDb();

    const r = await resolverAvisosDeDespachoSeEncerrado(
      asDb(db),
      encerramento({
        pacotes: [pacote('LOGISTICS_PICKUP_DONE')],
        estadoConfirmado: ESTADO_FRETE.postado,
      }),
      DEPOIS,
    );

    expect(r).toEqual({ despachoResolvidos: 0, etiquetaResolvida: false });
    expect(db.opLog).toHaveLength(3);
    expect(db.writes).toEqual([]);
  });

  it('linha JÁ resolvida ⇒ não conta e não re-carimba', async () => {
    const db = await comTudoAberto();
    const obs = encerramento({ pacotes: [pacote('LOGISTICS_REQUEST_CREATED')] });
    await resolverAvisosDeDespachoSeEncerrado(asDb(db), obs, DEPOIS);

    const r = await resolverAvisosDeDespachoSeEncerrado(asDb(db), obs, { nowMs: AGORA_MS + 9000 });

    expect(r.despachoResolvidos).toBe(0);
    expect(armazenado(db, PATH_NFE).resolvidoEm).toBe(DEPOIS.nowMs * 1000);
  });

  it('⚠️ uma falha do Firestore na resolução SOBE — nada a engole', async () => {
    const db = await comTudoAberto();
    const falha = grpc(14, 'UNAVAILABLE');
    db.falhasDeUpdate.set(PATH_ETIQUETA, falha);

    await expect(
      resolverAvisosDeDespachoSeEncerrado(
        asDb(db),
        encerramento({ estadoConfirmado: ESTADO_FRETE.postado }),
        DEPOIS,
      ),
    ).rejects.toBe(falha);
    expect(armazenado(db, PATH_ETIQUETA).resolvidoEm).toBeNull();
  });

  it('RT8 B: a linha que o gancho abriu é a que o resolvedor fecha na coleta', async () => {
    const db = new FakeDb();
    await avisarArranjoAutomatico(asDb(db), entrada(), resultado('programado'));

    const r = await resolverAvisosDeDespachoSeEncerrado(
      asDb(db),
      encerramento({
        pacotes: [pacote('LOGISTICS_PICKUP_DONE')],
        estadoConfirmado: ESTADO_FRETE.postado,
      }),
      DEPOIS,
    );

    expect(r.etiquetaResolvida).toBe(true);
    expect(Object.keys(db.store)).toEqual([PATH_ETIQUETA]);
    expect(armazenado(db, PATH_ETIQUETA).resolucaoMotivo).toBe('coletado');
  });

  it('a entrada não carrega a ação do frete: portão por `acao` só no chamador — mutante 65', async () => {
    const obs: EncerramentoDespachoShopee = {
      integracaoId: INTEGRACAO,
      pedidoId: PEDIDO_ID,
      estadoConfirmado: ESTADO_FRETE.postado,
      orderStatus: null,
      pacotes: [pacote('LOGISTICS_PICKUP_DONE')],
      // @ts-expect-error — the resolver's input has no `acao`: a replay resolves too.
      acao: 'ignorado-sem-mudanca',
    };
    const db = await comTudoAberto();

    const r = await resolverAvisosDeDespachoSeEncerrado(asDb(db), obs, DEPOIS);

    expect(r).toEqual({ despachoResolvidos: 2, etiquetaResolvida: true });
  });

  it('o canal do arranjo do resolvedor é o MESMO conjunto do gancho', () => {
    // O resolvedor não tem lista de canais própria: ele chama os predicados de
    // `faseEtiqueta.ts`. ÂNCORA do valor que os testes acima usam.
    expect(CANAIS_ARRANJO_AUTOMATICO).toEqual([TURBO, TURBO_2, SO_ARRANJO]);
    expect((CANAIS_ARRANJO_AUTOMATICO as readonly number[]).includes(FORA)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  (8) o texto-fonte                                                          */
/* -------------------------------------------------------------------------- */

describe('8 — o texto-fonte do módulo', () => {
  const fonte = readFileSync(
    fileURLToPath(new URL('./despachoAutomatico.ts', import.meta.url)),
    'utf8',
  );

  it('não lê relógio, não converte, não loga e não nomeia a API de transação', () => {
    for (const proibido of [
      'console.',
      'Date.now(',
      'new Date(',
      'runTransaction',
      'millisToMicros',
      'coerceToMicros',
    ]) {
      expect(fonte, proibido).not.toContain(proibido);
    }
  });

  it('nunca nomeia o relógio de evento, um prazo nem um link externo — mutantes 60 e 61', () => {
    for (const proibido of ['relogioEvento', 'prazo:', 'urlExterna', 'limiteMs', 'canceladoEmMs']) {
      expect(fonte, proibido).not.toContain(proibido);
    }
  });

  it('⚠️ o CANCELLED é a constante do importador, nunca um literal local — mutante 70', () => {
    expect(fonte).not.toContain("'CANCELLED'");
    expect(fonte).toContain('SHOPEE_ORDER_STATUS.cancelled');
    expect(SHOPEE_ORDER_STATUS.cancelled).toBe('CANCELLED');
  });

  it('⚠️ o gancho é importado SÓ como tipo — o `rastrear:pedido` nunca carrega o arranjo', () => {
    const importsDoGancho =
      fonte.match(/import[^;]*from '\.\.\/pedidos\/arranjoAutomatico'/g) ?? [];
    // ÂNCORA: o módulo de fato importa os tipos do gancho.
    expect(importsDoGancho).toHaveLength(1);
    expect(importsDoGancho[0]?.startsWith('import type {')).toBe(true);
  });

  it('os slugs de resolução são os persistidos', () => {
    expect(RESOLUCAO_AVISO_DESPACHO).toEqual({
      arranjado: 'arranjado',
      nfeValidada: 'nfe-validada',
      coletado: 'coletado',
      pedidoCancelado: 'pedido-cancelado',
      envioEncerrado: 'envio-encerrado',
    });
    expect(CLASSE_DESPACHO_PENDENTE).toEqual({ nfe: 'nfe', manual: 'manual' });
  });

  it('a rota literal dos planos é a que o builder do schema produz (RT7)', () => {
    expect(URL_INTERNA.rota).toBe(ROTAS_AVISO.despachoCheckout.build(PEDIDO_ID));
  });
});
