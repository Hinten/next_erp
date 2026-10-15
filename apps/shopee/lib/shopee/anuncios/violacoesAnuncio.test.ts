import { describe, expect, it } from 'vitest';

import { shopeeViolacaoSchema } from '@delfrance/schemas';

import {
  detalhesDeDeboost,
  detalhesDeStatus,
  grafiaDeboostUsada,
  violacoesDeDetalhes,
} from './violacoesAnuncio';

/* ---------------------------------- fixtures ------------------------------ */

const ITEM_ID = 2500139861;

/** 2026-09-10 12:22:34Z, in Shopee's SECONDS. */
const PRAZO_S = 1_788_973_354;
const PRAZO_MS = 1_788_973_354_000;
/** One second later — the near-miss the seconds reader must NOT collapse. */
const PRAZO_S_SEGUINTE = 1_788_973_355;
const PRAZO_MS_SEGUINTE = 1_788_973_355_000;

function linhaDeStatus(parcial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    violation_type: 'Prohibited Listing',
    violation_reason: 'motivo da Shopee',
    suggestion: 'sugestão da Shopee',
    fix_deadline_time: PRAZO_S,
    update_time: PRAZO_S,
    ...parcial,
  };
}

/* -------------------------------------------------------------------------- */
/*                     (1) the two sides, and what separates them              */
/* -------------------------------------------------------------------------- */

describe('violacoesDeDetalhes', () => {
  it('marca kind status/deboost e só o deboost carrega suggested_category', () => {
    const categoria = [{ category_id: 100017, category_name: 'Camisetas' }];

    const { violacoes, descartadas } = violacoesDeDetalhes(
      [linhaDeStatus({ suggested_category: categoria })],
      [
        linhaDeStatus({
          violation_type: 'Other Listing Improvement',
          suggested_category: categoria,
        }),
      ],
    );

    expect(descartadas).toBe(0);
    expect(violacoes).toHaveLength(2);
    expect(violacoes[0]?.kind).toBe('status');
    expect(violacoes[1]?.kind).toBe('deboost');
    // A status row that CARRIED one still answers null — the page declares the
    // field on the deboost side alone.
    expect(violacoes[0]?.suggested_category).toBeNull();
    expect(violacoes[1]?.suggested_category).toEqual([
      { category_id: 100017, category_name: 'Camisetas' },
    ]);
  });

  it('o lado status vem primeiro e a ordem do fio é preservada dentro de cada lado', () => {
    const { violacoes } = violacoesDeDetalhes(
      [linhaDeStatus({ violation_type: 'S1' }), linhaDeStatus({ violation_type: 'S2' })],
      [linhaDeStatus({ violation_type: 'D1' })],
    );

    expect(violacoes.map((v) => v.violation_type)).toEqual(['S1', 'S2', 'D1']);
    expect(violacoes.map((v) => v.kind)).toEqual(['status', 'status', 'deboost']);
  });

  /* ------------------------------ units + legacy --------------------------- */

  it('fix_deadline_time vira MILLIS; days_to_fix continua null — nada é derivado', () => {
    const { violacoes } = violacoesDeDetalhes([linhaDeStatus()], []);

    expect(violacoes[0]?.fix_deadline_time).toBe(PRAZO_MS);
    expect(violacoes[0]?.update_time).toBe(PRAZO_MS);
    // ⚠️ A derivação seria com relógio, com perda e NÃO idempotente: o mesmo
    // push repetido um dia depois daria outro número.
    expect(violacoes[0]?.days_to_fix).toBeNull();
  });

  it('um fix_deadline_time ausente ou 0 é null, nunca 0 nem agora', () => {
    const { violacoes, descartadas } = violacoesDeDetalhes(
      [
        linhaDeStatus({ fix_deadline_time: 0, update_time: 0 }),
        linhaDeStatus({ fix_deadline_time: undefined, update_time: undefined }),
        { violation_type: 'sem prazo nenhum' },
      ],
      [],
    );

    expect(descartadas).toBe(0);
    for (const violacao of violacoes) {
      expect(violacao.fix_deadline_time).toBeNull();
      expect(violacao.update_time).toBeNull();
    }
  });

  it('⚠️ PAR: 1788973354, "1788973354" e um piso pré-2020 — os dois primeiros são o MESMO instante', () => {
    const { violacoes } = violacoesDeDetalhes(
      [
        linhaDeStatus({ fix_deadline_time: PRAZO_S }),
        linhaDeStatus({ fix_deadline_time: String(PRAZO_S) }),
      ],
      [],
    );

    expect(violacoes[0]?.fix_deadline_time).toBe(PRAZO_MS);
    expect(violacoes[1]?.fix_deadline_time).toBe(PRAZO_MS);
  });

  it('⚠️ NEAR-MISS: um segundo adiante NÃO colapsa, e um valor fracionário ou ilegível é ausência', () => {
    const { violacoes } = violacoesDeDetalhes(
      [
        linhaDeStatus({ fix_deadline_time: PRAZO_S_SEGUINTE }),
        linhaDeStatus({ fix_deadline_time: PRAZO_S + 0.5 }),
        linhaDeStatus({ fix_deadline_time: 'ontem' }),
        // Pré-2020 (2019-12-31): o piso da Shopee trata como ausência.
        linhaDeStatus({ fix_deadline_time: 1_577_750_400 }),
      ],
      [],
    );

    expect(violacoes[0]?.fix_deadline_time).toBe(PRAZO_MS_SEGUINTE);
    expect(violacoes[0]?.fix_deadline_time).not.toBe(PRAZO_MS);
    expect(violacoes[1]?.fix_deadline_time).toBeNull();
    expect(violacoes[2]?.fix_deadline_time).toBeNull();
    expect(violacoes[3]?.fix_deadline_time).toBeNull();
  });

  /* --------------------------------- prose --------------------------------- */

  it('⚠️ PAR: "", "   " e a chave ausente são a MESMA ausência', () => {
    const { violacoes } = violacoesDeDetalhes(
      [linhaDeStatus({ violation_type: '', suggestion: '   ' }), { fix_deadline_time: PRAZO_S }],
      [],
    );

    expect(violacoes[0]?.violation_type).toBeNull();
    expect(violacoes[0]?.suggestion).toBeNull();
    expect(violacoes[1]?.violation_type).toBeNull();
    expect(violacoes[1]?.suggestion).toBeNull();
  });

  it('⚠️ NEAR-MISS: "-", "0" e " Spam " são VALORES, copiados verbatim', () => {
    const { violacoes } = violacoesDeDetalhes(
      [linhaDeStatus({ violation_type: '-', violation_reason: '0', suggestion: ' Spam ' })],
      [],
    );

    expect(violacoes[0]?.violation_type).toBe('-');
    expect(violacoes[0]?.violation_reason).toBe('0');
    expect(violacoes[0]?.suggestion).toBe(' Spam ');
  });

  /* ------------------------------- tolerância ------------------------------ */

  it('uma linha ilegível é descartada e contada, nunca adivinhada', () => {
    const { violacoes, descartadas } = violacoesDeDetalhes(
      [linhaDeStatus(), null, 'texto', 42, [], true],
      [undefined, linhaDeStatus({ violation_type: 'D' })],
    );

    expect(descartadas).toBe(6);
    expect(violacoes).toHaveLength(2);
    expect(violacoes.map((v) => v.kind)).toEqual(['status', 'deboost']);
  });

  it('uma linha vazia é um REGISTRO com tudo null, não um descarte', () => {
    const { violacoes, descartadas } = violacoesDeDetalhes([{}], []);

    expect(descartadas).toBe(0);
    expect(violacoes).toEqual([
      {
        violation_type: null,
        violation_reason: null,
        suggestion: null,
        fix_deadline_time: null,
        update_time: null,
        suggested_category: null,
        kind: 'status',
        days_to_fix: null,
      },
    ]);
  });

  it('uma chave que a Shopee inventar NÃO é copiada para o documento', () => {
    const { violacoes } = violacoesDeDetalhes(
      [linhaDeStatus({ buyer_note: 'prosa não enumerada', violation_id: 9 })],
      [],
    );

    expect(violacoes[0]).not.toHaveProperty('buyer_note');
    expect(violacoes[0]).not.toHaveProperty('violation_id');
    expect(Object.keys(violacoes[0] ?? {}).sort()).toEqual([
      'days_to_fix',
      'fix_deadline_time',
      'kind',
      'suggested_category',
      'suggestion',
      'update_time',
      'violation_reason',
      'violation_type',
    ]);
  });

  it('uma suggested_category ilegível não custa as irmãs nem conta como descarte', () => {
    const { violacoes, descartadas } = violacoesDeDetalhes(
      [],
      [
        linhaDeStatus({
          suggested_category: [{ category_id: 100017, category_name: 'Camisetas' }, 'lixo', null],
        }),
        linhaDeStatus({ suggested_category: 'nem array é' }),
      ],
    );

    expect(descartadas).toBe(0);
    expect(violacoes[0]?.suggested_category).toEqual([
      { category_id: 100017, category_name: 'Camisetas' },
    ]);
    expect(violacoes[1]?.suggested_category).toBeNull();
  });

  /* ------------------------ o resultado é gravável ------------------------- */

  it('toda linha do resultado passa por shopeeViolacaoSchema', () => {
    const { violacoes } = violacoesDeDetalhes(
      [linhaDeStatus(), {}, linhaDeStatus({ fix_deadline_time: 0, violation_type: '' })],
      [
        linhaDeStatus({
          suggested_category: [{ category_id: 100017, category_name: 'Camisetas' }],
        }),
      ],
    );

    expect(violacoes).toHaveLength(4);
    for (const violacao of violacoes) {
      expect(shopeeViolacaoSchema.parse(violacao)).toEqual(violacao);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*                        (2) the two deboost spellings                        */
/* -------------------------------------------------------------------------- */

describe('detalhesDeDeboost', () => {
  it('aceita as DUAS grafias deboost_details e deboosted_details', () => {
    const linha = linhaDeStatus();

    expect(detalhesDeDeboost({ item_id: ITEM_ID, deboost_details: [linha] })).toEqual([linha]);
    expect(detalhesDeDeboost({ item_id: ITEM_ID, deboosted_details: [linha] })).toEqual([linha]);
    expect(grafiaDeboostUsada({ deboost_details: [linha] })).toBe('deboost_details');
    expect(grafiaDeboostUsada({ deboosted_details: [linha] })).toBe('deboosted_details');
  });

  it('⚠️ NEAR-MISS: deboost_detail no singular NÃO casa', () => {
    const corpo = { item_id: ITEM_ID, deboost_detail: [linhaDeStatus()] };

    expect(detalhesDeDeboost(corpo)).toEqual([]);
    expect(grafiaDeboostUsada(corpo)).toBeNull();
  });

  it('nenhuma das grafias, ou uma grafia sem linhas, responde [] e grafia null', () => {
    expect(detalhesDeDeboost({ item_id: ITEM_ID })).toEqual([]);
    expect(detalhesDeDeboost({ deboost_details: null, deboosted_details: null })).toEqual([]);
    expect(detalhesDeDeboost({ deboost_details: [], deboosted_details: [] })).toEqual([]);
    expect(detalhesDeDeboost({ deboost_details: 'nem array' })).toEqual([]);
    expect(grafiaDeboostUsada({ deboost_details: [], deboosted_details: null })).toBeNull();
  });

  it('uma grafia VAZIA não esconde as linhas da outra — a tabela só ganha quando carrega linha', () => {
    const daTabela = linhaDeStatus({ violation_type: 'tabela' });
    const daAmostra = linhaDeStatus({ violation_type: 'amostra' });

    // O parse do get_item_violation_info traz SEMPRE as duas chaves (default null).
    expect(detalhesDeDeboost({ deboost_details: [], deboosted_details: [daAmostra] })).toEqual([
      daAmostra,
    ]);
    expect(grafiaDeboostUsada({ deboost_details: [], deboosted_details: [daAmostra] })).toBe(
      'deboosted_details',
    );

    // Com as duas carregando linha, a grafia da TABELA vence — e o leitor e a
    // linha de log respondem a mesma coisa.
    const ambas = { deboost_details: [daTabela], deboosted_details: [daAmostra] };
    expect(detalhesDeDeboost(ambas)).toEqual([daTabela]);
    expect(grafiaDeboostUsada(ambas)).toBe('deboost_details');
  });
});

describe('detalhesDeStatus', () => {
  it('lê item_status_details, e qualquer outra coisa é []', () => {
    const linha = linhaDeStatus();

    expect(detalhesDeStatus({ item_status_details: [linha] })).toEqual([linha]);
    expect(detalhesDeStatus({ item_status_details: null })).toEqual([]);
    expect(detalhesDeStatus({ item_status_details: 'nem array' })).toEqual([]);
    expect(detalhesDeStatus({ item_id: ITEM_ID })).toEqual([]);
  });

  it('as duas leituras juntas montam a chamada do handler', () => {
    const corpo: Record<string, unknown> = {
      item_id: ITEM_ID,
      item_status: 'BANNED',
      item_status_details: [linhaDeStatus()],
      deboosted_details: [linhaDeStatus({ violation_type: 'Other Listing Improvement' })],
    };

    const { violacoes, descartadas } = violacoesDeDetalhes(
      detalhesDeStatus(corpo),
      detalhesDeDeboost(corpo),
    );

    expect(descartadas).toBe(0);
    expect(violacoes.map((v) => v.kind)).toEqual(['status', 'deboost']);
  });
});
