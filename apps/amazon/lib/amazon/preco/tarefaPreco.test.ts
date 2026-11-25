/**
 * The price push's jobs-queue contract: the two strict payloads (no price
 * field, ever), their coherence, and the three names.
 */
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@delfrance/data/admin';

import {
  MAX_UNIDADES_SKU_TAREFA_ESTOQUE,
  REFERENCIA_SUBMISSAO_REGEX,
} from '../estoque/tarefaEstoque';
import { TIPO_TAREFA_LOTE_AMAZON, VERSAO_TAREFA_LOTE_AMAZON } from '../feeds/tarefaLote';
import {
  MAX_UNIDADES_SKU_TAREFA_PRECO,
  ORIGEM_TAREFA_PRECO_AMAZON,
  REFERENCIA_SUBMISSAO_PRECO_REGEX,
  TIPO_TAREFA_PRECO_AMAZON,
  type TarefaPrecoSkuAmazon,
  nomeDaTarefaPrecoAmazon,
  nomePaginaPrecoAmazon,
  nomeRetomadaPrecoAmazon,
  nomeTarefaPrecoAmazon,
  origemTarefaPrecoAmazonSchema,
  tarefaPaginaPrecoAmazonSchema,
  tarefaPrecoSkuAmazonSchema,
} from './tarefaPreco';

const CONTA = 'conta-1';
const RUN = 'run_01';

const manual = (o: Partial<TarefaPrecoSkuAmazon> = {}): TarefaPrecoSkuAmazon => ({
  v: VERSAO_TAREFA_LOTE_AMAZON,
  tipo: TIPO_TAREFA_PRECO_AMAZON.sku,
  contaId: CONTA,
  sku: 'SKU-1',
  origem: ORIGEM_TAREFA_PRECO_AMAZON.manual,
  referencia: 'req-123',
  parte: null,
  baixarPreco: false,
  solicitadoEmMs: 1_800_000_000_000,
  codigosAntes: [],
  ...o,
});
const execucao = (o: Partial<TarefaPrecoSkuAmazon> = {}) =>
  manual({ origem: ORIGEM_TAREFA_PRECO_AMAZON.execucao, referencia: RUN, parte: 7, ...o });
const verificacao = (o: Partial<TarefaPrecoSkuAmazon> = {}) =>
  manual({
    origem: ORIGEM_TAREFA_PRECO_AMAZON.verificacao,
    referencia: 'amzn-sub.1',
    codigosAntes: ['19037'],
    ...o,
  });
const ok = (t: unknown) => tarefaPrecoSkuAmazonSchema.safeParse(t).success;

describe('★ preco-sku: identities only, never a price', () => {
  it('the three origens parse, each in its shape', () => {
    expect(ok(manual())).toBe(true);
    expect(ok(execucao())).toBe(true);
    expect(ok(verificacao())).toBe(true);
    expect(origemTarefaPrecoAmazonSchema.options).toEqual(['manual', 'execucao', 'verificacao']);
  });

  it('★ STRICT: a `preco` key (or a faixa, or any price-shaped field) is refused', () => {
    for (const extra of [{ preco: 10 }, { faixa: { base: 10 } }, { base: 10 }, { oferta: null }]) {
      expect(ok({ ...manual(), ...extra }), Object.keys(extra)[0]).toBe(false);
    }
    // The fields are exactly these: none names a price.
    expect(Object.keys(tarefaPrecoSkuAmazonSchema.shape).sort()).toEqual(
      [
        'v',
        'tipo',
        'contaId',
        'sku',
        'origem',
        'referencia',
        'parte',
        'baixarPreco',
        'solicitadoEmMs',
        'codigosAntes',
      ].sort(),
    );
  });

  it('★ `parte` exactly for execucao: required there (NEAR-MISS: null refused), refused elsewhere; at most part 999', () => {
    expect(ok(execucao({ parte: null }))).toBe(false);
    expect(ok(manual({ parte: 0 }))).toBe(false);
    expect(ok(verificacao({ parte: 3 }))).toBe(false);
    expect(ok(execucao({ parte: 0 }))).toBe(true);
    expect(ok(execucao({ parte: 999 }))).toBe(true);
    expect(ok(execucao({ parte: 1_000 }))).toBe(false);
    expect(ok(execucao({ parte: 1.5 }))).toBe(false);
  });

  it('`codigosAntes` only for a verification, at most 10 codes under the grammar', () => {
    expect(ok(manual({ codigosAntes: ['19037'] }))).toBe(false);
    expect(ok(execucao({ codigosAntes: ['19037'] }))).toBe(false);
    expect(ok(verificacao({ codigosAntes: [] }))).toBe(true);
    const dez = Array.from({ length: 10 }, (_v, i) => String(19_000 + i));
    expect(ok(verificacao({ codigosAntes: dez }))).toBe(true);
    expect(ok(verificacao({ codigosAntes: [...dez, '1'] }))).toBe(false);
    expect(ok(verificacao({ codigosAntes: ['19 037'] }))).toBe(false);
  });

  it('each origem’s referencia has its grammar: a submissionId never holds `:` (a name field)', () => {
    expect(ok(verificacao({ referencia: 'a:b' }))).toBe(false);
    expect(ok(manual({ referencia: 'a b' }))).toBe(false);
    expect(ok(execucao({ referencia: '' }))).toBe(false);
    expect(ok(verificacao({ referencia: 'amzn1.sub-OK' }))).toBe(true);
  });

  it('★ a request’s and a run’s referencia are run ids (no `.`), a verification’s a submissionId (NEAR-MISS: `.` refused for manual and execucao, kept for verificacao)', () => {
    expect(ok(manual({ referencia: 'req.1' }))).toBe(false);
    expect(ok(execucao({ referencia: 'run.1' }))).toBe(false);
    expect(ok(verificacao({ referencia: 'sub.1' }))).toBe(true);
    expect(ok(manual({ referencia: 'req_1-a' }))).toBe(true);
    expect(ok(execucao({ referencia: 'run_1-a' }))).toBe(true);
  });

  it('the consent is a boolean and the clock a ms integer; the SKU fits a task, the stock task’s own bound', () => {
    expect(ok(manual({ baixarPreco: 'true' as unknown as boolean }))).toBe(false);
    expect(ok(manual({ solicitadoEmMs: -1 }))).toBe(false);
    expect(ok(manual({ solicitadoEmMs: 1.5 }))).toBe(false);
    expect(ok(manual({ sku: '' }))).toBe(false);
    expect(ok(manual({ sku: 'x'.repeat(MAX_UNIDADES_SKU_TAREFA_PRECO) }))).toBe(true);
    expect(ok(manual({ sku: 'x'.repeat(MAX_UNIDADES_SKU_TAREFA_PRECO + 1) }))).toBe(false);
    expect(MAX_UNIDADES_SKU_TAREFA_PRECO).toBe(MAX_UNIDADES_SKU_TAREFA_ESTOQUE);
    expect(REFERENCIA_SUBMISSAO_PRECO_REGEX.source).toBe(REFERENCIA_SUBMISSAO_REGEX.source);
    expect(REFERENCIA_SUBMISSAO_PRECO_REGEX.flags).toBe(REFERENCIA_SUBMISSAO_REGEX.flags);
  });

  it('a jobs-queue payload: the queue’s version, and a tipo no other jobs task uses', () => {
    expect(ok(manual({ v: 2 as unknown as 1 }))).toBe(false);
    expect(Object.values(TIPO_TAREFA_LOTE_AMAZON)).not.toContain(TIPO_TAREFA_PRECO_AMAZON.sku);
    expect(Object.values(TIPO_TAREFA_LOTE_AMAZON)).not.toContain(TIPO_TAREFA_PRECO_AMAZON.pagina);
  });
});

describe('preco-pagina', () => {
  const pagina = {
    v: 1,
    tipo: TIPO_TAREFA_PRECO_AMAZON.pagina,
    contaId: CONTA,
    execucaoId: RUN,
    pagina: 3,
  };

  it('the conta, the run and the page, strictly', () => {
    expect(tarefaPaginaPrecoAmazonSchema.safeParse(pagina).success).toBe(true);
    expect(tarefaPaginaPrecoAmazonSchema.safeParse({ ...pagina, parte: 1 }).success).toBe(false);
    expect(tarefaPaginaPrecoAmazonSchema.safeParse({ ...pagina, pagina: -1 }).success).toBe(false);
    expect(
      tarefaPaginaPrecoAmazonSchema.safeParse({ ...pagina, tipo: TIPO_TAREFA_PRECO_AMAZON.sku })
        .success,
    ).toBe(false);
  });
});

describe('★ the names', () => {
  it('★ a task’s name is sha256Hex(preco:<origem>:<conta>:<referencia>:<sku>), and moves with the origem and the referencia', () => {
    expect(nomeTarefaPrecoAmazon('manual', CONTA, 'req-123', 'SKU-1')).toBe(
      sha256Hex('preco:manual:conta-1:req-123:SKU-1'),
    );
    const base = nomeDaTarefaPrecoAmazon(manual());
    expect(base).toBe(nomeTarefaPrecoAmazon('manual', CONTA, 'req-123', 'SKU-1'));
    expect(nomeDaTarefaPrecoAmazon(manual({ referencia: 'req-124' }))).not.toBe(base);
    expect(
      nomeDaTarefaPrecoAmazon(manual({ origem: ORIGEM_TAREFA_PRECO_AMAZON.execucao, parte: 0 })),
    ).not.toBe(base);
    // NEAR-MISS: the consent, the clock and the part are not in the name (one task per SKU and reference).
    expect(nomeDaTarefaPrecoAmazon(manual({ baixarPreco: true, solicitadoEmMs: 1 }))).toBe(base);
    expect(nomeDaTarefaPrecoAmazon(execucao({ parte: 1 }))).toBe(
      nomeDaTarefaPrecoAmazon(execucao({ parte: 2 })),
    );
  });

  it('a SKU holding `:` cannot shift a field: it is the last one, and no other field may hold `:`', () => {
    expect(nomeTarefaPrecoAmazon('manual', CONTA, 'r', 'a:b')).toBe(
      sha256Hex('preco:manual:conta-1:r:a:b'),
    );
    // The one preimage it could collide with is refused at its referencia.
    expect(() => nomeTarefaPrecoAmazon('manual', CONTA, 'r:a', 'b')).toThrow(/referencia/);
  });

  it('refuses a field outside its grammar, naming the field only', () => {
    expect(() => nomeTarefaPrecoAmazon('outra' as 'manual', CONTA, 'r', 'S')).toThrow(/origem/);
    expect(() => nomeTarefaPrecoAmazon('manual', 'conta:1', 'r', 'S')).toThrow(/contaId/);
    expect(() => nomeTarefaPrecoAmazon('verificacao', CONTA, 'a:b', 'S')).toThrow(/referencia/);
    expect(() => nomeTarefaPrecoAmazon('manual', CONTA, 'r', '')).toThrow(/sku/);
    expect(() => nomeTarefaPrecoAmazon('manual', CONTA, 'r', 'x'.repeat(81))).toThrow(/sku/);
  });

  it('a page’s name is (conta, run, page); the re-kick’s adds the stall’s progress stamp', () => {
    expect(nomePaginaPrecoAmazon(CONTA, RUN, 3)).toBe(sha256Hex('preco-pagina:conta-1:run_01:3'));
    expect(nomePaginaPrecoAmazon(CONTA, RUN, 4)).not.toBe(nomePaginaPrecoAmazon(CONTA, RUN, 3));
    expect(nomeRetomadaPrecoAmazon(CONTA, RUN, 3, 1_000)).toBe(
      sha256Hex('preco-retomada:conta-1:run_01:3:1000'),
    );
    expect(nomeRetomadaPrecoAmazon(CONTA, RUN, 3, 1_001)).not.toBe(
      nomeRetomadaPrecoAmazon(CONTA, RUN, 3, 1_000),
    );
    expect(nomeRetomadaPrecoAmazon(CONTA, RUN, 3, 1_000)).not.toBe(
      nomePaginaPrecoAmazon(CONTA, RUN, 3),
    );
    expect(() => nomePaginaPrecoAmazon(CONTA, RUN, -1)).toThrow(/pagina/);
    expect(() => nomeRetomadaPrecoAmazon(CONTA, RUN, 0, 1.5)).toThrow(/progressoEmMs/);
    expect(() => nomePaginaPrecoAmazon(CONTA, 'run:1', 0)).toThrow(/execucaoId/);
  });
});
