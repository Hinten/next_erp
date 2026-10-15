import { describe, expect, it } from 'vitest';

import { UF_SIGLA, enderecoSchema } from './endereco';

/** The smallest endereço the schema accepts; every other field defaults. */
const MINIMO = {
  cep: '01310100',
  logradouro: 'Avenida Paulista',
  numero: '1000',
  cidade: 'São Paulo',
  estado: UF_SIGLA.SP,
};

function aceita(cpfCnpj: string): boolean {
  return enderecoSchema.safeParse({ ...MINIMO, cpf_cnpj: cpfCnpj }).success;
}

describe('enderecoSchema.cpf_cnpj', () => {
  it('accepts an ALPHANUMERIC CNPJ (RFB IN 2.229/2024)', () => {
    // This field is the NF-e destinatário / recebedor — a COUNTERPARTY, which
    // is exactly who the Receita issues alphanumeric CNPJs to. Under the old
    // `^\d*$` the value could not be stored at all.
    expect(aceita('12ABC34501DE35')).toBe(true);
  });

  it('still accepts a numeric CPF and CNPJ', () => {
    expect(aceita('52998224725')).toBe(true);
    expect(aceita('11222333000181')).toBe(true);
    expect(aceita('')).toBe(true);
  });

  it('⚠️ NEAR-MISS: the canonical stored form is UPPERCASE and unpunctuated', () => {
    // `normalizeDocumento` is what produces the stored value; accepting the
    // lowercase or punctuated spelling here would make two writings of one
    // document both storable, and a `cpf_cnpj ==` lookup answer for only one.
    expect(aceita('12abc34501de35')).toBe(false);
    expect(aceita('12.ABC.345/01DE-35')).toBe(false);
  });

  it('⚠️ NEAR-MISS: letters are allowed ONLY in the alfa CNPJ shape', () => {
    // `^[0-9A-Z]*$` — the spelling `cliente.cpf_cnpj` uses — would take all of
    // these. `cliente` can afford it because a `validateCpfCnpj` refine backs it;
    // this field has none, so the regex is the whole guard. ⚠️ `ABCDEFGHIJK` is
    // the expensive one: eleven characters, and `melhorEnvioCart` classifies by
    // `normalizeDocumento(...).length === 14`, so it would go out to Melhor Envio
    // in the CPF slot on a real label.
    expect(aceita('ABCDEFGHIJKLMN')).toBe(false);
    expect(aceita('ABCDEFGHIJK')).toBe(false);
    expect(aceita('A')).toBe(false);
    // The two check digits stay numeric — `[0-9A-Z]{12}[0-9]{2}`, never 14.
    expect(aceita('12ABC34501DEFG')).toBe(false);
  });

  it('every purely NUMERIC value the old rule took is still taken', () => {
    // The `\d*` alternative is what keeps rule 8 read-tolerance intact: a
    // partial or half-typed legacy value must not start failing `parseRead`.
    expect(aceita('1122233300018')).toBe(true);
    expect(aceita('1')).toBe(true);
  });

  it('⚠️ NEAR-MISS: no check-digit refine here, deliberately', () => {
    // `cliente.cpf_cnpj` carries one; this field never has, so adding it would
    // be a TIGHTENING on the legacy corpus rather than part of the alfa
    // widening — a stored endereço with a typo'd document would start failing
    // `parseRead` (root CLAUDE.md rule 8: read-tolerance for legacy shapes).
    expect(aceita('12ABC34501DE99')).toBe(true);
    expect(aceita('00000000000')).toBe(true);
  });
});
