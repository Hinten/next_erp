import { describe, expect, it, vi } from 'vitest';
import { ViaCepError, type EnderecoViaCep, type ViaCepClient } from '@delfrance/core/cep';
import { UF_SIGLA, enderecoSchema } from './endereco';
import {
  ENDERECO_FALLBACKS,
  NFE_ENDERECO_LIMITES,
  buildEnderecoForcado,
  recoverEnderecoFromCep,
  resolveUf,
  sanitizeCep,
  type EnderecoBuildOutcome,
  type EnderecoForcado,
} from './enderecoBuilder';

const CEP = '01310100';

/** A complete, ordinary billing address — the shape every case varies from. */
function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cepRaw: CEP,
    logradouro: 'Avenida Paulista',
    numero: '1578',
    complemento: 'sala 4',
    bairro: 'Bela Vista',
    cidade: 'São Paulo',
    estadoRaw: 'São Paulo',
    paisId: 'BR',
    ...overrides,
  };
}

function ok(raw: unknown): EnderecoForcado {
  const outcome = buildEnderecoForcado(raw);
  if (outcome.kind !== 'ok') throw new Error(`esperava 'ok', veio '${outcome.kind}'`);
  return outcome.fields;
}

function stubViaCep(resposta: EnderecoViaCep | null | Error): ViaCepClient {
  return {
    buscarCep: vi.fn(async () => {
      if (resposta instanceof Error) throw resposta;
      return resposta;
    }),
  };
}

const VIACEP_SP: EnderecoViaCep = {
  logradouro: 'Avenida Paulista',
  bairro: 'Bela Vista',
  cidade: 'São Paulo',
  estado: 'SP',
  codigoMunicipio: '3550308',
};

describe('sanitizeCep', () => {
  it('strips punctuation and keeps 8 digits', () => {
    expect(sanitizeCep('01310-100')).toBe(CEP);
    expect(sanitizeCep(' 01.310.100 ')).toBe(CEP);
  });

  it.each([null, '', '0131010', '013101000', 'abcdefgh', '0000000'])(
    'rejects %j — enderecoSchema.cep demands exactly 8 digits',
    (entrada) => {
      expect(sanitizeCep(entrada)).toBeNull();
    },
  );
});

describe('resolveUf', () => {
  it('maps an accented state NAME to its sigla', () => {
    expect(resolveUf('São Paulo')).toBe(UF_SIGLA.SP);
    expect(resolveUf('  paranÁ ')).toBe(UF_SIGLA.PR);
  });

  it('accepts a sigla directly, in any casing', () => {
    expect(resolveUf('sp')).toBe(UF_SIGLA.SP);
    expect(resolveUf('EX')).toBe(UF_SIGLA.EX);
  });

  it("treats an ABSENT estado as AC — forceEndereco's null-branch, not a failure", () => {
    expect(resolveUf(null)).toBe(UF_SIGLA.AC);
  });

  it('returns null for a present-but-unrecognised name', () => {
    expect(resolveUf('Freedonia')).toBeNull();
    // Unaccented Portuguese is NOT folded — that is #788's fix, at the decode
    // boundary. Pinned here so the gap is visible rather than assumed absent.
    expect(resolveUf('Sao Paulo')).toBeNull();
  });
});

describe('buildEnderecoForcado — happy path', () => {
  it('passes a complete address through untouched', () => {
    expect(ok(raw())).toEqual({
      idExterno: null,
      cep: CEP,
      logradouro: 'Avenida Paulista',
      numero: '1578',
      bairro: 'Bela Vista',
      complemento: 'sala 4',
      codigoMunicipio: null,
      cidade: 'São Paulo',
      estado: UF_SIGLA.SP,
      cPais: null,
      pais: null,
      nome: null,
      cpf_cnpj: null,
      rg: null,
      ie: null,
      imun: null,
      email: null,
      telefone: null,
    } satisfies EnderecoForcado);
  });

  it('produces something enderecoSchema actually accepts, fallbacks included', () => {
    // The whole point of the force fill: what comes out must be storable
    // without a ZodError aborting the import.
    expect(() => enderecoSchema.parse(ok(raw()))).not.toThrow();
    expect(() => enderecoSchema.parse(ok({ cepRaw: CEP }))).not.toThrow();
  });

  it('stores a non-BR country id and drops BR as the implicit default', () => {
    expect(ok(raw({ paisId: 'AR' })).pais).toBe('AR');
    expect(ok(raw({ paisId: 'BR' })).pais).toBeNull();
  });

  it('never fills codigoMunicipio — that field is a manual override, not a cache', () => {
    expect(ok(raw()).codigoMunicipio).toBeNull();
    expect(ok(raw({ codigoMunicipio: '3550308' })).codigoMunicipio).toBeNull();
  });
});

describe('buildEnderecoForcado — CEP is the only essential field', () => {
  it.each([
    ['ausente', undefined],
    ['nulo', null],
    ['vazio', ''],
    ['curto demais', '1234567'],
    ['sem dígitos', 'não informado'],
    ["o filler '0000000' do legado", '0000000'],
  ])('reporta sem-cep quando o CEP está %s', (_rotulo, cepRaw) => {
    const outcome = buildEnderecoForcado(raw({ cepRaw }));
    expect(outcome.kind).toBe('sem-cep');
  });

  it('carries the rejected raw value so the caller can log what arrived', () => {
    const outcome = buildEnderecoForcado(raw({ cepRaw: '  123  ' }));
    expect(outcome).toEqual({ kind: 'sem-cep', cepRaw: '123' });
  });

  it('builds from a CEP alone — every other field is forced', () => {
    expect(ok({ cepRaw: '01310-100' })).toMatchObject({
      cep: CEP,
      logradouro: ENDERECO_FALLBACKS.logradouro,
      numero: ENDERECO_FALLBACKS.numero,
      bairro: ENDERECO_FALLBACKS.bairro,
      cidade: ENDERECO_FALLBACKS.cidade,
      complemento: null,
      estado: UF_SIGLA.AC,
    });
  });
});

describe('buildEnderecoForcado — untrusted input', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['uma string', 'Avenida Paulista, 1578'],
    ['um array', []],
    ['um número', 42],
  ])('não lança quando o input inteiro é %s', (_rotulo, entrada) => {
    expect(() => buildEnderecoForcado(entrada)).not.toThrow();
    expect(buildEnderecoForcado(entrada).kind).toBe('sem-cep');
  });

  it('coerces a numeric street_number instead of storing a number', () => {
    const fields = ok(raw({ numero: 1578 }));
    expect(fields.numero).toBe('1578');
    expect(typeof fields.numero).toBe('string');
  });

  it('coerces a numeric CEP without inventing a leading zero', () => {
    // A CEP arriving as a number has already lost its leading zero: 1310100 is
    // 7 digits, so it is rejected rather than zero-padded into a different city.
    expect(buildEnderecoForcado(raw({ cepRaw: 1310100 }))).toEqual({
      kind: 'sem-cep',
      cepRaw: '1310100',
    });
    // A CEP that never had one round-trips fine.
    expect(ok(raw({ cepRaw: 13101000 })).cep).toBe('13101000');
  });

  it('discards non-scalar garbage rather than stringifying it', () => {
    const fields = ok(raw({ logradouro: { nome: 'Rua X' }, bairro: ['Centro'], cidade: true }));
    expect(fields.logradouro).toBe(ENDERECO_FALLBACKS.logradouro);
    expect(fields.bairro).toBe(ENDERECO_FALLBACKS.bairro);
    expect(fields.cidade).toBe(ENDERECO_FALLBACKS.cidade);
  });

  it('ignores non-finite numbers', () => {
    expect(ok(raw({ numero: NaN })).numero).toBe(ENDERECO_FALLBACKS.numero);
    expect(ok(raw({ numero: Infinity })).numero).toBe(ENDERECO_FALLBACKS.numero);
  });

  it('trims, and treats a whitespace-only value as absent', () => {
    expect(ok(raw({ logradouro: '  Rua das Flores  ' })).logradouro).toBe('Rua das Flores');
    expect(ok(raw({ logradouro: '   ' })).logradouro).toBe(ENDERECO_FALLBACKS.logradouro);
    // Not 'Rua ' — the completion prefix must never be applied to nothing.
    expect(ok(raw({ bairro: '\t\n' })).bairro).toBe(ENDERECO_FALLBACKS.bairro);
  });
});

describe('buildEnderecoForcado — NF-e length limits', () => {
  it('clamps a logradouro longer than the XSD allows, so stored === signed', () => {
    const longo = 'Avenida Professora Ida Kolb do Nascimento Santos e Silva Junior de Almeida';
    expect(longo.length).toBeGreaterThan(NFE_ENDERECO_LIMITES.logradouro.max);
    const fields = ok(raw({ logradouro: longo }));
    expect(fields.logradouro).toHaveLength(NFE_ENDERECO_LIMITES.logradouro.max);
    expect(longo.startsWith(fields.logradouro)).toBe(true);
  });

  it('never leaves a trailing space behind a cut', () => {
    const fields = ok(raw({ logradouro: `${'a'.repeat(59)} palavra` }));
    expect(fields.logradouro).toBe('a'.repeat(59));
  });

  it('honours the stricter SCHEMA cap on numero and complemento', () => {
    expect(ok(raw({ numero: '1'.repeat(30) })).numero).toHaveLength(
      NFE_ENDERECO_LIMITES.numero.max,
    );
    expect(ok(raw({ complemento: 'c'.repeat(90) })).complemento).toHaveLength(
      NFE_ENDERECO_LIMITES.complemento.max,
    );
  });

  it('completes a 1-char logradouro instead of throwing the character away', () => {
    // xLgr requires 2 characters; today such a value stores fine and then fails
    // the pre-send XSD gate. Clientes really do send these.
    expect(ok(raw({ logradouro: 'A' })).logradouro).toBe('Rua A');
  });

  it('completes a 1-char bairro the same way', () => {
    expect(ok(raw({ bairro: 'B' })).bairro).toBe('Bairro B');
  });

  it('has no completion for cidade — a 1-char município is garbage, not data', () => {
    expect(ok(raw({ cidade: 'X' })).cidade).toBe(ENDERECO_FALLBACKS.cidade);
  });

  it('accepts a 1-char numero, whose XSD minimum is 1', () => {
    expect(ok(raw({ numero: '7' })).numero).toBe('7');
  });

  it('every fallback and completion clears the XSD minimum', () => {
    const forcado = ok({ cepRaw: CEP });
    expect(forcado.logradouro.length).toBeGreaterThanOrEqual(NFE_ENDERECO_LIMITES.logradouro.min);
    expect(forcado.bairro.length).toBeGreaterThanOrEqual(NFE_ENDERECO_LIMITES.bairro.min);
    expect(forcado.cidade.length).toBeGreaterThanOrEqual(NFE_ENDERECO_LIMITES.cidade.min);
    expect(forcado.numero.length).toBeGreaterThanOrEqual(NFE_ENDERECO_LIMITES.numero.min);
    expect(ok(raw({ logradouro: 'A', bairro: 'B' })).logradouro.length).toBeGreaterThanOrEqual(2);
  });
});

describe('buildEnderecoForcado — estado', () => {
  it('resolves a name, a sigla, and defaults an absent one to AC', () => {
    expect(ok(raw({ estadoRaw: 'Minas Gerais' })).estado).toBe(UF_SIGLA.MG);
    expect(ok(raw({ estadoRaw: 'mg' })).estado).toBe(UF_SIGLA.MG);
    expect(ok(raw({ estadoRaw: null })).estado).toBe(UF_SIGLA.AC);
  });

  it('reports uf-desconhecida for a present-but-unmappable estado, WITH a usable endereço', () => {
    const outcome = buildEnderecoForcado(raw({ estadoRaw: 'Sao Paulo' }));
    expect(outcome.kind).toBe('uf-desconhecida');
    if (outcome.kind !== 'uf-desconhecida') return;
    expect(outcome.estadoRaw).toBe('Sao Paulo');
    // Not a discard: everything else is filled and the UF is provisionally AC.
    expect(outcome.fields).toMatchObject({ cep: CEP, logradouro: 'Avenida Paulista' });
    expect(outcome.fields.estado).toBe(UF_SIGLA.AC);
  });

  it('prefers sem-cep over uf-desconhecida — no CEP means nothing to recover from', () => {
    expect(buildEnderecoForcado(raw({ estadoRaw: 'Freedonia', cepRaw: null }))).toEqual({
      kind: 'sem-cep',
      cepRaw: null,
    });
  });
});

describe('recoverEnderecoFromCep', () => {
  function desconhecida(overrides: Record<string, unknown> = {}) {
    const outcome = buildEnderecoForcado(raw({ estadoRaw: 'Sao Paulo', ...overrides }));
    if (outcome.kind !== 'uf-desconhecida') throw new Error(`veio '${outcome.kind}'`);
    return outcome;
  }

  it('resolves the real UF from the CEP', async () => {
    const { fields, ufResolvida } = await recoverEnderecoFromCep(
      desconhecida(),
      stubViaCep(VIACEP_SP),
    );
    expect(ufResolvida).toBe(true);
    expect(fields.estado).toBe(UF_SIGLA.SP);
  });

  it('fills only the fields that fell back — the payload wins', async () => {
    const outcome = desconhecida({ logradouro: 'Rua Particular do Cliente', bairro: null });
    const { fields } = await recoverEnderecoFromCep(outcome, stubViaCep(VIACEP_SP));
    expect(fields.logradouro).toBe('Rua Particular do Cliente');
    expect(fields.bairro).toBe('Bela Vista');
  });

  it('keeps the fallback when ViaCEP answers blank (a CEP-geral, city-wide code)', async () => {
    const cepGeral: EnderecoViaCep = { ...VIACEP_SP, logradouro: '', bairro: '   ' };
    const { fields } = await recoverEnderecoFromCep(
      desconhecida({ logradouro: null, bairro: null }),
      stubViaCep(cepGeral),
    );
    expect(fields.logradouro).toBe(ENDERECO_FALLBACKS.logradouro);
    expect(fields.bairro).toBe(ENDERECO_FALLBACKS.bairro);
    expect(fields.estado).toBe(UF_SIGLA.SP);
  });

  it('clamps what ViaCEP returns, exactly like the payload', async () => {
    const gigante: EnderecoViaCep = { ...VIACEP_SP, logradouro: 'R'.repeat(200) };
    const { fields } = await recoverEnderecoFromCep(
      desconhecida({ logradouro: null }),
      stubViaCep(gigante),
    );
    expect(fields.logradouro).toHaveLength(NFE_ENDERECO_LIMITES.logradouro.max);
  });

  it('keeps AC and reports ufResolvida:false when the CEP is unknown', async () => {
    const { fields, ufResolvida } = await recoverEnderecoFromCep(desconhecida(), stubViaCep(null));
    expect(ufResolvida).toBe(false);
    expect(fields.estado).toBe(UF_SIGLA.AC);
    // Losing the endereço would strand the pedido short of `pago`; keeping it
    // is safe because cMun is null, so emission throws rather than signing AC.
    expect(fields.cep).toBe(CEP);
  });

  it('swallows ViaCepError — a network failure is not a failed endereço', async () => {
    const { fields, ufResolvida } = await recoverEnderecoFromCep(
      desconhecida(),
      stubViaCep(new ViaCepError('sem rede', CEP)),
    );
    expect(ufResolvida).toBe(false);
    expect(fields.estado).toBe(UF_SIGLA.AC);
  });

  it('rethrows anything that is NOT a ViaCepError', async () => {
    await expect(
      recoverEnderecoFromCep(desconhecida(), stubViaCep(new RangeError('bug de verdade'))),
    ).rejects.toThrow(RangeError);
  });

  it('keeps AC when ViaCEP answers with something that is not a sigla', async () => {
    const lixo: EnderecoViaCep = { ...VIACEP_SP, estado: 'Sao Paulo' };
    const { fields, ufResolvida } = await recoverEnderecoFromCep(desconhecida(), stubViaCep(lixo));
    expect(ufResolvida).toBe(false);
    expect(fields.estado).toBe(UF_SIGLA.AC);
  });

  it('asks ViaCEP for the sanitised CEP, once', async () => {
    const client = stubViaCep(VIACEP_SP);
    await recoverEnderecoFromCep(desconhecida({ cepRaw: '01310-100' }), client);
    expect(client.buscarCep).toHaveBeenCalledTimes(1);
    expect(client.buscarCep).toHaveBeenCalledWith(CEP);
  });

  it('still yields a schema-valid endereço', async () => {
    const { fields } = await recoverEnderecoFromCep(desconhecida(), stubViaCep(VIACEP_SP));
    expect(() => enderecoSchema.parse(fields)).not.toThrow();
  });
});

describe('EnderecoBuildOutcome', () => {
  it('is exhaustively narrowable — every kind carries what its handler needs', () => {
    const outcomes: EnderecoBuildOutcome[] = [
      buildEnderecoForcado(raw()),
      buildEnderecoForcado(raw({ estadoRaw: 'Freedonia' })),
      buildEnderecoForcado(raw({ cepRaw: null })),
    ];
    expect(outcomes.map((o) => o.kind)).toEqual(['ok', 'uf-desconhecida', 'sem-cep']);
  });
});
