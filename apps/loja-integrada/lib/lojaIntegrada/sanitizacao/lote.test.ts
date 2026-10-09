import { describe, expect, it } from 'vitest';

import {
  ARQUIVO_NOMES_PROIBIDOS,
  ErroDeUsoSanitizacao,
  lerNomesProibidos,
  montarLote,
  temHar,
} from './lote';

const b = (t: string) => new TextEncoder().encode(t);

describe('montarLote', () => {
  it('pairs `<nome>.json` with `<nome>.txt`, sorted', () => {
    expect(montarLote(['b.txt', 'a.json', 'b.json', 'a.txt'], [])).toEqual({
      pares: ['a', 'b'],
      ignorados: 0,
      problemas: [],
    });
  });

  it('`a.json` alone and `c.txt` alone are refused by name', () => {
    const lote = montarLote(['a.json', 'b.json', 'b.txt', 'c.txt'], []);
    expect(lote.pares).toEqual(['b']);
    expect(lote.problemas).toEqual([
      { tipo: 'sem-sidecar', nome: 'a' },
      { tipo: 'sem-corpo', nome: 'c' },
    ]);
  });

  it('a name outside the grammar is counted, never named', () => {
    const lote = montarLote(
      ['ok.json', 'ok.txt', 'Pedido Fulano.json', 'A.txt', 'x.JSON', `${'a'.repeat(41)}.json`],
      [],
    );
    expect(lote.problemas).toEqual([{ tipo: 'nome-fora-da-gramatica', quantidade: 4 }]);
    expect(JSON.stringify(lote)).not.toContain('Fulano');
  });

  it('other files are ignored and counted; the store-name list is neither', () => {
    const lote = montarLote(
      ['a.json', 'a.txt', 'notas.md', 'foto.png', ARQUIVO_NOMES_PROIBIDOS],
      [],
    );
    expect(lote).toEqual({ pares: ['a'], ignorados: 2, problemas: [] });
  });

  it('`--so` keeps only the named pairs, and the rest of the folder is not judged', () => {
    const lote = montarLote(['a.json', 'a.txt', 'b.json', 'b.txt', 'sozinho.json'], ['b']);
    expect(lote).toEqual({ pares: ['b'], ignorados: 0, problemas: [] });
  });

  it('a `--so` name that is not a complete pair is a usage error', () => {
    expect(() => montarLote(['a.json', 'a.txt'], ['z'])).toThrow(ErroDeUsoSanitizacao);
    expect(() => montarLote(['a.json', 'a.txt', 'b.json'], ['b'])).toThrow(ErroDeUsoSanitizacao);
  });

  it('zero pairs is a usage error', () => {
    expect(() => montarLote([], [])).toThrow(ErroDeUsoSanitizacao);
    expect(() => montarLote(['a.json', ARQUIVO_NOMES_PROIBIDOS], [])).toThrow(ErroDeUsoSanitizacao);
  });
});

describe('temHar', () => {
  it('any `.har`, any case', () => {
    expect(temHar(['a.json', 'sessao.har'])).toBe(true);
    expect(temHar(['SESSAO.HAR'])).toBe(true);
    expect(temHar(['a.json', 'a.txt', 'har.txt'])).toBe(false);
  });
});

describe('lerNomesProibidos', () => {
  const SENTINELA = 'XQZ';

  it('missing, empty or comments only → usage error', () => {
    expect(() => lerNomesProibidos(null)).toThrow(ErroDeUsoSanitizacao);
    expect(() => lerNomesProibidos(b(''))).toThrow(ErroDeUsoSanitizacao);
    expect(() => lerNomesProibidos(b('# só comentário\n\n'))).toThrow(ErroDeUsoSanitizacao);
  });

  it('a term shorter than 4 letters or digits → usage error, by line number, never the term', () => {
    expect(() => lerNomesProibidos(b(`Loja Exemplo\n${SENTINELA}\n`))).toThrow(
      /line 2: a term needs at least 4/,
    );
    expect(() => lerNomesProibidos(b(`Loja Exemplo\n${SENTINELA}\n`))).not.toThrow(SENTINELA);
    // Punctuation does not count toward the 4.
    expect(() => lerNomesProibidos(b('a.b.c\n'))).toThrow(ErroDeUsoSanitizacao);
  });

  it('accepts comments, blank lines, CRLF and a UTF-8 BOM', () => {
    expect(
      lerNomesProibidos(b('\uFEFF# lojas\r\nLoja Exemplo\r\n\r\n  lojaexemplo.com.br  \r\n')),
    ).toEqual(['Loja Exemplo', 'lojaexemplo.com.br']);
  });

  it('refuses UTF-16', () => {
    expect(() => lerNomesProibidos(new Uint8Array([0xff, 0xfe, 0x4c, 0x00]))).toThrow(/UTF-16/);
  });
});
