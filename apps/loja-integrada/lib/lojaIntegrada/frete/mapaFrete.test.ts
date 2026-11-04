/**
 * The freight `mapa` registration (step 20, #1826), against `testing/fakeDb.ts`, which models
 * the `lastUpdateTime` precondition and the array-union sentinel as the server applies them.
 * `mapaFrete.firestore.test.ts` proves the same primitives on the emulator.
 *
 * The rows are spelled out with all seven keys, never built through the code under test, so a
 * change to the row the importer appends is a visible diff here.
 */
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { intFreteCollection } from '@delfrance/data/admin/collections';
import { mapaDeIntegracoesSchema } from '@delfrance/schemas';

import { classificarFalhaLi } from '../notificacoes/notificacao';
import { type DocData, FakeDb, arrayUnion, asDb, grpc, increment } from '../testing/fakeDb';
import { AGORA_MS, loggerEspiao } from '../testing/fixtures';
import {
  LiMapaFreteEmConflitoError,
  MAX_TENTATIVAS_MAPA_FRETE_LI,
  type MapaFreteDeps,
  type RegistroFormaEnvioLi,
  registrarFormaEnvioNoMapaLi,
} from './mapaFrete';

const CONTA = 'conta-li-mapa';
const FRETE = `lojaIntegrada-${CONTA}`;
const CAMINHO = `int_frete/${FRETE}`;
const BACK_REF = `documents/integracao/${CONTA}`;

const PAC = { id: 141909, code: 'PAC', nome: 'Gateway A', tipo: 'Transportadora' } as const;

/** The conta's freight doc as the core leaves it, with `over` on top. */
function docFrete(over: DocData = {}): DocData {
  return {
    tipo: 'lojaIntegrada',
    nome: 'Loja de teste',
    ativo: true,
    contaLojaIntegradaEnviosOuterRef: BACK_REF,
    filialIntegracaoFreteOuterRef: 'documents/filiais/f1',
    dataCadastro: 1,
    ultimaModificacao: 1,
    mapa: [],
    ...over,
  };
}

/** The 7-key row the importer appends, written out by hand. */
function linha(
  idOriginal: string,
  numero: number,
  nomeOriginal = 'Gateway A - Transportadora',
): DocData {
  return {
    nomeOriginal,
    idOriginal,
    observacao: `Origem: Pedido ${String(numero)}`,
    nomeTarget: null,
    targetData: null,
    integracaoUid: null,
    targetTipoIntegracao: 'outros',
  };
}

function registrar(
  db: FakeDb,
  over: Partial<RegistroFormaEnvioLi> = {},
  deps: Partial<MapaFreteDeps> = {},
) {
  return registrarFormaEnvioNoMapaLi(
    asDb(db),
    { integracaoId: CONTA, intFreteId: FRETE, formaEnvio: PAC, numero: 1001, ...over },
    { arrayUnion, ...deps },
  );
}

/** The stored `mapa`. */
function mapaDe(db: FakeDb): unknown {
  return db.ler(CAMINHO)?.mapa;
}

function leiturasDoFrete(db: FakeDb): number {
  return db.leituras.filter((c) => c === CAMINHO).length;
}

/** The freight doc through its admin handle — the same ref the helper builds. */
function refFrete(db: FakeDb) {
  return intFreteCollection.docRef(asDb(db), {}, FRETE);
}

/**
 * A write by ANOTHER writer, through the same fake. ⚠️ It is a write on the same path, so it
 * consumes the next QUEUED hook: a hook arms the following one only after this write.
 */
function escritaConcorrente(db: FakeDb, patch: DocData): Promise<unknown> {
  return refFrete(db).update(patch);
}

describe('registrarFormaEnvioNoMapaLi: the decision', () => {
  it('an ABSENT key ⇒ exactly ONE union of the 7-key row, writing `mapa` and nothing else', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, docFrete({ mapa: [] }));

    const r = await registrar(db);

    // The snapshot the decision was taken on — never the appended row.
    expect(r).toEqual({ resultado: 'registrada', mapa: [], lidoEmUs: expect.any(Number) });
    const escritas = db.escritasEm(CAMINHO);
    expect(escritas).toHaveLength(1);
    expect(escritas[0]?.verbo).toBe('update');
    // `mapa` ONLY: no `ultimaModificacao`, no other field.
    expect(escritas[0]?.dados).toEqual({ mapa: { __arrayUnion: [linha('141909---PAC', 1001)] } });
    expect(mapaDe(db)).toEqual([linha('141909---PAC', 1001)]);
    expect(Object.keys(linha('141909---PAC', 1001))).toHaveLength(7);
  });

  it('a key already present ⇒ zero writes, whether the row is unmapped or MAPPED (a mapped row is never touched)', async () => {
    const naoMapeada = linha('141909---PAC', 7);
    const mapeada = {
      ...linha('141909---PAC', 7),
      integracaoUid: 'me-1',
      targetTipoIntegracao: 'melhorEnvios',
      targetData: { id: 1, name: 'Serviço', company: { id: 2, name: 'Empresa' } },
      nomeTarget: 'Empresa — Serviço',
    };
    for (const armazenada of [naoMapeada, mapeada]) {
      const db = new FakeDb();
      db.seed(CAMINHO, docFrete({ mapa: [armazenada] }));
      expect(await registrar(db)).toEqual({
        resultado: 'ja-presente',
        mapa: [armazenada],
        lidoEmUs: expect.any(Number),
      });
      expect(db.escritas).toEqual([]);
      expect(mapaDe(db)).toEqual([armazenada]);
    }
  });

  it('EQUAL pair: the same key under another nome, tipo or order number — and the id as a string — IS the method ⇒ zero writes', async () => {
    const db = new FakeDb();
    const armazenada = {
      nomeOriginal: 'Outro - outro',
      idOriginal: '141909---PAC',
      observacao: 'x',
    };
    db.seed(CAMINHO, docFrete({ mapa: [armazenada] }));

    const r = await registrar(db, {
      formaEnvio: { id: '141909', code: 'PAC', nome: 'Gateway B', tipo: 'Outro' },
      numero: 2002,
    });

    expect(r.resultado).toBe('ja-presente');
    expect(db.escritas).toEqual([]);
  });

  it('⚠️ NEAR-MISS: the same id under another code is ABSENT ⇒ +1 row each (presence is the FULL key, never the id part)', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, docFrete({ mapa: [linha('141909---PAC', 7)] }));

    expect(
      (await registrar(db, { formaEnvio: { ...PAC, code: 'SEDEX' }, numero: 8 })).resultado,
    ).toBe('registrada');
    // The code is VERBATIM: a case or a trailing space is another service.
    expect(
      (await registrar(db, { formaEnvio: { ...PAC, code: 'pac' }, numero: 9 })).resultado,
    ).toBe('registrada');
    expect(
      (await registrar(db, { formaEnvio: { ...PAC, code: 'PAC ' }, numero: 10 })).resultado,
    ).toBe('registrada');
    expect(mapaDe(db)).toEqual([
      linha('141909---PAC', 7),
      linha('141909---SEDEX', 8),
      linha('141909---pac', 9),
      linha('141909---PAC ', 10),
    ]);
  });

  it('a NULL or ABSENT `mapa` becomes [row]', async () => {
    for (const over of [{ mapa: null }, {}]) {
      const db = new FakeDb();
      const doc = docFrete(over);
      if (!('mapa' in over)) delete doc.mapa;
      db.seed(CAMINHO, doc);

      expect(await registrar(db)).toEqual({
        resultado: 'registrada',
        mapa: null,
        lidoEmUs: expect.any(Number),
      });
      expect(mapaDe(db)).toEqual([linha('141909---PAC', 1001)]);
    }
  });

  it('⚠️ NEAR-MISS (raw read): a stored row under the key that FAILS the row schema is still the method ⇒ ja-presente, zero writes, never a second row beside it', async () => {
    const casos: readonly [string, DocData][] = [
      ['no nomeOriginal', { idOriginal: '141909---PAC' }],
      [
        'a target tipo the schema does not know',
        { ...linha('141909---PAC', 7), targetTipoIntegracao: 'desconhecido' },
      ],
      ['a non-string nomeOriginal', { ...linha('141909---PAC', 7), nomeOriginal: 42 }],
    ];
    for (const [nome, armazenada] of casos) {
      // Anti-vacuity: each stored row really fails the row schema.
      expect(mapaDeIntegracoesSchema.safeParse(armazenada).success, nome).toBe(false);
      const db = new FakeDb();
      db.seed(CAMINHO, docFrete({ mapa: [armazenada] }));

      expect(await registrar(db), nome).toEqual({
        resultado: 'ja-presente',
        mapa: [armazenada],
        lidoEmUs: expect.any(Number),
      });
      expect(db.escritas, nome).toEqual([]);
      expect(mapaDe(db), nome).toEqual([armazenada]);
    }
  });

  it('legacy rows stay BYTE-identical: nothing parsed or normalised, and no ZodError on rows that fail the row schema', async () => {
    const legado: unknown[] = [
      { idOriginal: null, nomeOriginal: 'Legado', chaveDesconhecida: { a: 1 } },
      { idOriginal: 42 },
      { nomeOriginal: 'Sem as outras chaves', idOriginal: '1---null' },
      'uma linha solta',
      null,
    ];
    const db = new FakeDb();
    db.seed(CAMINHO, docFrete({ mapa: legado }));

    const r = await registrar(db);

    expect(r).toEqual({ resultado: 'registrada', mapa: legado, lidoEmUs: expect.any(Number) });
    const armazenado = mapaDe(db) as unknown[];
    expect(JSON.stringify(armazenado.slice(0, legado.length))).toBe(JSON.stringify(legado));
    expect(armazenado.slice(legado.length)).toEqual([linha('141909---PAC', 1001)]);
  });

  it('a `mapa` that is no list (a map, a string, a number) ⇒ mapa-invalido and ZERO writes: a union would overwrite it', async () => {
    for (const mapa of [{ '141909---PAC': { integracaoUid: 'me-1' } }, 'texto', 3]) {
      const db = new FakeDb();
      db.seed(CAMINHO, docFrete({ mapa }));
      expect(await registrar(db)).toEqual({
        resultado: 'mapa-invalido',
        mapa: null,
        lidoEmUs: expect.any(Number),
      });
      expect(db.escritas).toEqual([]);
      expect(mapaDe(db)).toEqual(mapa);
    }
  });

  it('a foreign doc ⇒ sem-int-frete and zero writes: no doc, another tipo, another conta, the BARE back-ref', async () => {
    const casos: readonly [string, DocData | null][] = [
      ['no doc', null],
      ['tipo shopee', docFrete({ tipo: 'shopee' })],
      ['tipo in another case', docFrete({ tipo: 'lojaintegrada' })],
      [
        'another conta',
        docFrete({ contaLojaIntegradaEnviosOuterRef: 'documents/integracao/outra' }),
      ],
      ['the bare back-ref', docFrete({ contaLojaIntegradaEnviosOuterRef: `integracao/${CONTA}` })],
      ['no back-ref', docFrete({ contaLojaIntegradaEnviosOuterRef: null })],
    ];
    for (const [nome, doc] of casos) {
      const db = new FakeDb();
      if (doc !== null) db.seed(CAMINHO, doc);
      expect(await registrar(db), nome).toEqual({
        resultado: 'sem-int-frete',
        mapa: null,
        lidoEmUs: expect.any(Number),
      });
      expect(db.escritas, nome).toEqual([]);
    }
  });

  it('an unkeyable method ⇒ chave-invalida with ZERO reads and zero writes', async () => {
    const formas: unknown[] = [
      { ...PAC, id: '0141909' },
      { ...PAC, id: 0 },
      { ...PAC, id: 1.5 },
      { ...PAC, code: 7 },
      { code: 'PAC' },
      'PAC',
      null,
      undefined,
    ];
    for (const formaEnvio of formas) {
      const db = new FakeDb();
      db.seed(CAMINHO, docFrete());
      expect(await registrar(db, { formaEnvio })).toEqual({
        resultado: 'chave-invalida',
        lidoEmUs: null,
        mapa: null,
      });
      expect(db.leituras).toEqual([]);
      expect(db.escritas).toEqual([]);
    }
  });
});

describe('registrarFormaEnvioNoMapaLi: rule 7, tier 1', () => {
  it('a LOST precondition ⇒ re-read and RE-DECIDE: the same key landed meanwhile, so it writes nothing', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, docFrete({ mapa: [] }));
    db.antesDaProximaEscrita(CAMINHO, async () => {
      await escritaConcorrente(db, { mapa: arrayUnion(linha('141909---PAC', 999)) });
    });

    const r = await registrar(db);

    expect(r).toEqual({
      resultado: 'ja-presente',
      mapa: [linha('141909---PAC', 999)],
      lidoEmUs: expect.any(Number),
    });
    // ONE row for the key: the concurrent one. This call's row never landed.
    expect(mapaDe(db)).toEqual([linha('141909---PAC', 999)]);
    expect(leiturasDoFrete(db)).toBe(2);
  });

  it('lidoEmUs is the µs readTime of the DECIDING read — the retry’s, after a lost precondition (the step-5 aviso clock)', async () => {
    const us = (t: { seconds: number; nanoseconds: number }) =>
      t.seconds * 1_000_000 + t.nanoseconds / 1000;
    const db = new FakeDb();
    db.seed(CAMINHO, docFrete({ mapa: [] }));
    let concorrente = 0;
    db.antesDaProximaEscrita(CAMINHO, async () => {
      const w = (await refFrete(db).update({ nome: 'Renomeada' })) as {
        writeTime: { seconds: number; nanoseconds: number };
      };
      concorrente = us(w.writeTime);
    });
    const r = await registrar(db);
    expect(r.resultado).toBe('registrada');
    // Read AFTER the concurrent commit: a later clock than that write's.
    expect(r.lidoEmUs).not.toBeNull();
    expect(r.lidoEmUs!).toBeGreaterThanOrEqual(concorrente);
    // And before this call's own union landed.
    const minha = db.escritasEm(CAMINHO).at(-1)!;
    expect(r.lidoEmUs!).toBeLessThan(us(minha.writeTime));
  });

  it('a lost precondition on an UNRELATED write (the trigger renaming the doc) ⇒ still absent, appended on the 2nd attempt, and the rename survives', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, docFrete({ mapa: [] }));
    db.antesDaProximaEscrita(CAMINHO, async () => {
      await escritaConcorrente(db, { nome: 'Renomeada', ultimaModificacao: 2 });
    });

    expect((await registrar(db)).resultado).toBe('registrada');

    expect(db.ler(CAMINHO)).toMatchObject({
      nome: 'Renomeada',
      ultimaModificacao: 2,
      mapa: [linha('141909---PAC', 1001)],
    });
    expect(leiturasDoFrete(db)).toBe(2);
  });

  it('the doc RETYPED or re-pointed at another conta between the read and the write ⇒ the re-read re-runs the doc check: sem-int-frete, nothing appended', async () => {
    const casos: readonly [string, DocData][] = [
      ['retyped to shopee', { tipo: 'shopee' }],
      [
        'back-ref re-pointed at another conta',
        { contaLojaIntegradaEnviosOuterRef: 'documents/integracao/outra' },
      ],
    ];
    for (const [nome, patch] of casos) {
      const db = new FakeDb();
      db.seed(CAMINHO, docFrete({ mapa: [] }));
      db.antesDaProximaEscrita(CAMINHO, async () => {
        await escritaConcorrente(db, patch);
      });

      expect(await registrar(db), nome).toEqual({
        resultado: 'sem-int-frete',
        mapa: null,
        lidoEmUs: expect.any(Number),
      });

      expect(db.ler(CAMINHO), nome).toMatchObject({ ...patch, mapa: [] });
      // The concurrent write only: this call wrote nothing on its second attempt.
      expect(db.escritasEm(CAMINHO), nome).toHaveLength(1);
      expect(leiturasDoFrete(db), nome).toBe(2);
    }
  });

  it('`mapa` turned into a MAP between the read and the write ⇒ the re-read re-runs the shape check: mapa-invalido, the map kept as it is', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, docFrete({ mapa: [] }));
    const mapa = { '141909---PAC': { integracaoUid: 'me-1' } };
    db.antesDaProximaEscrita(CAMINHO, async () => {
      await escritaConcorrente(db, { mapa });
    });

    expect(await registrar(db)).toEqual({
      resultado: 'mapa-invalido',
      mapa: null,
      lidoEmUs: expect.any(Number),
    });

    // A union on the retry would have replaced the map with [row].
    expect(mapaDe(db)).toEqual(mapa);
    expect(db.escritasEm(CAMINHO)).toHaveLength(1);
    expect(leiturasDoFrete(db)).toBe(2);
  });

  it('a NOT_FOUND (5) is re-read and re-decided like a 9', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, docFrete({ mapa: [] }));
    db.antesDaProximaEscrita(CAMINHO, () => {
      throw grpc(5, 'NOT_FOUND');
    });

    expect((await registrar(db)).resultado).toBe('registrada');
    expect(mapaDe(db)).toEqual([linha('141909---PAC', 1001)]);
    expect(leiturasDoFrete(db)).toBe(2);
  });

  it(`${String(MAX_TENTATIVAS_MAPA_FRETE_LI)} lost preconditions ⇒ LiMapaFreteEmConflitoError after exactly ${String(MAX_TENTATIVAS_MAPA_FRETE_LI)} reads — never fewer, never unbounded`, async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, docFrete({ mapa: [] }));
    // A concurrent rename before EVERY write of the helper — one more than the cap, so an
    // unbounded loop would get past them and append. Each hook arms the next only after its
    // own write: a hook queued up front would be consumed by the previous hook's write.
    let restantes = MAX_TENTATIVAS_MAPA_FRETE_LI + 1;
    const armar = (): void => {
      db.antesDaProximaEscrita(CAMINHO, async () => {
        restantes -= 1;
        await escritaConcorrente(db, { nome: `Renomeada ${String(restantes)}` });
        if (restantes > 0) armar();
      });
    };
    armar();

    const err: unknown = await registrar(db).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LiMapaFreteEmConflitoError);
    expect(err).toMatchObject({ integracaoId: CONTA, intFreteId: FRETE, tentativas: 3 });
    expect(leiturasDoFrete(db)).toBe(3);
    expect(mapaDe(db)).toEqual([]);
  });

  it('the step-3 classifier returns null for LiMapaFreteEmConflitoError, so the task rethrows and retries (control: a ZodError parks)', async () => {
    const deps = { agoraMs: () => AGORA_MS, increment };
    const conflito = new LiMapaFreteEmConflitoError(CONTA, FRETE, 3);
    expect(conflito).not.toBeInstanceOf(ZodError);
    expect(await classificarFalhaLi(asDb(new FakeDb()), conflito, null, deps)).toBeNull();
    // Anti-vacuity: the classifier is not null for everything — a ZodError is a refusal.
    expect(
      await classificarFalhaLi(asDb(new FakeDb()), new ZodError([]), null, deps),
    ).not.toBeNull();
  });

  it('a doc REMOVED between the read and the write ⇒ sem-int-frete on the re-read, never resurrected', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, docFrete({ mapa: [] }));
    db.antesDaProximaEscrita(CAMINHO, async () => {
      await refFrete(db).delete();
    });

    expect(await registrar(db)).toEqual({
      resultado: 'sem-int-frete',
      mapa: null,
      lidoEmUs: expect.any(Number),
    });

    expect(db.ler(CAMINHO)).toBeUndefined();
    expect(db.escritasEm(CAMINHO).map((e) => e.verbo)).toEqual(['delete']);
    expect(leiturasDoFrete(db)).toBe(2);
  });

  it('any other failure is rethrown untouched after ONE attempt (rule 6): a gRPC 14 on the write, a failed read', async () => {
    const indisponivel = grpc(14, 'UNAVAILABLE');
    const db = new FakeDb();
    db.seed(CAMINHO, docFrete({ mapa: [] }));
    db.falharEscrita(CAMINHO, indisponivel);
    await expect(registrar(db)).rejects.toBe(indisponivel);
    expect(leiturasDoFrete(db)).toBe(1);

    const leitura = grpc(4, 'DEADLINE_EXCEEDED');
    const db2 = new FakeDb();
    db2.seed(CAMINHO, docFrete({ mapa: [] }));
    db2.falharLeitura(CAMINHO, leitura);
    await expect(registrar(db2)).rejects.toBe(leitura);
    expect(db2.escritas).toEqual([]);
  });
});

describe('registrarFormaEnvioNoMapaLi: logs', () => {
  it('every refusal logs ids only — never the method’s name, the doc’s fields or a row', async () => {
    const espiao = loggerEspiao();
    const deps = { logger: espiao.logger };

    const semDoc = new FakeDb();
    await registrar(semDoc, {}, deps);
    const invalida = new FakeDb();
    invalida.seed(CAMINHO, docFrete({ mapa: { a: 'Gateway A' } }));
    await registrar(invalida, {}, deps);
    await registrar(new FakeDb(), { formaEnvio: { ...PAC, id: 'x' } }, deps);

    expect(espiao.chamadas).toHaveLength(3);
    for (const [, meta] of espiao.chamadas) {
      expect(meta).toEqual({ integracaoId: CONTA, intFreteId: FRETE, numero: 1001 });
    }
    expect(JSON.stringify(espiao.chamadas)).not.toMatch(/Gateway|Transportadora|Loja de teste/);
  });
});
