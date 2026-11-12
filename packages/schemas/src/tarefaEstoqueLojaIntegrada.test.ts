import { describe, expect, it } from 'vitest';
import * as barrel from './index';
import { TIPO_TAREFA_IMPORTACAO_LI } from './importacaoLojaIntegrada';
import { TIPO_TAREFA_LI, tipoTarefaLiSchema } from './notificacaoLojaIntegrada';
import {
  TIPO_TAREFA_ESCRITA_LI,
  tipoTarefaEscritaLiSchema,
} from './notificacaoEscritaLojaIntegrada';
import * as modulo from './tarefaEstoqueLojaIntegrada';
import {
  ORIGEM_TAREFA_ESTOQUE_LI,
  TIPO_TAREFA_ESTOQUE_LI,
  TIPO_TAREFA_RECONCILE_ESTOQUE_LI,
  origemTarefaEstoqueLiSchema,
  tarefaEstoqueKitsLiSchema,
  tarefaEstoqueLiSchema,
  tarefaFilaEstoqueLiSchema,
  tarefaReconcileEstoqueLiSchema,
  tipoTarefaEstoqueLiSchema,
} from './tarefaEstoqueLojaIntegrada';

/** ⌊1 800 000 000 000 ms / 60 s⌋: a real window number. */
const JANELA = 30_000_000;

const ESTOQUE = {
  tipo: TIPO_TAREFA_ESTOQUE_LI.estoque,
  contaId: 'conta-li-1',
  produtoId: 'p1',
  origem: ORIGEM_TAREFA_ESTOQUE_LI.evento,
  janela: JANELA,
  estoqueId: 'e1',
  apagado: false,
  estoqueIds: null,
  geracao: 0,
} as const;

const KITS = {
  tipo: TIPO_TAREFA_ESTOQUE_LI.estoqueKits,
  contaId: 'conta-li-1',
  componenteId: 'blank',
  janela: JANELA,
} as const;

const RECONCILE = {
  tipo: TIPO_TAREFA_RECONCILE_ESTOQUE_LI,
  execucaoId: 'estoque-reconcile-20271115',
  seq: 3,
} as const;

describe('tarefaEstoqueLiSchema (one send run)', () => {
  it('round-trips an event task and a kit task', () => {
    expect(tarefaEstoqueLiSchema.parse(ESTOQUE)).toEqual(ESTOQUE);
    const kit = {
      ...ESTOQUE,
      produtoId: 'kit1',
      origem: ORIGEM_TAREFA_ESTOQUE_LI.kit,
      estoqueId: null,
      estoqueIds: { blank: 'e-blank', print: null },
    };
    expect(tarefaEstoqueLiSchema.parse(kit)).toEqual(kit);
  });

  it.each([
    ['quantidade', 5],
    ['S', 5],
    ['Q', 7],
    ['s', 5],
    ['q', 7],
    ['qtd', 5],
    ['estoque', 5],
    ['disponivel', 5],
    ['quantidade_reservada', 2],
    ['reservado', 2],
    ['alvo', 7],
  ])(
    '⚠️ a payload carrying `%s` is REFUSED — S is derived at send time, never enqueued',
    (chave, valor) => {
      expect(tarefaEstoqueLiSchema.safeParse({ ...ESTOQUE, [chave]: valor }).success).toBe(false);
      expect(tarefaFilaEstoqueLiSchema.safeParse({ ...ESTOQUE, [chave]: valor }).success).toBe(
        false,
      );
    },
  );

  it('⚠️ STRICT: ANY extra key is refused, not stripped — a field nobody reviewed never rides', () => {
    expect(tarefaEstoqueLiSchema.safeParse({ ...ESTOQUE, extra: null }).success).toBe(false);
    expect(tarefaEstoqueLiSchema.safeParse({ ...ESTOQUE, nome: 'x' }).success).toBe(false);
  });

  it('every field is required: an old payload missing one is refused, never defaulted', () => {
    for (const chave of Object.keys(ESTOQUE)) {
      const semChave: Record<string, unknown> = { ...ESTOQUE };
      Reflect.deleteProperty(semChave, chave);
      expect(tarefaEstoqueLiSchema.safeParse(semChave).success, chave).toBe(false);
    }
  });

  it('the origins are exactly the six, and nothing folds into one', () => {
    expect(origemTarefaEstoqueLiSchema.options).toEqual([
      'evento',
      'kit',
      'reconcile',
      'manual',
      'publicacao',
      'deriva',
    ]);
    for (const quase of ['Evento', 'eventos', 'publicação', 'reconciliacao', '']) {
      expect(tarefaEstoqueLiSchema.safeParse({ ...ESTOQUE, origem: quase }).success, quase).toBe(
        false,
      );
    }
  });

  it('⚠️ THE LOOP CAP: generation 1 is exactly the drift follow-up', () => {
    const deriva = { ...ESTOQUE, origem: ORIGEM_TAREFA_ESTOQUE_LI.deriva, geracao: 1 };
    expect(tarefaEstoqueLiSchema.safeParse(deriva).success).toBe(true);
    // NEAR-MISS: a follow-up at generation 0 could enqueue another; an event at 1 is not one.
    expect(tarefaEstoqueLiSchema.safeParse({ ...deriva, geracao: 0 }).success).toBe(false);
    expect(tarefaEstoqueLiSchema.safeParse({ ...ESTOQUE, geracao: 1 }).success).toBe(false);
    expect(tarefaEstoqueLiSchema.safeParse({ ...deriva, geracao: 2 }).success).toBe(false);
  });

  it('the window is a non-negative safe integer', () => {
    for (const janela of [-1, 1.5, Number.NaN, 2 ** 53, '30000000']) {
      expect(tarefaEstoqueLiSchema.safeParse({ ...ESTOQUE, janela }).success, String(janela)).toBe(
        false,
      );
    }
    expect(tarefaEstoqueLiSchema.safeParse({ ...ESTOQUE, janela: 0 }).success).toBe(true);
  });

  it('ids are ids: the conta grammar, Firestore document ids', () => {
    for (const ruim of [
      { contaId: 'conta/1' },
      { contaId: '' },
      { produtoId: 'a/b' },
      { produtoId: '..' },
      { estoqueId: '' },
      { estoqueIds: { 'a/b': null } },
      { estoqueIds: { blank: 'e/1' } },
      { apagado: 'false' },
    ]) {
      expect(
        tarefaEstoqueLiSchema.safeParse({ ...ESTOQUE, ...ruim }).success,
        JSON.stringify(ruim),
      ).toBe(false);
    }
  });
});

describe('tarefaEstoqueKitsLiSchema (the zero-crossing fan-out of one component)', () => {
  it('round-trips, and carries no quantity and no kit list', () => {
    expect(tarefaEstoqueKitsLiSchema.parse(KITS)).toEqual(KITS);
    for (const [chave, valor] of [
      ['quantidade', 0],
      ['antes', 3],
      ['depois', 0],
      ['kits', ['k1']],
    ] as const) {
      expect(tarefaEstoqueKitsLiSchema.safeParse({ ...KITS, [chave]: valor }).success, chave).toBe(
        false,
      );
    }
  });
});

describe('the stock queue’s union, and the reads-queue slice', () => {
  it('dispatches by `tipo`: each task parses as its own shape and not as the other’s', () => {
    expect(tarefaFilaEstoqueLiSchema.parse(ESTOQUE)).toEqual(ESTOQUE);
    expect(tarefaFilaEstoqueLiSchema.parse(KITS)).toEqual(KITS);
    expect(tarefaFilaEstoqueLiSchema.safeParse({ ...KITS, tipo: ESTOQUE.tipo }).success).toBe(
      false,
    );
    expect(tarefaFilaEstoqueLiSchema.safeParse(RECONCILE).success).toBe(false);
    expect(tipoTarefaEstoqueLiSchema.options).toEqual(['estoque', 'estoque-kits']);
  });

  it('a reconcile slice names its run and dispatch, strictly', () => {
    expect(tarefaReconcileEstoqueLiSchema.parse(RECONCILE)).toEqual(RECONCILE);
    for (const ruim of [
      { ...RECONCILE, contaId: 'conta-li-1' },
      { ...RECONCILE, seq: -1 },
      { ...RECONCILE, seq: 1.5 },
      { ...RECONCILE, execucaoId: 'run 1' },
      { ...RECONCILE, tipo: 'estoque_reconcile' },
    ]) {
      expect(tarefaReconcileEstoqueLiSchema.safeParse(ruim).success, JSON.stringify(ruim)).toBe(
        false,
      );
    }
  });

  it('⚠️ no stock tipo is a member of the persisted notification or write-back tipos, nor the import’s', () => {
    for (const tipo of [...tipoTarefaEstoqueLiSchema.options, TIPO_TAREFA_RECONCILE_ESTOQUE_LI]) {
      expect(tipoTarefaLiSchema.safeParse(tipo).success, tipo).toBe(false);
      expect(tipoTarefaEscritaLiSchema.safeParse(tipo).success, tipo).toBe(false);
      expect(tipo).not.toBe(TIPO_TAREFA_IMPORTACAO_LI);
    }
    expect(Object.values(TIPO_TAREFA_LI)).not.toContain(TIPO_TAREFA_RECONCILE_ESTOQUE_LI);
    expect(Object.values(TIPO_TAREFA_ESCRITA_LI)).not.toContain(TIPO_TAREFA_ESTOQUE_LI.estoque);
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
