/**
 * The product import's START core (master plan step 9) on the fake Firestore: the read switch and
 * the conta FIRST (nothing read before the switch), then the guard, then ONE create — and never a
 * Loja Integrada call. The REAL context loader runs; `fetch` is stubbed to throw for the whole file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  type OpcoesImportacaoLi,
  importacaoLojaIntegradaSchema,
  opcoesImportacaoLiSchema,
} from '@delfrance/schemas';

import { __setRelogioDoCacheParaTestes } from '../core/contaCache';
import {
  LiChamadasDesligadasError,
  LiContaInativaError,
  LiContaNaoEncontradaError,
  LiContaParadaError,
  LiCredencialAusenteError,
} from '../core/erros';
import { CHAMADAS_ENV_LI } from '../core/valvulas';
import { FakeDb, asDb } from '../testing/fakeDb';
import {
  AGORA_MS,
  AMBIENTE_LIGADO,
  caminhoConta,
  caminhoCredencial,
  gravadorDeLog,
  ritmoFalso,
  seedConta,
  seedCredencial,
} from '../testing/fixtures';
import { caminhoJobLi, seedJobLi } from '../testing/importacaoLi';
import { type InicioImportacaoDeps, iniciarImportacaoLi } from './inicio';
import { FLUXO_IMPORTACAO_LI } from './job';

const CONTA = 'conta-li-inicio';
const UID = 'u-operador';

let fetchFalso: ReturnType<typeof vi.fn>;

beforeEach(() => {
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  fetchFalso = vi.fn(() => {
    throw new Error('inicio.test: o início de uma importação não chama a Loja Integrada');
  });
  vi.stubGlobal('fetch', fetchFalso);
});
afterEach(() => {
  expect(fetchFalso).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
});

function opcoes(over: Record<string, unknown> = {}): OpcoesImportacaoLi {
  return opcoesImportacaoLiSchema.parse({
    modo: 'simular',
    alvo: 'todos',
    acao: 'soVincular',
    ...over,
  });
}

function deps(db: FakeDb, ambiente = AMBIENTE_LIGADO) {
  const { ritmo, esperas } = ritmoFalso();
  const gravador = gravadorDeLog();
  const d: InicioImportacaoDeps = {
    db: asDb(db),
    ambiente,
    ritmo,
    agoraMs: () => AGORA_MS,
    escrever: gravador.escrever,
  };
  return { d, esperas, linhas: gravador.linhas };
}

function contaSaudavel(): FakeDb {
  const db = new FakeDb();
  seedConta(db, CONTA);
  seedCredencial(db, CONTA);
  return db;
}

describe('the read switch FIRST: nothing is read, nothing is created', () => {
  it.each<[string, string | undefined]>([
    ['unset', undefined],
    ['blank', ''],
    ['off', 'off'],
    ['ON', 'ON'],
    ['on␠', 'on '],
    ['true', 'true'],
  ])('%s ⇒ LiChamadasDesligadasError, ZERO reads, ZERO queries, ZERO writes', async (_n, valor) => {
    const db = contaSaudavel();
    seedJobLi(db, 'jobVivo', CONTA, { status: 'executando' });
    const { d, esperas, linhas } = deps(
      db,
      valor === undefined ? {} : { [CHAMADAS_ENV_LI]: valor },
    );

    const err: unknown = await iniciarImportacaoLi(d, CONTA, opcoes(), { uid: UID }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(LiChamadasDesligadasError);
    // The switch beats the guard too: even with a running job, it is the switch that answers.
    expect(db.leituras).toEqual([]);
    expect(db.consultas).toEqual([]);
    expect(db.escritas).toEqual([]);
    expect(esperas).toEqual([]);
    // One switch line, carrying the import's flow and this conta.
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.campos).toMatchObject({ fluxo: FLUXO_IMPORTACAO_LI, conta: CONTA });
  });
});

describe('then the conta and its credential (the context loader’s refusals), before the guard', () => {
  it('a missing conta ⇒ LiContaNaoEncontradaError, no query, no job', async () => {
    const db = new FakeDb();
    await expect(
      iniciarImportacaoLi(deps(db).d, CONTA, opcoes(), { uid: UID }),
    ).rejects.toBeInstanceOf(LiContaNaoEncontradaError);
    expect(db.consultas).toEqual([]);
    expect(db.escritas).toEqual([]);
  });

  it('an inactive conta ⇒ LiContaInativaError', async () => {
    const db = new FakeDb();
    seedConta(db, CONTA, { ativo: false });
    seedCredencial(db, CONTA);
    await expect(
      iniciarImportacaoLi(deps(db).d, CONTA, opcoes(), { uid: UID }),
    ).rejects.toBeInstanceOf(LiContaInativaError);
    expect(db.escritas).toEqual([]);
  });

  it('no credential ⇒ LiCredencialAusenteError', async () => {
    const db = new FakeDb();
    seedConta(db, CONTA);
    await expect(
      iniciarImportacaoLi(deps(db).d, CONTA, opcoes(), { uid: UID }),
    ).rejects.toBeInstanceOf(LiCredencialAusenteError);
    expect(db.consultas).toEqual([]);
  });

  it('a parked conta ⇒ LiContaParadaError, no job', async () => {
    const db = new FakeDb();
    seedConta(db, CONTA);
    seedCredencial(db, CONTA, {
      reconexaoPendente: { desdeMs: AGORA_MS - 10, status: 401, refCredencial: 'a.1' },
    });
    await expect(
      iniciarImportacaoLi(deps(db).d, CONTA, opcoes(), { uid: UID }),
    ).rejects.toBeInstanceOf(LiContaParadaError);
    expect(db.escritas).toEqual([]);
  });
});

describe('the guard: one running job per conta', () => {
  it.each(['pendente', 'executando'])(
    'a %s job ⇒ em-andamento with ITS id, and nothing written',
    async (status) => {
      const db = contaSaudavel();
      seedJobLi(db, 'jobVivo', CONTA, { status });
      expect(await iniciarImportacaoLi(deps(db).d, CONTA, opcoes(), { uid: UID })).toEqual({
        tipo: 'em-andamento',
        jobId: 'jobVivo',
      });
      expect(db.escritas).toEqual([]);
    },
  );

  it('⚠️ NEAR-MISS: a finished job, or another conta’s running one, does not block', async () => {
    const db = contaSaudavel();
    seedJobLi(db, 'jobVelho', CONTA, { status: 'concluido' });
    seedJobLi(db, 'jobDeOutra', 'conta-li-outra', { status: 'executando' });
    const r = await iniciarImportacaoLi(deps(db).d, CONTA, opcoes(), { uid: UID });
    expect(r.tipo).toBe('criado');
  });
});

describe('the create: ONE document, pendente, at an auto id', () => {
  it('the switch, the conta, the credential, the guard, then the create — in that order', async () => {
    const db = contaSaudavel();
    const { d, esperas } = deps(db);
    const r = await iniciarImportacaoLi(d, CONTA, opcoes(), { uid: UID });
    if (r.tipo !== 'criado') throw new Error('not created');

    expect(db.leituras).toEqual([caminhoConta(CONTA), caminhoCredencial(CONTA)]);
    expect(db.consultas.map((c) => c.colecao)).toEqual(['importacoesLojaIntegrada']);
    expect(db.escritas.map((e) => [e.verbo, e.caminho])).toEqual([
      ['create', caminhoJobLi(r.jobId)],
    ]);
    // The context's pacer is never spent: nothing is called.
    expect(esperas).toEqual([]);
  });

  it('the job: pendente, seq 0, phase catalogo, the options as sent, the uid and the stamps', async () => {
    const db = contaSaudavel();
    const sel = opcoes({
      modo: 'aplicar',
      alvo: 'selecionados',
      acao: 'completar',
      categorias: 'criarEVincular',
      fotos: 'soSemFotos',
      selecionados: [182904918, 182904919],
      simulacaoId: 'jobSimulado01',
    });
    const r = await iniciarImportacaoLi(deps(db).d, CONTA, sel, { uid: UID });
    if (r.tipo !== 'criado') throw new Error('not created');
    expect(r.jobId).toMatch(/^[A-Za-z0-9]{20}$/);

    const gravado = db.ler(caminhoJobLi(r.jobId));
    // The stored document IS a whole job: every default written, nothing it does not model.
    expect(importacaoLojaIntegradaSchema.parse(gravado)).toEqual(gravado);
    expect(gravado).toMatchObject({
      integracaoId: CONTA,
      iniciadoPor: UID,
      iniciadoEmMs: AGORA_MS,
      atualizadoEmMs: AGORA_MS,
      concluidoEmMs: null,
      status: 'pendente',
      fase: 'catalogo',
      motivo: null,
      seq: 0,
      modo: 'aplicar',
      alvo: 'selecionados',
      acao: 'completar',
      categorias: 'criarEVincular',
      fotos: 'soSemFotos',
      selecionados: [182904918, 182904919],
      simulacaoId: 'jobSimulado01',
      pausas429: 0,
    });
  });

  it('two starts in a row: the second meets the first’s pendente job (the guard by query)', async () => {
    const db = contaSaudavel();
    const primeiro = await iniciarImportacaoLi(deps(db).d, CONTA, opcoes(), { uid: UID });
    const segundo = await iniciarImportacaoLi(deps(db).d, CONTA, opcoes(), { uid: UID });
    if (primeiro.tipo !== 'criado') throw new Error('not created');
    expect(segundo).toEqual({ tipo: 'em-andamento', jobId: primeiro.jobId });
    expect(db.escritas).toHaveLength(1);
  });
});
