/**
 * The stock task's contract: the strict payload, the observation's rendering,
 * the name per observation (its exact preimage and its near-misses), and the
 * one read-back rule.
 */
import { Timestamp } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@delfrance/data/admin';

import {
  type LinhaJanelaEstoqueAmazon,
  janelaDoTick,
  observacoesDaJanela,
  produtosDaJanela,
  sondasDoProduto,
} from './descobertaEstoque';
import {
  MAX_UNIDADES_SKU_TAREFA_ESTOQUE,
  ORIGEM_TAREFA_ESTOQUE_AMAZON,
  type OrigemTarefaEstoqueAmazon,
  type TarefaEstoqueAmazon,
  VERSAO_TAREFA_ESTOQUE_AMAZON,
  nomeDaTarefaEstoque,
  nomeTarefaEstoque,
  origemTarefaEstoqueAmazonSchema,
  precisaVerificacao,
  referenciaDaObservacao,
  tarefaEstoqueAmazonSchema,
} from './tarefaEstoque';

const CONTA = 'conta-1';
const SKU = 'SKU-1';
const SEG = 1_000;
/** ms — a tick's cursor (2027-01-15T08:00:00Z). */
const T = 1_800_000_000_000;
const OBS = '1800000000.000000005';

function tarefa(over: Partial<TarefaEstoqueAmazon> = {}): unknown {
  return {
    v: VERSAO_TAREFA_ESTOQUE_AMAZON,
    contaId: CONTA,
    sku: SKU,
    origem: ORIGEM_TAREFA_ESTOQUE_AMAZON.delta,
    referencia: OBS,
    depositoId: null,
    ...over,
  };
}

const aceita = (t: unknown) => tarefaEstoqueAmazonSchema.safeParse(t).success;

describe('the payload: identities only, strict', () => {
  it('a delta task parses, and the origem set is closed', () => {
    expect(aceita(tarefa())).toBe(true);
    expect(origemTarefaEstoqueAmazonSchema.options).toEqual([
      'delta',
      'reconciliacao',
      'catch-up',
      'manual',
      'verificacao',
    ]);
    expect(aceita(tarefa({ origem: 'tick' as OrigemTarefaEstoqueAmazon }))).toBe(false);
  });

  it('it never carries a quantity (or any other unknown key), and its version is 1', () => {
    expect(aceita({ ...(tarefa() as object), quantidade: 5 })).toBe(false);
    expect(aceita({ ...(tarefa() as object), v: 2 })).toBe(false);
  });

  it('depositoId exists exactly for reconciliacao', () => {
    const rec = { origem: ORIGEM_TAREFA_ESTOQUE_AMAZON.reconciliacao, referencia: 'exec-1' };
    expect(aceita(tarefa({ ...rec, depositoId: 'dep-1' }))).toBe(true);
    expect(aceita(tarefa({ ...rec, depositoId: null }))).toBe(false);
    expect(aceita(tarefa({ depositoId: 'dep-1' }))).toBe(false);
    expect(aceita(tarefa({ ...rec, depositoId: 'depositos/dep-1' }))).toBe(false);
  });

  it('each origem’s referencia has its own grammar', () => {
    // delta: the rendered observation only.
    expect(aceita(tarefa({ referencia: '1800000000.5' }))).toBe(false);
    expect(aceita(tarefa({ referencia: 'exec-1' }))).toBe(false);
    // catch-up, manual: an id.
    for (const origem of [
      ORIGEM_TAREFA_ESTOQUE_AMAZON.catchUp,
      ORIGEM_TAREFA_ESTOQUE_AMAZON.manual,
    ]) {
      expect(aceita(tarefa({ origem, referencia: '50001' }))).toBe(true);
      expect(aceita(tarefa({ origem, referencia: 'a:b' }))).toBe(false);
      expect(aceita(tarefa({ origem, referencia: '' }))).toBe(false);
    }
    // ★ reconciliacao, catch-up, manual: the id grammar EXACTLY — a '.', '/' or '+' a
    // submissionId may hold is refused there (NEAR-MISS: the same text is a valid read-back reference).
    const rec = { origem: ORIGEM_TAREFA_ESTOQUE_AMAZON.reconciliacao, depositoId: 'dep-1' };
    expect(aceita(tarefa({ ...rec, referencia: 'exec-1' }))).toBe(true);
    for (const ruim of ['exec.1', 'exec/1', 'exec+1']) {
      expect(aceita(tarefa({ ...rec, referencia: ruim })), ruim).toBe(false);
      for (const origem of [
        ORIGEM_TAREFA_ESTOQUE_AMAZON.manual,
        ORIGEM_TAREFA_ESTOQUE_AMAZON.catchUp,
      ]) {
        expect(aceita(tarefa({ origem, referencia: ruim })), `${origem} ${ruim}`).toBe(false);
      }
      expect(
        aceita(tarefa({ origem: ORIGEM_TAREFA_ESTOQUE_AMAZON.verificacao, referencia: ruim })),
        ruim,
      ).toBe(true);
    }
    // verificacao: Amazon's submissionId, visible ASCII without ':'.
    const verificacao = ORIGEM_TAREFA_ESTOQUE_AMAZON.verificacao;
    expect(aceita(tarefa({ origem: verificacao, referencia: 'f1dc2914.75dd' }))).toBe(true);
    expect(aceita(tarefa({ origem: verificacao, referencia: 'f1:dc' }))).toBe(false);
    expect(aceita(tarefa({ origem: verificacao, referencia: 'f1 dc' }))).toBe(false);
  });

  it('the SKU is bounded in size only (the valve and the path check judge it)', () => {
    expect(aceita(tarefa({ sku: 'x'.repeat(MAX_UNIDADES_SKU_TAREFA_ESTOQUE) }))).toBe(true);
    expect(aceita(tarefa({ sku: '😀'.repeat(40) }))).toBe(true);
    expect(aceita(tarefa({ sku: 'x'.repeat(MAX_UNIDADES_SKU_TAREFA_ESTOQUE + 1) }))).toBe(false);
    expect(aceita(tarefa({ sku: '' }))).toBe(false);
    expect(aceita(tarefa({ sku: 'a/b:c' }))).toBe(true);
  });
});

describe('the observation’s rendering: <seconds>.<nanoseconds>, nine digits', () => {
  it('pins the rendering', () => {
    expect(referenciaDaObservacao(new Timestamp(1_800_000_000, 5))).toBe(OBS);
    expect(referenciaDaObservacao(new Timestamp(1_800_000_000, 0))).toBe('1800000000.000000000');
    expect(referenciaDaObservacao(new Timestamp(1_800_000_000, 999_999_999))).toBe(
      '1800000000.999999999',
    );
  });

  it('two instants one nanosecond apart render apart', () => {
    expect(referenciaDaObservacao(new Timestamp(1, 10))).not.toBe(
      referenciaDaObservacao(new Timestamp(1, 1)),
    );
    expect(referenciaDaObservacao(new Timestamp(1, 100_000_000))).not.toBe(
      referenciaDaObservacao(new Timestamp(1, 1)),
    );
  });

  it('refuses a shape no Timestamp has', () => {
    const forma = (seconds: number, nanoseconds: number) => ({
      seconds,
      nanoseconds,
      toMillis: () => 0,
    });
    expect(() => referenciaDaObservacao(forma(-1, 0))).toThrow(RangeError);
    expect(() => referenciaDaObservacao(forma(1, 1_000_000_000))).toThrow(RangeError);
    expect(() => referenciaDaObservacao(forma(1.5, 0))).toThrow(RangeError);
  });
});

describe('the name: the exact preimage', () => {
  it('is sha256Hex of estoque:<origem>:<contaId>:<referencia>:<sku>', () => {
    expect(nomeTarefaEstoque(ORIGEM_TAREFA_ESTOQUE_AMAZON.delta, CONTA, SKU, OBS)).toBe(
      sha256Hex(`estoque:delta:${CONTA}:${OBS}:${SKU}`),
    );
    expect(nomeDaTarefaEstoque(tarefaEstoqueAmazonSchema.parse(tarefa()))).toBe(
      nomeTarefaEstoque(ORIGEM_TAREFA_ESTOQUE_AMAZON.delta, CONTA, SKU, OBS),
    );
  });

  it('NEAR-MISSES: the reference and the SKU swapped, another origem, another conta are other names', () => {
    const nome = nomeTarefaEstoque(ORIGEM_TAREFA_ESTOQUE_AMAZON.catchUp, CONTA, SKU, '50001');
    expect(nome).not.toBe(sha256Hex(`estoque:catch-up:${CONTA}:${SKU}:50001`));
    expect(nome).not.toBe(
      nomeTarefaEstoque(ORIGEM_TAREFA_ESTOQUE_AMAZON.manual, CONTA, SKU, '50001'),
    );
    expect(nome).not.toBe(
      nomeTarefaEstoque(ORIGEM_TAREFA_ESTOQUE_AMAZON.catchUp, 'conta-2', SKU, '50001'),
    );
    expect(nome).not.toBe(
      nomeTarefaEstoque(ORIGEM_TAREFA_ESTOQUE_AMAZON.catchUp, CONTA, `${SKU} `, '50001'),
    );
  });

  it('the SKU bound is 80 UTF-16 units, pinned by value, and the name holds the payload’s own bound (80 in, 81 out)', () => {
    const d = ORIGEM_TAREFA_ESTOQUE_AMAZON.delta;
    expect(MAX_UNIDADES_SKU_TAREFA_ESTOQUE).toBe(80);
    expect(nomeTarefaEstoque(d, CONTA, 'x'.repeat(80), OBS)).toMatch(/^[0-9a-f]{64}$/);
    expect(nomeTarefaEstoque(d, CONTA, '😀'.repeat(40), OBS)).toMatch(/^[0-9a-f]{64}$/);
    expect(() => nomeTarefaEstoque(d, CONTA, 'x'.repeat(81), OBS)).toThrow(/sku/);
    expect(() => nomeTarefaEstoque(d, CONTA, '😀'.repeat(41), OBS)).toThrow(/sku/);
    expect(aceita(tarefa({ sku: 'x'.repeat(81) }))).toBe(false);
  });

  it('a read-back’s reference is Amazon’s submissionId: up to 128 visible characters, never a 129th', () => {
    const v = ORIGEM_TAREFA_ESTOQUE_AMAZON.verificacao;
    expect(nomeTarefaEstoque(v, CONTA, SKU, 's'.repeat(128))).toMatch(/^[0-9a-f]{64}$/);
    expect(() => nomeTarefaEstoque(v, CONTA, SKU, 's'.repeat(129))).toThrow(/referencia/);
    expect(aceita(tarefa({ origem: v, referencia: 's'.repeat(128) }))).toBe(true);
    expect(aceita(tarefa({ origem: v, referencia: 's'.repeat(129) }))).toBe(false);
  });

  it('a SKU holding `:` cannot shift a field: the reference never holds one', () => {
    const a = nomeTarefaEstoque(ORIGEM_TAREFA_ESTOQUE_AMAZON.catchUp, CONTA, 'b:c', 'a');
    expect(a).toBe(sha256Hex(`estoque:catch-up:${CONTA}:a:b:c`));
    expect(() =>
      nomeTarefaEstoque(ORIGEM_TAREFA_ESTOQUE_AMAZON.catchUp, CONTA, 'c', 'a:b'),
    ).toThrow(RangeError);
  });

  it('refuses every field outside its grammar, naming the field only', () => {
    const d = ORIGEM_TAREFA_ESTOQUE_AMAZON.delta;
    expect(() => nomeTarefaEstoque('x' as OrigemTarefaEstoqueAmazon, CONTA, SKU, OBS)).toThrow(
      /origem/,
    );
    expect(() => nomeTarefaEstoque(d, 'conta/1', SKU, OBS)).toThrow(/contaId/);
    expect(() => nomeTarefaEstoque(d, CONTA, '', OBS)).toThrow(/sku/);
    expect(() => nomeTarefaEstoque(d, CONTA, SKU, 'exec-1')).toThrow(/referencia/);
    // ★ The id origens refuse what only a submissionId may hold.
    for (const origem of [
      ORIGEM_TAREFA_ESTOQUE_AMAZON.reconciliacao,
      ORIGEM_TAREFA_ESTOQUE_AMAZON.manual,
      ORIGEM_TAREFA_ESTOQUE_AMAZON.catchUp,
    ]) {
      expect(() => nomeTarefaEstoque(origem, CONTA, SKU, 'exec.1'), origem).toThrow(/referencia/);
      expect(() => nomeTarefaEstoque(origem, CONTA, SKU, 'req/1'), origem).toThrow(RangeError);
    }
    let mensagem = '';
    try {
      nomeTarefaEstoque(d, CONTA, 'SEGREDO-123', 'exec-1');
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      mensagem = err.message;
    }
    expect(mensagem).toMatch(/referencia/);
    expect(mensagem).not.toMatch(/SEGREDO|exec-1/);
  });
});

/** A row of `produto`, stamped `carimboMs`, committed at `commit`. */
function linha(produto: string, carimboMs: number, commit: Timestamp): LinhaJanelaEstoqueAmazon {
  return {
    caminho: `produtos/${produto}/estoques/dep-1`,
    ultimaModificacao: carimboMs,
    updateTime: commit,
  };
}

/** The delta task names a tick mints for `linhas`, every produto probing itself and listing `SKU`. */
function nomesDoTick(
  cursorMs: number,
  agoraMs: number,
  linhas: LinhaJanelaEstoqueAmazon[],
): string[] {
  const janela = janelaDoTick({ cursorMs, agoraMs });
  if (janela === null) throw new Error('janela esperada');
  const { produtos } = produtosDaJanela(linhas, janela);
  const ids = produtos.map((p) => p.produtoId);
  return observacoesDaJanela({
    produtos,
    sondasPorProduto: new Map(ids.map((id) => [id, sondasDoProduto(id, null)])),
    skusPorSonda: new Map(ids.map((id) => [id, [SKU]])),
    janela,
  }).map((o) =>
    nomeTarefaEstoque(
      ORIGEM_TAREFA_ESTOQUE_AMAZON.delta,
      CONTA,
      o.sku,
      referenciaDaObservacao(o.updateTime),
    ),
  );
}

describe('★ names: one per OBSERVATION', () => {
  const W1 = Timestamp.fromMillis(T + 2 * SEG);
  const W2 = Timestamp.fromMillis(T + 4 * SEG);

  it('the same observation read twice (the overlap, a re-run tick) ⇒ the same name', () => {
    const l = linha('P', T + SEG, W1);
    const primeiro = nomesDoTick(T, T + 5 * 60 * SEG, [l]);
    const releitura = nomesDoTick(T + 10 * SEG, T + 10 * 60 * SEG, [l]);
    expect(primeiro).toHaveLength(1);
    expect(releitura).toEqual(primeiro);
  });

  it('★ two observations of one SKU ⇒ two names, EVEN with an equal ultimaModificacao (a write whose clock lost the max)', () => {
    // W1 lands (stamp T + 1 s); W2, an increment whose clock read earlier, leaves the stamp
    // at T + 1 s but moves the commit. The overlap re-reads the row: a NEW name.
    const antes = nomesDoTick(T, T + 5 * 60 * SEG, [linha('P', T + SEG, W1)]);
    const depois = nomesDoTick(T, T + 5 * 60 * SEG, [linha('P', T + SEG, W2)]);
    expect(depois).not.toEqual(antes);
  });

  it('a delta name never depends on the tick’s clock, its cursor or ultimaModificacao', () => {
    const base = nomesDoTick(T, T + 5 * 60 * SEG, [linha('P', T + SEG, W1)]);
    expect(nomesDoTick(T - 30 * SEG, T + 9 * 60 * SEG, [linha('P', T + SEG, W1)])).toEqual(base);
    expect(nomesDoTick(T, T + 5 * 60 * SEG, [linha('P', T + 2 * SEG, W1)])).toEqual(base);
  });

  it('a wrapper and its member mapping to one SKU name it by the NEWER of their two commits', () => {
    const janela = janelaDoTick({ cursorMs: T, agoraMs: T + 5 * 60 * SEG });
    if (janela === null) throw new Error('janela esperada');
    const { produtos } = produtosDaJanela(
      [linha('M', T + SEG, W2), linha('W', T + SEG, W1)],
      janela,
    );
    const [obs] = observacoesDaJanela({
      produtos,
      sondasPorProduto: new Map([
        ['M', sondasDoProduto('M', { paiId: 'W' })],
        ['W', sondasDoProduto('W', null)],
      ]),
      skusPorSonda: new Map([
        ['M', []],
        ['W', [SKU]],
      ]),
      janela,
    });
    expect(obs && referenciaDaObservacao(obs.updateTime)).toBe(referenciaDaObservacao(W2));
  });
});

describe('the read-back: one, never a chain, never for a reconcile', () => {
  it('only delta, catch-up and manual patches earn one', () => {
    const O = ORIGEM_TAREFA_ESTOQUE_AMAZON;
    expect(precisaVerificacao(O.delta)).toBe(true);
    expect(precisaVerificacao(O.catchUp)).toBe(true);
    expect(precisaVerificacao(O.manual)).toBe(true);
    expect(precisaVerificacao(O.verificacao)).toBe(false);
    expect(precisaVerificacao(O.reconciliacao)).toBe(false);
  });
});
