/**
 * The NF-e wire readers (#1522, step 14): our key from our XML, the sale gate,
 * the two folds, the four-verdict reader of `invoice_data` and the order gate.
 *
 * Every fold is tested on its SCOPE (root CLAUDE.md): a PAIR that must come out
 * equal and the NEAR-MISSES that must stay distinct — the near-misses are what
 * kill the widening mutants (reconcile §4, mutants 14–24).
 *
 * ⚠️ Fixture keys are SYNTHETIC and visibly fake: cUF `99` (no such UF) and a
 * CNPJ of repeated digits — or an alphanumeric-CNPJ variant for the `[0-9A-Z]`
 * window — assembled field by field, never a literal copied from anywhere.
 */
import { shopeeInvoiceDataSchema, type ShopeeOrderDetailRow } from '@delfrance/integrations-shopee';
import { CHAVE_NFE_REGEX } from '@delfrance/schemas';
import { describe, expect, it } from 'vitest';

import { pedidoForaDoBrasil } from '../pedidos/orderMapping';
import { MOTIVOS_QUE_AVISAM, MOTIVOS_QUE_CARIMBAM, MOTIVO_NFE_SHOPEE } from './errosNfe';
import {
  chaveCanonica,
  chaveDoProc,
  finalidadeDoProc,
  lerNotaNaShopee,
  portaoDoPedido,
  statusDaNota,
  type NotaNaShopee,
} from './notaNaShopee';

/* -------------------------------------------------------------------------- */
/*                                  fixtures                                   */
/* -------------------------------------------------------------------------- */

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
  readonly idAttr?: string | null;
  readonly chNFe?: string | null;
  readonly tpNF?: string | null;
  readonly finNFe?: string | null;
  readonly ns?: string;
  readonly aspas?: '"' | "'";
}

/** A minimal synthetic `nfeProc` — no signature, no real party anywhere. */
function procXml(o: OpcoesDoProc = {}): string {
  const p = o.ns === undefined ? '' : `${o.ns}:`;
  const q = o.aspas ?? '"';
  const id = o.idAttr === undefined ? `NFe${K}` : o.idAttr;
  const idParte = id === null ? '' : ` Id=${q}${id}${q}`;
  const tpNF = o.tpNF === undefined ? '1' : o.tpNF;
  const finNFe = o.finNFe === undefined ? '1' : o.finNFe;
  const chNFe = o.chNFe === undefined ? K : o.chNFe;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<${p}nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">`,
    `<${p}NFe><${p}infNFe versao="4.00"${idParte}><${p}ide><${p}cUF>99</${p}cUF><${p}mod>55</${p}mod>`,
    tpNF === null ? '' : `<${p}tpNF>${tpNF}</${p}tpNF>`,
    finNFe === null ? '' : `<${p}finNFe>${finNFe}</${p}finNFe>`,
    `</${p}ide><${p}emit><${p}xNome>TESTE SINTETICO SEM VALOR FISCAL</${p}xNome></${p}emit>`,
    `</${p}infNFe></${p}NFe>`,
    `<${p}protNFe versao="4.00"><${p}infProt><${p}tpAmb>1</${p}tpAmb>`,
    chNFe === null ? '' : `<${p}chNFe>${chNFe}</${p}chNFe>`,
    `<${p}cStat>100</${p}cStat></${p}infProt></${p}protNFe></${p}nfeProc>`,
  ].join('');
}

type LinhaDaNota = Pick<ShopeeOrderDetailRow, 'region' | 'invoice_data'>;

function linhaBr(
  invoice: Record<string, unknown> | null,
  region: string | null = 'BR',
): LinhaDaNota {
  return {
    region,
    invoice_data: invoice === null ? null : shopeeInvoiceDataSchema.parse(invoice),
  };
}

type LinhaDoPortao = Pick<
  ShopeeOrderDetailRow,
  'region' | 'fulfillment_flag' | 'is_international' | 'order_status'
>;

function linhaDoPortao(o: Partial<LinhaDoPortao> = {}): LinhaDoPortao {
  return {
    region: 'BR',
    fulfillment_flag: 'fulfilled_by_local_seller',
    is_international: false,
    order_status: 'READY_TO_SHIP',
    ...o,
  };
}

/** The DANFE layout: eleven groups of four characters. */
function espacadaComoDanfe(chave: string): string {
  return chave.replace(/(.{4})(?=.)/g, '$1 ');
}

describe('as chaves de teste', () => {
  it('são sintéticas, têm 44 caracteres e passam no CHAVE_NFE_REGEX (a alfanumérica também)', () => {
    for (const chave of [K, K_ALFA, K_OUTRA]) {
      expect(chave).toHaveLength(44);
      expect(chave.startsWith('99')).toBe(true);
      expect(CHAVE_NFE_REGEX.test(chave)).toBe(true);
    }
    expect(K_OUTRA).not.toBe(K);
  });
});

/* -------------------------------------------------------------------------- */
/*                                 chaveDoProc                                 */
/* -------------------------------------------------------------------------- */

describe('chaveDoProc — a chave NOSSA é a de dentro do XML', () => {
  it('1 — lê `infNFe/@Id` sem o prefixo `NFe`, conferida com o `chNFe` do protocolo', () => {
    expect(chaveDoProc(procXml())).toEqual({ chave: K });
  });

  it('2 — ⛔ mutante 20: uma chave de CNPJ ALFANUMÉRICO é aceita (nunca só dígitos)', () => {
    expect(chaveDoProc(procXml({ idAttr: `NFe${K_ALFA}`, chNFe: K_ALFA }))).toEqual({
      chave: K_ALFA,
    });
  });

  it('3 — ⛔ mutante 21: `Id` e `chNFe` divergentes dão `chaves-divergentes`', () => {
    expect(chaveDoProc(procXml({ chNFe: K_OUTRA }))).toEqual({ erro: 'chaves-divergentes' });
  });

  it('4 — ⛔ um `chNFe` vazio ou ilegível no protocolo também é divergência (o documento se contradiz)', () => {
    expect(chaveDoProc(procXml({ chNFe: '' }))).toEqual({ erro: 'chaves-divergentes' });
    expect(chaveDoProc(procXml({ chNFe: K.slice(0, 43) }))).toEqual({
      erro: 'chaves-divergentes',
    });
  });

  it('5 — PAR: espaços em volta do `chNFe` não o tornam outra chave', () => {
    expect(chaveDoProc(procXml({ chNFe: `  ${K}\n` }))).toEqual({ chave: K });
  });

  it('6 — sem protocolo nenhum, vale a chave do `Id` sozinha', () => {
    expect(chaveDoProc(procXml({ chNFe: null }))).toEqual({ chave: K });
  });

  it('7 — um `chNFe` ANTES do protocolo (dentro do infNFe) nunca é lido como o do protocolo', () => {
    const xml = procXml().replace('</ide>', `</ide><refX><chNFe>${K_OUTRA}</chNFe></refX>`);
    expect(chaveDoProc(xml)).toEqual({ chave: K });
  });

  it.each([
    ['sem atributo `Id`', procXml({ idAttr: null })],
    ['`Id` sem o prefixo `NFe`', procXml({ idAttr: K })],
    ['`Id` com o prefixo em minúsculas', procXml({ idAttr: `nfe${K}` })],
    ['`Id` com 43 caracteres', procXml({ idAttr: `NFe${K.slice(0, 43)}` })],
    ['`Id` com um caractere a mais', procXml({ idAttr: `NFe${K}0` })],
    ['`Id` com as letras do CNPJ em minúsculas', procXml({ idAttr: `NFe${K_ALFA.toLowerCase()}` })],
    ['`Id` com uma letra FORA da janela do CNPJ', procXml({ idAttr: `NFe${K.slice(0, 43)}A` })],
    ['`Id` espaçado como no DANFE', procXml({ idAttr: `NFe${espacadaComoDanfe(K)}` })],
    ['um XML que não é NF-e', '<qualquerCoisa>sem nota</qualquerCoisa>'],
    ['texto vazio', ''],
  ])('8 — ⛔ QUASE-MISS: %s ⇒ `sem-chave`', (_rotulo, xml) => {
    expect(chaveDoProc(xml)).toEqual({ erro: 'sem-chave' });
  });

  it('9 — ⛔ `infNFeSupl` não é `infNFe`: sem um `infNFe` de verdade não há chave', () => {
    const xml = `<nfeProc><NFe><infNFeSupl Id="NFe${K}"></infNFeSupl></NFe></nfeProc>`;
    expect(chaveDoProc(xml)).toEqual({ erro: 'sem-chave' });
  });

  it('10 — PAR: prefixo de namespace nas tags e aspas simples no `Id` leem a mesma chave', () => {
    expect(chaveDoProc(procXml({ ns: 'nfe', aspas: "'" }))).toEqual({ chave: K });
  });
});

/* -------------------------------------------------------------------------- */
/*                              finalidadeDoProc                               */
/* -------------------------------------------------------------------------- */

describe('finalidadeDoProc — só a nota de VENDA vai ao canal (R-p)', () => {
  it('1 — `tpNF 1` + `finNFe 1` é venda', () => {
    expect(finalidadeDoProc(procXml())).toBe('venda');
  });

  it('2 — ⛔ mutante 23: uma DEVOLUÇÃO (`finNFe 4`) e uma ENTRADA (`tpNF 0`) são `outra`', () => {
    expect(finalidadeDoProc(procXml({ finNFe: '4' }))).toBe('outra');
    expect(finalidadeDoProc(procXml({ tpNF: '0' }))).toBe('outra');
  });

  it.each(['2', '3', '5', '6', '9'])(
    '3 — ⛔ QUASE-MISS: `finNFe %s` legível e não normal é `outra` (nunca venda, nunca carimbo)',
    (finNFe) => {
      expect(finalidadeDoProc(procXml({ finNFe }))).toBe('outra');
    },
  );

  it.each([
    ['sem `tpNF`', procXml({ tpNF: null })],
    ['sem `finNFe`', procXml({ finNFe: null })],
    ['`tpNF` vazio', procXml({ tpNF: '' })],
    ['`finNFe` com letra', procXml({ finNFe: 'x' })],
    ['`tpNF` `01` (dois dígitos — nunca lido como `1`)', procXml({ tpNF: '01' })],
    ['`finNFe` `11`', procXml({ finNFe: '11' })],
    ['texto que não é XML', 'nada aqui'],
  ])('4 — ⛔ %s ⇒ `ilegivel`', (_rotulo, xml) => {
    expect(finalidadeDoProc(xml)).toBe('ilegivel');
  });

  it('5 — PAR: espaços em volta do dígito não mudam a leitura; o namespace também não', () => {
    expect(finalidadeDoProc(procXml({ tpNF: ' 1 ', finNFe: '\n1\n' }))).toBe('venda');
    expect(finalidadeDoProc(procXml({ ns: 'nfe' }))).toBe('venda');
  });

  it('6 — vale o PRIMEIRO elemento de cada: um segundo `tpNF 0` depois não muda nada', () => {
    const xml = procXml().replace(
      '</nfeProc>',
      '<extra><tpNF>0</tpNF><finNFe>4</finNFe></extra></nfeProc>',
    );
    expect(finalidadeDoProc(xml)).toBe('venda');
  });
});

/* -------------------------------------------------------------------------- */
/*                                chaveCanonica                                */
/* -------------------------------------------------------------------------- */

describe('chaveCanonica — `trim()` + o regex, e NADA mais', () => {
  it.each([
    ['a própria chave', K],
    ['espaços dos dois lados', `  ${K}  `],
    ['uma quebra de linha no fim', `${K}\n`],
    ['um TAB na frente', `\t${K}`],
  ])('PAR: %s ⇒ K', (_rotulo, bruta) => {
    expect(chaveCanonica(bruta)).toBe(K);
  });

  it('PAR: a chave alfanumérica é lida como ela mesma', () => {
    expect(chaveCanonica(` ${K_ALFA} `)).toBe(K_ALFA);
  });

  it('⛔ QUASE-MISS: K com UM dígito trocado no meio é OUTRA chave legível, nunca K', () => {
    const meio = 30;
    const trocada = `${K.slice(0, meio)}${K[meio] === '9' ? '8' : '9'}${K.slice(meio + 1)}`;
    expect(chaveCanonica(trocada)).toBe(trocada);
    expect(chaveCanonica(trocada)).not.toBe(K);
  });

  it('⛔ QUASE-MISS: K com o DÍGITO VERIFICADOR trocado é outra chave, nunca K', () => {
    const outroDv = `${K.slice(0, 43)}${K.endsWith('0') ? '1' : '0'}`;
    expect(chaveCanonica(outroDv)).toBe(outroDv);
    expect(chaveCanonica(outroDv)).not.toBe(K);
  });

  it.each([
    ['⛔ mutante 14: os 43 primeiros caracteres de K', K.slice(0, 43)],
    ['K + um caractere', `${K}0`],
    ['⛔ mutante 16: `NFe` + K', `NFe${K}`],
    ['⛔ mutante 15: a chave alfanumérica em MINÚSCULAS', K_ALFA.toLowerCase()],
    ['⛔ mutante 17: K espaçada como no DANFE', espacadaComoDanfe(K)],
    ['o sentinela de ausência `-`', '-'],
    ['texto vazio', ''],
    ['só espaços', '   '],
  ])('QUASE-MISS: %s ⇒ null', (_rotulo, bruta) => {
    expect(chaveCanonica(bruta)).toBeNull();
  });

  it('null ⇒ null', () => {
    expect(chaveCanonica(null)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                                statusDaNota                                 */
/* -------------------------------------------------------------------------- */

describe('statusDaNota — `trim()` + minúsculas, e um casamento EXATO', () => {
  it.each(['valid', ' VALID ', 'Valid\t'])('PAR: %j ⇒ valida', (bruto) => {
    expect(statusDaNota(bruto)).toBe('valida');
  });

  it.each(['pending', 'Pending', ' PENDING\n'])('PAR: %j ⇒ pendente', (bruto) => {
    expect(statusDaNota(bruto)).toBe('pendente');
  });

  it.each([
    ['⛔ mutante 19: `invalid` (contém `valid`)', 'invalid'],
    ['`validated`', 'validated'],
    ['`pending_review`', 'pending_review'],
    ['o português `valida`', 'valida'],
    ['`valid.`', 'valid.'],
  ])('QUASE-MISS: %s ⇒ desconhecido', (_rotulo, bruto) => {
    expect(statusDaNota(bruto)).toBe('desconhecido');
  });

  it.each([null, '', '   '])('%j ⇒ ausente', (bruto) => {
    expect(statusDaNota(bruto)).toBe('ausente');
  });
});

/* -------------------------------------------------------------------------- */
/*                               lerNotaNaShopee                               */
/* -------------------------------------------------------------------------- */

describe('lerNotaNaShopee — quatro vereditos', () => {
  it('1 — um pedido ESTRANGEIRO é `nao-br`, mesmo que `invoice_data` traga a nossa chave', () => {
    expect(lerNotaNaShopee(linhaBr({ access_key: K, status: 'valid' }, 'SG'), K)).toEqual({
      veredito: 'nao-br',
    });
    expect(lerNotaNaShopee(linhaBr(null, 'SG'), K)).toEqual({ veredito: 'nao-br' });
  });

  it('2 — ⛔ mutante 22: um pedido BR SEM `invoice_data` é `sem-nota` (sobe), NUNCA `nao-br`', () => {
    const nota = lerNotaNaShopee(linhaBr(null), K);
    expect(nota).toEqual({ veredito: 'sem-nota', status: 'ausente', invoiceDataAusente: true });
    expect(nota.veredito).not.toBe('nao-br');
  });

  it('3 — uma região AUSENTE não é estrangeira: `invoice_data` nulo ⇒ `sem-nota`', () => {
    expect(lerNotaNaShopee(linhaBr(null, null), K)).toEqual({
      veredito: 'sem-nota',
      status: 'ausente',
      invoiceDataAusente: true,
    });
  });

  it.each([
    ['⛔ mutante 18: `""` (a amostra da própria Shopee)', ''],
    ['só espaços', '   '],
    ['nula', null],
  ])('4 — chave %s ⇒ `sem-nota`, NUNCA `outra`', (_rotulo, access_key) => {
    expect(lerNotaNaShopee(linhaBr({ access_key }), K)).toEqual({
      veredito: 'sem-nota',
      status: 'ausente',
      invoiceDataAusente: false,
    });
  });

  it('5 — `sem-nota` carrega o status: `valid` sem chave é a leitura `nota-dispensada` do handler', () => {
    expect(lerNotaNaShopee(linhaBr({ access_key: '', status: 'valid' }), K)).toEqual({
      veredito: 'sem-nota',
      status: 'valida',
      invoiceDataAusente: false,
    });
  });

  it('6 — a NOSSA chave validada ⇒ `nossa` + `valida`, sem motivo pendente', () => {
    expect(
      lerNotaNaShopee(linhaBr({ access_key: K, status: 'valid', pending_reason: 'x' }), K),
    ).toEqual({ veredito: 'nossa', status: 'valida', motivoPendente: null });
  });

  it('7 — PAR: a nossa chave com espaços em volta continua sendo `nossa`', () => {
    const nota = lerNotaNaShopee(linhaBr({ access_key: ` ${K}\n`, status: 'valid' }), K);
    expect(nota.veredito).toBe('nossa');
  });

  it('8 — `pendente` + motivo ⇒ o motivo SANITIZADO: a chave some, o cStat fica', () => {
    const nota = lerNotaNaShopee(
      linhaBr({
        access_key: K,
        status: 'pending',
        pending_reason: `Rejeição 539: Duplicidade de NF-e [chNFe:${K}]`,
      }),
      K,
    );
    expect(nota.veredito).toBe('nossa');
    const motivo = (nota as Extract<NotaNaShopee, { veredito: 'nossa' }>).motivoPendente;
    expect(motivo).not.toBeNull();
    expect(motivo).toContain('539');
    expect(motivo).not.toContain(K);
    expect(motivo).not.toContain(K.slice(0, 20));
  });

  it('9 — `pendente` SEM motivo ⇒ `motivoPendente: null`', () => {
    expect(lerNotaNaShopee(linhaBr({ access_key: K, status: 'pending' }), K)).toEqual({
      veredito: 'nossa',
      status: 'pendente',
      motivoPendente: null,
    });
  });

  it('10 — ⛔ `invalid` na nossa nota é `desconhecido`, NUNCA `valida` (não resolveria o aviso de uma nota recusada)', () => {
    expect(lerNotaNaShopee(linhaBr({ access_key: K, status: 'invalid' }), K)).toEqual({
      veredito: 'nossa',
      status: 'desconhecido',
      motivoPendente: null,
    });
  });

  it('11 — OUTRA chave legível ⇒ `outra`, legível, com a chave (para a regra da irmã cancelada)', () => {
    expect(lerNotaNaShopee(linhaBr({ access_key: K_OUTRA, status: 'valid' }), K)).toEqual({
      veredito: 'outra',
      legivel: true,
      chave: K_OUTRA,
    });
  });

  it.each([
    ['⛔ mutante 16: `NFe` + K', `NFe${K}`],
    ['⛔ mutante 14: os 43 primeiros de K', K.slice(0, 43)],
    ['⛔ mutante 17: K espaçada como no DANFE', espacadaComoDanfe(K)],
    ['o sentinela `-`', '-'],
  ])('12 — QUASE-MISS: %s ⇒ `outra` ILEGÍVEL, nunca `nossa`', (_rotulo, access_key) => {
    expect(lerNotaNaShopee(linhaBr({ access_key }), K)).toEqual({
      veredito: 'outra',
      legivel: false,
      chave: null,
    });
  });

  it('13 — ⛔ mutante 15: a NOSSA chave alfanumérica em minúsculas é `outra` ilegível', () => {
    expect(lerNotaNaShopee(linhaBr({ access_key: K_ALFA.toLowerCase() }), K_ALFA)).toEqual({
      veredito: 'outra',
      legivel: false,
      chave: null,
    });
    expect(lerNotaNaShopee(linhaBr({ access_key: K_ALFA }), K_ALFA).veredito).toBe('nossa');
  });
});

/* -------------------------------------------------------------------------- */
/*                         pedidoForaDoBrasil (extraído)                       */
/* -------------------------------------------------------------------------- */

describe('pedidoForaDoBrasil — o predicado ÚNICO de "sem NF-e" (emissão e envio)', () => {
  it('PAR: `BR` e uma região ausente NÃO são estrangeiras', () => {
    expect(pedidoForaDoBrasil('BR')).toBe(false);
    expect(pedidoForaDoBrasil(null)).toBe(false);
  });

  it('⛔ QUASE-MISS: `SG`, `br` minúsculo e `BR ` com espaço SÃO estrangeiras (casamento exato)', () => {
    expect(pedidoForaDoBrasil('SG')).toBe(true);
    expect(pedidoForaDoBrasil('br')).toBe(true);
    expect(pedidoForaDoBrasil('BR ')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*                                portaoDoPedido                               */
/* -------------------------------------------------------------------------- */

describe('portaoDoPedido — o portão do pedido, na ORDEM declarada', () => {
  it('1 — um pedido BR comum, pronto para envio, SEGUE', () => {
    expect(portaoDoPedido(linhaDoPortao())).toEqual({ segue: true });
  });

  it('2 — estrangeiro ⇒ `pedido-nao-br`, antes de qualquer outra regra', () => {
    expect(
      portaoDoPedido(
        linhaDoPortao({
          region: 'SG',
          fulfillment_flag: 'fulfilled_by_shopee',
          order_status: 'CANCELLED',
        }),
      ),
    ).toEqual({ segue: false, motivo: 'pedido-nao-br' });
  });

  it('3 — uma região ausente não barra o pedido', () => {
    expect(portaoDoPedido(linhaDoPortao({ region: null }))).toEqual({ segue: true });
  });

  it('4 — FBS ⇒ `pedido-fbs`; PAR: a grafia com espaços e maiúsculas é a mesma', () => {
    for (const fulfillment_flag of ['fulfilled_by_shopee', ' Fulfilled_By_Shopee ']) {
      expect(portaoDoPedido(linhaDoPortao({ fulfillment_flag }))).toEqual({
        segue: false,
        motivo: 'pedido-fbs',
      });
    }
  });

  it('5 — cross-border ⇒ `loja-cross-border` (a grafia do passo 13)', () => {
    expect(portaoDoPedido(linhaDoPortao({ fulfillment_flag: 'fulfilled_by_cb_seller' }))).toEqual({
      segue: false,
      motivo: 'loja-cross-border',
    });
  });

  it.each([
    ['o vendedor local', 'fulfilled_by_local_seller'],
    ['nulo', null],
    ['⛔ QUASE-MISS: um sufixo a mais', 'fulfilled_by_shopee_x'],
    ['⛔ QUASE-MISS: sem os sublinhados', 'fulfilled by shopee'],
  ])('6 — `fulfillment_flag` %s SEGUE', (_rotulo, fulfillment_flag) => {
    expect(portaoDoPedido(linhaDoPortao({ fulfillment_flag }))).toEqual({ segue: true });
  });

  it('7 — exportação (`is_international === true`) ⇒ `pedido-exportacao`; `false` e `null` seguem', () => {
    expect(portaoDoPedido(linhaDoPortao({ is_international: true }))).toEqual({
      segue: false,
      motivo: 'pedido-exportacao',
    });
    expect(portaoDoPedido(linhaDoPortao({ is_international: false }))).toEqual({ segue: true });
    expect(portaoDoPedido(linhaDoPortao({ is_international: null }))).toEqual({ segue: true });
  });

  it('8 — `CANCELLED` ⇒ `pedido-cancelado`', () => {
    expect(portaoDoPedido(linhaDoPortao({ order_status: 'CANCELLED' }))).toEqual({
      segue: false,
      motivo: 'pedido-cancelado',
    });
  });

  it('9 — ⛔ mutante 24: `IN_CANCEL` NÃO barra — envia e classifica', () => {
    expect(portaoDoPedido(linhaDoPortao({ order_status: 'IN_CANCEL' }))).toEqual({ segue: true });
  });

  it('10 — ⛔ QUASE-MISS: `cancelled` minúsculo não é `CANCELLED` (casamento exato)', () => {
    expect(portaoDoPedido(linhaDoPortao({ order_status: 'cancelled' }))).toEqual({ segue: true });
  });

  it('11 — a ORDEM: FBS antes de exportação, exportação antes de cancelado', () => {
    expect(
      portaoDoPedido(
        linhaDoPortao({ fulfillment_flag: 'fulfilled_by_shopee', is_international: true }),
      ),
    ).toEqual({ segue: false, motivo: 'pedido-fbs' });
    expect(
      portaoDoPedido(linhaDoPortao({ is_international: true, order_status: 'CANCELLED' })),
    ).toEqual({ segue: false, motivo: 'pedido-exportacao' });
  });

  it('12 — só `pedido-exportacao` avisa, e nenhum motivo do portão carimba (os conjuntos decidem)', () => {
    const motivos = [
      MOTIVO_NFE_SHOPEE.pedidoNaoBr,
      MOTIVO_NFE_SHOPEE.pedidoFbs,
      MOTIVO_NFE_SHOPEE.lojaCrossBorder,
      MOTIVO_NFE_SHOPEE.pedidoExportacao,
      MOTIVO_NFE_SHOPEE.pedidoCancelado,
    ];
    expect(motivos.filter((m) => MOTIVOS_QUE_AVISAM.has(m))).toEqual(['pedido-exportacao']);
    expect(motivos.filter((m) => MOTIVOS_QUE_CARIMBAM.has(m))).toEqual([]);
  });
});
