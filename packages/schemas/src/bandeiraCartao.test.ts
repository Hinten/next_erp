import { describe, expect, it } from 'vitest';
import {
  BANDEIRA,
  BANDEIRA_LABELS,
  bandeiraCartaoMeta,
  bandeiraCartaoSchema,
  bandeiraDoNomeDaMarca,
  bandeiraSchema,
} from './bandeiraCartao';

const MINIMAL = {
  ehCredito: true,
  nome: 'Visa Crédito',
  cnpj_instituicao: null,
  bandeira: null,
};

describe('bandeiraCartaoSchema', () => {
  it('accepts a minimal valid bandeira and applies numeric defaults', () => {
    const out = bandeiraCartaoSchema.parse(MINIMAL);
    expect(out).toMatchObject({
      ehCredito: true,
      nome: 'Visa Crédito',
      tarifa: 0,
      tarifaFixa: 0,
      maxParcelas: 1,
      prazoRecebimento: 0,
    });
  });

  it('rejects empty nome', () => {
    expect(bandeiraCartaoSchema.safeParse({ ...MINIMAL, nome: '' }).success).toBe(false);
  });

  it('rejects nome > 255 chars', () => {
    expect(bandeiraCartaoSchema.safeParse({ ...MINIMAL, nome: 'x'.repeat(256) }).success).toBe(
      false,
    );
  });

  it('rejects cnpj_instituicao > 14 chars', () => {
    expect(
      bandeiraCartaoSchema.safeParse({
        ...MINIMAL,
        cnpj_instituicao: '1'.repeat(15),
      }).success,
    ).toBe(false);
  });

  it('rejects a PUNCTUATED cnpj_instituicao — the stored form is unpunctuated', () => {
    expect(
      bandeiraCartaoSchema.safeParse({
        ...MINIMAL,
        cnpj_instituicao: '12.345.678/0001-90',
      }).success,
    ).toBe(false);
  });

  it('accepts an ALPHANUMERIC cnpj_instituicao (RFB IN 2.229/2024)', () => {
    // `<card><CNPJ>` is the credenciadora — a COUNTERPARTY, which is exactly who
    // the Receita issues alphanumeric CNPJs to. Under the old `^\d*$` a new
    // acquirer could not be registered at all.
    expect(
      bandeiraCartaoSchema.safeParse({ ...MINIMAL, cnpj_instituicao: '12ABC34501DE35' }).success,
    ).toBe(true);
  });

  it('⚠️ NEAR-MISS: lowercase is refused — the canonical stored form is uppercase', () => {
    expect(
      bandeiraCartaoSchema.safeParse({ ...MINIMAL, cnpj_instituicao: '12abc34501de35' }).success,
    ).toBe(false);
  });

  it('⚠️ NEAR-MISS: letters ONLY in the alfa CNPJ shape, and never in the DVs', () => {
    // No `validateCpfCnpj` refine backs this field, so the regex is the whole
    // guard — and `generator-input.ts` copies the value into `<card><CNPJ>`
    // verbatim, so anything it accepts reaches the signed XML unre-checked.
    for (const bad of ['ABCDEFGHIJKLMN', '12ABC34501DEFG', 'ABCDEFGHIJK', 'A']) {
      expect(
        bandeiraCartaoSchema.safeParse({ ...MINIMAL, cnpj_instituicao: bad }).success,
        bad,
      ).toBe(false);
    }
    // Every purely numeric value the old `\d*` took is still taken.
    for (const ok of ['', '1122233300018', '11222333000181']) {
      expect(bandeiraCartaoSchema.safeParse({ ...MINIMAL, cnpj_instituicao: ok }).success, ok).toBe(
        true,
      );
    }
  });

  it('rejects tarifa < 0', () => {
    expect(bandeiraCartaoSchema.safeParse({ ...MINIMAL, tarifa: -1 }).success).toBe(false);
  });

  it('rejects maxParcelas < 1', () => {
    expect(bandeiraCartaoSchema.safeParse({ ...MINIMAL, maxParcelas: 0 }).success).toBe(false);
  });

  it('accepts a known bandeira code', () => {
    const out = bandeiraCartaoSchema.parse({
      ...MINIMAL,
      bandeira: BANDEIRA.visa,
    });
    expect(out.bandeira).toBe('01');
  });

  it('rejects an unknown bandeira code', () => {
    expect(bandeiraCartaoSchema.safeParse({ ...MINIMAL, bandeira: '00' }).success).toBe(false);
  });

  // Regression: Firebase JS SDK v12 rejects `undefined` in addDoc/setDoc.
  it('rejects missing cnpj_instituicao (must be present, even if null)', () => {
    const { cnpj_instituicao, ...without } = MINIMAL;
    void cnpj_instituicao;
    expect(bandeiraCartaoSchema.safeParse(without).success).toBe(false);
  });
});

describe('bandeira enum + labels', () => {
  it('has labels for every bandeira value', () => {
    for (const value of Object.values(BANDEIRA)) {
      expect(BANDEIRA_LABELS[value]).toBeDefined();
      expect(bandeiraSchema.safeParse(value).success).toBe(true);
    }
  });
});

describe('bandeiraCartaoMeta', () => {
  it('targets the bandeirasCartao collection', () => {
    expect(bandeiraCartaoMeta.collectionPath).toBe('bandeirasCartao');
  });

  it('reuses the pagamento BigInt permission bits', () => {
    expect(bandeiraCartaoMeta.permissions.read).toBe(1n << 24n);
    expect(bandeiraCartaoMeta.permissions.write).toBe(1n << 25n);
    expect(bandeiraCartaoMeta.permissions.delete).toBe(1n << 26n);
  });
});

/**
 * `bandeiraDoNomeDaMarca` decides which card brand two spellings name — a fold
 * whose output is what the NF-e `tBand` says (`equivalence-fold-inventory`). Each
 * direction is pinned: what must come out EQUAL, and the near-misses that must
 * stay DISTINCT.
 */
describe('bandeiraDoNomeDaMarca', () => {
  const conhecida = (bandeira: string) => ({ bandeira, desconhecida: false });
  const DESCONHECIDA = { bandeira: BANDEIRA.outros, desconhecida: true };
  const SEM_MARCA = { bandeira: null, desconhecida: false };

  it.each([
    ['Visa', BANDEIRA.visa],
    ['VISA', BANDEIRA.visa],
    [' visa ', BANDEIRA.visa],
    ['Mastercard', BANDEIRA.mastercard],
    ['MasterCard', BANDEIRA.mastercard],
    ['master', BANDEIRA.mastercard],
    ['American Express', BANDEIRA.american_express],
    ['amex', BANDEIRA.american_express],
    ['american_express', BANDEIRA.american_express],
    ['Diners Club', BANDEIRA.diners],
    ['diners', BANDEIRA.diners],
    ['Elo', BANDEIRA.elo],
    ['Hipercard', BANDEIRA.hipercard],
  ])('★ EQUAL: %j ⇒ %s', (raw, codigo) => {
    expect(bandeiraDoNomeDaMarca(raw)).toEqual(conhecida(codigo));
  });

  it('★ every BANDEIRA member name is a hit — the Shopee-parity members included', () => {
    // A fold without the member-name lookup would answer `sorocred`, `aura` and
    // `cabal` as unknown, and moving the Shopee importer onto this fold would
    // then change its verdicts.
    expect(bandeiraDoNomeDaMarca('sorocred')).toEqual(conhecida(BANDEIRA.sorocred));
    expect(bandeiraDoNomeDaMarca('aura')).toEqual(conhecida(BANDEIRA.aura));
    expect(bandeiraDoNomeDaMarca('Cabal')).toEqual(conhecida(BANDEIRA.cabal));
    for (const [nome, codigo] of Object.entries(BANDEIRA)) {
      expect(bandeiraDoNomeDaMarca(nome), nome).toEqual(conhecida(codigo));
    }
  });

  it("the two aliases beyond the Shopee importer's fold are KNOWN — its migration turns exactly these from unknown into known", () => {
    // The Shopee fold knows the member names plus `master` and `amex`, and files
    // any other spelling as an unknown 99. This fold keeps every one of those
    // verdicts and adds exactly the two below, so moving the Shopee importer
    // here changes those two (unknown 99 ⇒ a known code), and nothing else.
    const comumAosDois = { master: BANDEIRA.mastercard, amex: BANDEIRA.american_express };
    for (const [nome, codigo] of Object.entries(comumAosDois)) {
      expect(bandeiraDoNomeDaMarca(nome), nome).toEqual(conhecida(codigo));
    }
    const soNesteFold = {
      'american express': BANDEIRA.american_express,
      'diners club': BANDEIRA.diners,
    };
    for (const [nome, codigo] of Object.entries(soNesteFold)) {
      expect(bandeiraDoNomeDaMarca(nome), nome).toEqual(conhecida(codigo));
    }
  });

  it.each(['Visas', 'Visa Electron', 'Master Card', 'american  express', 'mastercard platinum'])(
    '★ NEAR-MISS: %j is UNKNOWN (99 + desconhecida), never the brand it contains',
    (raw) => {
      expect(bandeiraDoNomeDaMarca(raw)).toEqual(DESCONHECIDA);
    },
  );

  it('★ NEAR-MISS: an explicit `outros` is 99 WITHOUT the unknown flag — distinct from an unknown brand', () => {
    expect(bandeiraDoNomeDaMarca('outros')).toEqual(conhecida(BANDEIRA.outros));
    expect(bandeiraDoNomeDaMarca('Outros')).toEqual(conhecida(BANDEIRA.outros));
    expect(bandeiraDoNomeDaMarca('outros')).not.toEqual(bandeiraDoNomeDaMarca('nao-existe'));
  });

  it('NEAR-MISS: two real brands stay apart', () => {
    expect(bandeiraDoNomeDaMarca('Elo')).not.toEqual(bandeiraDoNomeDaMarca('Hipercard'));
    expect(bandeiraDoNomeDaMarca('Visa')).not.toEqual(bandeiraDoNomeDaMarca('Mastercard'));
  });

  it.each([[''], ['   '], [null], [undefined], [1], [{ nome: 'visa' }]])(
    '★ no brand (%j) is null, never 99',
    (raw) => {
      expect(bandeiraDoNomeDaMarca(raw)).toEqual(SEM_MARCA);
    },
  );

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    '★ an inherited key (%s) is an UNKNOWN brand, never a function or a hit',
    (raw) => {
      expect(bandeiraDoNomeDaMarca(raw)).toEqual(DESCONHECIDA);
    },
  );
});
