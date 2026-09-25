import { describe, expect, it } from 'vitest';

import {
  type VarLinkShopeeCru,
  idDoRef,
  modelosUtilizaveis,
  varLinksDoAnuncio,
} from './vinculosShopee';

/* -------------------------------------------------------------------------- */
/*   Fixtures — invented ids only. Never a real partner, shop or credential.   */
/* -------------------------------------------------------------------------- */

const INTEGRACAO = 'int-1';
const ANCORA = 'prod-ancora';
const LINK_A = 'link-a';
const LINK_B = 'link-b';
const MODEL_A = 2000458802;
const MODEL_B = 2000458803;

function refLink(produtoId: string, linkDocId: string): string {
  return `documents/produtos/${produtoId}/prodshopee/${linkDocId}`;
}

function refLinkNua(produtoId: string, linkDocId: string): string {
  return `produtos/${produtoId}/prodshopee/${linkDocId}`;
}

function varLink(extra: VarLinkShopeeCru = {}): VarLinkShopeeCru {
  return {
    produtoShopeeOuterRef: refLink(ANCORA, LINK_A),
    model_id: MODEL_A,
    varLinkDocId: 'var-a',
    ...extra,
  };
}

/** The STOCK family's child shape: a member plus its model links. */
interface FilhoDeEstoque {
  readonly produtoId: string;
  readonly ehKit: boolean;
  readonly varLinks: readonly VarLinkShopeeCru[];
}

/** The PRICE family's child shape: a different extra field, the same two keys. */
interface FilhoDePrecoFake {
  readonly produtoId: string;
  readonly precos: unknown;
  readonly varLinks: readonly VarLinkShopeeCru[];
}

/* -------------------------------------------------------------------------- */
/*                 fold (1) — idDoRef: the two ref encodings                   */
/* -------------------------------------------------------------------------- */

describe('idDoRef — fold (1): a que CONTA o vínculo pertence', () => {
  it('PAR — `documents/integracoes/<id>` e o `integracoes/<id>` nu são o MESMO id', () => {
    expect(idDoRef(`documents/integracoes/${INTEGRACAO}`)).toBe(INTEGRACAO);
    expect(idDoRef(`integracoes/${INTEGRACAO}`)).toBe(INTEGRACAO);
  });

  it('QUASE-IGUAL — outro id de integração continua OUTRO id (int-1 ≠ int-12)', () => {
    expect(idDoRef('documents/integracoes/int-12')).toBe('int-12');
    expect(idDoRef('documents/integracoes/int-12')).not.toBe(INTEGRACAO);
  });

  it('⚠️ o alargamento REGISTRADO: só o último segmento conta, a coleção não', () => {
    // Pinned so a future "tightening" is a decision, not an accident: the fold
    // accepts a legacy encoding by comparing the id alone.
    expect(idDoRef(`documents/outraColecao/${INTEGRACAO}`)).toBe(INTEGRACAO);
  });

  it('ilegível ⇒ null: ausente, vazio, não-texto e só barras', () => {
    expect(idDoRef(undefined)).toBeNull();
    expect(idDoRef(null)).toBeNull();
    expect(idDoRef('')).toBeNull();
    expect(idDoRef(42)).toBeNull();
    expect(idDoRef({ id: INTEGRACAO })).toBeNull();
    expect(idDoRef('///')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*            fold (2) — varLinksDoAnuncio: by LINK, never by produto          */
/* -------------------------------------------------------------------------- */

describe('varLinksDoAnuncio — fold (2): a que ANÚNCIO o modelo pertence', () => {
  it('PAR — as duas codificações do `produtoShopeeOuterRef` apontam para o MESMO anúncio', () => {
    const filhos: FilhoDeEstoque[] = [
      {
        produtoId: 'filho-1',
        ehKit: false,
        varLinks: [varLink({ produtoShopeeOuterRef: refLink(ANCORA, LINK_A) })],
      },
      {
        produtoId: 'filho-2',
        ehKit: false,
        varLinks: [
          varLink({ produtoShopeeOuterRef: refLinkNua(ANCORA, LINK_A), model_id: MODEL_B }),
        ],
      },
    ];

    const atribuidos = varLinksDoAnuncio(filhos, LINK_A);

    expect(atribuidos.map((a) => a.filho.produtoId)).toEqual(['filho-1', 'filho-2']);
  });

  it('⚠️ QUASE-IGUAL — dois `prodshopee` sob UM produto recebem conjuntos DISJUNTOS (M21)', () => {
    // Both children are the SAME produto's; each model link names a DIFFERENT
    // listing. Attributing by produto would hand listing A the model of B.
    const filhos: FilhoDeEstoque[] = [
      {
        produtoId: 'filho-1',
        ehKit: false,
        varLinks: [
          varLink({ produtoShopeeOuterRef: refLink(ANCORA, LINK_A), varLinkDocId: 'var-a' }),
          varLink({
            produtoShopeeOuterRef: refLink(ANCORA, LINK_B),
            model_id: MODEL_B,
            varLinkDocId: 'var-b',
          }),
        ],
      },
    ];

    const deA = varLinksDoAnuncio(filhos, LINK_A).map((a) => a.varLink.varLinkDocId);
    const deB = varLinksDoAnuncio(filhos, LINK_B).map((a) => a.varLink.varLinkDocId);

    expect(deA).toEqual(['var-a']);
    expect(deB).toEqual(['var-b']);
  });

  it('QUASE-IGUAL — um id de vínculo que difere de um caractere não é este anúncio', () => {
    const filhos: FilhoDeEstoque[] = [
      {
        produtoId: 'filho-1',
        ehKit: false,
        varLinks: [varLink({ produtoShopeeOuterRef: refLink(ANCORA, `${LINK_A}x`) })],
      },
    ];

    expect(varLinksDoAnuncio(filhos, LINK_A)).toEqual([]);
  });

  it('uma referência ausente ou ilegível não atribui o modelo a nenhum anúncio', () => {
    const filhos: FilhoDeEstoque[] = [
      {
        produtoId: 'filho-1',
        ehKit: false,
        varLinks: [
          varLink({ produtoShopeeOuterRef: undefined }),
          varLink({ produtoShopeeOuterRef: 7 }),
        ],
      },
    ];

    expect(varLinksDoAnuncio(filhos, LINK_A)).toEqual([]);
  });

  it('não filtra NADA além do anúncio: um modelo ausente ou com id 0 ainda é devolvido', () => {
    // "No rows at all" and "rows that were all dropped" are different listings;
    // the filtering is fold (3)'s and only happens there.
    const filhos: FilhoDeEstoque[] = [
      {
        produtoId: 'filho-1',
        ehKit: false,
        varLinks: [varLink({ model_id: 0 }), varLink({ modeloAusenteEm: 1_760_000_000_000 })],
      },
    ];

    expect(varLinksDoAnuncio(filhos, LINK_A)).toHaveLength(2);
  });

  it('é ESTRUTURAL: o filho da família de preço passa e volta com o SEU tipo', () => {
    const filhos: FilhoDePrecoFake[] = [
      { produtoId: 'filho-1', precos: { normal: { valor: 10 } }, varLinks: [varLink()] },
    ];

    const [primeiro] = varLinksDoAnuncio(filhos, LINK_A);

    // `precos` is readable without a cast — the generic kept the caller's type.
    expect(primeiro?.filho.precos).toEqual({ normal: { valor: 10 } });
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
