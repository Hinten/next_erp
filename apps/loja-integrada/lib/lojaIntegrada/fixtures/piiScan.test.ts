import { describe, expect, it } from 'vitest';

import { FALSO_LI, type ValorJsonLi, redigirCorpo } from '../core/redacao';
import { PII_FALSA, gerarCnpj, gerarCpf } from '../testing/especificacaoPii';
import {
  achadosDePadroes,
  contemNomeDeLoja,
  criarListaDeNomes,
  dobrarNomeDeLoja,
  formatarAchadosLi,
  piiScan,
  residuoDeRedacao,
  rotuloDeChave,
  semFalsosConhecidosLi,
  tiposNaLinhaLi,
} from './piiScan';
import type { EnvelopeFixtureLi } from './wireCorpus';

/* Synthetic PII lives inline here, generated at run time — never in `__wire__/`. */
const CPF = gerarCpf('529982247');
const CPF_INVALIDO = `${CPF.slice(0, 10)}${String((Number(CPF[10]) + 1) % 10)}`;
const CNPJ = gerarCnpj('112223330001');
const CNPJ_LETRA = gerarCnpj('12ABC34501DE');
const CNPJ_LETRA_INVALIDO = `${CNPJ_LETRA.slice(0, 13)}${String((Number(CNPJ_LETRA[13]) + 1) % 10)}`;
const SENTINELA = 'SENTINELA-7f3a9c';
/**
 * `--verificar` skips addresses under a reserved domain, so proving it flags one
 * needs a domain that is not reserved. Assembled at run time: the committed text
 * holds no such address.
 */
const EMAIL_FORA_DO_RESERVADO = ['cliente.real', 'exemplo.com.br'].join('@');
const LISTA = criarListaDeNomes(['Loja Exemplo', 'lojaexemplo.com.br']);

function envelope(
  caminho: string,
  status: number,
  corpo: ValorJsonLi,
  query: readonly (readonly [string, string])[] = [],
): EnvelopeFixtureLi {
  return {
    versao: 1,
    perfil: 'fixture',
    credencial: 'personal-token',
    capturadoEm: '2026-10-07',
    requisicao: { metodo: 'GET', caminho, query },
    resposta: {
      status,
      politica: 'estrutural',
      forma: corpo === null ? 'vazio' : 'json',
      bytes: 10,
      corpo,
    },
  };
}

/** The fixture profile's own output for a body (what the sanitizer would write). */
function sanitizado(caminho: string, status: number, corpo: unknown): ValorJsonLi {
  const r = redigirCorpo({ caminho, status, corpo: JSON.stringify(corpo) }, 'fixture');
  if (!r.ok) throw new Error(`refused: ${r.motivo}`);
  return r.corpo;
}

const PEDIDO_CRU = {
  meta: { limit: 20, offset: 0, total_count: 1, next: null, previous: null },
  objects: [
    {
      numero: 1234,
      cliente: {
        nome: PII_FALSA.nome,
        email: 'cliente.real@exemplo.invalid',
        cpf: CPF,
        telefone_celular: '(00) 91234-5678',
      },
      endereco_entrega: { endereco: 'Rua Exemplo, 10', cep: '00000-001', numero: '10' },
      itens: [{ sku: 'CAM-001-P', quantidade: '2.000', preco_venda: '59.90' }],
      obs: SENTINELA,
    },
  ],
};

describe('piiScan — the two controls', () => {
  it('CONTROL A (known-bad): an unredacted body is reported, path by path', () => {
    const achados = piiScan(envelope('/v1/pedido/search/', 200, PEDIDO_CRU as ValorJsonLi));
    const residuos = achados.filter((a) => a.tipo === 'residuo').map((a) => a.caminho);
    expect(residuos).toEqual(
      expect.arrayContaining([
        'resposta.corpo.objects.*.cliente.nome',
        'resposta.corpo.objects.*.cliente.email',
        'resposta.corpo.objects.*.cliente.cpf',
        'resposta.corpo.objects.*.endereco_entrega.endereco',
        'resposta.corpo.objects.*.obs',
      ]),
    );
    // Kept values are not residue.
    expect(residuos).not.toContain('resposta.corpo.objects.*.numero');
    expect(residuos).not.toContain('resposta.corpo.objects.*.itens.*.sku');
  });

  it('CONTROL B (known-good): the redaction of that body is a fixpoint and reports nothing', () => {
    const corpo = sanitizado('/v1/pedido/search/', 200, PEDIDO_CRU);
    expect(piiScan(envelope('/v1/pedido/search/', 200, corpo), LISTA)).toEqual([]);
  });

  it('a finding carries a path and a kind, never the value', () => {
    const achados = piiScan(envelope('/v1/pedido/search/', 200, PEDIDO_CRU as ValorJsonLi), LISTA);
    const texto = JSON.stringify(achados) + formatarAchadosLi('x', achados).join('\n');
    for (const valor of [SENTINELA, CPF, 'cliente.real', '91234-5678', 'Rua Exemplo']) {
      expect(texto).not.toContain(valor);
    }
    expect(Object.keys(achados[0] ?? {}).sort()).toEqual(['caminho', 'tipo']);
  });
});

describe('piiScan — each layer fails on its own', () => {
  it('layer 1 alone: a non-allow-listed key with an innocent value is residue, and no pattern fires', () => {
    const env = envelope('/v1/pedido/1', 200, { campo_novo: 'abc' });
    expect(residuoDeRedacao(env)).toEqual([
      { caminho: 'resposta.corpo.campo_novo', tipo: 'residuo' },
    ]);
    expect(achadosDePadroes(env)).toEqual([]);
  });

  it('a residue finding prints a key the redactor kept only through its label: a listed name reads `<chave>`', () => {
    // The redactor keeps an identifier key it does not know; only the store-name list knows this one.
    const env = envelope('/v1/pedido/1', 200, { Loja_Exemplo: { campo_novo: 'abc' } });
    const achados = residuoDeRedacao(env, LISTA);
    expect(achados).toEqual([{ caminho: 'resposta.corpo.<chave>.campo_novo', tipo: 'residuo' }]);
    expect(JSON.stringify(achados).toLowerCase()).not.toContain('exemplo');
  });

  it('layer 2 alone: an 11-digit numero with valid CPF check digits survives the redactor, the pattern layer flags it', () => {
    const corpo = sanitizado('/v1/pedido/1', 200, { numero: Number(CPF) });
    expect(corpo).toEqual({ numero: Number(CPF) });
    const env = envelope('/v1/pedido/1', 200, corpo);
    expect(residuoDeRedacao(env)).toEqual([]);
    expect(achadosDePadroes(env)).toEqual([{ caminho: 'resposta.corpo.numero', tipo: 'cpf' }]);
  });

  it('the residue layer also re-redacts the request line', () => {
    const env = envelope('/v1/pedido/search/', 200, null, [['cliente_email', 'x']]);
    expect(residuoDeRedacao(env)).toEqual([{ caminho: 'requisicao.query.*.*', tipo: 'residuo' }]);
    const limpo = envelope('/v1/pedido/search/', 200, null, [
      ['cliente_email', '<redacted>'],
      ['limit', '20'],
    ]);
    expect(residuoDeRedacao(limpo)).toEqual([]);
  });

  it('a non-JSON form must carry a null body', () => {
    const env: EnvelopeFixtureLi = {
      ...envelope('/v1/pedido/1', 400, null),
      resposta: { status: 400, politica: 'estrutural', forma: 'texto', bytes: 4, corpo: 'html' },
    };
    expect(residuoDeRedacao(env)).toEqual([{ caminho: 'resposta.corpo', tipo: 'residuo' }]);
  });
});

describe('piiScan — near-misses of the pattern layer', () => {
  const tipos = (corpo: ValorJsonLi) =>
    achadosDePadroes(envelope('/v1/produto/1', 200, corpo), LISTA).map((a) => a.tipo);

  it('an 8-digit NCM passes; `12345-678` is a CEP', () => {
    expect(tipos({ ncm: '61091000' })).toEqual([]);
    expect(tipos({ x: '12345-678' })).toEqual(['cep']);
  });

  it('a GTIN-13 passes', () => {
    expect(tipos({ gtin: '7891234567895' })).toEqual([]);
  });

  it('a letter-bearing CNPJ with valid check digits is flagged; with invalid ones it is not', () => {
    expect(tipos({ x: CNPJ_LETRA })).toEqual(['cnpj']);
    expect(tipos({ x: CNPJ_LETRA_INVALIDO })).toEqual([]);
    expect(tipos({ x: CNPJ })).toEqual(['cnpj']);
  });

  it('an 11-digit numero with valid CPF check digits is flagged; with invalid ones it is not', () => {
    expect(tipos({ numero: Number(CPF) })).toEqual(['cpf']);
    expect(tipos({ numero: Number(CPF_INVALIDO) })).toEqual([]);
    expect(tipos({ numero: CPF })).toEqual(['cpf']);
  });

  it('a real-shaped Correios code is flagged; the placeholder is not', () => {
    expect(tipos({ objeto: 'BR123456789XX' })).toEqual(['rastreio']);
    expect(tipos({ objeto: FALSO_LI.rastreio })).toEqual([]);
  });

  it('a street address is flagged; a code that merely contains the letters is not', () => {
    expect(tipos({ x: 'Avenida Exemplo 0' })).toEqual(['endereco']);
    expect(tipos({ x: 'ruadasflores' })).toEqual([]);
  });

  it('a key is scanned too, and printed only through its tag', () => {
    expect(achadosDePadroes(envelope('/v1/produto/1', 200, { [CPF]: 1 }))).toEqual([
      { caminho: 'resposta.corpo.<redacted:cpf>', tipo: 'cpf' },
    ]);
    // Near-miss: not EXACTLY 11 digits.
    expect(achadosDePadroes(envelope('/v1/produto/1', 200, { [`${CPF}x`]: 1 }))).toEqual([]);
    const comEmail = achadosDePadroes(
      envelope('/v1/produto/1', 200, { 'cliente.real@exemplo.invalid': 1 }),
    );
    expect(comEmail).toEqual([{ caminho: 'resposta.corpo.<redacted:email>', tipo: 'email' }]);
  });

  it('every placeholder of the redactor is skipped', () => {
    for (const valor of Object.values(FALSO_LI)) expect(tipos({ x: valor })).toEqual([]);
  });
});

describe('piiScan — a document inside a URL-shaped value', () => {
  // The redactor keeps every all-digit path segment (an LI id), so the check
  // digits are this layer's job: segment by segment, not only a WHOLE value.
  it('a CPF or a CNPJ as a path segment of the request is flagged', () => {
    expect(achadosDePadroes(envelope(`/v1/cliente/${CPF}`, 200, null))).toEqual([
      { caminho: 'requisicao.caminho', tipo: 'cpf' },
    ]);
    expect(achadosDePadroes(envelope(`/v1/cliente/${CNPJ}/`, 200, null))).toEqual([
      { caminho: 'requisicao.caminho', tipo: 'cnpj' },
    ]);
    expect(achadosDePadroes(envelope(`/v1/pedido/1;${CPF}`, 200, null))).toEqual([
      { caminho: 'requisicao.caminho', tipo: 'cpf' },
    ]);
  });

  it('a CPF in `meta.next` is flagged', () => {
    const env = envelope('/v1/pedido/search/', 200, {
      meta: { next: `/api/v1/pedido/${CPF}/?limit=20`, previous: `/v1/x/?numero=${CPF}` },
      objects: [],
    });
    expect(achadosDePadroes(env)).toEqual([
      { caminho: 'resposta.corpo.meta.next', tipo: 'cpf' },
      { caminho: 'resposta.corpo.meta.previous', tipo: 'cpf' },
    ]);
  });

  it('near-miss: an id, invalid check digits, or a longer digit run is not a document', () => {
    for (const caminho of [
      '/v1/pedido/1234/',
      `/v1/cliente/${CPF_INVALIDO}`,
      `/v1/cliente/1${CPF}`,
      `/v1/cliente/${CNPJ_LETRA_INVALIDO}`,
    ]) {
      expect(achadosDePadroes(envelope(caminho, 200, null)), caminho).toEqual([]);
    }
  });

  it('a percent-encoded digit does not hide a CPF in a kept query value', () => {
    const codificado = `%3${CPF.slice(0, 1)}${CPF.slice(1)}`;
    const env = envelope('/v1/pedido/search/', 200, null, [['numero', codificado]]);
    expect(achadosDePadroes(env)).toEqual([{ caminho: 'requisicao.query.*.*', tipo: 'cpf' }]);
  });
});

describe('the store-name list', () => {
  it('a term matches its case and accent variants, and the same words with other separators', () => {
    expect(contemNomeDeLoja('LOJA EXÊMPLO', LISTA)).toBe(true);
    expect(contemNomeDeLoja('pedido da loja-exemplo, ok', LISTA)).toBe(true);
    expect(contemNomeDeLoja('https://www.lojaexemplo.com.br/x', LISTA)).toBe(true);
    // A multi-word name also matches with its separators gone.
    expect(contemNomeDeLoja('LOJAEXEMPLO-CAM-01', LISTA)).toBe(true);
  });

  it('a term does not match a different word', () => {
    expect(contemNomeDeLoja('Loja Exemplar', LISTA)).toBe(false);
    expect(contemNomeDeLoja('loja', LISTA)).toBe(false);
    // A single-word term is never matched across two words.
    const umaPalavra = criarListaDeNomes(['mega']);
    expect(contemNomeDeLoja('time gap', umaPalavra)).toBe(false);
    expect(contemNomeDeLoja('Megaloja', umaPalavra)).toBe(true);
  });

  it('a term matches through percent-encoding (a kept query value stays as written)', () => {
    expect(contemNomeDeLoja('LOJA%2FEXEMPLO-01', LISTA)).toBe(true);
    expect(contemNomeDeLoja('loja%20exemplo', LISTA)).toBe(true);
    expect(contemNomeDeLoja('LOJA%20EX%C3%8AMPLO', LISTA)).toBe(true);
    expect(contemNomeDeLoja('%4C%4F%4A%41%45%58%45%4D%50%4C%4F', LISTA)).toBe(true);
    // Encoded twice still matches.
    expect(contemNomeDeLoja('LOJA%252FEXEMPLO', LISTA)).toBe(true);
    // An escape wedged between the words is dropped too: decoded, `é` would glue them into another word.
    expect(contemNomeDeLoja('LOJA%C3%A9EXEMPLO', LISTA)).toBe(true);
  });

  it('near-miss: percent-encoding never makes a different word match', () => {
    expect(contemNomeDeLoja('LOJA%2FEXEMPLAR-01', LISTA)).toBe(false);
    expect(contemNomeDeLoja('%4C%4F%4A%41', LISTA)).toBe(false);
    // A malformed escape is left as written and never throws.
    expect(contemNomeDeLoja('LOJA%ZZEXEMPLAR%', LISTA)).toBe(false);
  });

  it('an encoded listed name in a kept query value or in `meta.next` is `nome-de-loja`', () => {
    const env = envelope(
      '/v1/produto/',
      200,
      { meta: { next: '/api/v1/produto/?sku=LOJA%2FEXEMPLO-01&offset=20' }, objects: [] },
      [['sku', 'LOJA%2FEXEMPLO-01']],
    );
    expect(achadosDePadroes(env, LISTA)).toEqual([
      { caminho: 'requisicao.query.*.*', tipo: 'nome-de-loja' },
      { caminho: 'resposta.corpo.meta.next', tipo: 'nome-de-loja' },
    ]);
    expect(tiposNaLinhaLi('      "LOJA%2FEXEMPLO-01"', LISTA)).toEqual(['nome-de-loja']);
  });

  it('the fold: accents, case and separators only', () => {
    expect(dobrarNomeDeLoja('  Loja__Exêmplo!! ')).toBe('loja exemplo');
    expect(dobrarNomeDeLoja('Ação')).toBe('acao');
  });

  it('a listed name in a value, a key or the request line is `nome-de-loja`, and never printed', () => {
    const env = envelope(
      '/v1/produto/',
      200,
      { objects: [{ sku: 'LOJAEXEMPLO-1' }], lojaexemplo: 1 },
      [['sku', 'loja-exemplo-2']],
    );
    const achados = achadosDePadroes(env, LISTA);
    expect(achados).toEqual([
      { caminho: 'requisicao.query.*.*', tipo: 'nome-de-loja' },
      { caminho: 'resposta.corpo.objects.*.sku', tipo: 'nome-de-loja' },
      { caminho: 'resposta.corpo.<chave>', tipo: 'nome-de-loja' },
    ]);
    expect(JSON.stringify(achados).toLowerCase()).not.toContain('exemplo');
  });

  it('CI has no list: without one, no name finding', () => {
    const env = envelope('/v1/produto/', 200, { objects: [{ sku: 'LOJAEXEMPLO-1' }] });
    expect(achadosDePadroes(env)).toEqual([]);
  });
});

describe('rotuloDeChave', () => {
  it.each([
    ['nome_cliente', 'nome_cliente'],
    ['João Silva', '<chave>'],
    ['cliente.real@exemplo.invalid', '<redacted:email>'],
    [`_${CPF}`, '<redacted:cpf>'],
    ['loja_exemplo', '<chave>'],
  ])('%s → %s', (chave, rotulo) => {
    expect(rotuloDeChave(chave, LISTA)).toBe(rotulo);
  });

  it('a mask hit prints the tag only, never the rest of the key', () => {
    expect(rotuloDeChave('Fulano Real cliente.real@exemplo.invalid', null)).toBe(
      '<redacted:email>',
    );
  });
});

describe('free text (`--verificar`)', () => {
  it('the mandated fakes are skipped', () => {
    for (const linha of [
      `CPF ${FALSO_LI.cpf}, CNPJ ${FALSO_LI.cnpj}, CEP ${FALSO_LI.cep}`,
      `fone ${FALSO_LI.telefone} ou ${PII_FALSA.telefone}`,
      `e-mail ${PII_FALSA.email} ou ${FALSO_LI.email} ou x@example.com`,
    ]) {
      expect(tiposNaLinhaLi(linha, LISTA)).toEqual([]);
    }
  });

  it('a real-looking value on a line is flagged by kind', () => {
    expect(tiposNaLinhaLi(`mande para ${EMAIL_FORA_DO_RESERVADO}`, LISTA)).toEqual(['email']);
    expect(tiposNaLinhaLi(`o documento ${CPF} aparece aqui`, LISTA)).toEqual(['cpf']);
    expect(tiposNaLinhaLi('a Loja Exemplo vendeu', LISTA)).toEqual(['nome-de-loja']);
    expect(tiposNaLinhaLi(`"numero=%3${CPF.slice(0, 1)}${CPF.slice(1)}"`, LISTA)).toEqual(['cpf']);
  });

  it('blanking keeps the line length (so nothing shifts)', () => {
    const linha = `a ${FALSO_LI.cpf} b`;
    expect(semFalsosConhecidosLi(linha)).toHaveLength(linha.length);
  });
});
