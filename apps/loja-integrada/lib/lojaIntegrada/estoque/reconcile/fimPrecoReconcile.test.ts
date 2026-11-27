/**
 * `fimPrecoReconcile.ts` and `contasPrecoReconcile.ts` (master plan step 13, PR 13-f1): the price
 * end of one conta — `ultimoReconcilePreco` with the RUN's tabelas, and the "sem preço no ERP"
 * aviso raised or resolved only under `on`, live for the conta, still the conta the run priced,
 * with no contained fault, and once the parents phase finished it. Against `testing/fakeDb.ts` and
 * the real aviso writer; invented ids.
 */
import { describe, expect, it } from 'vitest';
import { INTEGRACAO_TIPO } from '@delfrance/schemas';

import { chavePrecoSemErpLi } from '../../avisos/avisos';
import { CANARIO_ENV_LI, FLUXO_LI, VALVULA_ENV_LI, lerValvula } from '../../core/valvulas';
import { FakeDb, asDb, increment } from '../../testing/fakeDb';
import {
  AGORA_RECONCILE_MS,
  INICIO_RUN_RECONCILE_MS,
  RUN_A,
  loggerGravador,
} from '../../testing/reconcileEstoqueLi';
import {
  INDISPONIBILIDADE_PRECO_LI,
  indisponibilidadePrecoLi,
  reverContasPrecoLi,
  tabelasDobradasLi,
} from './contasPrecoReconcile';
import { carregarEstadosPrecoLi } from './estadoPrecoReconcile';
import { FimPrecoReconcileLi } from './fimPrecoReconcile';

const TABELAS_DO_RUN = { normal: 'tab-n', promocional: 'tab-p' };
const RAIZ = 'sincPrecoLojaIntegrada/C1';
const AVISO = `avisos/${chavePrecoSemErpLi('C1')}`;

const LIGADO = { [VALVULA_ENV_LI.preco]: 'on', [CANARIO_ENV_LI.preco]: '*' };

function semearConta(db: FakeDb, over: Record<string, unknown> = {}): void {
  db.seed('integracao/C1', {
    tipo: INTEGRACAO_TIPO.lojaIntegrada,
    nome: 'Loja A',
    ativo: true,
    tabelaNormalOuterRef: 'documents/listaDePrecos/tab-n',
    tabelaPromocionalOuterRef: 'listaDePrecos/tab-p',
    ...over,
  });
}

function semearRaiz(
  db: FakeDb,
  contadores: Record<string, number>,
  amostras: Record<string, string[]> = {},
): void {
  db.seed(RAIZ, {
    reconcilePreco: null,
    execucaoPreco: {
      execucaoId: RUN_A,
      tabelas: TABELAS_DO_RUN,
      amostras,
      contadores,
      candidatos: [],
      mantidos: [],
    },
  });
}

const RETIDOS = { paisConcluido: 1, retidos: 3, retidosIlegiveis: 1, retidosSemPai: 1, alvos: 5 };

/**
 * One price end over C1, at the fixtures' clock moved `diaMs` on (a later run's); returns the
 * state's writes and the lines.
 */
async function fim(db: FakeDb, ambiente: Record<string, string> = LIGADO, diaMs = 0) {
  const log = loggerGravador();
  const estados = await carregarEstadosPrecoLi(asDb(db), RUN_A, [{ idx: 0, contaId: 'C1' }], {
    baldes: 'nenhum',
  });
  const f = new FimPrecoReconcileLi({
    db: asDb(db),
    deps: { agoraMs: () => AGORA_RECONCILE_MS + diaMs, increment, logger: log.logger },
    execucaoId: RUN_A,
    runIniciadoEmMs: INICIO_RUN_RECONCILE_MS + diaMs,
    contas: ['C1'],
    valvula: lerValvula(FLUXO_LI.preco, ambiente),
    estadoDe: async () => estados.get('C1') ?? null,
  });
  await f.unidade(0);
  const estado = estados.get('C1');
  const escritas = (estado?.escritas() ?? []).map((w) =>
    w.tipo === 'apagar'
      ? { caminho: w.ref.path, dados: undefined }
      : { caminho: w.ref.path, dados: w.dados },
  );
  return { log, escritas };
}

describe('the price end — `ultimoReconcilePreco`', () => {
  it('the conta’s counters and the tabelas the RUN fixed — never the conta’s current ones — and the cursor cleared', async () => {
    const db = new FakeDb();
    // The conta was re-pointed after the take: the end still records what the run priced with.
    semearConta(db, { tabelaNormalOuterRef: 'documents/listaDePrecos/tab-nova' });
    semearRaiz(db, RETIDOS, { retido: ['p3', 'p1', 'p2'] });
    const { escritas } = await fim(db);
    expect(escritas).toHaveLength(1);
    expect(escritas[0]?.dados).toMatchObject({
      reconcilePreco: null,
      ultimoReconcilePreco: {
        execucaoId: RUN_A,
        iniciadoEmMs: INICIO_RUN_RECONCILE_MS,
        concluidoEmMs: AGORA_RECONCILE_MS,
        tabelas: TABELAS_DO_RUN,
        contadores: RETIDOS,
      },
    });
  });

  it('a GONE conta (or no longer a Loja Integrada one) ⇒ nothing: no root write, no aviso', async () => {
    for (const conta of [null, { tipo: 99, nome: 'x' }]) {
      const db = new FakeDb();
      if (conta !== null) db.seed('integracao/C1', conta);
      semearRaiz(db, RETIDOS);
      const { escritas } = await fim(db);
      expect(escritas, JSON.stringify(conta)).toEqual([]);
      expect(db.ler(AVISO)).toBeUndefined();
    }
  });

  it('a conta this run did not price ⇒ nothing read for the aviso, nothing written', async () => {
    const db = new FakeDb();
    semearConta(db);
    const { escritas, log } = await fim(db);
    expect(escritas).toEqual([]);
    expect(log.linhas).toEqual([]);
  });
});

describe('the "sem preço no ERP" aviso', () => {
  it('RAISED under `on` and live: produtos, ilegiveis, semPai, the sorted sample; clocked by the run’s start', async () => {
    const db = new FakeDb();
    semearConta(db);
    semearRaiz(db, RETIDOS, { retido: ['p3', 'p1', 'p2'] });
    await fim(db);
    const aviso = db.ler(AVISO);
    expect(aviso).toMatchObject({
      tipo: 'lojaIntegradaPrecoSemErp',
      severidade: 'atencao',
      canal: 'lojaIntegrada',
      params: { loja: 'Loja A', produtos: 3, ilegiveis: 1, semPai: 1, amostra: 'p1, p2, p3' },
      relogioEvento: INICIO_RUN_RECONCILE_MS * 1000,
    });
    expect(aviso?.resolvidoEm ?? null).toBeNull();
  });

  it('RESOLVED by a later run counting none — only an OPEN row; NEAR-MISS: no row ⇒ nothing written (never a seeded resolved row)', async () => {
    const db = new FakeDb();
    semearConta(db);
    semearRaiz(db, RETIDOS, { retido: ['p1'] });
    await fim(db);
    expect(db.ler(AVISO)?.resolvidoEm ?? null).toBeNull();
    // A later run of the same id (the clock only has to be newer): none held.
    const depois = new FakeDb();
    for (const caminho of ['integracao/C1', AVISO]) {
      const dados = db.ler(caminho);
      if (dados !== undefined) depois.seed(caminho, dados);
    }
    semearRaiz(depois, { paisConcluido: 1, retidos: 0, alvos: 8 });
    const log = loggerGravador();
    const estados = await carregarEstadosPrecoLi(asDb(depois), RUN_A, [{ idx: 0, contaId: 'C1' }], {
      baldes: 'nenhum',
    });
    await new FimPrecoReconcileLi({
      db: asDb(depois),
      deps: { agoraMs: () => AGORA_RECONCILE_MS + 86_400_000, increment, logger: log.logger },
      execucaoId: RUN_A,
      runIniciadoEmMs: INICIO_RUN_RECONCILE_MS + 86_400_000,
      contas: ['C1'],
      valvula: lerValvula(FLUXO_LI.preco, LIGADO),
      estadoDe: async () => estados.get('C1') ?? null,
    }).unidade(0);
    expect(depois.ler(AVISO)?.resolvidoEm).not.toBeNull();
    expect(depois.ler(AVISO)?.resolucaoMotivo).toBe('conferencia-sem-casos');

    const nenhum = new FakeDb();
    semearConta(nenhum);
    semearRaiz(nenhum, { paisConcluido: 1, retidos: 0 });
    await fim(nenhum);
    expect(nenhum.ler(AVISO)).toBeUndefined();
    expect(nenhum.escritasEm(AVISO)).toEqual([]);
  });

  it('NEAR-MISS: a row already RESOLVED, met by a later run counting none again, is left untouched — no rewrite each night', async () => {
    const db = new FakeDb();
    semearConta(db);
    semearRaiz(db, RETIDOS, { retido: ['p1'] });
    await fim(db);
    semearRaiz(db, { paisConcluido: 1, retidos: 0 });
    await fim(db, LIGADO, 86_400_000);
    expect(db.ler(AVISO)?.resolvidoEm).not.toBeNull();
    const escritasAteAqui = db.escritasEm(AVISO).length;

    semearRaiz(db, { paisConcluido: 1, retidos: 0 });
    await fim(db, LIGADO, 2 * 86_400_000);
    expect(db.escritasEm(AVISO)).toHaveLength(escritasAteAqui);
  });

  it.each([
    ['dry-run', { [VALVULA_ENV_LI.preco]: 'dry-run', [CANARIO_ENV_LI.preco]: '*' }, {}, {}],
    [
      'outside the canary',
      { [VALVULA_ENV_LI.preco]: 'on', [CANARIO_ENV_LI.preco]: 'C9:1' },
      {},
      {},
    ],
    ['the conta’s tabela changed since the take', LIGADO, { tabelaPromocionalOuterRef: null }, {}],
    ['the conta inactive', LIGADO, { ativo: false }, {}],
    ['a contained fault on the conta (`armaFalhou`)', LIGADO, {}, { armaFalhou: 1 }],
  ] as const)(
    'NOT written when %s — ONE INFO line with the count and the sample instead; `ultimoReconcilePreco` still written',
    async (_caso, ambiente, conta, contadores) => {
      const db = new FakeDb();
      semearConta(db, conta);
      semearRaiz(db, { ...RETIDOS, ...contadores }, { retido: ['p2', 'p1'] });
      const { log, escritas } = await fim(db, ambiente);
      expect(db.ler(AVISO)).toBeUndefined();
      expect(escritas).toHaveLength(1);
      const info = log.linhas.filter((l) => l.msg.includes('achado de preço da conta (sem aviso)'));
      expect(info).toHaveLength(1);
      expect(info[0]?.meta).toMatchObject({ produtos: 3, amostra: ['p1', 'p2'] });
    },
  );

  it('NEAR-MISS: not live and NONE held ⇒ no INFO line (only a non-zero row is a finding)', async () => {
    const db = new FakeDb();
    semearConta(db);
    semearRaiz(db, { paisConcluido: 1, retidos: 0 });
    const { log, escritas } = await fim(db, {
      [VALVULA_ENV_LI.preco]: 'dry-run',
      [CANARIO_ENV_LI.preco]: '*',
    });
    expect(log.linhas).toEqual([]);
    expect(escritas).toHaveLength(1);
  });

  it('undecidable — the parents phase did not finish the conta ⇒ neither raised, nor resolved, nor logged', async () => {
    const db = new FakeDb();
    semearConta(db);
    semearRaiz(db, { retidos: 3 });
    db.seed(AVISO, { tipo: 'lojaIntegradaPrecoSemErp', conta: 'C1', resolvidoEm: null });
    const { log, escritas } = await fim(db);
    expect(db.escritasEm(AVISO)).toEqual([]);
    expect(log.linhas).toEqual([]);
    expect(escritas).toHaveLength(1);
  });
});

describe('contasPrecoReconcile — the fold and the re-read', () => {
  it('tabelasDobradasLi: promo == normal folds to null; no normal ⇒ not priced', () => {
    expect(tabelasDobradasLi({ normal: 'N', promocional: 'N' })).toEqual({
      normal: 'N',
      promocional: null,
    });
    expect(tabelasDobradasLi({ normal: 'N', promocional: null })).toEqual({
      normal: 'N',
      promocional: null,
    });
    // NEAR-MISS: a distinct promo stays.
    expect(tabelasDobradasLi({ normal: 'N', promocional: 'P' })).toEqual({
      normal: 'N',
      promocional: 'P',
    });
    expect(tabelasDobradasLi({ normal: null, promocional: 'P' })).toBeNull();
  });

  it('indisponibilidadePrecoLi over an uncached re-read: gone, inactive, a tabela moved — or available', async () => {
    const db = new FakeDb();
    semearConta(db);
    db.seed('integracao/C2', {
      tipo: INTEGRACAO_TIPO.lojaIntegrada,
      nome: 'b',
      ativo: false,
      tabelaNormalOuterRef: 'documents/listaDePrecos/tab-n',
    });
    db.seed('integracao/C3', {
      tipo: INTEGRACAO_TIPO.lojaIntegrada,
      nome: 'c',
      tabelaNormalOuterRef: 'documents/listaDePrecos/tab-n',
      tabelaPromocionalOuterRef: 'documents/listaDePrecos/tab-n',
    });
    const revistas = await reverContasPrecoLi(asDb(db), ['C1', 'C2', 'C3', 'C4']);
    expect(revistas.get('C1')).toMatchObject({
      existe: true,
      ativo: true,
      tabelas: TABELAS_DO_RUN,
      nome: 'Loja A',
    });
    expect(indisponibilidadePrecoLi(revistas.get('C1'), TABELAS_DO_RUN)).toBeNull();
    expect(indisponibilidadePrecoLi(revistas.get('C2'), TABELAS_DO_RUN)).toBe(
      INDISPONIBILIDADE_PRECO_LI.inativa,
    );
    // C3's promo names its normal one: folded to null — the same as the run's { tab-n, null }.
    expect(
      indisponibilidadePrecoLi(revistas.get('C3'), { normal: 'tab-n', promocional: null }),
    ).toBeNull();
    expect(indisponibilidadePrecoLi(revistas.get('C3'), TABELAS_DO_RUN)).toBe(
      INDISPONIBILIDADE_PRECO_LI.tabelaMudou,
    );
    expect(indisponibilidadePrecoLi(revistas.get('C4'), TABELAS_DO_RUN)).toBe(
      INDISPONIBILIDADE_PRECO_LI.ausente,
    );
    expect(indisponibilidadePrecoLi(undefined, TABELAS_DO_RUN)).toBe(
      INDISPONIBILIDADE_PRECO_LI.ausente,
    );
  });

  it('the price end re-reads the contas ONCE per slice, however many contas the slice ends', async () => {
    const db = new FakeDb();
    const contas = ['C1', 'C2', 'C3'];
    for (const conta of contas) {
      db.seed(`integracao/${conta}`, {
        tipo: INTEGRACAO_TIPO.lojaIntegrada,
        nome: `Loja ${conta}`,
        ativo: true,
        tabelaNormalOuterRef: 'documents/listaDePrecos/tab-n',
        tabelaPromocionalOuterRef: 'listaDePrecos/tab-p',
      });
      db.seed(`sincPrecoLojaIntegrada/${conta}`, {
        execucaoPreco: {
          execucaoId: RUN_A,
          tabelas: TABELAS_DO_RUN,
          amostras: {},
          contadores: { paisConcluido: 1, retidos: 0 },
          candidatos: [],
          mantidos: [],
        },
      });
    }
    const estados = await carregarEstadosPrecoLi(
      asDb(db),
      RUN_A,
      contas.map((contaId, idx) => ({ idx, contaId })),
      { baldes: 'nenhum' },
    );
    const f = new FimPrecoReconcileLi({
      db: asDb(db),
      deps: { agoraMs: () => AGORA_RECONCILE_MS, increment, logger: loggerGravador().logger },
      execucaoId: RUN_A,
      runIniciadoEmMs: INICIO_RUN_RECONCILE_MS,
      contas,
      valvula: lerValvula(FLUXO_LI.preco, {
        [VALVULA_ENV_LI.preco]: 'dry-run',
        [CANARIO_ENV_LI.preco]: '*',
      }),
      estadoDe: async (idx) => estados.get(contas[idx] ?? '') ?? null,
    });
    for (let idx = 0; idx < contas.length; idx += 1) await f.unidade(idx);
    for (const conta of contas) {
      expect(
        db.leituras.filter((c) => c === `integracao/${conta}`),
        conta,
      ).toHaveLength(1);
    }
  });
});
