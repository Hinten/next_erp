/**
 * The product import's grupo memo, Simular overlay and `aprendizado` phase (`gruposLi.ts`), on the
 * fake Firestore: what a unanimous claim writes (one tier-1 update per grupo, through the never-drop
 * merge), what Simular writes instead (nothing — an overlay its later resolutions read), that both
 * modes give the same verdict, what a lost precondition does (re-read, re-decide once, then report),
 * and the report's mapping of a refused learning.
 *
 * Nothing reaches the network (D17): the phase makes no Loja Integrada call, and the GLOBAL `fetch`
 * is stubbed to throw for the whole file — every test also asserts it was never called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { grupoDeVariacoesCollection } from '@delfrance/data/admin/collections';
import {
  MODO_IMPORTACAO_LI,
  MOTIVO_RECUSA_APRENDIZADO_LI,
  type ModoImportacaoLi,
  PENDENCIA_IMPORTACAO_LI,
  TIPO_RESOLUCAO_OPCAO_LI,
  evidenciaOpcaoLiSchema,
  importacaoLojaIntegradaMeta,
  resolverOpcoesDoFilhoLi,
} from '@delfrance/schemas';

import { type DocData, FakeDb, asDb, grpc } from '../testing/fakeDb';
import { AGORA_MS } from '../testing/fixtures';
import { uriOpcaoLi } from '../testing/produtosLi';
import { lerEvidenciasDoJobLi } from './evidencias';
import {
  type DepsAprendizadoLi,
  UNIDADE_DO_APRENDIZADO_LI,
  executarAprendizadoLi,
  gruposComSimulacaoLi,
  gruposParaResolverLi,
  lerMemoDeGruposLi,
  pendenciaDaRecusaLi,
  recusasDoAprendizadoLi,
} from './gruposLi';
import { UNIDADE_IMPORTACAO_LI } from './orcamento';

const CONTA = 'conta-li-grupos';
const OUTRA = 'conta-li-grupos-2';
const JOB = 'job-grupos';
const TAM = 8946;
const COR = 7001;

let fetchFalso: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchFalso = vi.fn(() => Promise.reject(new Error('gruposLi.test: nenhuma chamada de rede')));
  vi.stubGlobal('fetch', fetchFalso);
});
afterEach(() => {
  expect(fetchFalso).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

/* ------------------------------- fixtures --------------------------------- */

const CAMINHO_GRUPO = (id: string) => `grupoDeVariacoes/${id}`;

/** A grupo's ref through its handle (an operator's concurrent edit). */
const refGrupo = (db: FakeDb, id: string) => grupoDeVariacoesCollection.docRef(asDb(db), {}, id);

function deps(db: FakeDb, modo: ModoImportacaoLi = MODO_IMPORTACAO_LI.aplicar): DepsAprendizadoLi {
  return { db: asDb(db), jobId: JOB, contaId: CONTA, modo, agoraMs: () => AGORA_MS };
}

/** A conta's VALID link entry: grade → { option → variantes }. */
function entrada(
  grade: number,
  opcoes: Record<number, readonly string[]>,
  conta = CONTA,
): Record<string, unknown> {
  return {
    name: null,
    grade_id: grade,
    integracaoLiId: conta,
    variationOptions: Object.entries(opcoes).map(([opcao, ids]) => ({
      li_option_id: Number(opcao),
      li_option_name: null,
      arakene_variation_id: [...ids],
    })),
  };
}

function seedGrupo(db: FakeDb, id: string, variantes: readonly string[], links?: unknown): void {
  db.seed(CAMINHO_GRUPO(id), {
    nome: `Grupo ${id}`,
    variacoes: variantes.map((v) => ({ id: v, nome: v.toUpperCase() })),
    ...(links === undefined ? {} : { linksVariacoesli: links }),
  });
}

/** A claim document: `(grade, option)` claimed as these `(grupo, variante, single-axis)` pairs. */
function seedEvidencia(
  db: FakeDb,
  grade: number,
  opcao: number,
  ...pares: readonly (readonly [string, string, boolean?])[]
): void {
  db.seed(
    `${importacaoLojaIntegradaMeta.collectionPath}/${JOB}/evidencias/${String(grade)}_${String(opcao)}`,
    evidenciaOpcaoLiSchema.parse({
      gradeId: grade,
      opcaoId: opcao,
      alegacoes: pares.map(([grupoId, varianteId, eixoUnico]) => ({
        grupoId,
        varianteId,
        ocorrencias: 1,
        todasDeEixoUnico: eixoUnico ?? true,
        exemploLiFilhoId: 1,
        exemploErpFilhoId: 'x',
      })),
    }) as unknown as DocData,
  );
}

async function aprender(db: FakeDb, modo: ModoImportacaoLi = MODO_IMPORTACAO_LI.aplicar) {
  return executarAprendizadoLi(deps(db, modo), await lerMemoDeGruposLi(asDb(db)));
}

/** How option `(grade, opcao)` of THIS conta resolves over `grupos`. */
function resolver(
  grupos: Parameters<typeof resolverOpcoesDoFilhoLi>[0]['grupos'],
  grade: number,
  opcao: number,
) {
  return resolverOpcoesDoFilhoLi({
    contaId: CONTA,
    opcoesUris: [uriOpcaoLi(grade, opcao)],
    grupos,
  })[0];
}

/* --------------------------------- the memo ------------------------------- */

describe('lerMemoDeGruposLi — the whole collection, raw links, the read stamp', () => {
  it('variantes from the embedded `variacoes` ids (exact strings), links RAW, versao = updateTime, ascending id', async () => {
    const db = new FakeDb();
    const links = [entrada(TAM, { 1: ['v-p'] }), { lixo: true }];
    seedGrupo(db, 'tam', ['v-p', 'v-m'], links);
    db.seed(CAMINHO_GRUPO('cor'), {
      nome: 'Cor',
      variacoes: [{ id: 'v-az', nome: 'Azul' }, { id: 7, nome: 'sete' }, 'solta'],
    });
    const memo = await lerMemoDeGruposLi(asDb(db));
    expect(memo.map((g) => [g.id, g.variantesIds, g.linksVariacoesli])).toEqual([
      ['cor', ['v-az'], undefined],
      ['tam', ['v-p', 'v-m'], links],
    ]);
    expect(db.carimboDe(CAMINHO_GRUPO('tam'))?.isEqual(memo[1]?.versao)).toBe(true);
    // A whole, unfiltered collection read: no index involved.
    expect(db.consultas).toEqual([
      { colecao: 'grupoDeVariacoes', filtros: [], ordens: [], limite: null, apos: null },
    ]);
  });
});

/* -------------------------------- aplicar --------------------------------- */

describe('executarAprendizadoLi — aplicar: one tier-1 write per grupo the decision changes', () => {
  it('EQUAL: unanimous claims for an option of a linked grade ⇒ appended to THAT entry; every other element byte-identical', async () => {
    const db = new FakeDb();
    const invalida = { grade_id: '12', integracaoLiId: 'x' };
    const daOutra = entrada(TAM, { 9: ['v-m'] }, OUTRA);
    seedGrupo(db, 'tam', ['v-p', 'v-m'], [invalida, entrada(TAM, { 2: ['v-m'] }), daOutra]);
    seedEvidencia(db, TAM, 1, ['tam', 'v-p'], ['tam', 'v-p']);

    const r = await aprender(db);

    expect(r.aprendidos).toEqual([{ gradeId: TAM, opcaoId: 1, grupoId: 'tam', varianteId: 'v-p' }]);
    expect(r.gruposGravados).toEqual(['tam']);
    expect(db.escritas).toHaveLength(1);
    const [escrita] = db.escritas;
    expect(escrita).toMatchObject({ verbo: 'update', caminho: CAMINHO_GRUPO('tam') });
    expect(escrita?.dados).toEqual({
      linksVariacoesli: [
        invalida,
        {
          ...entrada(TAM, { 2: ['v-m'] }),
          variationOptions: [
            { li_option_id: 2, li_option_name: null, arakene_variation_id: ['v-m'] },
            { li_option_id: 1, li_option_name: null, arakene_variation_id: ['v-p'] },
          ],
        },
        daOutra,
      ],
      ultimaModificacao: AGORA_MS,
    });
    // The memo is chained from the write's own writeTime.
    expect(escrita?.writeTime.isEqual(r.memo.find((g) => g.id === 'tam')?.versao)).toBe(true);
    expect(r.aprendizadosSimulados).toEqual([]);
  });

  it('a grade NOTHING holds and single-axis claims ⇒ a new (conta, grade) entry; never a new grupo or variante', async () => {
    const db = new FakeDb();
    seedGrupo(db, 'tam', ['v-p', 'v-m']);
    seedEvidencia(db, TAM, 1, ['tam', 'v-p']);
    seedEvidencia(db, TAM, 2, ['tam', 'v-m']);
    const r = await aprender(db);
    expect(r.aprendidos.map((a) => a.opcaoId)).toEqual([1, 2]);
    expect(db.escritas.map((e) => [e.verbo, e.caminho])).toEqual([
      ['update', CAMINHO_GRUPO('tam')],
    ]);
    expect(db.ler(CAMINHO_GRUPO('tam'))?.linksVariacoesli).toEqual([
      entrada(TAM, { 1: ['v-p'], 2: ['v-m'] }),
    ]);
    expect(db.idsEm('grupoDeVariacoes')).toEqual(['tam']);
    expect(db.ler(CAMINHO_GRUPO('tam'))?.variacoes).toHaveLength(2);
  });

  it('⚠️ NEAR-MISS: claims naming two variantes ⇒ divergente, nothing learned, ZERO writes', async () => {
    const db = new FakeDb();
    seedGrupo(db, 'tam', ['v-p', 'v-m'], [entrada(TAM, {})]);
    seedEvidencia(db, TAM, 1, ['tam', 'v-p'], ['tam', 'v-m']);
    const r = await aprender(db);
    expect(r.aprendidos).toEqual([]);
    expect(r.recusados).toEqual([
      { gradeId: TAM, opcaoId: 1, motivo: MOTIVO_RECUSA_APRENDIZADO_LI.divergente },
    ]);
    expect(db.escritas).toEqual([]);
  });

  it('nothing new (the option is already linked) ⇒ zero writes, counted as already linked', async () => {
    const db = new FakeDb();
    seedGrupo(db, 'tam', ['v-p'], [entrada(TAM, { 1: ['v-p'] })]);
    seedEvidencia(db, TAM, 1, ['tam', 'v-p']);
    const r = await aprender(db);
    expect(r).toMatchObject({ aprendidos: [], jaVinculadas: 1, gruposGravados: [] });
    expect(db.escritas).toEqual([]);
  });

  it('no claim document ⇒ cursor null, nothing decided, nothing written; otherwise the cursor is the last id in key order', async () => {
    const db = new FakeDb();
    seedGrupo(db, 'tam', ['v-p']);
    expect(await aprender(db)).toMatchObject({ aprendizado: { cursorEvidenciaId: null } });
    seedEvidencia(db, 9, 1, ['tam', 'v-p']);
    seedEvidencia(db, 10, 1, ['tam', 'v-p']);
    const r = await aprender(db);
    expect(r.aprendizado).toEqual({ cursorEvidenciaId: '9_1', conflitos: [] });
  });

  it('every unit of the phase is a no-call unit', () => {
    expect(UNIDADE_DO_APRENDIZADO_LI).toBe(UNIDADE_IMPORTACAO_LI.familia);
  });
});

describe('executarAprendizadoLi — aplicar: a lost precondition (root rule 7, tier 1)', () => {
  it('an edit landing between the memo read and our write ⇒ the write is REFUSED, the grupo re-read, re-decided once, and both changes kept', async () => {
    const db = new FakeDb();
    seedGrupo(db, 'tam', ['v-p', 'v-m'], [entrada(TAM, {})]);
    seedEvidencia(db, TAM, 1, ['tam', 'v-p']);
    const operador = entrada(COR, { 31: ['v-m'] });
    db.antesDaProximaEscrita(CAMINHO_GRUPO('tam'), async () => {
      await refGrupo(db, 'tam').update({ linksVariacoesli: [entrada(TAM, {}), operador] });
    });

    const r = await aprender(db);

    // The operator's write, then ours — the first attempt of ours never landed.
    expect(db.escritasEm(CAMINHO_GRUPO('tam'))).toHaveLength(2);
    expect(db.ler(CAMINHO_GRUPO('tam'))?.linksVariacoesli).toEqual([
      entrada(TAM, { 1: ['v-p'] }),
      operador,
    ]);
    expect(r).toMatchObject({ gruposGravados: ['tam'], recusados: [] });
    expect(r.aprendidos.map((a) => a.opcaoId)).toEqual([1]);
    expect(db.carimboDe(CAMINHO_GRUPO('tam'))?.isEqual(r.memo[0]?.versao)).toBe(true);
  });

  it('the re-decision re-runs EVERY check: an operator linking the variante to another option ⇒ refused, nothing written by us', async () => {
    const db = new FakeDb();
    seedGrupo(db, 'tam', ['v-p', 'v-m'], [entrada(TAM, {})]);
    seedEvidencia(db, TAM, 1, ['tam', 'v-p']);
    db.antesDaProximaEscrita(CAMINHO_GRUPO('tam'), async () => {
      await refGrupo(db, 'tam').update({ linksVariacoesli: [entrada(TAM, { 5: ['v-p'] })] });
    });
    const r = await aprender(db);
    expect(r.recusados).toEqual([
      { gradeId: TAM, opcaoId: 1, motivo: MOTIVO_RECUSA_APRENDIZADO_LI.varianteEmOutraOpcao },
    ]);
    expect(r.gruposGravados).toEqual([]);
    expect(db.escritasEm(CAMINHO_GRUPO('tam'))).toHaveLength(1); // the operator's only
  });

  it('lost TWICE ⇒ the learnings reported as conflito-de-escrita, never forced; the job goes on', async () => {
    const db = new FakeDb();
    seedGrupo(db, 'tam', ['v-p', 'v-m'], [entrada(TAM, {})]);
    seedEvidencia(db, TAM, 1, ['tam', 'v-p']);
    const caminho = CAMINHO_GRUPO('tam');
    const editar = (n: number) => refGrupo(db, 'tam').update({ nome: `editado ${String(n)}` });
    // Install the second interleaving only once the first one's own write has landed.
    db.antesDaProximaEscrita(caminho, async () => {
      await editar(1);
      db.antesDaProximaEscrita(caminho, async () => {
        await editar(2);
      });
    });
    const r = await aprender(db);
    expect(r.recusados).toEqual([
      { gradeId: TAM, opcaoId: 1, motivo: PENDENCIA_IMPORTACAO_LI.conflitoDeEscrita },
    ]);
    // Carried on the job's cursor: the families report it, the decision re-run cannot.
    expect(r.aprendizado.conflitos).toEqual([`${String(TAM)}_1`]);
    expect(r.gruposGravados).toEqual([]);
    expect(db.ler(caminho)?.linksVariacoesli).toEqual([entrada(TAM, {})]);
  });

  it('⚠️ a loss re-decides EVERY grupo still to write: an edit of the first grupo that refuses the second grupo’s learning ⇒ ZERO writes on the second', async () => {
    const db = new FakeDb();
    // g1 holds this conta's grade TAM; nothing holds grade COR, so a single-axis claim of it would
    // create a new (conta, COR) entry in g2.
    seedGrupo(db, 'g1', ['v-x'], [entrada(TAM, {})]);
    seedGrupo(db, 'g2', ['v-y']);
    seedEvidencia(db, TAM, 10, ['g1', 'v-x']);
    seedEvidencia(db, COR, 20, ['g2', 'v-y']);
    // Before our g1 write, an operator saves g1 with a (conta, COR) entry of its own.
    db.antesDaProximaEscrita(CAMINHO_GRUPO('g1'), async () => {
      await refGrupo(db, 'g1').update({ linksVariacoesli: [entrada(TAM, {}), entrada(COR, {})] });
    });

    const r = await aprender(db);

    // g2 is never written: (conta, COR) now lives in g1, and a second entry would make COR resolve
    // `grade-em-dois-grupos` for every product of it.
    expect(db.escritasEm(CAMINHO_GRUPO('g2'))).toEqual([]);
    expect(db.ler(CAMINHO_GRUPO('g2'))?.linksVariacoesli).toBeUndefined();
    expect(r.recusados).toEqual([
      { gradeId: COR, opcaoId: 20, motivo: MOTIVO_RECUSA_APRENDIZADO_LI.gradeEmOutroGrupo },
    ]);
    // g1's own learning still lands, on the fresh read, beside the operator's entry.
    expect(r.gruposGravados).toEqual(['g1']);
    expect(db.ler(CAMINHO_GRUPO('g1'))?.linksVariacoesli).toEqual([
      entrada(TAM, { 10: ['v-x'] }),
      entrada(COR, {}),
    ]);
  });

  it('⚠️ NEAR-MISS: the same two grupos with NO edit ⇒ both written from the one decision', async () => {
    const db = new FakeDb();
    seedGrupo(db, 'g1', ['v-x'], [entrada(TAM, {})]);
    seedGrupo(db, 'g2', ['v-y']);
    seedEvidencia(db, TAM, 10, ['g1', 'v-x']);
    seedEvidencia(db, COR, 20, ['g2', 'v-y']);
    const r = await aprender(db);
    expect(r.gruposGravados).toEqual(['g1', 'g2']);
    expect(r.recusados).toEqual([]);
    expect(db.ler(CAMINHO_GRUPO('g2'))?.linksVariacoesli).toEqual([entrada(COR, { 20: ['v-y'] })]);
  });

  it('a grupo deleted meanwhile ⇒ refused (9), re-read as gone, learned nowhere', async () => {
    const db = new FakeDb();
    seedGrupo(db, 'tam', ['v-p'], [entrada(TAM, {})]);
    seedEvidencia(db, TAM, 1, ['tam', 'v-p']);
    db.antesDaProximaEscrita(CAMINHO_GRUPO('tam'), async () => {
      await refGrupo(db, 'tam').delete();
    });
    const r = await aprender(db);
    expect(r.recusados).toEqual([
      { gradeId: TAM, opcaoId: 1, motivo: MOTIVO_RECUSA_APRENDIZADO_LI.grupoDesconhecido },
    ]);
    expect(db.ler(CAMINHO_GRUPO('tam'))).toBeUndefined();
    expect(r.memo).toEqual([]);
  });

  it('any other failure propagates unchanged (root rule 6): the task retries', async () => {
    const db = new FakeDb();
    seedGrupo(db, 'tam', ['v-p'], [entrada(TAM, {})]);
    seedEvidencia(db, TAM, 1, ['tam', 'v-p']);
    db.falharEscrita(CAMINHO_GRUPO('tam'), grpc(14, 'UNAVAILABLE'));
    await expect(aprender(db)).rejects.toMatchObject({ code: 14 });
  });
});

/* --------------------------------- Simular -------------------------------- */

describe('Simular: no grupo write, an overlay — and the SAME verdict as aplicar', () => {
  it('writes NOTHING; returns the learnings for the checkpoint', async () => {
    const db = new FakeDb();
    seedGrupo(db, 'tam', ['v-p', 'v-m'], [entrada(TAM, {})]);
    seedEvidencia(db, TAM, 1, ['tam', 'v-p']);
    const r = await aprender(db, MODO_IMPORTACAO_LI.simular);
    expect(db.escritas).toEqual([]);
    expect(r.aprendizadosSimulados).toEqual([
      { grupoId: 'tam', gradeId: TAM, opcaoId: 1, varianteId: 'v-p' },
    ]);
    expect(r.gruposGravados).toEqual([]);
  });

  it('EQUAL: an option learned from one family resolves another family the same way under Simular (overlay) and aplicar (written)', async () => {
    const semear = (db: FakeDb) => {
      seedGrupo(db, 'tam', ['v-p', 'v-m'], [entrada(TAM, { 2: ['v-m'] })]);
      seedGrupo(db, 'cor', ['v-az'], [entrada(COR, {})]);
      seedEvidencia(db, TAM, 1, ['tam', 'v-p']);
      seedEvidencia(db, COR, 31, ['cor', 'v-az']);
    };
    const dbSim = new FakeDb();
    semear(dbSim);
    const sim = await aprender(dbSim, MODO_IMPORTACAO_LI.simular);
    const jobSim = {
      modo: MODO_IMPORTACAO_LI.simular,
      integracaoId: CONTA,
      aprendizadosSimulados: [...sim.aprendizadosSimulados],
    };
    const gruposSim = gruposParaResolverLi(await lerMemoDeGruposLi(asDb(dbSim)), jobSim);

    const dbApl = new FakeDb();
    semear(dbApl);
    await aprender(dbApl, MODO_IMPORTACAO_LI.aplicar);
    const gruposApl = gruposParaResolverLi(await lerMemoDeGruposLi(asDb(dbApl)), {
      modo: MODO_IMPORTACAO_LI.aplicar,
      integracaoId: CONTA,
      aprendizadosSimulados: [],
    });

    for (const [g, o, variante] of [
      [TAM, 1, 'v-p'],
      [TAM, 2, 'v-m'],
      [COR, 31, 'v-az'],
    ] as const) {
      const v = resolver(gruposSim, g, o);
      expect(v).toEqual(resolver(gruposApl, g, o));
      expect(v).toMatchObject({ tipo: TIPO_RESOLUCAO_OPCAO_LI.resolvida, varianteIds: [variante] });
    }
  });

  it('⚠️ NEAR-MISS: without the overlay a Simular would NOT resolve them; under aplicar a stored overlay is never applied', async () => {
    const db = new FakeDb();
    seedGrupo(db, 'tam', ['v-p', 'v-m'], [entrada(TAM, {})]);
    const memo = await lerMemoDeGruposLi(asDb(db));
    const simulados = [{ grupoId: 'tam', gradeId: TAM, opcaoId: 1, varianteId: 'v-p' }];
    expect(resolver([...memo], TAM, 1)).toMatchObject({
      tipo: TIPO_RESOLUCAO_OPCAO_LI.opcaoSemVinculo,
    });
    expect(
      resolver(
        gruposParaResolverLi(memo, {
          modo: MODO_IMPORTACAO_LI.aplicar,
          integracaoId: CONTA,
          aprendizadosSimulados: simulados,
        }),
        TAM,
        1,
      ),
    ).toMatchObject({ tipo: TIPO_RESOLUCAO_OPCAO_LI.opcaoSemVinculo });
    expect(
      resolver(
        gruposParaResolverLi(memo, {
          modo: MODO_IMPORTACAO_LI.simular,
          integracaoId: CONTA,
          aprendizadosSimulados: simulados,
        }),
        TAM,
        1,
      ),
    ).toMatchObject({ tipo: TIPO_RESOLUCAO_OPCAO_LI.resolvida, varianteIds: ['v-p'] });
  });

  it('the overlay keeps every stored element, and leaves a grupo whose value cannot take a merge as it is', () => {
    const invalida = { grade_id: 'x' };
    const grupos = gruposComSimulacaoLi(
      [
        { id: 'tam', variantesIds: ['v-p'], linksVariacoesli: [invalida] },
        { id: 'quebrado', variantesIds: ['v-q'], linksVariacoesli: 'não é lista' },
      ],
      CONTA,
      [
        { grupoId: 'tam', gradeId: TAM, opcaoId: 1, varianteId: 'v-p' },
        { grupoId: 'quebrado', gradeId: COR, opcaoId: 2, varianteId: 'v-q' },
      ],
    );
    expect(grupos[0]?.linksVariacoesli).toEqual([invalida, entrada(TAM, { 1: ['v-p'] })]);
    expect(grupos[1]?.linksVariacoesli).toBe('não é lista');
  });
});

/* ------------------------------- the report ------------------------------- */

describe('the report: why an option stays unlearned', () => {
  it('divergente and variante-disputada ⇒ evidencia-divergente; every other motivo ⇒ variacao-sem-vinculo', () => {
    for (const motivo of Object.values(MOTIVO_RECUSA_APRENDIZADO_LI)) {
      const esperado =
        motivo === MOTIVO_RECUSA_APRENDIZADO_LI.divergente ||
        motivo === MOTIVO_RECUSA_APRENDIZADO_LI.varianteDisputada
          ? PENDENCIA_IMPORTACAO_LI.evidenciaDivergente
          : PENDENCIA_IMPORTACAO_LI.variacaoSemVinculo;
      expect(pendenciaDaRecusaLi(motivo), motivo).toBe(esperado);
    }
  });

  it('recusasDoAprendizadoLi re-runs the decision: two options claiming one variante ⇒ both disputed; a multi-axis claim on a new grade ⇒ eixos-multiplos', async () => {
    const db = new FakeDb();
    seedGrupo(db, 'tam', ['v-p', 'v-m'], [entrada(TAM, {})]);
    seedGrupo(db, 'cor', ['v-az']);
    seedEvidencia(db, TAM, 1, ['tam', 'v-p']);
    seedEvidencia(db, TAM, 2, ['tam', 'v-p']);
    seedEvidencia(db, COR, 31, ['cor', 'v-az', false]);
    const recusas = recusasDoAprendizadoLi(
      CONTA,
      await lerEvidenciasDoJobLi(asDb(db), JOB),
      await lerMemoDeGruposLi(asDb(db)),
    );
    expect(Object.fromEntries(recusas)).toEqual({
      [`${String(TAM)}_1`]: MOTIVO_RECUSA_APRENDIZADO_LI.varianteDisputada,
      [`${String(TAM)}_2`]: MOTIVO_RECUSA_APRENDIZADO_LI.varianteDisputada,
      [`${String(COR)}_31`]: MOTIVO_RECUSA_APRENDIZADO_LI.eixosMultiplos,
    });
    expect(pendenciaDaRecusaLi(recusas.get(`${String(TAM)}_1`)!)).toBe(
      PENDENCIA_IMPORTACAO_LI.evidenciaDivergente,
    );
  });
});
