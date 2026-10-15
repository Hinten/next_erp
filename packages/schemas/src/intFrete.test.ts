import { describe, expect, it } from 'vitest';
import {
  calcularPrazoDespachoCivil,
  escolherIntFreteMaisNovo,
  faixaCepOptionString,
  faixaDeCepSchema,
  getPrazoDespacho,
  getPrazoDespachoNoFuso,
  intFreteMeta,
  intFreteSchema,
  tokenMelEnvMeta,
  tokenMelEnvSchema,
  type DiaDaSemana,
  type HorarioDeCorte,
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
/*          contaShopeeFreteOuterRef — the Shopee conta back-ref (#1528)       */
/* -------------------------------------------------------------------------- */

describe('intFreteSchema — contaShopeeFreteOuterRef (#1528)', () => {
  /**
   * A legacy `FreteShopee` doc with exactly the keys `_$FreteShopeeToJson` writes
   * (`.old/packages/canais_de_venda/shopee/lib/src/models.g.dart:127-154`):
   * `FreteShopee.fromConta` sets tipo / nome / ativo / the filial / the back-ref,
   * the base constructor stamps `dataCadastro` in ms, `mapa` / `faixaCep` /
   * `horarioDeCorte` / `enderecoDeOrigem` are `writeNotNull` and never set (so
   * ABSENT), there is no `prazoExtra` (not a `FreteShopee` field) and no
   * `ultimaModificacao`, and the ODM's `docId` rides along. This is the shape
   * the window import brings in, and the sync ADOPTS it by this key.
   */
  const legado = {
    tipo: 'shopee',
    nome: 'Loja Shopee',
    ativo: true,
    dataCadastro: 1718000000000,
    filialIntegracaoFreteOuterRef: 'documents/filiais/f-1',
    contaShopeeFreteOuterRef: 'documents/integracao/int-1',
    docId: 'legacy-1',
  };

  it('T21 — parses the legacy FreteShopee golden doc, keeping the back-ref and the ODM docId', () => {
    const parsed = intFreteSchema.parse(legado);

    expect(parsed).toMatchObject(legado);
    expect(parsed.contaShopeeFreteOuterRef).toBe('documents/integracao/int-1');
    // The keys the legacy serializer never wrote come back defaulted, never absent.
    expect(parsed.ultimaModificacao).toBeNull();
    expect(parsed.prazoExtra).toBe(0);
    expect(parsed.horarioDeCorte).toBeNull();
    // The Mercado Livre twin is a DIFFERENT key: a Shopee doc leaves it null.
    expect(parsed.contaMercadoLivreMercadoEnviosOuterRef).toBeNull();
    // `.passthrough()` keeps the ODM metadata the legacy app wrote.
    expect((parsed as Record<string, unknown>).docId).toBe('legacy-1');
  });

  it('T22 — an absent key reads back as an explicit null (a non-shopee doc, and the golden one without it)', () => {
    const motoboy = intFreteSchema.parse({
      tipo: 'motoboy',
      nome: 'Motoboy Centro',
      ativo: true,
      filialIntegracaoFreteOuterRef: 'documents/filiais/f-1',
      dataCadastro: 1718000000000,
    });
    expect(motoboy.contaShopeeFreteOuterRef).toBeNull();
    // PRESENT with null, not missing: a browser `addDoc` of the parsed value
    // must never carry `undefined`, and the converter writes every key.
    expect(Object.hasOwn(motoboy, 'contaShopeeFreteOuterRef')).toBe(true);

    const semChave: Record<string, unknown> = { ...legado };
    delete semChave.contaShopeeFreteOuterRef;
    const parsed = intFreteSchema.parse(semChave);
    expect(parsed.contaShopeeFreteOuterRef).toBeNull();
    expect(Object.hasOwn(parsed, 'contaShopeeFreteOuterRef')).toBe(true);
  });

  it('T23 — the canonical `documents/integracao/<id>` passes; the bare `integracao/<id>` (near-miss) FAILS', () => {
    const campo = intFreteSchema.shape.contaShopeeFreteOuterRef;

    // Equal side: the canonical ref and an explicit null are both valid.
    expect(campo.safeParse('documents/integracao/int-1').success).toBe(true);
    expect(campo.safeParse(null).success).toBe(true);

    // Near-miss: the bare `pathNoDocuments` spelling is NOT the canonical form.
    // The sync's lookup is an equality on the canonical string, so a doc holding
    // the bare form would never be found — the schema must not bless it either.
    expect(campo.safeParse('integracao/int-1').success).toBe(false);
    // A path ending on a COLLECTION is not a dereferenceable doc ref.
    expect(campo.safeParse('documents/integracao').success).toBe(false);

    const doc = intFreteSchema.safeParse({
      ...legado,
      contaShopeeFreteOuterRef: 'integracao/int-1',
    });
    expect(doc.success).toBe(false);
    if (!doc.success) {
      expect(doc.error.issues.map((i) => i.path)).toEqual([['contaShopeeFreteOuterRef']]);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*   contaLojaIntegradaEnviosOuterRef — the Loja Integrada conta back-ref      */
/*                               (#1826)                                       */
/* -------------------------------------------------------------------------- */

describe('intFreteSchema — contaLojaIntegradaEnviosOuterRef (#1826)', () => {
  /**
   * A migrated `EnviosLojaIntegrada` doc in the corpus shape of master plan §3: the plain fields,
   * the canonical back-ref, a `mapa` whose rows carry all seven keys (one mapped to a Melhor Envio
   * service, one unmapped carrying a key the schema does not model, one with no `idOriginal`), a
   * `horarioDeCorte`, and the ODM's `docId`. No `ultimaModificacao`, no `prazoExtra`.
   */
  const legado = {
    tipo: 'lojaIntegrada',
    nome: 'Loja Teste',
    ativo: true,
    dataCadastro: 1718000000000,
    filialIntegracaoFreteOuterRef: 'documents/filiais/f-1',
    contaLojaIntegradaEnviosOuterRef: 'documents/integracao/int-1',
    mapa: [
      {
        nomeOriginal: 'Gateway Teste - PAC',
        idOriginal: '141909---PAC',
        observacao: 'Origem: Pedido 101',
        nomeTarget: 'Empresa Teste — Serviço Teste',
        targetData: { id: 1, name: 'Serviço Teste', company: { id: 2, name: 'Empresa Teste' } },
        integracaoUid: 'me-1',
        targetTipoIntegracao: 'melhorEnvios',
      },
      {
        nomeOriginal: 'Gateway Teste - Expresso',
        idOriginal: '141909---null',
        observacao: 'Origem: Pedido 102',
        nomeTarget: null,
        targetData: null,
        integracaoUid: null,
        targetTipoIntegracao: 'outros',
        campoDesconhecido: 'mantém',
      },
      {
        nomeOriginal: 'Retirada',
        idOriginal: null,
        observacao: null,
        nomeTarget: 'Retirada Loja Matriz',
        targetData: null,
        integracaoUid: 'ret-1',
        targetTipoIntegracao: 'retiradaNaLoja',
      },
    ],
    horarioDeCorte: [
      {
        diaDaSemana: 1,
        horaDeCorte: 14,
        minutosDeCorte: 0,
        prazoDePostagem: 0,
        horaPostagem: 18,
        minutosPostagem: 0,
      },
    ],
    docId: 'legacy-1',
  };

  it('parses the golden doc, keeping the mapa rows, the horário, the back-ref and the ODM docId', () => {
    const parsed = intFreteSchema.parse(legado);

    expect(parsed).toMatchObject(legado);
    expect(parsed.contaLojaIntegradaEnviosOuterRef).toBe('documents/integracao/int-1');
    expect(parsed.mapa).toHaveLength(3);
    // Every row keeps its seven keys; the unknown one rides `.passthrough()`.
    expect((parsed.mapa?.[1] as Record<string, unknown>).campoDesconhecido).toBe('mantém');
    expect(parsed.mapa?.[2]?.idOriginal).toBeNull();
    expect(parsed.horarioDeCorte).toEqual(legado.horarioDeCorte);
    // The twins are DIFFERENT keys: a Loja Integrada doc leaves both null.
    expect(parsed.contaShopeeFreteOuterRef).toBeNull();
    expect(parsed.contaMercadoLivreMercadoEnviosOuterRef).toBeNull();
    expect(parsed.ultimaModificacao).toBeNull();
    expect(parsed.prazoExtra).toBe(0);
    expect((parsed as Record<string, unknown>).docId).toBe('legacy-1');
  });

  it('an absent key reads back as an explicit null, present on the parsed value', () => {
    const motoboy = intFreteSchema.parse({
      tipo: 'motoboy',
      nome: 'Motoboy Centro',
      ativo: true,
      filialIntegracaoFreteOuterRef: 'documents/filiais/f-1',
      dataCadastro: 1718000000000,
    });
    expect(motoboy.contaLojaIntegradaEnviosOuterRef).toBeNull();
    expect(Object.hasOwn(motoboy, 'contaLojaIntegradaEnviosOuterRef')).toBe(true);
  });

  it('⚠️ NEAR-MISS: the canonical `documents/integracao/<id>` passes; the bare `integracao/<id>` FAILS', () => {
    const campo = intFreteSchema.shape.contaLojaIntegradaEnviosOuterRef;
    expect(campo.safeParse('documents/integracao/int-1').success).toBe(true);
    expect(campo.safeParse(null).success).toBe(true);
    expect(campo.safeParse('integracao/int-1').success).toBe(false);

    const doc = intFreteSchema.safeParse({
      ...legado,
      contaLojaIntegradaEnviosOuterRef: 'integracao/int-1',
    });
    expect(doc.success).toBe(false);
    if (!doc.success) {
      expect(doc.error.issues.map((i) => i.path)).toEqual([['contaLojaIntegradaEnviosOuterRef']]);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*            escolherIntFreteMaisNovo — THE pick among a conta's docs        */
/* -------------------------------------------------------------------------- */

describe('escolherIntFreteMaisNovo', () => {
  const doc = (id: string, data: Record<string, unknown>) => ({ id, data });

  it('the newest dataCadastro wins, whatever the arrival order', () => {
    const velho = doc('a', { dataCadastro: 1000 });
    const novo = doc('z', { dataCadastro: 2000 });
    expect(escolherIntFreteMaisNovo([velho, novo])).toBe(novo);
    expect(escolherIntFreteMaisNovo([novo, velho])).toBe(novo);
  });

  it('⚠️ NEAR-MISS: an EQUAL dataCadastro goes to the lowest id, in either arrival order', () => {
    const a = doc('a', { dataCadastro: 1000 });
    const b = doc('b', { dataCadastro: 1000 });
    expect(escolherIntFreteMaisNovo([a, b])).toBe(a);
    expect(escolherIntFreteMaisNovo([b, a])).toBe(a);
  });

  it('a dataCadastro that is not a finite number counts as 0', () => {
    const texto = doc('a', { dataCadastro: '2026-01-05T10:00:00.000Z' });
    const um = doc('z', { dataCadastro: 1 });
    expect(escolherIntFreteMaisNovo([texto, um])).toBe(um);
    // Absent and 0 tie, so the lowest id decides.
    expect(escolherIntFreteMaisNovo([doc('b', { dataCadastro: 0 }), doc('a', {})])?.id).toBe('a');
  });

  it('⚠️ a NaN or infinite dataCadastro counts as 0 too — the pick never depends on the arrival order', () => {
    // `typeof NaN === 'number'`, and every `>` / `===` against NaN is false: kept as a date, a
    // NaN seen first would beat every newer doc and, seen later, never win.
    for (const naoFinito of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const estranho = doc('a', { dataCadastro: naoFinito });
      const datado = doc('b', { dataCadastro: 2000 });
      expect(escolherIntFreteMaisNovo([estranho, datado]), String(naoFinito)).toBe(datado);
      expect(escolherIntFreteMaisNovo([datado, estranho]), String(naoFinito)).toBe(datado);
      // Read as 0, it TIES an absent date, so the lowest id decides — in either order.
      const semData = doc('0', {});
      expect(escolherIntFreteMaisNovo([estranho, semData]), String(naoFinito)).toBe(semData);
      expect(escolherIntFreteMaisNovo([semData, estranho]), String(naoFinito)).toBe(semData);
    }
  });

  it('⚠️ NEAR-MISS: it reads RAW bodies — a converter-parsed body can name ANOTHER doc', () => {
    // The importer's lookup queries `ativo == true`, which EXCLUDES a doc with no `ativo` field;
    // the schema's `ativo` default turns that absence into `true`, and `millisSinceEpoch`'s
    // preprocess turns an ISO string into ms. Fed the parsed bodies, the importer's predicate
    // picks a doc the importer never routes from.
    const base = {
      tipo: 'lojaIntegrada',
      nome: 'Loja Teste',
      filialIntegracaoFreteOuterRef: 'documents/filiais/f-1',
      contaLojaIntegradaEnviosOuterRef: 'documents/integracao/int-1',
    };
    const ativoVelho = { ...base, ativo: true, dataCadastro: 1718000000000 };
    const semAtivoNovo = { ...base, dataCadastro: 1735689600000 };
    const ehAtivo = (d: Readonly<Record<string, unknown>>) => d.ativo === true;
    const crus = [doc('a', ativoVelho), doc('b', semAtivoNovo)];
    const parseados = crus.map((c) => doc(c.id, intFreteSchema.parse(c.data)));
    expect(escolherIntFreteMaisNovo(crus, ehAtivo)?.id).toBe('a');
    expect(escolherIntFreteMaisNovo(parseados, ehAtivo)?.id).toBe('b');

    // The date half: an ISO `dataCadastro` reads as 0 raw and as ms parsed.
    const isoNovo = { ...base, ativo: true, dataCadastro: '2025-01-01T00:00:00.000Z' };
    const crusIso = [doc('a', ativoVelho), doc('b', isoNovo)];
    const parseadosIso = crusIso.map((c) => doc(c.id, intFreteSchema.parse(c.data)));
    expect(escolherIntFreteMaisNovo(crusIso)?.id).toBe('a');
    expect(escolherIntFreteMaisNovo(parseadosIso)?.id).toBe('b');
  });

  it('⚠️ NEAR-MISS: the predicate filters BEFORE the pick — the importer’s pick is the older ACTIVE doc', () => {
    const ativoVelho = doc('velho', { ativo: true, dataCadastro: 1000 });
    const inativoNovo = doc('novo', { ativo: false, dataCadastro: 2000 });
    expect(escolherIntFreteMaisNovo([ativoVelho, inativoNovo], (d) => d.ativo === true)).toBe(
      ativoVelho,
    );
    // Without the predicate the SAME docs pick the newer inactive one.
    expect(escolherIntFreteMaisNovo([ativoVelho, inativoNovo])).toBe(inativoNovo);
  });

  it('nothing to pick ⇒ null', () => {
    expect(escolherIntFreteMaisNovo([])).toBeNull();
    expect(
      escolherIntFreteMaisNovo(
        [doc('a', { ativo: false, dataCadastro: 1 })],
        (d) => d.ativo === true,
      ),
    ).toBeNull();
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
  it('intFreteMeta targets int_frete and cascades its credential subcollections', () => {
    expect(intFreteMeta.collectionPath).toBe('int_frete');
    expect(intFreteMeta.cascade).toEqual([
      // #1034 — the per-attempt OAuth connect record; credential material, so it
      // frees on delete for the same reason the token does.
      { path: 'int_frete/{intFreteId}/oauthState', onDelete: 'cascade' },
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

/* -------------------------------------------------------------------------- */
/*                          getPrazoDespachoNoFuso                            */
/*                                                                            */
/*  The SAME rule as above, with the two zone-dependent halves named out loud  */
/*  instead of inherited from the process. Anchors: 2021-01-04 is a Monday;    */
/*  every instant below is written as a UTC epoch so the assertion does not    */
/*  depend on the runner's own timezone.                                       */
/* -------------------------------------------------------------------------- */

const SAO_PAULO = 'America/Sao_Paulo';

/** The Shopee fallback schedule: Mon-Fri, cut-off 14:00, posted at 00:00. */
function corte14h(diaDaSemana: DiaDaSemana): HorarioDeCorte {
  return {
    diaDaSemana,
    horaDeCorte: 14,
    minutosDeCorte: 0,
    prazoDePostagem: 0,
    horaPostagem: null,
    minutosPostagem: null,
  };
}

const CORTE_14H_SEG_A_SEX: HorarioDeCorte[] = [
  corte14h(1),
  corte14h(2),
  corte14h(3),
  corte14h(4),
  corte14h(5),
];

const SEGUNDA_00H_SP = Date.UTC(2021, 0, 4, 3, 0);
const TERCA_00H_SP = Date.UTC(2021, 0, 5, 3, 0);
const SEGUNDA_11_00H_SP = Date.UTC(2021, 0, 11, 3, 0);

describe('getPrazoDespachoNoFuso', () => {
  it('returns null for null/empty schedules', () => {
    expect(getPrazoDespachoNoFuso(null, Date.UTC(2021, 0, 4, 16, 59), SAO_PAULO)).toBeNull();
    expect(getPrazoDespachoNoFuso([], Date.UTC(2021, 0, 4, 16, 59), SAO_PAULO)).toBeNull();
  });

  it('a Monday at 13:59 São Paulo dispatches the SAME Monday, 00:00 São Paulo', () => {
    // 16:59Z = 13:59 in São Paulo (UTC-3).
    expect(
      getPrazoDespachoNoFuso(CORTE_14H_SEG_A_SEX, Date.UTC(2021, 0, 4, 16, 59), SAO_PAULO),
    ).toBe(SEGUNDA_00H_SP);
  });

  it('⚠️ NEAR-MISS: 14:00 still dispatches today (the inclusive-minute quirk) and 14:01 does not', () => {
    expect(
      getPrazoDespachoNoFuso(CORTE_14H_SEG_A_SEX, Date.UTC(2021, 0, 4, 17, 0), SAO_PAULO),
    ).toBe(SEGUNDA_00H_SP);
    expect(
      getPrazoDespachoNoFuso(CORTE_14H_SEG_A_SEX, Date.UTC(2021, 0, 4, 17, 1), SAO_PAULO),
    ).toBe(TERCA_00H_SP);
  });

  it('a Friday past the cut-off lands on Monday, not on Saturday', () => {
    // Friday 2021-01-08 at 14:01 São Paulo.
    expect(
      getPrazoDespachoNoFuso(CORTE_14H_SEG_A_SEX, Date.UTC(2021, 0, 8, 17, 1), SAO_PAULO),
    ).toBe(SEGUNDA_11_00H_SP);
  });

  it('a Saturday lands on Monday — the weekend has no entry at all', () => {
    // Saturday 2021-01-09 at 12:00 São Paulo.
    expect(
      getPrazoDespachoNoFuso(CORTE_14H_SEG_A_SEX, Date.UTC(2021, 0, 9, 15, 0), SAO_PAULO),
    ).toBe(SEGUNDA_11_00H_SP);
  });

  it('⚠️ NEAR-MISS: the SAME instant under timeZone "UTC" answers a DIFFERENT day — the whole reason the zone is a parameter', () => {
    const instante = Date.UTC(2021, 0, 4, 16, 59); // 13:59 São Paulo, 16:59 UTC
    expect(getPrazoDespachoNoFuso(CORTE_14H_SEG_A_SEX, instante, SAO_PAULO)).toBe(SEGUNDA_00H_SP);
    // In UTC the cut-off has already passed, so the deadline is Tuesday 00:00 UTC.
    expect(getPrazoDespachoNoFuso(CORTE_14H_SEG_A_SEX, instante, 'UTC')).toBe(
      Date.UTC(2021, 0, 5, 0, 0),
    );
  });

  it('⚠️ NEAR-MISS: the WEEKDAY comes from the zone too — an instant that is Monday in UTC is Sunday in São Paulo', () => {
    const instante = Date.UTC(2021, 0, 4, 2, 0); // Monday 02:00 UTC = Sunday 23:00 São Paulo
    // Sunday has no entry: the scan walks to Monday the 4th.
    expect(getPrazoDespachoNoFuso(CORTE_14H_SEG_A_SEX, instante, SAO_PAULO)).toBe(SEGUNDA_00H_SP);
    // In UTC it is already Monday, before the cut-off: same calendar day, different instant.
    expect(getPrazoDespachoNoFuso(CORTE_14H_SEG_A_SEX, instante, 'UTC')).toBe(
      Date.UTC(2021, 0, 4, 0, 0),
    );
  });

  it('carries the month overflow through the zoned path (Friday Jan 29 + 3 days = Feb 1)', () => {
    const soSegunda = [corte14h(1)];
    // Friday 2021-01-29 at 10:00 São Paulo → the next segunda is Feb 1.
    expect(getPrazoDespachoNoFuso(soSegunda, Date.UTC(2021, 0, 29, 13, 0), SAO_PAULO)).toBe(
      Date.UTC(2021, 1, 1, 3, 0),
    );
  });

  it('⚠️ the civil core does NOT normalise the day — the Date constructor does, exactly as Dart did', () => {
    const alvo = calcularPrazoDespachoCivil([corte14h(1)], {
      diaDaSemana: 5,
      ano: 2021,
      mes: 0,
      dia: 29,
      hora: 10,
      minuto: 0,
    });
    expect(alvo).toEqual({ ano: 2021, mes: 0, dia: 32, hora: 0, minuto: 0 });
  });

  it('⚠️ NEAR-MISS: the offset is measured at the RESULT, not at `agora` — a deadline may cross a DST transition', () => {
    // Saturday 2021-03-13 12:00 New York (EST, UTC-5). US DST starts on the
    // 14th, so the Monday deadline is 00:00 EDT (UTC-4) = 04:00Z. Reusing the
    // offset that held at `agora` would answer 05:00Z.
    const sabadoEst = Date.UTC(2021, 2, 13, 17, 0);
    expect(getPrazoDespachoNoFuso(CORTE_14H_SEG_A_SEX, sabadoEst, 'America/New_York')).toBe(
      Date.UTC(2021, 2, 15, 4, 0),
    );
    expect(getPrazoDespachoNoFuso(CORTE_14H_SEG_A_SEX, sabadoEst, 'America/New_York')).not.toBe(
      Date.UTC(2021, 2, 15, 5, 0),
    );
  });

  it('⚠️ NEAR-MISS: the offset is corrected a SECOND time — a one-pass conversion lands an hour off inside a spring-forward day', () => {
    // Sunday 2021-03-14 is the US spring-forward. A schedule posting at 03:00
    // targets a civil time that is already EDT (UTC-4) while the FIRST offset
    // guess is measured on the EST (UTC-5) side of the transition.
    const domingo03h: HorarioDeCorte[] = [
      {
        diaDaSemana: 7,
        horaDeCorte: 23,
        minutosDeCorte: 59,
        prazoDePostagem: 0,
        horaPostagem: 3,
        minutosPostagem: 0,
      },
    ];
    const domingo01hEst = Date.UTC(2021, 2, 14, 6, 0);
    expect(getPrazoDespachoNoFuso(domingo03h, domingo01hEst, 'America/New_York')).toBe(
      Date.UTC(2021, 2, 14, 7, 0),
    );
    // One pass would answer 08:00Z, i.e. 04:00 New York — an hour past the
    // configured posting time.
    expect(getPrazoDespachoNoFuso(domingo03h, domingo01hEst, 'America/New_York')).not.toBe(
      Date.UTC(2021, 2, 14, 8, 0),
    );
  });

  it('agrees with getPrazoDespacho when the named zone IS the runner\u2019s own', () => {
    const fusoLocal = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const instantes = [
      Date.UTC(2021, 0, 4, 16, 59),
      Date.UTC(2021, 0, 8, 17, 1),
      Date.UTC(2021, 5, 16, 10, 0),
    ];
    for (const ms of instantes) {
      const local = getPrazoDespacho(CORTE_14H_SEG_A_SEX, new Date(ms));
      // A Mon-Fri schedule always resolves inside the 7-day scan — a pair of
      // nulls would make this comparison prove nothing.
      expect(local).not.toBeNull();
      expect(getPrazoDespachoNoFuso(CORTE_14H_SEG_A_SEX, ms, fusoLocal)).toBe(local?.getTime());
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                  Stored schedules the schema does not model                */
/*                                                                            */
/*  The web freight tabs read `int_frete` through a SOFT read, which hands    */
/*  back the raw document when the parse fails — so whatever the imported     */
/*  corpus holds reaches the rule unvalidated. Every case below compares a    */
/*  malformed schedule with the answer its readable rows give on their own.   */
/* -------------------------------------------------------------------------- */

/** A value as it may sit in Firestore — typed past the schema on purpose. */
function armazenado(valor: unknown): HorarioDeCorte[] {
  return valor as HorarioDeCorte[];
}

/** Monday 2021-01-04, 10:00 — before `corteSegunda`'s 16:30 cut-off. */
const SEGUNDA_10H = { diaDaSemana: 1, ano: 2021, mes: 0, dia: 4, hora: 10, minuto: 0 };

const corteQuarta = {
  diaDaSemana: 3 as const,
  horaDeCorte: 16,
  minutosDeCorte: 0,
  prazoDePostagem: 0,
  horaPostagem: 11,
  minutosPostagem: 45,
};

describe('calcularPrazoDespachoCivil — stored shapes the schema does not model', () => {
  it('skips rows that are not objects: the answer is the readable rows’ own', () => {
    const soValidas = calcularPrazoDespachoCivil([corteSegunda], SEGUNDA_10H);
    // A schedule that answers nothing would make the comparison prove nothing.
    expect(soValidas).toEqual({ ano: 2021, mes: 0, dia: 4, hora: 18, minuto: 0 });
    expect(
      calcularPrazoDespachoCivil(
        armazenado([null, 'texto', 7, corteSegunda, undefined]),
        SEGUNDA_10H,
      ),
    ).toEqual(soValidas);
  });

  it('a schedule with no readable row answers nothing, like an empty one', () => {
    expect(calcularPrazoDespachoCivil(armazenado([null, 'texto']), SEGUNDA_10H)).toBeNull();
  });

  it.each([
    ['a map keyed by weekday', { 1: corteSegunda }],
    ['a string', 'segunda 16:30'],
    ['a number', 1],
    ['a bare row', corteSegunda],
  ])('a stored value that is not a list (%s) answers nothing', (_caso, valor) => {
    expect(calcularPrazoDespachoCivil(armazenado(valor), SEGUNDA_10H)).toBeNull();
    // NEAR-MISS: the same row inside a list does answer.
    expect(calcularPrazoDespachoCivil([corteSegunda], SEGUNDA_10H)).not.toBeNull();
  });

  it.each([
    ['as text', '1'],
    ['as null', null],
    ['as NaN', Number.NaN],
    ['as a fraction', 1.5],
    ['absent', undefined],
  ])('a row whose weekday is not an integer (%s) governs no day', (_caso, diaDaSemana) => {
    expect(
      calcularPrazoDespachoCivil(armazenado([{ ...corteSegunda, diaDaSemana }]), SEGUNDA_10H),
    ).toBeNull();
    // ...and does not shadow a readable row for the same day behind it.
    expect(
      calcularPrazoDespachoCivil(
        armazenado([{ ...corteSegunda, diaDaSemana, horaPostagem: 9 }, corteSegunda]),
        SEGUNDA_10H,
      ),
    ).toEqual(calcularPrazoDespachoCivil([corteSegunda], SEGUNDA_10H));
  });

  it('a numeric field stored as text reads as absent — never coerced, never concatenated', () => {
    const comPrazo = (prazoDePostagem: unknown) =>
      calcularPrazoDespachoCivil(
        armazenado([{ ...corteSegunda, prazoDePostagem }, corteQuarta]),
        SEGUNDA_10H,
      );
    // Read as absent: the null default (0 days) — today, at Monday's posting time.
    expect(comPrazo('2')).toEqual(comPrazo(null));
    expect(comPrazo(null)).toEqual({ ano: 2021, mes: 0, dia: 4, hora: 18, minuto: 0 });
    // NEAR-MISS: the integer 2 still shifts the target to quarta, two days on.
    expect(comPrazo(2)).toEqual({ ano: 2021, mes: 0, dia: 6, hora: 11, minuto: 45 });
  });

  it('an out-of-range value is read as stored — the rule computes what Flutter computed', () => {
    // Hour 25 is refused by the schema, yet Flutter read it as an int: every
    // hour of the day is "before" it, so the same day always passes.
    const tarde = { ...SEGUNDA_10H, hora: 23, minuto: 59 };
    expect(calcularPrazoDespachoCivil([{ ...corteSegunda, horaDeCorte: 25 }], tarde)).toEqual({
      ano: 2021,
      mes: 0,
      dia: 4,
      hora: 18,
      minuto: 0,
    });
    // NEAR-MISS: with the stored 16 the same instant missed the cut-off.
    expect(calcularPrazoDespachoCivil([corteSegunda], tarde)).toBeNull();
  });

  it('both bindings reach the tolerant core', () => {
    const segunda10h = new Date(2021, 0, 4, 10, 0);
    expect(getPrazoDespacho(armazenado([null, corteSegunda]), segunda10h)).toEqual(
      getPrazoDespacho([corteSegunda], segunda10h),
    );
    expect(getPrazoDespacho(armazenado({ 1: corteSegunda }), segunda10h)).toBeNull();

    const instante = Date.UTC(2021, 0, 4, 16, 59);
    expect(
      getPrazoDespachoNoFuso(armazenado(['texto', ...CORTE_14H_SEG_A_SEX]), instante, SAO_PAULO),
    ).toBe(SEGUNDA_00H_SP);
    expect(getPrazoDespachoNoFuso(armazenado({ 1: corte14h(1) }), instante, SAO_PAULO)).toBeNull();
  });
});
