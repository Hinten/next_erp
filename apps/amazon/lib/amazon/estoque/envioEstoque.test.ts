/**
 * The stock outcome write-back: the watermark (strictly newer `emMs` wins,
 * equal keeps the stored) and the three outcome shapes, each one the link
 * field's schema accepts.
 */
import { describe, expect, it } from 'vitest';
import {
  type EnvioListingAmazon,
  envioListingAmazonSchema,
} from '@delfrance/integrations-amazon-sp-api';
import {
  type EnvioEstoqueAmazon,
  MAX_PROBLEMAS_ENVIO_ESTOQUE_AMAZON,
  RESULTADO_ENVIO_ESTOQUE_AMAZON,
  VIA_ENVIO_ESTOQUE_AMAZON,
  envioEstoqueAmazonSchema,
} from '@delfrance/schemas';

import { MAX_PROBLEMAS_POR_SKU, type ProblemaSku } from '../feeds/relatorioFeed';
import {
  SEVERIDADE_ERRO_AMAZON,
  STATUS_ENVIO_LISTING_AMAZON,
  decidirGravacaoEnvioEstoque,
  envioDoFeed,
  envioDoPatch,
  envioIncerto,
} from './envioEstoque';

/** ms — a submission instant (2027-01-15T08:00:00Z). */
const T = 1_800_000_000_000;
const FEED = '50001';

const aceito = (emMs: number, quantidade = 3): EnvioEstoqueAmazon =>
  envioDoPatch(
    { status: STATUS_ENVIO_LISTING_AMAZON.aceito, submissionId: 'sub-1' },
    emMs,
    quantidade,
  );

function problema(severity: string, code = 'C1'): ProblemaSku {
  return { code, message: 'texto da Amazon', severity, attributeNames: null, categories: null };
}

describe('★ the watermark: strictly newer wins, equal keeps the stored', () => {
  it('stored emMs 1000 vs new 999 ⇒ keep; vs 1000 ⇒ keep; vs 1001 ⇒ write', () => {
    const armazenado = aceito(1_000);
    expect(decidirGravacaoEnvioEstoque(armazenado, aceito(999))).toBe(false);
    expect(decidirGravacaoEnvioEstoque(armazenado, aceito(1_000))).toBe(false);
    expect(decidirGravacaoEnvioEstoque(armazenado, aceito(1_001))).toBe(true);
  });

  it('nothing stored (null, or the field absent) ⇒ write', () => {
    expect(decidirGravacaoEnvioEstoque(null, aceito(1))).toBe(true);
    expect(decidirGravacaoEnvioEstoque(undefined, aceito(1))).toBe(true);
  });

  it('a feed report (submitted at T) never overwrites the outcome of a patch submitted after it (T + 1)', () => {
    const patchDepois = aceito(T + 1);
    const relatorio = envioDoFeed([problema(SEVERIDADE_ERRO_AMAZON)], FEED, T);
    expect(decidirGravacaoEnvioEstoque(patchDepois, relatorio)).toBe(false);
    // …and the reverse order lands: a patch after the feed replaces the feed's outcome.
    expect(decidirGravacaoEnvioEstoque(relatorio, patchDepois)).toBe(true);
  });

  it('a provisional incerto (T) is overwritten by its retry’s outcome (T + n)', () => {
    const provisorio = envioIncerto(T, 4);
    expect(decidirGravacaoEnvioEstoque(provisorio, aceito(T + 7_000, 3))).toBe(true);
    // NEAR-MISS: a stale answer from BEFORE the provisional entry does not replace it.
    expect(decidirGravacaoEnvioEstoque(provisorio, aceito(T - 1, 3))).toBe(false);
  });

  it('a stored value with no readable emMs is no watermark ⇒ write; a readable one is compared', () => {
    for (const lixo of ['x', 5, [], {}, { emMs: '1000' }, { emMs: -1 }, { emMs: 1.5 }]) {
      expect(decidirGravacaoEnvioEstoque(lixo, aceito(1)), JSON.stringify(lixo)).toBe(true);
    }
    // A stored entry the field's schema would refuse still guards by its emMs.
    expect(decidirGravacaoEnvioEstoque({ emMs: 2_000, via: 'outro' }, aceito(1_999))).toBe(false);
  });
});

describe('the patch outcome', () => {
  it('ACCEPTED ⇒ aceito, with its submission, the quantity sent, and no feed', () => {
    expect(aceito(T, 7)).toEqual({
      via: VIA_ENVIO_ESTOQUE_AMAZON.patch,
      emMs: T,
      quantidade: 7,
      resultado: RESULTADO_ENVIO_ESTOQUE_AMAZON.aceito,
      submissionId: 'sub-1',
      feedId: null,
      problemas: [],
    });
  });

  it('ACCEPTED with an issue ⇒ aceito-com-avisos; INVALID ⇒ recusado, its issues kept', () => {
    const avisos = envioDoPatch(
      { status: 'ACCEPTED', submissionId: 's', issues: [problema('WARNING')] },
      T,
      1,
    );
    expect(avisos.resultado).toBe(RESULTADO_ENVIO_ESTOQUE_AMAZON.aceitoComAvisos);
    const recusado = envioDoPatch(
      { status: 'INVALID', submissionId: 's', issues: [problema('ERROR', 'E9')] },
      T,
      1,
    );
    expect(recusado.resultado).toBe(RESULTADO_ENVIO_ESTOQUE_AMAZON.recusado);
    expect(recusado.problemas).toEqual([
      {
        code: 'E9',
        message: 'texto da Amazon',
        severity: 'ERROR',
        attributeNames: null,
        categories: null,
      },
    ]);
  });

  it('a status that is neither ⇒ incerto: no id, no issue, the quantity kept as a send', () => {
    for (const status of [null, undefined, 'VALID', 'accepted']) {
      const e = envioDoPatch({ status, submissionId: 's', issues: [problema('ERROR')] }, T, 4);
      expect(e).toEqual(envioIncerto(T, 4));
    }
  });

  it('an empty submissionId is none', () => {
    expect(envioDoPatch({ status: 'ACCEPTED', submissionId: '' }, T, 1).submissionId).toBeNull();
  });

  it('the package’s own parsed answer is what it reads (extra keys ignored)', () => {
    const resposta: EnvioListingAmazon = envioListingAmazonSchema.parse({
      sku: 'SKU-1',
      status: 'INVALID',
      submissionId: 'sub-9',
      issues: [{ code: 'E2', message: 'x', severity: 'ERROR', categories: ['INVALID_ATTRIBUTE'] }],
    });
    expect(envioDoPatch(resposta, T, 2)).toMatchObject({
      resultado: RESULTADO_ENVIO_ESTOQUE_AMAZON.recusado,
      submissionId: 'sub-9',
      problemas: [
        {
          code: 'E2',
          message: 'x',
          severity: 'ERROR',
          attributeNames: null,
          categories: ['INVALID_ATTRIBUTE'],
        },
      ],
    });
  });

  it('issues: ERROR first, then the rest in Amazon’s order, at most the cap', () => {
    const issues = [
      ...Array.from({ length: 12 }, (_, i) => problema('WARNING', `W${String(i)}`)),
      problema('ERROR', 'E1'),
    ];
    const e = envioDoPatch({ status: 'INVALID', submissionId: 's', issues }, T, 1);
    expect(e.problemas).toHaveLength(MAX_PROBLEMAS_ENVIO_ESTOQUE_AMAZON);
    expect(e.problemas.map((p) => p.code)).toEqual([
      'E1',
      ...Array.from({ length: 9 }, (_, i) => `W${String(i)}`),
    ]);
  });

  it('a quantity or an instant that is not a non-negative safe integer is refused', () => {
    expect(() => aceito(T, -1)).toThrow();
    expect(() => aceito(1.5)).toThrow();
    expect(() => envioIncerto(T, 2.5)).toThrow();
  });
});

describe('the provisional and the feed outcomes', () => {
  it('envioIncerto: a patch of that quantity, incerto, with no answer', () => {
    expect(envioIncerto(T, 4)).toEqual({
      via: VIA_ENVIO_ESTOQUE_AMAZON.patch,
      emMs: T,
      quantidade: 4,
      resultado: RESULTADO_ENVIO_ESTOQUE_AMAZON.incerto,
      submissionId: null,
      feedId: null,
      problemas: [],
    });
  });

  it('★ envioDoFeed carries quantidade: null, the feed, and recusado when a problem is an ERROR', () => {
    const e = envioDoFeed([problema('WARNING'), problema('ERROR')], FEED, T);
    expect(e).toMatchObject({
      via: VIA_ENVIO_ESTOQUE_AMAZON.feed,
      emMs: T,
      quantidade: null,
      resultado: RESULTADO_ENVIO_ESTOQUE_AMAZON.recusado,
      submissionId: null,
      feedId: FEED,
    });
    expect(e.problemas.map((p) => p.severity)).toEqual(['ERROR', 'WARNING']);
  });

  it('warnings only ⇒ aceito-com-avisos; none ⇒ aceito', () => {
    expect(envioDoFeed([problema('WARNING')], FEED, T).resultado).toBe(
      RESULTADO_ENVIO_ESTOQUE_AMAZON.aceitoComAvisos,
    );
    expect(envioDoFeed([], FEED, T).resultado).toBe(RESULTADO_ENVIO_ESTOQUE_AMAZON.aceito);
  });

  it('NEAR-MISS: the severity is compared EXACTLY — `error` or `Error ` is not an ERROR: not refused, not moved first', () => {
    for (const quase of ['error', 'Error', 'ERROR ']) {
      const e = envioDoFeed([problema('WARNING', 'W0'), problema(quase, 'Q')], FEED, T);
      expect(e.resultado, quase).toBe(RESULTADO_ENVIO_ESTOQUE_AMAZON.aceitoComAvisos);
      expect(
        e.problemas.map((p) => p.code),
        quase,
      ).toEqual(['W0', 'Q']);
    }
    expect(
      envioDoFeed([problema('WARNING', 'W0'), problema('ERROR', 'E')], FEED, T).problemas.map(
        (p) => p.code,
      ),
    ).toEqual(['E', 'W0']);
  });

  it('a feed id outside the record’s grammar is refused', () => {
    expect(() => envioDoFeed([], 'feed-1', T)).toThrow();
  });

  it('the report reducer’s per-SKU cap is the link field’s cap', () => {
    expect(MAX_PROBLEMAS_POR_SKU).toBe(MAX_PROBLEMAS_ENVIO_ESTOQUE_AMAZON);
  });

  it('every shape built here is one the link field’s schema accepts unchanged', () => {
    for (const e of [
      aceito(T),
      envioIncerto(T, 0),
      envioDoFeed([problema('ERROR')], FEED, T),
      envioDoPatch({ status: 'INVALID', submissionId: null, issues: [problema('ERROR')] }, T, 2),
    ]) {
      expect(envioEstoqueAmazonSchema.parse(e)).toEqual(e);
    }
  });
});
