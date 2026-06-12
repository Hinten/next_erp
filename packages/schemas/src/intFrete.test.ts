import { describe, expect, it } from 'vitest';
import {
  faixaCepOptionString,
  faixaDeCepSchema,
  getPrazoDespacho,
  intFreteMeta,
  intFreteSchema,
  tokenMelEnvMeta,
  tokenMelEnvSchema,
} from './intFrete';

/* -------------------------------------------------------------------------- */
/*      Golden-doc round-trips — fixtures shaped exactly as Flutter writes    */
/* -------------------------------------------------------------------------- */

describe('intFreteSchema — golden Flutter docs', () => {
  it('parses a Motoboy doc (faixaCep + horarioDeCorte) preserving every key', () => {
    const doc = {
      tipo: 'motoboy',
      nome: 'Motoboy Centro',
      ativo: true,
      filialIntegracaoFreteOuterRef: 'documents/filiais/fil-001',
      dataCadastro: 1718000000000,
      prazoExtra: 0,
      faixaCep: [
        { cepInicial: '01000000', cepFinal: '01999999', custo: 15, valor: 20, prazo: 1 },
        { cepInicial: '02000000', cepFinal: '02999999', custo: 18.5, valor: 25, prazo: 2 },
      ],
      horarioDeCorte: [
        {
          diaDaSemana: 1,
          horaDeCorte: 16,
          minutosDeCorte: 30,
          prazoDePostagem: 0,
          horaPostagem: 18,
          minutosPostagem: 0,
        },
      ],
    };
    const parsed = intFreteSchema.parse(doc);
    expect(parsed).toMatchObject(doc);
    // Keys Flutter omits when null come back as explicit null (read-safe for
    // the Flutter fromJson helpers, which all accept null).
    expect(parsed.mapa).toBeNull();
    expect(parsed.client_id).toBeNull();
    expect(parsed.enderecoDeOrigem).toBeNull();
  });

  it('parses a RetirarNaLoja doc with prazoExtra', () => {
    const doc = {
      tipo: 'retiradaNaLoja',
      nome: 'Retirada Loja Matriz',
      ativo: true,
      filialIntegracaoFreteOuterRef: 'documents/filiais/fil-001',
      dataCadastro: 1718000000000,
      prazoExtra: 2,
      horarioDeCorte: [
        {
          diaDaSemana: 5,
          horaDeCorte: 12,
          minutosDeCorte: 0,
          prazoDePostagem: 1,
          horaPostagem: 9,
          minutosPostagem: 0,
        },
      ],
    };
    expect(intFreteSchema.parse(doc)).toMatchObject(doc);
  });

  it('parses a ContaMelhorEnvios doc (client_id/client_secret + enderecoDeOrigem)', () => {
    const doc = {
      tipo: 'melhorEnvios',
      nome: 'Conta ME Principal',
      ativo: true,
      filialIntegracaoFreteOuterRef: 'documents/filiais/fil-001',
      dataCadastro: 1718000000000,
      client_id: '1234',
      client_secret: 'shhh',
      enderecoDeOrigem: {
        idExterno: null,
        logradouro: 'Rua das Caixas',
        numero: '42',
        bairro: 'Centro',
        complemento: null,
        cep: '01310100',
        codigoMunicipio: '3550308',
        cidade: 'São Paulo',
        estado: 'SP',
        cPais: null,
        pais: null,
        nome: null,
        cpf_cnpj: null,
        rg: null,
        ie: null,
        imun: null,
        email: null,
        telefone: null,
      },
    };
    const parsed = intFreteSchema.parse(doc);
    expect(parsed).toMatchObject(doc);
    expect(parsed.prazoExtra).toBe(0); // defaulted, never null
  });

  it('parses a marketplace doc (mercadoLivre) with a mapa routing table', () => {
    const doc = {
      tipo: 'mercadoLivre',
      nome: 'Mercado Envios',
      ativo: true,
      filialIntegracaoFreteOuterRef: 'documents/filiais/fil-001',
      dataCadastro: 1718000000000,
      mapa: [
        {
          nomeOriginal: 'Mercado Envios Full',
          idOriginal: 'fulfillment',
          observacao: null,
          nomeTarget: null,
          targetData: null,
          integracaoUid: null,
          targetTipoIntegracao: 'outros',
        },
        {
          nomeOriginal: 'Mercado Envios Flex',
          idOriginal: 'self_service',
          observacao: 'Entrega própria',
          nomeTarget: 'Motoboy Centro',
          targetData: { zona: 'centro' },
          integracaoUid: 'mtb-001',
          targetTipoIntegracao: 'motoboy',
        },
      ],
    };
    expect(intFreteSchema.parse(doc)).toMatchObject(doc);
  });

  it('preserves unknown legacy keys via passthrough (top level and nested)', () => {
    const parsed = intFreteSchema.parse({
      tipo: 'fob',
      nome: 'FOB',
      ativo: false,
      filialIntegracaoFreteOuterRef: 'documents/filiais/fil-001',
      dataCadastro: 1718000000000,
      campoLegadoDesconhecido: 'mantém',
      faixaCep: [
        {
          cepInicial: '01000000',
          cepFinal: '01999999',
          custo: 0,
          valor: 10,
          prazo: 0,
          extraLegado: true,
        },
      ],
    });
    expect((parsed as Record<string, unknown>).campoLegadoDesconhecido).toBe('mantém');
    expect((parsed.faixaCep?.[0] as Record<string, unknown>).extraLegado).toBe(true);
  });

  it('requires dataCadastro (Flutter late final DateTime crashes on null)', () => {
    const base = {
      tipo: 'motoboy',
      nome: 'X',
      ativo: true,
      filialIntegracaoFreteOuterRef: 'documents/filiais/f',
    };
    expect(intFreteSchema.safeParse(base).success).toBe(false);
    expect(intFreteSchema.safeParse({ ...base, dataCadastro: null }).success).toBe(false);
    expect(intFreteSchema.safeParse({ ...base, dataCadastro: 1718000000000 }).success).toBe(true);
  });

  it('rejects null prazoExtra (non-nullable Dart int) but defaults it when absent', () => {
    const base = {
      tipo: 'retiradaNaLoja',
      nome: 'X',
      ativo: true,
      filialIntegracaoFreteOuterRef: 'documents/filiais/f',
      dataCadastro: 1718000000000,
    };
    expect(intFreteSchema.parse(base).prazoExtra).toBe(0);
    expect(intFreteSchema.safeParse({ ...base, prazoExtra: null }).success).toBe(false);
  });

  it('rejects malformed CEPs in faixaCep', () => {
    expect(
      faixaDeCepSchema.safeParse({
        cepInicial: '0100000', // 7 digits
        cepFinal: '01999999',
        custo: 0,
        valor: 10,
        prazo: 1,
      }).success,
    ).toBe(false);
  });

  it('rejects duplicate weekdays in horarioDeCorte, pointing at the duplicate row', () => {
    const base = {
      tipo: 'retiradaNaLoja',
      nome: 'X',
      ativo: true,
      filialIntegracaoFreteOuterRef: 'documents/filiais/f',
      dataCadastro: 1718000000000,
    };
    const horario = (dia: number) => ({
      diaDaSemana: dia,
      horaDeCorte: 12,
      minutosDeCorte: 0,
      prazoDePostagem: 0,
      horaPostagem: 9,
      minutosPostagem: 0,
    });

    const dup = intFreteSchema.safeParse({
      ...base,
      horarioDeCorte: [horario(1), horario(3), horario(1)],
    });
    expect(dup.success).toBe(false);
    if (!dup.success) {
      const issue = dup.error.issues.find((i) => i.message === 'Dia da semana duplicado');
      expect(issue?.path).toEqual(['horarioDeCorte', 2, 'diaDaSemana']);
    }

    expect(
      intFreteSchema.safeParse({ ...base, horarioDeCorte: [horario(1), horario(2)] }).success,
    ).toBe(true);
    expect(intFreteSchema.safeParse({ ...base, horarioDeCorte: null }).success).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*                           faixaCepOptionString                             */
/* -------------------------------------------------------------------------- */

describe('faixaCepOptionString', () => {
  it('matches the Dart interpolation byte-for-byte (integral doubles get .0)', () => {
    expect(
      faixaCepOptionString({
        cepInicial: '01000000',
        cepFinal: '01999999',
        custo: 15,
        valor: 20,
        prazo: 1,
      }),
    ).toBe('01000000 - 01999999 - 15.0 - 20.0 - 1');
  });

  it('keeps fractional doubles as-is', () => {
    expect(
      faixaCepOptionString({
        cepInicial: '02000000',
        cepFinal: '02999999',
        custo: 18.5,
        valor: 25.25,
        prazo: 3,
      }),
    ).toBe('02000000 - 02999999 - 18.5 - 25.25 - 3');
  });
});

/* -------------------------------------------------------------------------- */
/*                              tokenMelEnv                                   */
/* -------------------------------------------------------------------------- */

describe('tokenMelEnvSchema', () => {
  it('parses a token doc', () => {
    const doc = {
      access_token: 'jwt.abc.def',
      refresh_token: 'r-123',
      expirationDate: 1718003600000,
    };
    expect(tokenMelEnvSchema.parse(doc)).toMatchObject(doc);
  });

  it('requires all three fields', () => {
    expect(tokenMelEnvSchema.safeParse({ access_token: 'a', expirationDate: 1 }).success).toBe(
      false,
    );
  });
});

/* -------------------------------------------------------------------------- */
/*                                 Metas                                      */
/* -------------------------------------------------------------------------- */

describe('metas', () => {
  it('intFreteMeta targets int_frete and cascades tokenMelEnv', () => {
    expect(intFreteMeta.collectionPath).toBe('int_frete');
    expect(intFreteMeta.cascade).toEqual([
      { path: 'int_frete/{intFreteId}/tokenMelEnv', onDelete: 'cascade' },
    ]);
  });

  it('tokenMelEnvMeta targets the subcollection', () => {
    expect(tokenMelEnvMeta.collectionPath).toBe('int_frete/{intFreteId}/tokenMelEnv');
  });

  it('permission bits line up with the PERM.frete domain (88–90)', () => {
    expect(intFreteMeta.permissions).toEqual({
      read: 1n << 88n,
      write: 1n << 89n,
      delete: 1n << 90n,
    });
    // Token reads deliberately require frete.write (credentials), delete uses
    // the dedicated delete bit.
    expect(tokenMelEnvMeta.permissions).toEqual({
      read: 1n << 89n,
      write: 1n << 89n,
      delete: 1n << 90n,
    });
  });
});

/* -------------------------------------------------------------------------- */
/*                            getPrazoDespacho                                */
/*                                                                            */
/*  Anchors: 2021-01-04 is a Monday (Dart weekday 1); all dates built with    */
/*  the local-time constructor — the function never reads the wall clock.    */
/* -------------------------------------------------------------------------- */

const corteSegunda = {
  diaDaSemana: 1 as const,
  horaDeCorte: 16,
  minutosDeCorte: 30,
  prazoDePostagem: 0,
  horaPostagem: 18,
  minutosPostagem: 0,
};

describe('getPrazoDespacho', () => {
  it('returns null for null/empty schedules', () => {
    expect(getPrazoDespacho(null, new Date(2021, 0, 4, 10, 0))).toBeNull();
    expect(getPrazoDespacho([], new Date(2021, 0, 4, 10, 0))).toBeNull();
  });

  it('same day before the cut-off → today at the posting time', () => {
    const out = getPrazoDespacho([corteSegunda], new Date(2021, 0, 4, 10, 0));
    expect(out).toEqual(new Date(2021, 0, 4, 18, 0));
  });

  it('minute boundary is inclusive (hour == horaDeCorte && minute <= minutosDeCorte)', () => {
    const out = getPrazoDespacho([corteSegunda], new Date(2021, 0, 4, 16, 30));
    expect(out).toEqual(new Date(2021, 0, 4, 18, 0));
  });

  it('one minute past the cut-off with a single-weekday schedule → null (legacy quirk: the same weekday only recurs at +7, past the c<7 scan)', () => {
    const out = getPrazoDespacho([corteSegunda], new Date(2021, 0, 4, 16, 31));
    expect(out).toBeNull();
  });

  it('no entry today → scans forward to the next scheduled weekday', () => {
    // Tuesday Jan 5 → next segunda is Jan 11 (c=6, no cut-off check past day 0).
    const out = getPrazoDespacho([corteSegunda], new Date(2021, 0, 5, 10, 0));
    expect(out).toEqual(new Date(2021, 0, 11, 18, 0));
  });

  it("prazoDePostagem comes from TODAY's entry and shifts the target weekday", () => {
    const horarios = [
      { ...corteSegunda, prazoDePostagem: 2 },
      {
        diaDaSemana: 3 as const, // quarta
        horaDeCorte: 16,
        minutosDeCorte: 0,
        prazoDePostagem: 0,
        horaPostagem: 11,
        minutosPostagem: 45,
      },
    ];
    // Monday 10:00, prazoDePostagem=2 → target weekday = quarta; the matched
    // entry (quarta) provides the posting time; date = monday + 0 + 2.
    const out = getPrazoDespacho(horarios, new Date(2021, 0, 4, 10, 0));
    expect(out).toEqual(new Date(2021, 0, 6, 11, 45));
  });

  it('weekday wrap: Friday with a Monday-only schedule lands on next Monday', () => {
    // Friday Jan 29 → Mon Feb 1 (c=3, date overflows into February).
    const out = getPrazoDespacho([corteSegunda], new Date(2021, 0, 29, 10, 0));
    expect(out).toEqual(new Date(2021, 1, 1, 18, 0));
  });

  it('null hora/minutos de corte count as 00:00 (same-day match only at exactly midnight)', () => {
    const semCorte = {
      diaDaSemana: 1 as const,
      horaDeCorte: null,
      minutosDeCorte: null,
      prazoDePostagem: null,
      horaPostagem: null,
      minutosPostagem: null,
    };
    // 00:00 → hour==0 && minute<=0 passes; posting time defaults 00:00.
    expect(getPrazoDespacho([semCorte], new Date(2021, 0, 4, 0, 0))).toEqual(
      new Date(2021, 0, 4, 0, 0),
    );
    // 00:01 → cut-off missed; single-weekday schedule → null (quirk above).
    expect(getPrazoDespacho([semCorte], new Date(2021, 0, 4, 0, 1))).toBeNull();
  });
});
