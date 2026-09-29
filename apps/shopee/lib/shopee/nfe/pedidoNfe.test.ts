/**
 * The NF-e upload's decisions over snapshots (#1522, step 14): the pedido, the
 * conta, the slot rule and the key the channel will read.
 *
 * Every predicate is tested on its SCOPE (root CLAUDE.md): a PAIR that must
 * come out equal and the NEAR-MISSES that must stay distinct. The ⛔ titles
 * name the reconcile §4 mutant each test kills (45, 46, 47, and the slot half
 * of 58).
 *
 * ⚠️ Fixture keys are SYNTHETIC and visibly fake — cUF `99` (no such UF) and a
 * CNPJ of repeated digits, or an alphanumeric-CNPJ variant — assembled field by
 * field the way `notaNaShopee.test.ts` does, never a literal copied from
 * anywhere. The ids are the repo's fixture ids.
 */
import {
  ESTADO_NFE,
  INTEGRACAO_FRETE,
  INTEGRACAO_TIPO,
  integracaoSchema,
  type Integracao,
} from '@delfrance/schemas';
import { describe, expect, it } from 'vitest';

import { makePedidoIdShopee } from '../pedidos/orderIds';
import { MOTIVO_NFE_SHOPEE } from './errosNfe';
import {
  avaliarContaParaNfeShopee,
  avaliarPedidoParaNfeShopee,
  chaveDaNfeParaCanal,
  escolherNfeParaEnvioShopee,
} from './pedidoNfe';

/* -------------------------------------------------------------------------- */
/*                                  fixtures                                   */
/* -------------------------------------------------------------------------- */

const CONTA = 'int-1';
const ORDER_SN = '260910KJBHUJDM';
const OUTER_REF = `documents/integracao/${CONTA}`;
const PEDIDO_ID = makePedidoIdShopee(CONTA, ORDER_SN);

/** A synthetic key: cUF 99 + AAMM + CNPJ + mod 55 + série + nNF + tpEmis + cNF + DV. */
function montarChave(cnpj: string, nNF = '000000001'): string {
  return `99${'2609'}${cnpj}55${'000'}${nNF}1${'00000000'}0`;
}

/** The all-ones CNPJ (invalid by its own check digits). */
const CNPJ_FICTICIO = '1'.repeat(14);
/** An alphanumeric-CNPJ body (12 characters) + its two numeric check digits. */
const CNPJ_ALFANUMERICO_FICTICIO = `ZZ1ZZ2ZZ3ZZ4${'00'}`;

const K = montarChave(CNPJ_FICTICIO);
const K_ALFA = montarChave(CNPJ_ALFANUMERICO_FICTICIO);
/** Another legible key: the same, with a different nNF. */
const K_OUTRA = montarChave(CNPJ_FICTICIO, '000000002');

interface OpcoesDoProc {
  readonly chave?: string;
  readonly chNFe?: string | null;
  readonly tpAmb?: string;
  readonly tpNF?: string | null;
  readonly finNFe?: string | null;
}

/** A minimal synthetic `nfeProc` — no signature, no real party anywhere. */
function procXml(o: OpcoesDoProc = {}): string {
  const chave = o.chave ?? K;
  const chNFe = o.chNFe === undefined ? chave : o.chNFe;
  const tpAmb = o.tpAmb ?? '1';
  const tpNF = o.tpNF === undefined ? '1' : o.tpNF;
  const finNFe = o.finNFe === undefined ? '1' : o.finNFe;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">',
    `<NFe><infNFe versao="4.00" Id="NFe${chave}"><ide><cUF>99</cUF><mod>55</mod>`,
    tpNF === null ? '' : `<tpNF>${tpNF}</tpNF>`,
    `<tpAmb>${tpAmb}</tpAmb>`,
    finNFe === null ? '' : `<finNFe>${finNFe}</finNFe>`,
    '</ide><emit><xNome>TESTE SINTETICO SEM VALOR FISCAL</xNome></emit>',
    '</infNFe></NFe>',
    `<protNFe versao="4.00"><infProt><tpAmb>${tpAmb}</tpAmb>`,
    chNFe === null ? '' : `<chNFe>${chNFe}</chNFe>`,
    '<cStat>100</cStat></infProt></protNFe></nfeProc>',
  ].join('');
}

/** A raw `nfev4` document: aprovada, a produção SALE proc, authorized at `autorizadaMs`. */
function nfeRaw(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    estado: ESTADO_NFE.aprovada,
    chave: K,
    xml_nfe_proc: procXml(),
    data_autorizacao: 1_790_000_000_000,
    ...o,
  };
}

/** A raw Shopee pedido whose id recomputes from `(int-1, 260910KJBHUJDM)`. */
function pedidoRaw(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    numero: ORDER_SN,
    integracaoPedidoOuterRef: OUTER_REF,
    bloquearEmissaoNFe: false,
    freteInicial: { externalOptionIntegracao: INTEGRACAO_FRETE.shopee, pacotes: [] },
    ...o,
  };
}

const ENFILEIRAR = { acao: 'enfileirar', contaId: CONTA, orderSn: ORDER_SN } as const;

function ignorar(motivo: string): { acao: 'ignorar'; motivo: string } {
  return { acao: 'ignorar', motivo };
}

/** A parsed Shopee conta — every other field takes its schema default. */
function contaShopee(o: Partial<Integracao> = {}): Integracao {
  return {
    ...integracaoSchema.parse({ tipo: INTEGRACAO_TIPO.shopee, nome: 'Conta de teste' }),
    ...o,
  };
}

/* -------------------------------------------------------------------------- */
/*                         avaliarPedidoParaNfeShopee                          */
/* -------------------------------------------------------------------------- */

describe('avaliarPedidoParaNfeShopee — a posse é PROVADA, nunca inferida', () => {
  it('as identidades de teste: o id do pedido é o digest de (int-1, order_sn)', () => {
    expect(PEDIDO_ID).toMatch(/^[0-9a-f]{64}$/);
    expect(makePedidoIdShopee('int-2', ORDER_SN)).not.toBe(PEDIDO_ID);
  });

  it('1 — sem documento ⇒ `pedido-nao-encontrado`', () => {
    expect(avaliarPedidoParaNfeShopee(PEDIDO_ID, null)).toEqual(
      ignorar(MOTIVO_NFE_SHOPEE.pedidoNaoEncontrado),
    );
  });

  it('2 — PAR: um pedido provado enfileira com a conta e o order_sn DA PROVA', () => {
    expect(avaliarPedidoParaNfeShopee(PEDIDO_ID, pedidoRaw())).toEqual(ENFILEIRAR);
  });

  it.each([
    ['o id de OUTRA conta (o digest de int-2)', makePedidoIdShopee('int-2', ORDER_SN), {}],
    ['um id que não é digest nenhum', 'pedido-manual-1', {}],
    [
      'o mesmo id, mas sem `integracaoPedidoOuterRef`',
      PEDIDO_ID,
      { integracaoPedidoOuterRef: null },
    ],
    [
      'o mesmo id, mas OUTRA conta no outerRef',
      PEDIDO_ID,
      { integracaoPedidoOuterRef: 'documents/integracao/int-2' },
    ],
    ['o mesmo id, mas outro `numero`', PEDIDO_ID, { numero: '260910KJBHUJDN' }],
    ['o mesmo id, mas `numero` numérico', PEDIDO_ID, { numero: 260910 }],
  ])(
    '3 — ⛔ mutante 45 — QUASE-MISS: %s ⇒ `nao-shopee`, mesmo com frete e marcador da Shopee',
    (_rotulo, docId, extra) => {
      const raw = pedidoRaw({ marketplace: { tipo: 'shopee' }, ...extra });
      expect(avaliarPedidoParaNfeShopee(docId, raw)).toEqual(ignorar(MOTIVO_NFE_SHOPEE.naoShopee));
    },
  );

  it('4 — a prova vem ANTES do bloqueio: um pedido alheio bloqueado é `nao-shopee`', () => {
    const raw = pedidoRaw({ bloquearEmissaoNFe: true });
    expect(avaliarPedidoParaNfeShopee('pedido-manual-1', raw)).toEqual(
      ignorar(MOTIVO_NFE_SHOPEE.naoShopee),
    );
  });

  it('5 — `bloquearEmissaoNFe === true` ⇒ `emissao-bloqueada` (antes do frete de outra integradora)', () => {
    expect(avaliarPedidoParaNfeShopee(PEDIDO_ID, pedidoRaw({ bloquearEmissaoNFe: true }))).toEqual(
      ignorar(MOTIVO_NFE_SHOPEE.emissaoBloqueada),
    );
    const outraIntegradora = pedidoRaw({
      bloquearEmissaoNFe: true,
      freteInicial: { externalOptionIntegracao: INTEGRACAO_FRETE.melhorEnvios },
    });
    expect(avaliarPedidoParaNfeShopee(PEDIDO_ID, outraIntegradora)).toEqual(
      ignorar(MOTIVO_NFE_SHOPEE.emissaoBloqueada),
    );
  });

  it.each([false, null, undefined, 'true', 1])(
    '6 — QUASE-MISS: `bloquearEmissaoNFe` = %j NÃO bloqueia (só o booleano `true`)',
    (valor) => {
      expect(
        avaliarPedidoParaNfeShopee(PEDIDO_ID, pedidoRaw({ bloquearEmissaoNFe: valor })),
      ).toEqual(ENFILEIRAR);
    },
  );

  it.each([
    INTEGRACAO_FRETE.melhorEnvios,
    INTEGRACAO_FRETE.retiradaNaLoja,
    INTEGRACAO_FRETE.motoboy,
    INTEGRACAO_FRETE.mercadoLivre,
  ])('7 — um frete de OUTRA integradora (%s) ⇒ `frete-de-outra-integradora`', (integradora) => {
    const raw = pedidoRaw({ freteInicial: { externalOptionIntegracao: integradora } });
    expect(avaliarPedidoParaNfeShopee(PEDIDO_ID, raw)).toEqual(
      ignorar(MOTIVO_NFE_SHOPEE.freteDeOutraIntegradora),
    );
  });

  it.each(['Shopee', ' shopee', 'SHOPEE'])(
    '8 — QUASE-MISS: `externalOptionIntegracao` = %j NÃO é a da Shopee (comparação EXATA do nosso slug)',
    (integradora) => {
      const raw = pedidoRaw({ freteInicial: { externalOptionIntegracao: integradora } });
      expect(avaliarPedidoParaNfeShopee(PEDIDO_ID, raw)).toEqual(
        ignorar(MOTIVO_NFE_SHOPEE.freteDeOutraIntegradora),
      );
    },
  );

  it.each([
    ['`freteInicial: null`', { freteInicial: null }],
    ['`freteInicial` AUSENTE', { freteInicial: undefined }],
    [
      'um frete com `externalOptionIntegracao: null`',
      { freteInicial: { externalOptionIntegracao: null } },
    ],
    ['um frete SEM `externalOptionIntegracao`', { freteInicial: { pacotes: [] } }],
    ['um `freteInicial` que não é um mapa', { freteInicial: 'shopee' }],
  ])(
    '9 — ⛔ mutante 46 — o braço da corrida: %s num pedido PROVADO ⇒ ENFILEIRA',
    (_rotulo, extra) => {
      expect(avaliarPedidoParaNfeShopee(PEDIDO_ID, pedidoRaw(extra))).toEqual(ENFILEIRAR);
    },
  );

  it('10 — o veredito de enfileirar carrega SÓ a identidade provada (nenhum campo do pedido vaza)', () => {
    const resultado = avaliarPedidoParaNfeShopee(PEDIDO_ID, pedidoRaw({ chave: K }));
    expect(Object.keys(resultado).sort()).toEqual(['acao', 'contaId', 'orderSn']);
  });
});

/* -------------------------------------------------------------------------- */
/*                          avaliarContaParaNfeShopee                          */
/* -------------------------------------------------------------------------- */

describe('avaliarContaParaNfeShopee — `ativo !== true`, nunca `=== false`', () => {
  it('PAR: uma conta Shopee com `ativo: true` passa', () => {
    expect(avaliarContaParaNfeShopee(contaShopee({ ativo: true }))).toEqual({ ok: true });
  });

  it('sem conta ⇒ `conta-nao-configurada`', () => {
    expect(avaliarContaParaNfeShopee(null)).toEqual({
      ok: false,
      motivo: MOTIVO_NFE_SHOPEE.contaNaoConfigurada,
    });
  });

  it.each([INTEGRACAO_TIPO.mercadoLivre, INTEGRACAO_TIPO.nenhuma])(
    'uma conta de outro tipo (%s) ⇒ `conta-nao-configurada`, mesmo ativa',
    (tipo) => {
      expect(avaliarContaParaNfeShopee(contaShopee({ tipo, ativo: true }))).toEqual({
        ok: false,
        motivo: MOTIVO_NFE_SHOPEE.contaNaoConfigurada,
      });
    },
  );

  it('o tipo vem ANTES do `ativo`: uma conta de outro tipo desativada é `conta-nao-configurada`', () => {
    expect(
      avaliarContaParaNfeShopee(contaShopee({ tipo: INTEGRACAO_TIPO.mercadoLivre, ativo: false })),
    ).toEqual({ ok: false, motivo: MOTIVO_NFE_SHOPEE.contaNaoConfigurada });
  });

  it.each([
    ['false', false],
    ['null (⛔ mutante 47)', null],
    ['undefined', undefined],
    ["a string 'true'", 'true'],
  ])('QUASE-MISS: `ativo` = %s ⇒ `conta-inativa`', (_rotulo, ativo) => {
    const conta = { ...contaShopee(), ativo } as unknown as Integracao;
    expect(avaliarContaParaNfeShopee(conta)).toEqual({
      ok: false,
      motivo: MOTIVO_NFE_SHOPEE.contaInativa,
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                         escolherNfeParaEnvioShopee                          */
/* -------------------------------------------------------------------------- */

describe('escolherNfeParaEnvioShopee — a regra do slot', () => {
  it('uma NF-e aprovada de VENDA em produção ⇒ ela', () => {
    expect(escolherNfeParaEnvioShopee([{ id: 's1', raw: nfeRaw() }])).toEqual({ nfeId: 's1' });
  });

  it('PAR: duas aprovadas de venda ⇒ a de `data_autorizacao` MAIS RECENTE, em qualquer ordem da lista', () => {
    const antiga = { id: 's1', raw: nfeRaw({ data_autorizacao: 1_790_000_000_000 }) };
    const recente = { id: 's6', raw: nfeRaw({ data_autorizacao: 1_790_000_060_000 }) };
    expect(escolherNfeParaEnvioShopee([antiga, recente])).toEqual({ nfeId: 's6' });
    expect(escolherNfeParaEnvioShopee([recente, antiga])).toEqual({ nfeId: 's6' });
  });

  it('empate na autorização ⇒ o MENOR id, em qualquer ordem da lista', () => {
    const s7 = { id: 's7', raw: nfeRaw() };
    const s6 = { id: 's6', raw: nfeRaw() };
    expect(escolherNfeParaEnvioShopee([s7, s6])).toEqual({ nfeId: 's6' });
    expect(escolherNfeParaEnvioShopee([s6, s7])).toEqual({ nfeId: 's6' });
  });

  it('uma autorização ilegível (ou ausente) perde para qualquer data — e empata entre si pelo id', () => {
    const semData = { id: 's1', raw: nfeRaw({ data_autorizacao: null }) };
    const lixo = { id: 's4', raw: nfeRaw({ data_autorizacao: 'ontem' }) };
    const comData = { id: 's6', raw: nfeRaw({ data_autorizacao: 1 }) };
    expect(escolherNfeParaEnvioShopee([semData, lixo, comData])).toEqual({ nfeId: 's6' });
    expect(escolherNfeParaEnvioShopee([lixo, semData])).toEqual({ nfeId: 's1' });
  });

  it('QUASE-MISS de unidade: um carimbo em µs de um instante ANTERIOR não vence um ms posterior', () => {
    // Um carimbo legado em µs é numericamente ~1000× maior; comparar os números
    // crus escolheria o instante MAIS ANTIGO. A leitura é sempre em ms.
    const msPosterior = { id: 's1', raw: nfeRaw({ data_autorizacao: 1_790_000_000_000 }) };
    const usAnterior = { id: 's6', raw: nfeRaw({ data_autorizacao: 1_780_000_000_000_000 }) };
    expect(escolherNfeParaEnvioShopee([msPosterior, usAnterior])).toEqual({ nfeId: 's1' });
  });

  it('PAR de unidade: o mesmo instante em ISO e em ms empata, e decide o id', () => {
    const iso = { id: 's6', raw: nfeRaw({ data_autorizacao: '2026-09-21T14:13:20.000Z' }) };
    const ms = { id: 's1', raw: nfeRaw({ data_autorizacao: 1_790_000_000_000 }) };
    expect(escolherNfeParaEnvioShopee([iso, ms])).toEqual({ nfeId: 's1' });
  });

  it('uma DEVOLUÇÃO aprovada ao lado da venda ⇒ a VENDA, mesmo autorizada depois', () => {
    const venda = { id: 's1', raw: nfeRaw({ data_autorizacao: 1_790_000_000_000 }) };
    const devolucao = {
      id: 's6',
      raw: nfeRaw({ xml_nfe_proc: procXml({ finNFe: '4' }), data_autorizacao: 1_799_000_000_000 }),
    };
    expect(escolherNfeParaEnvioShopee([devolucao, venda])).toEqual({ nfeId: 's1' });
  });

  it.each([
    ['uma devolução (`finNFe 4`)', { finNFe: '4' }],
    ['uma complementar (`finNFe 2`)', { finNFe: '2' }],
    ['uma entrada (`tpNF 0`)', { tpNF: '0' }],
  ])('só %s aprovada ⇒ `nfe-nao-e-de-venda`', (_rotulo, opcoes) => {
    const raw = nfeRaw({ xml_nfe_proc: procXml(opcoes) });
    expect(escolherNfeParaEnvioShopee([{ id: 's1', raw }])).toEqual({
      motivo: MOTIVO_NFE_SHOPEE.nfeNaoEDeVenda,
    });
  });

  it('⛔ mutante 58 (metade do slot): um slot CANCELADO nunca é escolhido sobre a substituta aprovada, mesmo autorizado depois', () => {
    const cancelada = {
      id: 's1',
      raw: nfeRaw({ estado: ESTADO_NFE.cancelada, data_autorizacao: 1_799_000_000_000 }),
    };
    const substituta = {
      id: 's6',
      raw: nfeRaw({ chave: K_OUTRA, xml_nfe_proc: procXml({ chave: K_OUTRA }) }),
    };
    expect(escolherNfeParaEnvioShopee([cancelada, substituta])).toEqual({ nfeId: 's6' });
  });

  it('um proc de finalidade ILEGÍVEL continua elegível — quem responde `xml-invalido` é o handler', () => {
    const raw = nfeRaw({ xml_nfe_proc: procXml({ finNFe: null }) });
    expect(escolherNfeParaEnvioShopee([{ id: 's1', raw }])).toEqual({ nfeId: 's1' });
  });

  it.each([
    ['a lista vazia', []],
    ['só uma cancelada', [{ id: 's1', raw: nfeRaw({ estado: ESTADO_NFE.cancelada }) }]],
    [
      'uma rejeitada e uma gerada',
      [
        { id: 's1', raw: nfeRaw({ estado: ESTADO_NFE.rejeitada }) },
        { id: 's6', raw: nfeRaw({ estado: ESTADO_NFE.gerado }) },
      ],
    ],
  ])('nada aprovado (%s) ⇒ `sem-nfe-aprovada`', (_rotulo, docs) => {
    expect(escolherNfeParaEnvioShopee(docs)).toEqual({ motivo: MOTIVO_NFE_SHOPEE.semNfeAprovada });
  });

  it('aprovada sem proc ⇒ `xml-ausente`; aprovada em homologação ⇒ `tpamb-homologacao`', () => {
    expect(escolherNfeParaEnvioShopee([{ id: 's1', raw: nfeRaw({ xml_nfe_proc: null }) }])).toEqual(
      { motivo: MOTIVO_NFE_SHOPEE.xmlAusente },
    );
    expect(
      escolherNfeParaEnvioShopee([
        { id: 's1', raw: nfeRaw({ xml_nfe_proc: procXml({ tpAmb: '2' }) }) },
      ]),
    ).toEqual({ motivo: MOTIVO_NFE_SHOPEE.tpambHomologacao });
  });

  it('sem nenhuma elegível, vence a falta MAIS FUNDA na escada — em qualquer ordem da lista', () => {
    const cancelada = { id: 's1', raw: nfeRaw({ estado: ESTADO_NFE.cancelada }) };
    const semProc = { id: 's4', raw: nfeRaw({ xml_nfe_proc: null }) };
    const homologacao = { id: 's6', raw: nfeRaw({ xml_nfe_proc: procXml({ tpAmb: '2' }) }) };
    const devolucao = { id: 's7', raw: nfeRaw({ xml_nfe_proc: procXml({ finNFe: '4' }) }) };

    expect(escolherNfeParaEnvioShopee([cancelada, semProc])).toEqual({
      motivo: MOTIVO_NFE_SHOPEE.xmlAusente,
    });
    expect(escolherNfeParaEnvioShopee([homologacao, semProc, cancelada])).toEqual({
      motivo: MOTIVO_NFE_SHOPEE.tpambHomologacao,
    });
    expect(escolherNfeParaEnvioShopee([devolucao, homologacao, semProc])).toEqual({
      motivo: MOTIVO_NFE_SHOPEE.nfeNaoEDeVenda,
    });
    expect(escolherNfeParaEnvioShopee([semProc, homologacao, devolucao])).toEqual({
      motivo: MOTIVO_NFE_SHOPEE.nfeNaoEDeVenda,
    });
  });

  it('a regra é de NÍVEL: uma NF-e já pronta é escolhida (um re-envio existe para ela)', () => {
    // O predicado de TRANSIÇÃO responderia `ja-pronta` para um documento pronto
    // antes e depois; o re-envio da rota e da CLI parte exatamente daí.
    expect(escolherNfeParaEnvioShopee([{ id: 's1', raw: nfeRaw() }])).toEqual({ nfeId: 's1' });
  });
});

/* -------------------------------------------------------------------------- */
/*                             chaveDaNfeParaCanal                             */
/* -------------------------------------------------------------------------- */

describe('chaveDaNfeParaCanal — a chave de DENTRO do XML, conferida com o documento', () => {
  it('as chaves de teste são sintéticas e distintas', () => {
    for (const chave of [K, K_ALFA, K_OUTRA]) {
      expect(chave).toHaveLength(44);
      expect(chave.startsWith('99')).toBe(true);
    }
    expect(new Set([K, K_ALFA, K_OUTRA]).size).toBe(3);
  });

  it('PAR: o `chave` do documento igual ao do XML ⇒ a chave', () => {
    expect(chaveDaNfeParaCanal(nfeRaw())).toEqual({ chave: K });
  });

  it('PAR: uma chave de CNPJ ALFANUMÉRICO é lida como ela mesma', () => {
    const raw = nfeRaw({ chave: K_ALFA, xml_nfe_proc: procXml({ chave: K_ALFA }) });
    expect(chaveDaNfeParaCanal(raw)).toEqual({ chave: K_ALFA });
  });

  it.each([
    ['`chave: null`', null],
    ['`chave` ausente', undefined],
  ])('sem `chave` no documento (%s) ⇒ vale a do XML sozinha', (_rotulo, chave) => {
    expect(chaveDaNfeParaCanal(nfeRaw({ chave }))).toEqual({ chave: K });
  });

  it('PAR da dobra: espaços em volta do `chave` armazenado não o tornam outra chave', () => {
    expect(chaveDaNfeParaCanal(nfeRaw({ chave: `  ${K}\n` }))).toEqual({ chave: K });
  });

  it.each([
    ['OUTRA chave legível', K_OUTRA],
    ['a alfanumérica em minúsculas', K_ALFA.toLowerCase()],
    ['a chave espaçada como no DANFE', K.replace(/(.{4})(?=.)/g, '$1 ')],
    ['`NFe` + a chave', `NFe${K}`],
    ['os primeiros 43 caracteres', K.slice(0, 43)],
    ['uma string vazia', ''],
    ['um número', 12345],
  ])('QUASE-MISS: o `chave` do documento = %s ⇒ `xml-invalido`', (_rotulo, chave) => {
    const raw = nfeRaw({
      chave,
      xml_nfe_proc: procXml({ chave: chave === K_ALFA.toLowerCase() ? K_ALFA : K }),
    });
    expect(chaveDaNfeParaCanal(raw)).toEqual({ motivo: MOTIVO_NFE_SHOPEE.xmlInvalido });
  });

  it('o XML sem chave nenhuma ⇒ `xml-invalido`, mesmo com o `chave` do documento preenchido', () => {
    const raw = nfeRaw({ xml_nfe_proc: procXml({ chave: 'NAO-E-CHAVE' }) });
    expect(chaveDaNfeParaCanal(raw)).toEqual({ motivo: MOTIVO_NFE_SHOPEE.xmlInvalido });
  });

  it('o XML que se contradiz (`Id` ≠ `chNFe` do protocolo) ⇒ `xml-invalido`', () => {
    const raw = nfeRaw({ xml_nfe_proc: procXml({ chNFe: K_OUTRA }) });
    expect(chaveDaNfeParaCanal(raw)).toEqual({ motivo: MOTIVO_NFE_SHOPEE.xmlInvalido });
  });

  it.each([
    ['null', null],
    ['ausente', undefined],
    ['um número', 42],
  ])('sem proc em texto (`xml_nfe_proc` %s) ⇒ `xml-invalido`', (_rotulo, xml) => {
    expect(chaveDaNfeParaCanal(nfeRaw({ xml_nfe_proc: xml }))).toEqual({
      motivo: MOTIVO_NFE_SHOPEE.xmlInvalido,
    });
  });

  it('o veredito carrega SÓ a chave — nada do XML sai daqui', () => {
    expect(Object.keys(chaveDaNfeParaCanal(nfeRaw()))).toEqual(['chave']);
  });
});
