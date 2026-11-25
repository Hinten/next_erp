import { describe, expect, it } from 'vitest';
import * as barrel from './index';
import { TIPO_TAREFA_IMPORTACAO_LI } from './importacaoLojaIntegrada';
import { TIPO_TAREFA_LI, tipoTarefaLiSchema } from './notificacaoLojaIntegrada';
import {
  TIPO_TAREFA_ESCRITA_LI,
  tipoTarefaEscritaLiSchema,
} from './notificacaoEscritaLojaIntegrada';
import {
  TIPO_TAREFA_RECONCILE_ESTOQUE_LI,
  tarefaFilaEstoqueLiSchema,
  tipoTarefaEstoqueLiSchema,
} from './tarefaEstoqueLojaIntegrada';
import * as modulo from './tarefaPrecoLojaIntegrada';
import {
  ORIGEM_TAREFA_PRECO_LI,
  TIPO_TAREFA_PRECO_LI,
  origemEmLotePrecoLi,
  origemTarefaPrecoLiSchema,
  tarefaPrecoLiSchema,
} from './tarefaPrecoLojaIntegrada';

/** ⌊1 800 000 000 000 ms / 60 s⌋: a real window number. */
const JANELA = 30_000_000;

const EVENTO = {
  tipo: TIPO_TAREFA_PRECO_LI,
  contaId: 'conta-li-1',
  produtoId: 'p1',
  origem: ORIGEM_TAREFA_PRECO_LI.evento,
  janela: JANELA,
  geracao: 0,
  baixar: true,
} as const;

const RECONCILE = {
  ...EVENTO,
  origem: ORIGEM_TAREFA_PRECO_LI.reconcile,
  baixar: false,
  tabelaNormalId: 'tab-normal',
  tabelaPromocionalId: 'tab-promo',
} as const;

/** Every spelling of a price a producer might be tempted to carry. */
const PRECOS = [
  ['cheio', 50],
  ['promocional', 39.99],
  ['custo', 12.5],
  ['preco', 50],
  ['precos', { 'tab-normal': { valor: 50 } }],
  ['valor', 50],
  ['promo', 39.99],
  ['preco_cheio', '50.00'],
  ['preco_promocional', null],
  ['cheioCentavos', 5000],
  ['alvo', 5000],
  ['quantidade', 5],
  ['sob_consulta', false],
] as const;

describe.each([
  ['an event', EVENTO],
  ['a reconcile send', RECONCILE],
] as const)('%s: IDS ONLY', (_nome, payload) => {
  it('round-trips as given', () => {
    expect(tarefaPrecoLiSchema.parse(payload)).toEqual(payload);
  });

  it.each(PRECOS)(
    '⚠️ a payload carrying `%s` is REFUSED — the price is derived at send time, never enqueued',
    (chave, valor) => {
      expect(tarefaPrecoLiSchema.safeParse({ ...payload, [chave]: valor }).success).toBe(false);
    },
  );

  it('every base field is required: an old payload missing one is refused, never defaulted', () => {
    for (const chave of Object.keys(EVENTO)) {
      const semChave: Record<string, unknown> = { ...payload };
      Reflect.deleteProperty(semChave, chave);
      expect(tarefaPrecoLiSchema.safeParse(semChave).success, chave).toBe(false);
    }
  });
});

describe('tarefaPrecoLiSchema (one send run)', () => {
  it('⚠️ STRICT: ANY extra key is refused, not stripped', () => {
    expect(tarefaPrecoLiSchema.safeParse({ ...EVENTO, extra: null }).success).toBe(false);
    expect(tarefaPrecoLiSchema.safeParse({ ...EVENTO, depositoId: 'd1' }).success).toBe(false);
  });

  it('the origins are exactly the six, and nothing folds into one', () => {
    expect(origemTarefaPrecoLiSchema.options).toEqual([
      'evento',
      'manual',
      'publicacao',
      'deriva',
      'reconcile',
      'atualizacao',
    ]);
    expect(Object.values(ORIGEM_TAREFA_PRECO_LI)).toEqual(origemTarefaPrecoLiSchema.options);
    for (const quase of ['Evento', 'eventos', 'publicação', 'atualizar', 'kit', '']) {
      expect(tarefaPrecoLiSchema.safeParse({ ...EVENTO, origem: quase }).success, quase).toBe(
        false,
      );
    }
  });

  it('only reconcile and atualizacao are bulk', () => {
    expect(origemTarefaPrecoLiSchema.options.filter(origemEmLotePrecoLi)).toEqual([
      'reconcile',
      'atualizacao',
    ]);
  });

  it('⚠️ THE LOOP CAP: generation 1 is exactly the drift follow-up', () => {
    const deriva = { ...EVENTO, origem: ORIGEM_TAREFA_PRECO_LI.deriva, geracao: 1 };
    expect(tarefaPrecoLiSchema.safeParse(deriva).success).toBe(true);
    expect(tarefaPrecoLiSchema.safeParse({ ...deriva, baixar: false }).success).toBe(true);
    // NEAR-MISS: a follow-up at generation 0 could enqueue another; an event at 1 is not one.
    expect(tarefaPrecoLiSchema.safeParse({ ...deriva, geracao: 0 }).success).toBe(false);
    expect(tarefaPrecoLiSchema.safeParse({ ...EVENTO, geracao: 1 }).success).toBe(false);
    expect(tarefaPrecoLiSchema.safeParse({ ...deriva, geracao: 2 }).success).toBe(false);
    // NEAR-MISS: the generation is 0 or 1 on EVERY origin — the type refuses the rest, not only
    // the deriva refine.
    for (const geracao of [2, 3, -1, 0.5, '0', null]) {
      expect(tarefaPrecoLiSchema.safeParse({ ...EVENTO, geracao }).success, String(geracao)).toBe(
        false,
      );
      expect(
        tarefaPrecoLiSchema.safeParse({ ...RECONCILE, geracao }).success,
        String(geracao),
      ).toBe(false);
    }
  });

  it('⚠️ the tabela ids ride EXACTLY on a bulk send — the promo one may be null there', () => {
    const atualizacao = { ...RECONCILE, origem: ORIGEM_TAREFA_PRECO_LI.atualizacao, baixar: true };
    expect(tarefaPrecoLiSchema.parse(atualizacao)).toEqual(atualizacao);
    expect(tarefaPrecoLiSchema.safeParse({ ...RECONCILE, tabelaPromocionalId: null }).success).toBe(
      true,
    );
    // NEAR-MISS: a bulk send without its normal tabela, or SILENT about its promo one.
    const { tabelaPromocionalId: _p, ...semPromo } = RECONCILE;
    expect(tarefaPrecoLiSchema.safeParse(semPromo).success).toBe(false);
    const { tabelaNormalId: _n, ...semNormal } = RECONCILE;
    expect(tarefaPrecoLiSchema.safeParse(semNormal).success).toBe(false);
    expect(tarefaPrecoLiSchema.safeParse({ ...RECONCILE, tabelaNormalId: null }).success).toBe(
      false,
    );
    // NEAR-MISS: any other origin reads the conta's tabelas when it runs.
    for (const origem of ['evento', 'manual', 'publicacao'] as const) {
      const tarefa = { ...EVENTO, origem };
      expect(tarefaPrecoLiSchema.safeParse(tarefa).success, origem).toBe(true);
      expect(
        tarefaPrecoLiSchema.safeParse({
          ...tarefa,
          tabelaNormalId: null,
          tabelaPromocionalId: null,
        }).success,
        origem,
      ).toBe(true);
      expect(
        tarefaPrecoLiSchema.safeParse({ ...tarefa, tabelaNormalId: 't1' }).success,
        origem,
      ).toBe(false);
      expect(
        tarefaPrecoLiSchema.safeParse({ ...tarefa, tabelaPromocionalId: 't2' }).success,
        origem,
      ).toBe(false);
    }
    for (const tabelaNormalId of ['', 'a/b', '..', 5, '__x__']) {
      expect(
        tarefaPrecoLiSchema.safeParse({ ...RECONCILE, tabelaNormalId }).success,
        String(tabelaNormalId),
      ).toBe(false);
    }
  });

  it('⚠️ baixar: a publish always may lower, the daily reconcile never may', () => {
    const publicacao = { ...EVENTO, origem: ORIGEM_TAREFA_PRECO_LI.publicacao };
    expect(tarefaPrecoLiSchema.safeParse(publicacao).success).toBe(true);
    expect(tarefaPrecoLiSchema.safeParse({ ...publicacao, baixar: false }).success).toBe(false);
    expect(tarefaPrecoLiSchema.safeParse(RECONCILE).success).toBe(true);
    expect(tarefaPrecoLiSchema.safeParse({ ...RECONCILE, baixar: true }).success).toBe(false);
    // The caller's choice elsewhere.
    for (const origem of ['evento', 'manual'] as const) {
      for (const baixar of [true, false]) {
        expect(
          tarefaPrecoLiSchema.safeParse({ ...EVENTO, origem, baixar }).success,
          `${origem}/${String(baixar)}`,
        ).toBe(true);
      }
    }
    for (const baixar of [true, false]) {
      const atualizacao = { ...RECONCILE, origem: ORIGEM_TAREFA_PRECO_LI.atualizacao, baixar };
      expect(tarefaPrecoLiSchema.safeParse(atualizacao).success, String(baixar)).toBe(true);
    }
    // NEAR-MISS: the flag is a boolean, never its text or a number.
    for (const baixar of ['true', 1, null]) {
      expect(tarefaPrecoLiSchema.safeParse({ ...EVENTO, baixar }).success, String(baixar)).toBe(
        false,
      );
    }
  });

  it('the window is a non-negative safe integer; ids are ids', () => {
    for (const janela of [-1, 1.5, Number.NaN, 2 ** 53, '30000000']) {
      expect(tarefaPrecoLiSchema.safeParse({ ...EVENTO, janela }).success, String(janela)).toBe(
        false,
      );
    }
    expect(tarefaPrecoLiSchema.safeParse({ ...EVENTO, janela: 0 }).success).toBe(true);
    for (const ruim of [
      { contaId: 'conta/1' },
      { contaId: '' },
      { produtoId: 'a/b' },
      { produtoId: '..' },
    ]) {
      expect(
        tarefaPrecoLiSchema.safeParse({ ...EVENTO, ...ruim }).success,
        JSON.stringify(ruim),
      ).toBe(false);
    }
  });

  it('⚠️ the price tipo is no stock, notification, write-back or import tipo — and no stock task parses as it', () => {
    expect(tipoTarefaEstoqueLiSchema.safeParse(TIPO_TAREFA_PRECO_LI).success).toBe(false);
    expect(tipoTarefaLiSchema.safeParse(TIPO_TAREFA_PRECO_LI).success).toBe(false);
    expect(tipoTarefaEscritaLiSchema.safeParse(TIPO_TAREFA_PRECO_LI).success).toBe(false);
    expect(TIPO_TAREFA_PRECO_LI).not.toBe(TIPO_TAREFA_IMPORTACAO_LI);
    expect(TIPO_TAREFA_PRECO_LI).not.toBe(TIPO_TAREFA_RECONCILE_ESTOQUE_LI);
    expect(Object.values(TIPO_TAREFA_LI)).not.toContain(TIPO_TAREFA_PRECO_LI);
    expect(Object.values(TIPO_TAREFA_ESCRITA_LI)).not.toContain(TIPO_TAREFA_PRECO_LI);
    expect(tarefaFilaEstoqueLiSchema.safeParse(EVENTO).success).toBe(false);
    expect(tarefaPrecoLiSchema.safeParse({ ...EVENTO, tipo: 'estoque' }).success).toBe(false);
  });

  it('the module exports nothing combined { schema, meta }, and the barrel re-exports it', () => {
    for (const [nome, valor] of Object.entries(modulo)) {
      const temSchemaEMeta =
        typeof valor === 'object' && valor !== null && 'schema' in valor && 'meta' in valor;
      expect(temSchemaEMeta, nome).toBe(false);
      expect(Reflect.get(barrel, nome), nome).toBe(valor);
    }
  });
});
