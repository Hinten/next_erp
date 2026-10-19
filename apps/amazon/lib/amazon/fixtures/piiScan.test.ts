import { describe, expect, it } from 'vitest';

import { PLACEHOLDERS_DOCUMENTO_AMAZON, type ValorJsonAmazon, redigirCorpo } from '../core/redacao';
import { TAMANHO_DO_SAL, criarFalsificadorAmazon } from '../sanitizacao/falsificacao';
import { gerarCnpj, gerarCpf, pontuarCpf } from '../testing/documentos';
import { getOrderBr } from '../testing/sandboxBr';
import {
  type AchadoPiiAmazon,
  achadosDePadroes,
  contemNomeDeLoja,
  criarListaDeNomes,
  dobrarNomeDeLoja,
  piiScan,
  residuoDeRedacao,
  rotuloDeChave,
  tiposDoTextoAmazon,
  tiposNaLinhaAmazon,
} from './piiScan';
import type { EnvelopeFixtureAmazon } from './wireCorpus';

const CPF = gerarCpf('529982247');
const CNPJ = gerarCnpj('000001234567');
const GET_ORDER = '/orders/2026-01-01/orders/000-0000000-0000001';
const falsificador = () => criarFalsificadorAmazon(new Uint8Array(TAMANHO_DO_SAL).fill(5));

/** A CLEAN envelope: the real `fixture` profile over a body, with the keyed faker. */
function envelopeDe(corpo: unknown, caminho = GET_ORDER): EnvelopeFixtureAmazon {
  const r = redigirCorpo({ caminho, status: 200, corpo: JSON.stringify(corpo) }, 'fixture', {
    falsificador: falsificador(),
  });
  if (!r.ok) throw new Error(`refused: ${r.motivo}`);
  return {
    versao: 1,
    perfil: 'fixture',
    credencial: 'modelo-sandbox',
    papeis: ['nao-se-aplica'],
    capturadoEm: '2026-10-19',
    limiteTaxa: null,
    requisicao: { tipo: 'http', metodo: 'GET', caminho, query: [], corpo: null },
    resposta: {
      status: 200,
      politica: 'estrutural',
      forma: r.forma,
      bytes: r.bytes,
      corpo: r.corpo,
    },
    anexos: { zip: null },
  };
}

/** The same envelope with one leaf of the response body replaced (a hand edit). */
function editado(e: EnvelopeFixtureAmazon, caminho: readonly (string | number)[], valor: unknown) {
  const copia = JSON.parse(JSON.stringify(e)) as { resposta: { corpo: unknown } };
  let alvo = copia.resposta.corpo as Record<string | number, unknown>;
  for (const k of caminho.slice(0, -1)) alvo = alvo[k] as Record<string | number, unknown>;
  alvo[caminho[caminho.length - 1] ?? ''] = valor;
  return copia as unknown as EnvelopeFixtureAmazon;
}

const tiposDe = (achados: readonly AchadoPiiAmazon[]) => achados.map((a) => a.tipo);
const LIMPO = envelopeDe(getOrderBr());

describe('layer 1: residue', () => {
  it('CONTROL B (known-good): every committed-shape fixture is a fixpoint and reports nothing', () => {
    expect(piiScan(LIMPO)).toEqual([]);
    expect(residuoDeRedacao(LIMPO)).toEqual([]);
  });

  it('CONTROL A (known-bad): a hand-edited fixture is reported as residue, path by path', () => {
    const e = editado(LIMPO, ['order', 'buyer', 'buyerName'], 'Fulana de Tal');
    expect(residuoDeRedacao(e)).toEqual([
      { caminho: 'resposta.corpo.order.buyer.buyerName', tipo: 'residuo' },
    ]);
    // A real id left where a fake belongs: not in a fake format, so residue.
    const id = editado(LIMPO, ['order', 'orderId'], '123-4567890-1234567');
    expect(residuoDeRedacao(id)).toEqual([
      { caminho: 'resposta.corpo.order.orderId', tipo: 'residuo' },
    ]);
    // The request line, and a zip name.
    const linha = {
      ...LIMPO,
      requisicao: { ...LIMPO.requisicao, caminho: '/orders/2026-01-01/orders/123-4567890-1234567' },
    } as EnvelopeFixtureAmazon;
    expect(tiposDe(residuoDeRedacao(linha))).toEqual(['residuo']);
    const zip = { ...LIMPO, anexos: { zip: { entradas: [{ nome: 'Etiqueta.zpl', bytes: 1 }] } } };
    expect(residuoDeRedacao(zip)).toEqual([
      { caminho: 'anexos.zip.entradas.nome.*', tipo: 'residuo' },
    ]);
  });

  it('key ORDER alone is not residue', () => {
    const corpo = LIMPO.resposta.corpo as { order: Record<string, ValorJsonAmazon> };
    const invertido = Object.fromEntries(Object.entries(corpo.order).reverse());
    expect(
      residuoDeRedacao({ ...LIMPO, resposta: { ...LIMPO.resposta, corpo: { order: invertido } } }),
    ).toEqual([]);
  });

  it('near-miss: one changed character, a type change and an extra element are residue', () => {
    // The smallest differences a fold wider than key ORDER could swallow.
    expect(
      tiposDe(residuoDeRedacao(editado(LIMPO, ['order', 'buyer', 'buyerName'], 'REDACTEd'))),
    ).toEqual(['residuo']);
    expect(
      tiposDe(
        residuoDeRedacao(editado(LIMPO, ['order', 'orderItems', 0, 'quantityOrdered'], true)),
      ),
    ).toEqual(['residuo']);
    expect(tiposDe(residuoDeRedacao(editado(LIMPO, ['order', 'extra'], 'x')))).toEqual(['residuo']);
    const programas = (LIMPO.resposta.corpo as { order: { programs: string[] } }).order.programs;
    expect(
      residuoDeRedacao(editado(LIMPO, ['order', 'programs'], [...programas, 'Atza|x'])),
    ).toContainEqual({ caminho: 'resposta.corpo.order.programs.*', tipo: 'residuo' });
  });

  it('★ a DV-valid CPF as an all-digit path segment is a finding in BOTH layers', () => {
    const e = {
      ...LIMPO,
      requisicao: { ...LIMPO.requisicao, caminho: `/orders/2026-01-01/orders/${CPF}` },
    } as EnvelopeFixtureAmazon;
    expect(tiposDe(residuoDeRedacao(e))).toContain('residuo');
    expect(achadosDePadroes(e)).toContainEqual({ caminho: 'requisicao.caminho', tipo: 'cpf' });
  });

  it('★ a DV-valid CPF inside a pagination URL is a finding in BOTH layers', () => {
    const url = `https://sellingpartnerapi-na.amazon.com/orders/2026-01-01/orders?doc=${CPF}&page=2`;
    const e = editado(LIMPO, ['order', 'proximaPagina'], url);
    expect(residuoDeRedacao(e)).toContainEqual({
      caminho: 'resposta.corpo.order.proximaPagina',
      tipo: 'residuo',
    });
    const padroes = tiposDe(achadosDePadroes(e));
    expect(padroes).toContain('url');
    expect(padroes).toContain('cpf');
  });
});

describe('layer 2: patterns (each kind, a positive and a near-miss)', () => {
  it.each([
    ['email', 'fulana@exemplo.com.br', 'email'],
    ['a punctuated CPF', pontuarCpf(CPF), 'cpf'],
    ['an exact 11-digit CPF', CPF, 'cpf'],
    ['an exact 14-digit CNPJ', CNPJ, 'cnpj'],
    ['a phone', '+55 11 98765-4321', 'telefone'],
    ['a CEP', '01234-567', 'cep'],
    ['a street address', 'Rua das Flores 12', 'endereco'],
    ['an apartment', 'apto 45', 'endereco'],
    ['a real order id', '123-4567890-1234567', 'pedido-amazon'],
    ['a real ASIN', 'B012345678', 'asin'],
    ['a seller-shaped id', 'AZXCVBNMASDFG1', 'id-de-conta'],
    [
      'a real solution id',
      'amzn1.sp.solution.12345678-1234-1234-1234-123456789012',
      'id-de-aplicacao',
    ],
    ['an LWA token', 'Atza|IwEBIExemplo', 'token-lwa'],
    ['an AWS key id', 'AKIAABCDEFGHIJKLMNOP', 'chave-aws'],
    ['a URL with a query', 'https://exemplo.invalid/doc?x=1', 'url'],
  ])('%s is found', (_caso, valor, tipo) => {
    expect(tiposDoTextoAmazon(valor, null)).toContain(tipo);
    // …and a finding names a path and a kind, never the value.
    const achados = achadosDePadroes(editado(LIMPO, ['order', 'nota'], valor));
    expect(achados).toContainEqual({ caminho: 'resposta.corpo.order.nota', tipo });
    expect(JSON.stringify(achados)).not.toContain(valor);
  });

  it.each([
    ['the public BR marketplace id', 'A2Q3Y263D00KWC'],
    ['the seller-id placeholder', 'AXXXXXXXXXXXXX'],
    ['a placeholder CPF', PLACEHOLDERS_DOCUMENTO_AMAZON.cpfPontuado],
    ['a placeholder CNPJ', PLACEHOLDERS_DOCUMENTO_AMAZON.cnpj14],
    ['a fake order id', '000-0000000-1234567'],
    ['a fake ASIN', 'B0ZZ12AB34'],
    ['the all-zero solution id', 'amzn1.sp.solution.00000000-0000-0000-0000-000000000000'],
    ['an ISO date', '2026-10-19T10:00:00Z'],
    ['a money string', '1599.90'],
    ['the 44-digit chave', `${'0'.repeat(20)}55000000000123${'0'.repeat(9)}7`],
    ['a word holding a street word', 'Pruas e salas'],
  ])('near-miss: %s is NOT a finding', (_caso, valor) => {
    expect(achadosDePadroes(editado(LIMPO, ['order', 'nota'], valor))).toEqual([]);
  });

  it('★ the DV pass has NO exemption: a DV-valid 14-digit order item id is a finding', () => {
    const e = editado(LIMPO, ['order', 'orderItems', 0, 'orderItemId'], CNPJ);
    expect(achadosDePadroes(e)).toContainEqual({
      caminho: 'resposta.corpo.order.orderItems.*.orderItemId',
      tipo: 'cnpj',
    });
    // Near-miss: the same length with a wrong check digit is not.
    const errado = `${CNPJ.slice(0, 13)}${String((Number(CNPJ.charAt(13)) + 1) % 10)}`;
    expect(
      achadosDePadroes(editado(LIMPO, ['order', 'orderItems', 0, 'orderItemId'], errado)),
    ).toEqual([]);
  });

  it('an integer leaf with valid check digits is a finding; a quantity is not', () => {
    expect(tiposDe(achadosDePadroes(editado(LIMPO, ['order', 'n'], Number(CPF))))).toEqual(['cpf']);
    expect(achadosDePadroes(editado(LIMPO, ['order', 'n'], 12))).toEqual([]);
  });

  it('a key is scanned too, and printed only through rotuloDeChave', () => {
    const e = editado(LIMPO, ['order', 'fulana@exemplo.com.br'], 1);
    const achados = achadosDePadroes(e);
    expect(achados).toContainEqual({
      caminho: 'resposta.corpo.order.<redacted:email>',
      tipo: 'email',
    });
    expect(JSON.stringify(achados)).not.toContain('fulana');
    expect(rotuloDeChave('orderId', null)).toBe('orderId');
    expect(rotuloDeChave('a-b', null)).toBe('<chave>');
    expect(rotuloDeChave('termoficticiozeta', criarListaDeNomes(['Termo Ficticio Zeta']))).toBe(
      '<chave>',
    );
  });

  it('the denylist: a listed term in a leaf is a finding (CI has no list, so CI finds no names)', () => {
    const lista = criarListaDeNomes(['Termo Ficticio Zeta']);
    const e = editado(LIMPO, ['order', 'nota'], 'loja TERMO-FICTÍCIO-ZETA ltda');
    expect(tiposDe(achadosDePadroes(e, lista))).toEqual(['nome-de-loja']);
    expect(achadosDePadroes(e)).toEqual([]);
  });
});

describe('the denylist fold', () => {
  const lista = criarListaDeNomes(['Termo Ficticio', 'zeta']);

  it('a term matches its case and accent variants, and the same words with other separators', () => {
    expect(dobrarNomeDeLoja('  TERMO   Fictício! ')).toBe('termo ficticio');
    for (const t of [
      'Termo Ficticio',
      'TERMO FICTÍCIO',
      'termo-ficticio',
      'termoficticio',
      'x termo_ficticio y',
    ]) {
      expect(contemNomeDeLoja(t, lista), t).toBe(true);
    }
  });

  it('a term matches through percent-encoding, 1, 2 and 3 rounds', () => {
    expect(contemNomeDeLoja('termo%20ficticio', lista)).toBe(true);
    expect(contemNomeDeLoja('termo%2520ficticio', lista)).toBe(true);
    expect(contemNomeDeLoja('termo%252520ficticio', lista)).toBe(true);
    expect(contemNomeDeLoja('%7A%65%74%61', lista)).toBe(true);
    // An escape glued inside the word: dropped.
    expect(contemNomeDeLoja('termo%C3%A9ficticio', lista)).toBe(true);
  });

  it('near-miss: a term does not match a different word', () => {
    expect(contemNomeDeLoja('Termo Ficticia', lista)).toBe(false);
    // A single-word term never matches across two words.
    expect(contemNomeDeLoja('ze ta', lista)).toBe(false);
  });

  it('near-miss: percent-encoding never makes a different word match', () => {
    expect(contemNomeDeLoja('termo%20ficticia', lista)).toBe(false);
    expect(contemNomeDeLoja('%7A%65%74%6F', lista)).toBe(false);
  });
});

describe('free text (--verificar)', () => {
  const lista = criarListaDeNomes(['Termo Ficticio Zeta']);

  it('the redactor placeholders and the mandated fakes are skipped, by exact token', () => {
    expect(
      tiposNaLinhaAmazon(
        `"taxRegistrationNumber": "${PLACEHOLDERS_DOCUMENTO_AMAZON.cpfPontuado}"`,
        lista,
      ),
    ).toEqual([]);
    expect(
      tiposNaLinhaAmazon('"phone": "+00 00 0000-0000", "x": "redacted@example.invalid"', lista),
    ).toEqual([]);
    // A real document beside a placeholder is still found.
    expect(
      tiposNaLinhaAmazon(
        `${PLACEHOLDERS_DOCUMENTO_AMAZON.cpfPontuado} e ${pontuarCpf(CPF)}`,
        lista,
      ),
    ).toEqual(['cpf']);
  });

  it('string escapes are decoded so an embedded line break does not glue words', () => {
    expect(tiposNaLinhaAmazon('"nota": "Termo Ficticio\\nZeta"', lista)).toEqual(['nome-de-loja']);
  });
});
