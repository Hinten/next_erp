import { describe, expect, it } from 'vitest';

import * as schemas from '@delfrance/schemas';

import {
  type VarLinkShopeeCru,
  idDoRef,
  modelosUtilizaveis,
  varLinksDoAnuncio,
} from './vinculosShopee';

// Folds (1) and (2) — `idDoRef` and `varLinksDoAnuncio` — MOVED to
// `@delfrance/schemas` with their suite (`produto/collection/vinculosShopee.test.ts`,
// step 21, #1529); this module re-exports them, and fold (3) stays here.

/* -------------------------------------------------------------------------- */
/*   Fixtures — invented ids only. Never a real partner, shop or credential.   */
/* -------------------------------------------------------------------------- */

const ANCORA = 'prod-ancora';
const LINK_A = 'link-a';
const MODEL_A = 2000458802;
const MODEL_B = 2000458803;

function refLink(produtoId: string, linkDocId: string): string {
  return `documents/produtos/${produtoId}/prodshopee/${linkDocId}`;
}

function varLink(extra: VarLinkShopeeCru = {}): VarLinkShopeeCru {
  return {
    produtoShopeeOuterRef: refLink(ANCORA, LINK_A),
    model_id: MODEL_A,
    varLinkDocId: 'var-a',
    ...extra,
  };
}

/* -------------------------------------------------------------------------- */
/*                 the moved folds still resolve from here (L11)               */
/* -------------------------------------------------------------------------- */

describe('folds (1) e (2) — reexportados de @delfrance/schemas', () => {
  it('são as MESMAS funções, não cópias — e respondem como antes', () => {
    expect(idDoRef).toBe(schemas.idDoRef);
    expect(varLinksDoAnuncio).toBe(schemas.varLinksDoAnuncio);
    expect(idDoRef('documents/integracoes/int-1')).toBe('int-1');
    expect(
      varLinksDoAnuncio([{ produtoId: 'filho-1', varLinks: [varLink()] }], LINK_A).map(
        (a) => a.filho.produtoId,
      ),
    ).toEqual(['filho-1']);
  });
});

/* -------------------------------------------------------------------------- */
/*          fold (3) — modelosUtilizaveis: which model ids are usable          */
/* -------------------------------------------------------------------------- */

function atribuido(
  produtoId: string,
  extra: VarLinkShopeeCru = {},
): { readonly filho: { readonly produtoId: string }; readonly varLink: VarLinkShopeeCru } {
  return { filho: { produtoId }, varLink: varLink(extra) };
}

describe('modelosUtilizaveis — fold (3): o que é "sem modelo utilizável"', () => {
  it('PAR — `0`, ausente, texto numérico e fracionário são TODOS "sem modelo utilizável"', () => {
    const candidatos = modelosUtilizaveis([
      atribuido('f-0', { model_id: 0 }),
      atribuido('f-ausente', { model_id: undefined }),
      atribuido('f-texto', { model_id: String(MODEL_A) }),
      atribuido('f-fracao', { model_id: 12.5 }),
      atribuido('f-nan', { model_id: Number.NaN }),
      atribuido('f-negativo', { model_id: -MODEL_A }),
    ]);

    expect(candidatos).toEqual([]);
  });

  it('QUASE-IGUAL — dois ids que diferem de UM dígito continuam DOIS modelos', () => {
    const candidatos = modelosUtilizaveis([
      atribuido('filho-1', { model_id: MODEL_A, varLinkDocId: 'var-a' }),
      atribuido('filho-2', { model_id: MODEL_A + 1, varLinkDocId: 'var-b' }),
    ]);

    expect(candidatos).toEqual([
      { modelId: MODEL_A, produtoId: 'filho-1', varLinkDocId: 'var-a' },
      { modelId: MODEL_A + 1, produtoId: 'filho-2', varLinkDocId: 'var-b' },
    ]);
  });

  it('PAR — o MESMO `model_id` duas vezes colapsa num único candidato: o PRIMEIRO', () => {
    const candidatos = modelosUtilizaveis([
      atribuido('filho-1', { model_id: MODEL_A, varLinkDocId: 'var-a' }),
      atribuido('filho-2', { model_id: MODEL_A, varLinkDocId: 'var-dup' }),
    ]);

    expect(candidatos).toEqual([{ modelId: MODEL_A, produtoId: 'filho-1', varLinkDocId: 'var-a' }]);
  });

  it('⚠️ um modelo marcado ausente sai ANTES da deduplicação — o vivo com o mesmo id fica', () => {
    const candidatos = modelosUtilizaveis([
      atribuido('filho-morto', { model_id: MODEL_A, modeloAusenteEm: 1_760_000_000_000 }),
      atribuido('filho-vivo', { model_id: MODEL_A, varLinkDocId: 'var-vivo' }),
    ]);

    expect(candidatos).toEqual([
      { modelId: MODEL_A, produtoId: 'filho-vivo', varLinkDocId: 'var-vivo' },
    ]);
  });

  it('QUASE-IGUAL — qualquer leitura NÃO-nula de `modeloAusenteEm` descarta; `null` não', () => {
    const candidatos = modelosUtilizaveis([
      atribuido('lixo', { model_id: MODEL_A, modeloAusenteEm: 'lixo' }),
      atribuido('nulo', { model_id: MODEL_B, modeloAusenteEm: null }),
    ]);

    expect(candidatos.map((c) => c.produtoId)).toEqual(['nulo']);
  });

  it('um `varLinkDocId` vazio ou não-texto vira null, e o modelo continua utilizável', () => {
    const candidatos = modelosUtilizaveis([
      atribuido('filho-1', { model_id: MODEL_A, varLinkDocId: '' }),
      atribuido('filho-2', { model_id: MODEL_B, varLinkDocId: 3 }),
    ]);

    expect(candidatos.map((c) => c.varLinkDocId)).toEqual([null, null]);
  });

  it('a ordem de descoberta é preservada', () => {
    const candidatos = modelosUtilizaveis([
      atribuido('filho-2', { model_id: MODEL_B }),
      atribuido('filho-1', { model_id: MODEL_A }),
    ]);

    expect(candidatos.map((c) => c.modelId)).toEqual([MODEL_B, MODEL_A]);
  });
});
