import { describe, expect, it } from 'vitest';

import { descreverSefaz, redigirIdentificadores } from './sefaz-log';

/**
 * ⚠️ Both directions, deliberately. A test that the redaction APPLIES cannot
 * show where it STOPS, and over-redaction is the failure that would make these
 * logs useless — `nProt`/`nRec`/`nNF` carry no personal data and are often the
 * only way to correlate a CI run with a document at SEFAZ. So every masking
 * case below is paired with a near-miss that must stay READABLE.
 */
describe('redigirIdentificadores', () => {
  describe('masks fiscal identifiers', () => {
    it('masks a punctuated CNPJ and keeps every word around it', () => {
      // The real #1471 rejection, with the CNPJ replaced by a fabricated one.
      expect(
        redigirIdentificadores(
          'Rejeição: CNPJ 11.222.333/0001-44 do Emitente não cadastrado na Receita Federal',
        ),
      ).toBe('Rejeição: CNPJ [CNPJ] do Emitente não cadastrado na Receita Federal');
    });

    it('masks a BARE 14-digit CNPJ', () => {
      expect(redigirIdentificadores('Emitente 11222333000144 irregular')).toBe(
        'Emitente [CNPJ] irregular',
      );
    });

    it('masks a CPF, punctuated and bare — a destinatário can be a person', () => {
      expect(redigirIdentificadores('Destinatario 123.456.789-09')).toBe('Destinatario [CPF]');
      expect(redigirIdentificadores('Destinatario 12345678909')).toBe('Destinatario [CPF]');
    });

    it('masks a 44-digit chave WHOLE — it embeds the CNPJ at positions 7-20', () => {
      const chave = '3'.repeat(44);
      const out = redigirIdentificadores(`NF-e ${chave} nao consta`);
      expect(out).toBe('NF-e [chave] nao consta');
      // The point of ordering chave FIRST: no CNPJ-shaped slice survives inside.
      expect(out).not.toContain('[CNPJ]');
    });

    it('masks every occurrence, not just the first', () => {
      expect(redigirIdentificadores('de 11.222.333/0001-44 para 55.666.777/0001-88')).toBe(
        'de [CNPJ] para [CNPJ]',
      );
    });
  });

  describe('NEAR-MISS — must stay readable', () => {
    it('leaves a 15-digit nProt alone', () => {
      // 15 digits: `\b\d{14}\b` cannot match inside it (no word boundary), which
      // is the whole reason every pattern is FIXED-width rather than `\d{11,}`.
      expect(redigirIdentificadores('Autorizado, protocolo 135260000012345')).toBe(
        'Autorizado, protocolo 135260000012345',
      );
    });

    it('leaves a 15-digit nRec alone inside the duplicidade message', () => {
      expect(redigirIdentificadores('Rejeicao: Duplicidade de NF-e [nRec:351000000000123]')).toBe(
        'Rejeicao: Duplicidade de NF-e [nRec:351000000000123]',
      );
    });

    it('leaves a 9-digit nNF and a 3-digit cStat alone', () => {
      expect(redigirIdentificadores('nNF 500000123 recusada, cStat 178')).toBe(
        'nNF 500000123 recusada, cStat 178',
      );
    });

    it('leaves a 12- or 13-digit run alone — neither is a CNPJ or a CPF', () => {
      expect(redigirIdentificadores('valor 112223330001 e 1122233300014')).toBe(
        'valor 112223330001 e 1122233300014',
      );
    });

    it('leaves an identifier-free rejection completely untouched', () => {
      const texto = 'Rejeicao: UF informada no campo cUF nao e atendida pelo Web Service';
      expect(redigirIdentificadores(texto)).toBe(texto);
    });
  });

  it('tolerates null/undefined/empty — a live log must never crash the suite', () => {
    expect(redigirIdentificadores(null)).toBe('');
    expect(redigirIdentificadores(undefined)).toBe('');
    expect(redigirIdentificadores('')).toBe('');
  });
});

describe('descreverSefaz', () => {
  it('redacts inside the one-line form, which also feeds the ASSERTION message', () => {
    expect(
      descreverSefaz('SVC-AN protNFe', {
        cStat: '178',
        xMotivo: 'Rejeição: CNPJ 11.222.333/0001-44 do Emitente não cadastrado na Receita Federal',
      }),
    ).toBe(
      '[SVC-AN protNFe] cStat=178 xMotivo="Rejeição: CNPJ [CNPJ] do Emitente não cadastrado na Receita Federal"',
    );
  });

  it('appends prot.cStat only when the caller resolved one', () => {
    expect(descreverSefaz('consSitNFe', { cStat: '100', xMotivo: 'ok', protCStat: '100' })).toBe(
      '[consSitNFe] cStat=100 xMotivo="ok" prot.cStat=100',
    );
    expect(descreverSefaz('lote', { cStat: '104', xMotivo: 'Lote processado' })).toBe(
      '[lote] cStat=104 xMotivo="Lote processado"',
    );
  });

  it('appends cMsg/xMsg only when present, and redacts xMsg too', () => {
    expect(
      descreverSefaz('protNFe', {
        cStat: '178',
        xMotivo: 'Rejeicao',
        cMsg: '9',
        xMsg: 'CNPJ 11.222.333/0001-44 desconhecido',
      }),
    ).toBe('[protNFe] cStat=178 xMotivo="Rejeicao" cMsg=9 xMsg="CNPJ [CNPJ] desconhecido"');
  });
});
