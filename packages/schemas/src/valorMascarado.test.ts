import { describe, expect, it } from 'vitest';
import {
  MOTIVO_RECUSA,
  TIPO_DE_VALOR,
  cpfCnpjUtilizavel,
  motivoDaRecusa,
  nomeUtilizavel,
  valorUtilizavel,
} from './valorMascarado';

/* -------------------------------------------------------------------------- */
/*  Synthetic documents                                                       */
/*                                                                            */
/*  Generated here rather than pasted, so a near-miss (one wrong check digit,  */
/*  a 10- or 12-character run) is derived from the SAME base as its valid      */
/*  twin — a pasted pair proves nothing about which digit moved.               */
/*                                                                            */
/*  ⚠️ The generators are cross-checked against the two canonical fake         */
/*  documents (`12345678909`, `11222333000181`) in the first test below. A     */
/*  generator that mirrors the validator's own bug would otherwise make every  */
/*  "valid" case here vacuous.                                                 */
/* -------------------------------------------------------------------------- */

function cpfComDv(base9: string): string {
  const digitos = base9.split('').map(Number);
  const dv = (parcial: number[]): number => {
    const peso = parcial.length + 1;
    const soma = parcial.reduce((acc, d, i) => acc + d * (peso - i), 0);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  const dv1 = dv(digitos);
  const dv2 = dv([...digitos, dv1]);
  return `${base9}${dv1}${dv2}`;
}

function cnpjComDv(base12: string): string {
  const valor = (c: string): number => c.charCodeAt(0) - 48;
  const pesos1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const pesos2 = [6, ...pesos1];
  const dv = (chars: string, pesos: number[]): number => {
    const soma = pesos.reduce((acc, p, i) => acc + valor(chars[i]!) * p, 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  const dv1 = dv(base12, pesos1);
  const dv2 = dv(`${base12}${dv1}`, pesos2);
  return `${base12}${dv1}${dv2}`;
}

/** Obviously fake, algorithmically valid. */
const CPF_VALIDO = cpfComDv('123456789');
const CNPJ_VALIDO = cnpjComDv('112223330001');
/** The same CPF with its LAST check digit moved by one — nothing else differs. */
const CPF_DV_ERRADO = `${CPF_VALIDO.slice(0, 10)}${(Number(CPF_VALIDO[10]) + 1) % 10}`;

describe('the synthetic documents this file is built on', () => {
  it('agree with the two canonical fake documents — the generators are not mirroring a bug', () => {
    expect(CPF_VALIDO).toBe('12345678909');
    expect(CNPJ_VALIDO).toBe('11222333000181');
  });

  it('⚠️ NEAR-MISS: the wrong-DV twin differs from the valid one in ONE character', () => {
    expect(CPF_DV_ERRADO).not.toBe(CPF_VALIDO);
    expect(CPF_DV_ERRADO.slice(0, 10)).toBe(CPF_VALIDO.slice(0, 10));
  });
});

/* -------------------------------------------------------------------------- */
/*                              valorUtilizavel                               */
/* -------------------------------------------------------------------------- */

describe('valorUtilizavel', () => {
  it('accepts a clear value and returns it trimmed', () => {
    expect(valorUtilizavel('Joaquin')).toBe('Joaquin');
    expect(valorUtilizavel('  Joaquin  ')).toBe('Joaquin');
  });

  it('⚠️ NEAR-MISS: "J******n" is masked and "Joaquin" is not — the pair a `=== "***"` test lost', () => {
    expect(valorUtilizavel('Joaquin')).toBe('Joaquin');
    expect(valorUtilizavel('J******n')).toBeNull();
  });

  it('refuses an asterisk in ANY position — the mask is partial, never a fixed literal', () => {
    for (const mascarado of [
      '*',
      '***',
      '****',
      '******64',
      'Ấp******',
      '11*****8888',
      'Joaquin*',
    ]) {
      expect(valorUtilizavel(mascarado)).toBeNull();
    }
  });

  it('treats "-" as absence, not as a one-character value', () => {
    expect(valorUtilizavel('-')).toBeNull();
    expect(valorUtilizavel('  -  ')).toBeNull();
  });

  it('⚠️ NEAR-MISS: a value that merely CONTAINS a dash survives', () => {
    expect(valorUtilizavel('Ana-Maria')).toBe('Ana-Maria');
    expect(valorUtilizavel('-')).toBeNull();
  });

  it('treats empty, whitespace-only, null and undefined as absence', () => {
    expect(valorUtilizavel('')).toBeNull();
    expect(valorUtilizavel('   ')).toBeNull();
    expect(valorUtilizavel(null)).toBeNull();
    expect(valorUtilizavel(undefined)).toBeNull();
  });

  it('never throws on the raw shapes a soft-parsed read hands back', () => {
    expect(valorUtilizavel(42)).toBeNull();
    expect(valorUtilizavel({ nome: 'Joaquin' })).toBeNull();
    expect(valorUtilizavel(['Joaquin'])).toBeNull();
    expect(valorUtilizavel(true)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                              nomeUtilizavel                                */
/* -------------------------------------------------------------------------- */

describe('nomeUtilizavel', () => {
  it('collapses whitespace and returns the value that would be STORED', () => {
    expect(nomeUtilizavel('  Joaquin   da  Silva ')).toBe('Joaquin da Silva');
  });

  it('⚠️ NEAR-MISS: two characters pass, one character does not — a single letter is mask residue', () => {
    expect(nomeUtilizavel('Jo')).toBe('Jo');
    expect(nomeUtilizavel('J')).toBeNull();
  });

  it('refuses a masked name even when it is long enough', () => {
    expect(nomeUtilizavel('J******n')).toBeNull();
    expect(nomeUtilizavel('****')).toBeNull();
  });

  it('refuses "-" and whitespace, which `clienteSchema.nome` would accept', () => {
    expect(nomeUtilizavel('-')).toBeNull();
    expect(nomeUtilizavel('   ')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                             cpfCnpjUtilizavel                              */
/* -------------------------------------------------------------------------- */

describe('cpfCnpjUtilizavel', () => {
  it('accepts a punctuated CPF and returns the canonical stored form', () => {
    expect(cpfCnpjUtilizavel('123.456.789-09')).toBe(CPF_VALIDO);
    expect(cpfCnpjUtilizavel(` ${CPF_VALIDO} `)).toBe(CPF_VALIDO);
  });

  it('accepts a punctuated CNPJ of 14 characters', () => {
    expect(cpfCnpjUtilizavel('11.222.333/0001-81')).toBe(CNPJ_VALIDO);
  });

  it('accepts the alphanumeric CNPJ of IN RFB 2.229/2024', () => {
    const alfanumerico = cnpjComDv('12ABC345000J');
    expect(alfanumerico).toMatch(/^[A-Z0-9]{12}\d{2}$/);
    expect(cpfCnpjUtilizavel(alfanumerico)).toBe(alfanumerico);
  });

  it('⚠️ NEAR-MISS: a CPF with a WRONG check digit is refused — the schema refine would throw inside add() and retry the import for ever', () => {
    expect(cpfCnpjUtilizavel(CPF_VALIDO)).toBe(CPF_VALIDO);
    expect(cpfCnpjUtilizavel(CPF_DV_ERRADO)).toBeNull();
  });

  it('⚠️ NEAR-MISS: only 11 and 14 characters pass — 10 and 12 digit runs are refused', () => {
    expect(cpfCnpjUtilizavel(CPF_VALIDO.slice(0, 10))).toBeNull();
    expect(cpfCnpjUtilizavel(`${CPF_VALIDO}0`)).toBeNull();
    expect(cpfCnpjUtilizavel(CNPJ_VALIDO.slice(0, 12))).toBeNull();
  });

  it('refuses the all-same-digit degenerate CPF', () => {
    expect(cpfCnpjUtilizavel('11111111111')).toBeNull();
  });

  it('⚠️ a punctuated MASK normalises to eleven characters and passes the LENGTH test — the mask gate is what refuses it', () => {
    // `normalizeDocumento` strips `.` and `-` but NOT `*`, so this is 11 chars.
    expect('***.***.***-**'.replace(/[.\-/\s]/g, '')).toHaveLength(11);
    expect(cpfCnpjUtilizavel('***.***.***-**')).toBeNull();
  });

  it('never throws on a non-string', () => {
    expect(cpfCnpjUtilizavel(12345678909)).toBeNull();
    expect(cpfCnpjUtilizavel(null)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                              motivoDaRecusa                                */
/* -------------------------------------------------------------------------- */

describe('motivoDaRecusa', () => {
  it('separates ausente, mascarado and invalido — the three the capture record must tell apart', () => {
    expect(motivoDaRecusa(null, TIPO_DE_VALOR.nome)).toBe(MOTIVO_RECUSA.ausente);
    expect(motivoDaRecusa('  ', TIPO_DE_VALOR.nome)).toBe(MOTIVO_RECUSA.ausente);
    expect(motivoDaRecusa('-', TIPO_DE_VALOR.nome)).toBe(MOTIVO_RECUSA.ausente);
    expect(motivoDaRecusa('J******n', TIPO_DE_VALOR.nome)).toBe(MOTIVO_RECUSA.mascarado);
    expect(motivoDaRecusa('J', TIPO_DE_VALOR.nome)).toBe(MOTIVO_RECUSA.invalido);
  });

  it('answers null for a value that was NOT refused', () => {
    expect(motivoDaRecusa('Joaquin', TIPO_DE_VALOR.nome)).toBeNull();
    expect(motivoDaRecusa(CPF_VALIDO, TIPO_DE_VALOR.documento)).toBeNull();
    expect(motivoDaRecusa('x', TIPO_DE_VALOR.texto)).toBeNull();
  });

  it('⚠️ NEAR-MISS: a masked document is "mascarado" and a wrong-DV one is "invalido" — waiting fixes only the first', () => {
    expect(motivoDaRecusa('***.***.***-**', TIPO_DE_VALOR.documento)).toBe(MOTIVO_RECUSA.mascarado);
    expect(motivoDaRecusa(CPF_DV_ERRADO, TIPO_DE_VALOR.documento)).toBe(MOTIVO_RECUSA.invalido);
  });

  it('⚠️ NEAR-MISS: the same one-character value is fine as texto and refused as nome', () => {
    expect(motivoDaRecusa('J', TIPO_DE_VALOR.texto)).toBeNull();
    expect(motivoDaRecusa('J', TIPO_DE_VALOR.nome)).toBe(MOTIVO_RECUSA.invalido);
  });

  it('never leaks the value it judged — the verdict is the whole output', () => {
    for (const tipo of [TIPO_DE_VALOR.texto, TIPO_DE_VALOR.nome, TIPO_DE_VALOR.documento]) {
      const motivo = motivoDaRecusa(CPF_DV_ERRADO, tipo);
      if (motivo !== null) expect(motivo).not.toContain(CPF_DV_ERRADO);
    }
  });
});
