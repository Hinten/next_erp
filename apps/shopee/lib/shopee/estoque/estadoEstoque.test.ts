import { describe, expect, it } from 'vitest';

import { MODO_VARREDURA_ESTOQUE } from '@delfrance/schemas';

import { type DocData, FakeDb, asDb } from '../testing/fakeDb';
import { MOTIVOS_DE_PAUSA } from './constantesEstoque';
import { MOTIVO_ESTOQUE_SHOPEE } from './errosEstoque';
import {
  CARIMBO_VARREDURA,
  type ContinuacaoLida,
  armarPausa,
  carimbarVarredura,
  estaPausada,
  lerEstadoEstoque,
  registrarErroDaConta,
  registrarMotivoDaConta,
} from './estadoEstoque';

/* -------------------------------------------------------------------------- */
/*                                  fixtures                                  */
/* -------------------------------------------------------------------------- */

const INT = 'int-1';
const CAMINHO = `estoqueShopeeSync/${INT}`;
const AGORA = 1_760_000_000_000;

const CONTINUACAO: ContinuacaoLida = {
  afterAnchorId: 'prod-42',
  changedSinceMs: AGORA - 900_000,
  modo: MODO_VARREDURA_ESTOQUE.incremental,
  movimentosDesdeMs: AGORA - 900_000,
  startedAtMs: AGORA - 60_000,
};

/** Every field set, so a round-trip can show that none of them is dropped. */
function docCompleto(): DocData {
  return {
    cursorMs: 1_000,
    lastSweepAtMs: 2_000,
    lastDailyAtMs: 3_000,
    lastReconciliacaoAtMs: 4_000,
    lastError: 'boom',
    lastErrorAtMs: 5_000,
    pausadoAte: 6_000,
    pausaMotivo: MOTIVOS_DE_PAUSA.burst,
    pausaCodigo: 'error_limit',
    pauseCount: 7,
    ultimoMotivoConta: MOTIVO_ESTOQUE_SHOPEE.lojaFbs,
    ultimoMotivoContaEmMs: 8_000,
    continuacao: { ...CONTINUACAO },
  };
}

/** The LAST patch written at the state doc's path, whatever the verb. */
function ultimaEscrita(db: FakeDb): DocData {
  const minhas = db.writes.filter((w) => w.path === CAMINHO);
  const ultima = minhas[minhas.length - 1];
  if (ultima === undefined) throw new Error('nenhuma escrita no documento de estado');
  return ultima.patch;
}

/* -------------------------------------------------------------------------- */
/*                            (1) a leitura tolerante                          */
/* -------------------------------------------------------------------------- */

describe('lerEstadoEstoque', () => {
  it('um documento AUSENTE lê tudo nulo, pauseCount 0 e existe: false', async () => {
    const db = new FakeDb();

    const estado = await lerEstadoEstoque(asDb(db), INT);

    expect(estado).toEqual({
      cursorMs: null,
      lastSweepAtMs: null,
      lastDailyAtMs: null,
      lastReconciliacaoAtMs: null,
      lastError: null,
      lastErrorAtMs: null,
      pausadoAte: null,
      pausaMotivo: null,
      pausaCodigo: null,
      pauseCount: 0,
      ultimoMotivoConta: null,
      ultimoMotivoContaEmMs: null,
      continuacao: null,
      existe: false,
    });
    expect(db.writes).toEqual([]);
  });

  it('um documento COMPLETO faz round-trip campo a campo', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, docCompleto());

    const estado = await lerEstadoEstoque(asDb(db), INT);

    expect(estado).toEqual({ ...docCompleto(), continuacao: CONTINUACAO, existe: true });
  });

  it('⚠️ um documento VAZIO existe mas lê tudo nulo — "existe" e "tem dados" são fatos diferentes', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, {});

    const estado = await lerEstadoEstoque(asDb(db), INT);

    expect(estado.existe).toBe(true);
    expect(estado.cursorMs).toBeNull();
    expect(estado.pauseCount).toBe(0);
  });

  it('a leitura custa UM get e nenhuma escrita', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, docCompleto());

    await lerEstadoEstoque(asDb(db), INT);

    expect(db.opLog.filter((o) => o.op === 'get')).toHaveLength(1);
    expect(db.writes).toEqual([]);
  });

  it('valores de tipo errado são tolerados, campo a campo, sem derrubar o tick', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, {
      cursorMs: 'ontem',
      pauseCount: 'muitos',
      lastError: 42,
      pausadoAte: Number.NaN,
      ultimoMotivoConta: '',
    });

    const estado = await lerEstadoEstoque(asDb(db), INT);

    expect(estado.cursorMs).toBeNull();
    expect(estado.pauseCount).toBe(0);
    expect(estado.lastError).toBeNull();
    expect(estado.pausadoAte).toBeNull();
    expect(estado.ultimoMotivoConta).toBeNull();
    expect(estado.existe).toBe(true);
  });
});

describe('lerEstadoEstoque — a continuação, e os três quase-acertos', () => {
  async function lendo(continuacao: unknown): Promise<ContinuacaoLida | null> {
    const db = new FakeDb();
    db.seed(CAMINHO, { continuacao });
    return (await lerEstadoEstoque(asDb(db), INT)).continuacao;
  }

  it('PAR: uma continuação ÍNTEGRA é lida inteira', async () => {
    await expect(lendo({ ...CONTINUACAO })).resolves.toEqual(CONTINUACAO);
  });

  it('PAR: changedSinceMs -1 (a reconciliação) é um valor LEGÍTIMO, nunca "malformado"', async () => {
    const reconciliacao: ContinuacaoLida = {
      ...CONTINUACAO,
      changedSinceMs: -1,
      modo: MODO_VARREDURA_ESTOQUE.reconciliacao,
      movimentosDesdeMs: null,
    };
    await expect(lendo({ ...reconciliacao })).resolves.toEqual(reconciliacao);
  });

  it('⚠️ NEAR-MISS: sem a CHAVE movimentosDesdeMs, a continuação inteira lê null', async () => {
    const { movimentosDesdeMs: _ignorado, ...semAChave } = CONTINUACAO;
    await expect(lendo(semAChave)).resolves.toBeNull();
  });

  it('⚠️ NEAR-MISS: um modo desconhecido derruba a continuação inteira', async () => {
    await expect(lendo({ ...CONTINUACAO, modo: 'semanal' })).resolves.toBeNull();
  });

  it('⚠️ NEAR-MISS: afterAnchorId vazio derruba a continuação inteira', async () => {
    await expect(lendo({ ...CONTINUACAO, afterAnchorId: '' })).resolves.toBeNull();
  });

  it('uma continuação que não é objeto lê null', async () => {
    for (const lixo of [null, 'prod-42', 7, [CONTINUACAO]]) {
      await expect(lendo(lixo)).resolves.toBeNull();
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                               (2) o portão                                  */
/* -------------------------------------------------------------------------- */

describe('estaPausada — o limite é ESTRITO', () => {
  const com = (pausadoAte: number | null) => ({
    cursorMs: null,
    lastSweepAtMs: null,
    lastDailyAtMs: null,
    lastReconciliacaoAtMs: null,
    lastError: null,
    lastErrorAtMs: null,
    pausadoAte,
    pausaMotivo: null,
    pausaCodigo: null,
    pauseCount: 0,
    ultimoMotivoConta: null,
    ultimoMotivoContaEmMs: null,
    continuacao: null,
    existe: true,
  });

  it('PAR: pausadoAte no futuro está pausado; no passado não está', () => {
    expect(estaPausada(com(AGORA + 1), AGORA)).toBe(true);
    expect(estaPausada(com(AGORA - 1), AGORA)).toBe(false);
  });

  it('⚠️ NEAR-MISS: pausadoAte === nowMs NÃO está pausado', () => {
    expect(estaPausada(com(AGORA), AGORA)).toBe(false);
  });

  it('sem pausa registrada, não está pausado', () => {
    expect(estaPausada(com(null), AGORA)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                          (3) os cinco escritores                            */
/* -------------------------------------------------------------------------- */

describe('armarPausa', () => {
  it('escreve os quatro campos do portão e pauseCount = atual + 1', async () => {
    const db = new FakeDb();

    await armarPausa(asDb(db), INT, {
      ate: AGORA + 300_000,
      motivo: MOTIVOS_DE_PAUSA.cotaDiaria,
      codigo: 'error_limit',
      pauseCountAtual: 4,
    });

    expect(ultimaEscrita(db)).toEqual({
      pausadoAte: AGORA + 300_000,
      pausaMotivo: MOTIVOS_DE_PAUSA.cotaDiaria,
      pausaCodigo: 'error_limit',
      pauseCount: 5,
    });
  });

  it('⚠️ uma pausa NÃO toca o cursor nem a continuação — não é progresso', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, docCompleto());

    await armarPausa(asDb(db), INT, {
      ate: AGORA,
      motivo: MOTIVOS_DE_PAUSA.lojaBloqueada,
      codigo: null,
      pauseCountAtual: 0,
    });

    const patch = ultimaEscrita(db);
    expect(Object.keys(patch).sort()).toEqual([
      'pausaCodigo',
      'pausaMotivo',
      'pausadoAte',
      'pauseCount',
    ]);
    const estado = await lerEstadoEstoque(asDb(db), INT);
    expect(estado.cursorMs).toBe(1_000);
    expect(estado.continuacao).toEqual(CONTINUACAO);
  });

  it('um código nulo (a pausa é nossa) é escrito como null, não omitido', async () => {
    const db = new FakeDb();

    await armarPausa(asDb(db), INT, {
      ate: AGORA,
      motivo: MOTIVOS_DE_PAUSA.lojaEmFerias,
      codigo: null,
      pauseCountAtual: 0,
    });

    expect(Object.keys(ultimaEscrita(db))).toContain('pausaCodigo');
    expect(ultimaEscrita(db).pausaCodigo).toBeNull();
  });
});

describe('registrarErroDaConta', () => {
  it('escreve lastError/lastErrorAtMs/lastSweepAtMs e NADA mais', async () => {
    const db = new FakeDb();

    await registrarErroDaConta(asDb(db), INT, 'gRPC 14 UNAVAILABLE', AGORA);

    expect(ultimaEscrita(db)).toEqual({
      lastError: 'gRPC 14 UNAVAILABLE',
      lastErrorAtMs: AGORA,
      lastSweepAtMs: AGORA,
    });
  });

  it('⚠️ nunca o cursor e nunca a continuação — o próximo tick repete a mesma janela', async () => {
    const db = new FakeDb();

    await registrarErroDaConta(asDb(db), INT, 'boom', AGORA);

    const chaves = Object.keys(ultimaEscrita(db));
    expect(chaves).not.toContain('cursorMs');
    expect(chaves).not.toContain('continuacao');
  });
});

describe('registrarMotivoDaConta', () => {
  it('escreve o motivo, o instante e lastSweepAtMs, e nada mais', async () => {
    const db = new FakeDb();

    await registrarMotivoDaConta(asDb(db), INT, MOTIVO_ESTOQUE_SHOPEE.multiArmazem, AGORA);

    expect(ultimaEscrita(db)).toEqual({
      ultimoMotivoConta: MOTIVO_ESTOQUE_SHOPEE.multiArmazem,
      ultimoMotivoContaEmMs: AGORA,
      lastSweepAtMs: AGORA,
    });
  });
});

describe('carimbarVarredura — cada variante nomeia EXATAMENTE as suas chaves', () => {
  it('incremental DRENADA: cursorMs = startedAtMs (não nowMs) e limpa erro + motivo', async () => {
    const db = new FakeDb();

    await carimbarVarredura(asDb(db), INT, {
      tipo: CARIMBO_VARREDURA.incrementalDrenada,
      startedAtMs: AGORA - 60_000,
      nowMs: AGORA,
    });

    expect(ultimaEscrita(db)).toEqual({
      cursorMs: AGORA - 60_000,
      continuacao: null,
      lastSweepAtMs: AGORA,
      lastError: null,
      ultimoMotivoConta: null,
    });
  });

  it('⚠️ NEAR-MISS: o cursor drenado é o INÍCIO da varredura, nunca o relógio do fim', async () => {
    const db = new FakeDb();

    await carimbarVarredura(asDb(db), INT, {
      tipo: CARIMBO_VARREDURA.incrementalDrenada,
      startedAtMs: AGORA - 60_000,
      nowMs: AGORA,
    });

    expect(ultimaEscrita(db).cursorMs).not.toBe(AGORA);
  });

  it('diário DRENADO: lastDailyAtMs, e NUNCA cursorMs', async () => {
    const db = new FakeDb();

    await carimbarVarredura(asDb(db), INT, {
      tipo: CARIMBO_VARREDURA.diarioDrenado,
      nowMs: AGORA,
    });

    expect(ultimaEscrita(db)).toEqual({
      lastDailyAtMs: AGORA,
      continuacao: null,
      lastSweepAtMs: AGORA,
      lastError: null,
    });
    expect(Object.keys(ultimaEscrita(db))).not.toContain('cursorMs');
  });

  it('reconciliação DRENADA: lastReconciliacaoAtMs, e NUNCA cursorMs nem lastDailyAtMs', async () => {
    const db = new FakeDb();

    await carimbarVarredura(asDb(db), INT, {
      tipo: CARIMBO_VARREDURA.reconciliacaoDrenada,
      nowMs: AGORA,
    });

    expect(ultimaEscrita(db)).toEqual({
      lastReconciliacaoAtMs: AGORA,
      continuacao: null,
      lastSweepAtMs: AGORA,
      lastError: null,
    });
    const chaves = Object.keys(ultimaEscrita(db));
    expect(chaves).not.toContain('cursorMs');
    expect(chaves).not.toContain('lastDailyAtMs');
  });

  it('TRUNCADA: continuacao + lastSweepAtMs, e avança NADA', async () => {
    const db = new FakeDb();

    await carimbarVarredura(asDb(db), INT, {
      tipo: CARIMBO_VARREDURA.truncada,
      continuacao: CONTINUACAO,
      nowMs: AGORA,
    });

    expect(ultimaEscrita(db)).toEqual({
      continuacao: { ...CONTINUACAO },
      lastSweepAtMs: AGORA,
    });
    const chaves = Object.keys(ultimaEscrita(db));
    for (const proibida of ['cursorMs', 'lastDailyAtMs', 'lastReconciliacaoAtMs', 'lastError']) {
      expect(chaves).not.toContain(proibida);
    }
  });

  it('uma continuação truncada sobrevive ao round-trip com o modo congelado', async () => {
    const db = new FakeDb();
    const diaria: ContinuacaoLida = { ...CONTINUACAO, modo: MODO_VARREDURA_ESTOQUE.diario };

    await carimbarVarredura(asDb(db), INT, {
      tipo: CARIMBO_VARREDURA.truncada,
      continuacao: diaria,
      nowMs: AGORA,
    });

    expect((await lerEstadoEstoque(asDb(db), INT)).continuacao).toEqual(diaria);
  });

  it('a continuação drenada é gravada como null — uma chave ausente deixaria a antiga viva', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, docCompleto());

    await carimbarVarredura(asDb(db), INT, {
      tipo: CARIMBO_VARREDURA.incrementalDrenada,
      startedAtMs: AGORA,
      nowMs: AGORA,
    });

    expect((await lerEstadoEstoque(asDb(db), INT)).continuacao).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*                     (4) o método: merge, e patches PLANOS                   */
/* -------------------------------------------------------------------------- */

describe('toda escrita é um merge (upsert), nunca mergeIfExists e nunca set', () => {
  it('⚠️ merge, não mergeIfExists: o `update` nunca é usado, então patches fica VAZIO', async () => {
    // `mergeIfExists` É um `update()`, e o dobro registra todo `update` em
    // `patches`. Zero entradas ali com uma entrada em `writes` é a prova do
    // método — e um `update` num documento ausente falharia NOT_FOUND, que é
    // exatamente o primeiro tick de cada conta.
    const db = new FakeDb();

    await carimbarVarredura(asDb(db), INT, {
      tipo: CARIMBO_VARREDURA.truncada,
      continuacao: CONTINUACAO,
      nowMs: AGORA,
    });

    expect(db.patches).toEqual([]);
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0]?.path).toBe(CAMINHO);
  });

  it('⚠️ merge, não set: um campo que o patch não nomeia SOBREVIVE', async () => {
    const db = new FakeDb();
    db.seed(CAMINHO, docCompleto());

    await registrarErroDaConta(asDb(db), INT, 'boom', AGORA);

    const estado = await lerEstadoEstoque(asDb(db), INT);
    expect(estado.cursorMs).toBe(1_000);
    expect(estado.pauseCount).toBe(7);
    expect(estado.lastError).toBe('boom');
  });

  it('o primeiro tick de uma conta CRIA o documento', async () => {
    const db = new FakeDb();

    await registrarMotivoDaConta(asDb(db), INT, MOTIVO_ESTOQUE_SHOPEE.semDeposito, AGORA);

    expect((await lerEstadoEstoque(asDb(db), INT)).existe).toBe(true);
  });

  it('nenhum patch tem chave pontuada, e o único objeto aninhado é o VALOR de continuacao', async () => {
    const db = new FakeDb();

    await carimbarVarredura(asDb(db), INT, {
      tipo: CARIMBO_VARREDURA.truncada,
      continuacao: CONTINUACAO,
      nowMs: AGORA,
    });
    await armarPausa(asDb(db), INT, {
      ate: AGORA,
      motivo: MOTIVOS_DE_PAUSA.burst,
      codigo: 'error_limit',
      pauseCountAtual: 0,
    });
    await registrarErroDaConta(asDb(db), INT, 'boom', AGORA);

    for (const { patch } of db.writes) {
      for (const [chave, valor] of Object.entries(patch)) {
        expect(chave).not.toContain('.');
        if (typeof valor === 'object' && valor !== null) expect(chave).toBe('continuacao');
      }
    }
  });
});
