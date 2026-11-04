import { describe, expect, it } from 'vitest';

import { criarListaDeNomes } from '../fixtures/piiScan';
import {
  ARQUIVO_NOMES_PROIBIDOS,
  ARQUIVO_SAL,
  BYTES_DE_ASSINATURA,
  ErroDeUsoSanitizacao,
  MINIMO_POR_TERMO,
  NOME_DE_CAPTURA_AMAZON,
  assinaturaBinaria,
  ehEnv,
  ehHar,
  lerNomesProibidos,
  montarLote,
  tiposDoNomeAmazon,
  validarSal,
} from './lote';

const b = (t: string) => new TextEncoder().encode(t);

describe('run-wide refusals', () => {
  it.each([
    ['a zip', [0x50, 0x4b, 0x03, 0x04, 0x14], 'zip'],
    ['a ZPL', [0x5e, 0x58, 0x41, 0x0a], 'zpl'],
    ['a PDF', [0x25, 0x50, 0x44, 0x46, 0x2d], 'pdf'],
    ['a gzip', [0x1f, 0x8b, 0x08], 'gzip'],
  ])('★ %s is recognised by its first bytes', (_caso, bytes, tipo) => {
    expect(assinaturaBinaria(new Uint8Array(bytes))).toBe(tipo);
  });

  it('near-miss: JSON, a sidecar, an empty file and a near-signature are not', () => {
    expect(assinaturaBinaria(b('{"a":1}'))).toBeNull();
    expect(assinaturaBinaria(b('GET /x 200'))).toBeNull();
    expect(assinaturaBinaria(new Uint8Array())).toBeNull();
    expect(assinaturaBinaria(b('PK'))).toBeNull();
    expect(assinaturaBinaria(b('%PDF'))).toBeNull();
    expect(assinaturaBinaria(b(' ^XA'))).toBeNull();
  });

  it('reads no more than the longest signature', () => {
    expect(BYTES_DE_ASSINATURA).toBe(5);
  });

  it('★ a HAR of any name case, and every .env entry', () => {
    expect(ehHar('x.har')).toBe(true);
    expect(ehHar('Sessao.HAR')).toBe(true);
    expect(ehHar('x.har.txt')).toBe(false);
    expect(ehEnv('.env.local')).toBe(true);
    expect(ehEnv('.env')).toBe(true);
    expect(ehEnv('.ENV.production')).toBe(true);
    expect(ehEnv('ambiente.env')).toBe(false);
    expect(ehEnv(ARQUIVO_SAL)).toBe(false);
  });
});

describe('pairing', () => {
  it('pairs body and sidecar, attaches .req.json and .zip.txt, skips the kept files', () => {
    const lote = montarLote(
      [
        'c3-bulk.json',
        'c3-bulk.txt',
        'c3-bulk.req.json',
        'c3-bulk.zip.txt',
        'c1-pedido.json',
        'c1-pedido.txt',
        ARQUIVO_NOMES_PROIBIDOS,
        ARQUIVO_SAL,
        'notas.md',
      ],
      [],
    );
    expect(lote.pares).toEqual([
      { nome: 'c1-pedido', requisicao: false, zip: false },
      { nome: 'c3-bulk', requisicao: true, zip: true },
    ]);
    expect(lote.ignorados).toBe(1);
    expect(lote.problemas).toEqual([]);
  });

  it('★ an unpaired capture, an orphan attachment and a bad name refuse the run', () => {
    const lote = montarLote(
      ['a.json', 'a.txt', 'b.json', 'c.txt', 'd.req.json', 'Maiuscula.json', 'x.y.json'],
      [],
    );
    expect(lote.problemas).toEqual([
      { tipo: 'sem-sidecar', nome: 'b' },
      { tipo: 'sem-corpo', nome: 'c' },
      { tipo: 'anexo-sem-par', nome: 'd', extensao: 'req.json' },
      { tipo: 'nome-fora-da-gramatica', quantidade: 2 },
    ]);
  });

  it('★ a pair file that is not a regular file refuses the run by name', () => {
    const lote = montarLote(['a.json', 'a.txt', 'b.txt'], [], ['b.json']);
    expect(lote.problemas).toEqual([{ tipo: 'nao-e-arquivo', nome: 'b', extensao: 'json' }]);
  });

  it('--so converts only the named pairs; a name that is not a pair is a usage error', () => {
    const arquivos = ['a.json', 'a.txt', 'b.json', 'b.txt', 'c.json'];
    expect(montarLote(arquivos, ['b']).pares.map((p) => p.nome)).toEqual(['b']);
    expect(() => montarLote(arquivos, ['c'])).toThrow(ErroDeUsoSanitizacao);
  });

  it('zero pairs is a usage error', () => {
    expect(() => montarLote(['notas.md'], [])).toThrow(ErroDeUsoSanitizacao);
  });
});

describe('★ the name grammar: a capture name is a PUBLIC file name', () => {
  it.each([
    ['an Amazon order id', 'c1-123-4567890-1234567'],
    ['a bare phone', 'c1-11987654321'],
    ['a hyphenated phone', 'c1-11-98765-4321'],
    ['a bare CEP', 'c1-01234567'],
    ['a hyphenated CEP', 'c1-01234-567'],
    ['a bare 6-digit run', 'c1-123456'],
    ['8 digits split by hyphens (a date)', 'pedido-2026-10-19'],
  ])('refuses %s', (_caso, nome) => {
    expect(NOME_DE_CAPTURA_AMAZON.test(nome)).toBe(false);
    expect(tiposDoNomeAmazon(nome, null)).toContain('digitos-no-nome');
  });

  it('near-miss: a request description with short digit groups passes, and trips nothing', () => {
    for (const nome of ['c1-pedido-cpf', 'c1-9-10-pedido', 'c2-12345', 'sb-getorder-br']) {
      expect(NOME_DE_CAPTURA_AMAZON.test(nome), nome).toBe(true);
      expect(tiposDoNomeAmazon(nome, null), nome).toEqual([]);
    }
  });

  it('a folder entry name: the scanner patterns, the listed terms and a digit run', () => {
    const lista = criarListaDeNomes(['Termo Ficticio Zeta']);
    expect(tiposDoNomeAmazon('702-1234567-1234567.har', null)).toEqual(
      expect.arrayContaining(['pedido-amazon', 'digitos-no-nome']),
    );
    expect(tiposDoNomeAmazon('fulana-11987654321.json', null)).toEqual(['digitos-no-nome']);
    expect(tiposDoNomeAmazon('termo-ficticio-zeta.txt', lista)).toEqual(['nome-de-loja']);
    expect(tiposDoNomeAmazon('termo-ficticio-zeta.txt', null)).toEqual([]);
  });
});

describe('the files the sanitizer keeps', () => {
  it('the denylist: comments and blanks skipped, BOM and CRLF accepted', () => {
    expect(
      lerNomesProibidos(new Uint8Array([0xef, 0xbb, 0xbf, ...b('# x\r\nTermo Um\r\n\r\nzeta')])),
    ).toEqual(['Termo Um', 'zeta']);
  });

  it(`refuses a missing, empty or UTF-16 list, and a term under ${String(MINIMO_POR_TERMO)} letters, without echoing it`, () => {
    expect(() => lerNomesProibidos(null)).toThrow(ErroDeUsoSanitizacao);
    expect(() => lerNomesProibidos(b('# só comentário\n'))).toThrow(ErroDeUsoSanitizacao);
    expect(() => lerNomesProibidos(new Uint8Array([0xff, 0xfe, 0x41, 0x00]))).toThrow(
      ErroDeUsoSanitizacao,
    );
    expect(() => lerNomesProibidos(b('Xy-z\n'))).toThrow(/line 1/);
    expect(() => lerNomesProibidos(b('Xy-z\n'))).not.toThrow(/Xy/);
  });

  it('★ a short or long salt refuses the run; exactly 32 bytes is read', () => {
    expect(() => validarSal(new Uint8Array(31))).toThrow(ErroDeUsoSanitizacao);
    expect(() => validarSal(new Uint8Array(33))).toThrow(ErroDeUsoSanitizacao);
    expect(validarSal(new Uint8Array(32))).toHaveLength(32);
  });
});
