import { describe, expect, it, vi } from 'vitest';
import {
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
  MercadoLivreReauthRequiredError,
  type MlModeration,
} from '@delfrance/integrations-mercado-livre';

import {
  MAX_EVIDENCIAS,
  MAX_MODERACOES,
  consultarModeracoes,
  mapModeracoes,
  moderacoesArmazenadas,
  moderacoesIguais,
  moderationReferenceId,
  precisaConsultarModeracao,
} from './moderacoes';

/**
 * Every fixture below is taken from a response Mercado Livre PUBLISHES, not
 * invented: *Gerenciar moderações* (the `evidences` + REASON/REMEDY shape and the
 * remedy-less `DENYLIST` removal), *Moderações com pausa* (`evidence`, singular)
 * and *Moderações de imagens* (`WATERMARK`). The tolerance this module has is
 * the tolerance those three pages require of it.
 */

/** *Gerenciar moderações* — the canonical shape, both wordings present. */
const DOCS_MODERATION = {
  name: 'POOR_QUALITY_THUMBNAIL',
  id: '7123400815',
  date_created: '2021-04-14T10:47:05.270-0400',
  evidences: [
    { text_matched: '604505-MLA82848669458_022025', section_name: 'pictures' },
    { text_matched: 'MLA29272', section_name: 'category' },
  ],
  wordings: [
    { type: 'REMEDY', value: 'Corrija sua publicação para vender no Mercado Livre.' },
    {
      type: 'REASON',
      value: 'Seu anúncio foi pausado porque, aparentemente, descumpre nossas Políticas.',
    },
  ],
} as unknown as MlModeration;

/**
 * *Gerenciar moderações*, the removal case. ⚠️ REASON and NO REMEDY — the docs
 * say so outright: "Apenas será retornado o REASON, pois a moderação não tem um
 * REMEDY". The listing cannot be modified or recovered.
 */
const DOCS_REMOVIDO = {
  name: 'DENYLIST',
  id: '7123400816',
  date_created: '2021-04-14T10:47:05.270-0400',
  evidences: [{ section_name: 'title', text_matched: 'Apple - Iphone-BDM-BDS' }],
  wordings: [
    {
      type: 'REASON',
      value: 'Seu anúncio foi cancelado porque a Apple confirmou a denúncia por falsificação.',
    },
  ],
} as unknown as MlModeration;

/**
 * *Moderações com pausa* — ML spells the key **`evidence`**, singular, on this
 * page and on *Moderações de imagens*, while *Gerenciar moderações* uses
 * `evidences`. Also note `date_created` in the OTHER format.
 */
const DOCS_PRECO = {
  name: 'PAUSED_PREVENTION_PRICE',
  id: '7123400818',
  date_created: '2022-10-25 15:57:46.0',
  wordings: [
    { type: 'REASON', value: 'Pausamos porque detectamos uma alteração incomum no preço.' },
    { type: 'REMEDY', value: 'Verifique o valor antes de reativá-la.' },
  ],
  evidence: [{ text_matched: 'O preço alertado é 77393.720000', section_name: 'item' }],
} as unknown as MlModeration;

describe('mapModeracoes', () => {
  it('keeps the REASON, the REMEDY and where ML found the problem', () => {
    expect(mapModeracoes([DOCS_MODERATION])).toEqual([
      {
        nome: 'POOR_QUALITY_THUMBNAIL',
        dataCriacao: '2021-04-14T10:47:05.270-0400',
        motivo: 'Seu anúncio foi pausado porque, aparentemente, descumpre nossas Políticas.',
        remedio: 'Corrija sua publicação para vender no Mercado Livre.',
        secoes: ['pictures', 'category'],
        evidencias: ['604505-MLA82848669458_022025', 'MLA29272'],
      },
    ]);
  });

  /**
   * ⚠️ THE case the UI depends on. A removed listing has no way back, and the
   * null is what lets a reader refuse to offer a fix. Falling back to the motivo
   * — the obvious "helpful" default — would send the operator to edit a listing
   * that can never be reactivated.
   */
  it('leaves remedio NULL for a removed listing — never falls back to the motivo', () => {
    const [m] = mapModeracoes([DOCS_REMOVIDO]);
    expect(m?.remedio).toBeNull();
    expect(m?.motivo).toContain('falsificação');
    expect(m?.secoes).toEqual(['title']);
  });

  it("reads ML's singular `evidence` spelling as well as `evidences`", () => {
    // Sharing one spelling would silently lose every evidence on two of ML's
    // three documented pages.
    expect(mapModeracoes([DOCS_PRECO])[0]).toMatchObject({
      secoes: ['item'],
      evidencias: ['O preço alertado é 77393.720000'],
    });
  });

  it('keeps date_created VERBATIM, in either of the two formats ML sends', () => {
    // Offset-bearing and zone-less, from two different doc pages. Parsing either
    // is lossy; the zone-less one is also ambiguous across our three server TZs.
    expect(mapModeracoes([DOCS_MODERATION])[0]?.dataCriacao).toBe('2021-04-14T10:47:05.270-0400');
    expect(mapModeracoes([DOCS_PRECO])[0]?.dataCriacao).toBe('2022-10-25 15:57:46.0');
  });

  it('DROPS a moderation with no REASON — an entry that explains nothing is noise', () => {
    // A red alert saying only "POOR_QUALITY_THUMBNAIL" is worse than the bare
    // "pausado" this feature replaces.
    const semMotivo = { name: 'X', wordings: [{ type: 'REMEDY', value: 'conserte' }] };
    expect(mapModeracoes([semMotivo as unknown as MlModeration])).toEqual([]);
    expect(mapModeracoes([{ name: 'X' } as unknown as MlModeration])).toEqual([]);
  });

  it('matches the wording type case-insensitively', () => {
    const lower = {
      name: 'X',
      wordings: [
        { type: 'reason', value: 'motivo' },
        { type: 'remedy', value: 'conserto' },
      ],
    };
    expect(mapModeracoes([lower as unknown as MlModeration])[0]).toMatchObject({
      motivo: 'motivo',
      remedio: 'conserto',
    });
  });

  it('survives an empty response and a null one', () => {
    expect(mapModeracoes([])).toEqual([]);
    expect(mapModeracoes(null)).toEqual([]);
    expect(mapModeracoes(undefined)).toEqual([]);
  });

  it('drops empty and duplicate evidence values rather than storing blanks', () => {
    const ruidoso = {
      name: 'MULTIPLE',
      wordings: [{ type: 'REASON', value: 'fotos fora do padrão' }],
      evidences: [
        { text_matched: 'a', section_name: 'pictures' },
        { text_matched: '  ', section_name: 'pictures' },
        { text_matched: 'a', section_name: null },
      ],
    };
    expect(mapModeracoes([ruidoso as unknown as MlModeration])[0]).toMatchObject({
      secoes: ['pictures'],
      evidencias: ['a'],
    });
  });

  it('caps both the moderation list and each entry evidence list', () => {
    // A Firestore document is not unbounded; `publishFalhas`' MAX_CAUSAS rule.
    const many = Array.from({ length: MAX_MODERACOES + 5 }, (_, i) => ({
      name: `F${String(i)}`,
      wordings: [{ type: 'REASON', value: `motivo ${String(i)}` }],
    })) as unknown as MlModeration[];
    expect(mapModeracoes(many)).toHaveLength(MAX_MODERACOES);

    const gordo = {
      name: 'MULTIPLE',
      wordings: [{ type: 'REASON', value: 'fotos' }],
      evidences: Array.from({ length: MAX_EVIDENCIAS + 10 }, (_, i) => ({
        text_matched: `pic-${String(i)}`,
        section_name: 'pictures',
      })),
    };
    expect(mapModeracoes([gordo as unknown as MlModeration])[0]?.evidencias).toHaveLength(
      MAX_EVIDENCIAS,
    );
  });
});

describe('precisaConsultarModeracao', () => {
  /**
   * The gate is the cost model. `items` fires for every change to every listing
   * the seller owns, so a healthy one must keep costing the single
   * `GET /items/{id}` it costs today.
   */
  it('never fires for a plainly healthy listing', () => {
    expect(precisaConsultarModeracao('active', null)).toBe(false);
    expect(precisaConsultarModeracao('active', [])).toBe(false);
    expect(precisaConsultarModeracao('paused', ['out_of_stock'])).toBe(false);
    expect(precisaConsultarModeracao('closed', ['deleted'])).toBe(false);
    expect(precisaConsultarModeracao(null, null)).toBe(false);
  });

  it('fires on under_review whatever the sub_status — every one is a moderation', () => {
    // Including one we have not catalogued: a listing under review with an
    // unfamiliar sub_status is exactly where the reason matters most.
    for (const sub of [null, [], ['waiting_for_patch'], ['algo_novo_do_ml']]) {
      expect(precisaConsultarModeracao('under_review', sub)).toBe(true);
    }
  });

  /**
   * ⚠️ The case that made `moderacoes` a separate field rather than a reuse of
   * `errors`: the listing is LIVE and sendable, so the #781 stock re-arm gate
   * would have wiped the diagnosis on the very write that produced it.
   */
  it('fires for an ACTIVE listing carrying an image moderation', () => {
    expect(precisaConsultarModeracao('active', ['poor_quality_thumbnail'])).toBe(true);
    expect(precisaConsultarModeracao('active', ['moderation_penalty'])).toBe(true);
  });

  it('fires for the preventive pause and the closed penalty', () => {
    expect(precisaConsultarModeracao('paused', ['moderation_penalty'])).toBe(true);
    expect(precisaConsultarModeracao('closed', ['moderation_penalty'])).toBe(true);
  });

  it('fires for BOTH of ML picture-pending spellings', () => {
    // Not a typo of one another — ML uses one per page, and normalising to a
    // single spelling would miss whichever page turns out to be right.
    expect(precisaConsultarModeracao('paused', ['picture_download_pending'])).toBe(true);
    expect(precisaConsultarModeracao('under_review', ['picture_downloading_pending'])).toBe(true);
  });

  it('fires when a moderation sub_status sits alongside ordinary ones', () => {
    expect(precisaConsultarModeracao('paused', ['out_of_stock', 'moderation_penalty'])).toBe(true);
  });
});

describe('moderationReferenceId', () => {
  it('appends ML element suffix — a bare item id is a silent miss', () => {
    expect(moderationReferenceId('MLB5095421681')).toBe('MLB5095421681-ITM');
  });
});

describe('consultarModeracoes', () => {
  const api = (impl: () => Promise<MlModeration[]>) => ({ getLastModeration: vi.fn(impl) });

  it('spends NO call at all on a healthy listing', async () => {
    const a = api(async () => [DOCS_MODERATION]);
    await expect(consultarModeracoes(a, 'MLB1', 'active', null)).resolves.toEqual([]);
    expect(a.getLastModeration).not.toHaveBeenCalled();
  });

  it('asks with the -ITM reference and maps the answer', async () => {
    const a = api(async () => [DOCS_MODERATION]);
    const out = await consultarModeracoes(a, 'MLB1', 'under_review', ['waiting_for_patch']);
    expect(a.getLastModeration).toHaveBeenCalledWith('MLB1-ITM');
    expect(out[0]?.motivo).toContain('descumpre nossas Políticas');
  });

  /**
   * 404 is ML's ordinary answer for an element with no active moderation. It is
   * DATA — a listing under review for a reason ML has not filed — not a failure,
   * and must not retry a task that has nothing to retry.
   */
  it('reads a 404 as "not moderated", not as an error', async () => {
    const a = api(async () => {
      throw new MercadoLivreHttpError('ML 404: not found', 404, null);
    });
    await expect(consultarModeracoes(a, 'MLB1', 'under_review', null)).resolves.toEqual([]);
  });

  /**
   * ⚠️ The judgement call, asserted so it cannot be quietly softened into a
   * `catch { return [] }`. Swallowing a transient would persist "not moderated",
   * which is indistinguishable from a healthy listing — the exact
   * no-explanation state this module exists to end. Throwing writes nothing and
   * the queue retries.
   */
  it('RETHROWS every non-404 so the caller records nothing', async () => {
    for (const err of [
      new MercadoLivreHttpError('ML 500: boom', 500, null),
      new MercadoLivreHttpError('ML 429: slow down', 429, null),
      new MercadoLivreNetworkError('rede caiu'),
      // A 401 never arrives as MercadoLivreHttpError — `api.ts` raises this
      // instead — so it must rethrow through the same door, not fall into the
      // 404 narrow by accident.
      new MercadoLivreReauthRequiredError('refresh_failed', 'reconecte a conta'),
    ]) {
      const a = api(async () => {
        throw err;
      });
      await expect(consultarModeracoes(a, 'MLB1', 'under_review', null)).rejects.toBe(err);
    }
  });
});

describe('moderacoesIguais', () => {
  const m = mapModeracoes([DOCS_MODERATION]);

  it('treats null, undefined and [] as the same "no moderation"', () => {
    expect(moderacoesIguais(null, [])).toBe(true);
    expect(moderacoesIguais(undefined, null)).toBe(true);
  });

  it('is true for the same reading twice — this is what makes the sync converge', () => {
    expect(moderacoesIguais(m, mapModeracoes([DOCS_MODERATION]))).toBe(true);
  });

  it('is false when a moderation appears or is lifted', () => {
    expect(moderacoesIguais(m, [])).toBe(false);
    expect(moderacoesIguais([], m)).toBe(false);
  });

  /**
   * The remedy is a DISPLAYED field, so it has to be able to move on its own: ML
   * downgrading a recoverable moderation to an unrecoverable one changes what the
   * operator can do about it, while every other field stays put.
   */
  it('is false when only the remedio changed', () => {
    expect(moderacoesIguais(m, [{ ...m[0]!, remedio: null }])).toBe(false);
  });

  it('is false when only the evidence changed', () => {
    expect(moderacoesIguais(m, [{ ...m[0]!, evidencias: ['outra-foto'] }])).toBe(false);
    expect(moderacoesIguais(m, [{ ...m[0]!, secoes: ['title'] }])).toBe(false);
  });
});

describe('moderacoesArmazenadas', () => {
  it('reads back what the link doc stores', () => {
    const stored = mapModeracoes([DOCS_MODERATION]);
    expect(moderacoesArmazenadas({ moderacoes: stored })).toEqual(stored);
  });

  it('reads a doc that predates the field as "no moderation"', () => {
    // Every legacy corpus row is this case, and it must not throw or be mistaken
    // for a moderation.
    expect(moderacoesArmazenadas({})).toEqual([]);
    expect(moderacoesArmazenadas({ moderacoes: null })).toEqual([]);
  });

  it('skips a malformed entry instead of failing the whole read', () => {
    expect(
      moderacoesArmazenadas({ moderacoes: [{ lixo: 1 }, ...mapModeracoes([DOCS_PRECO])] }),
    ).toHaveLength(1);
  });
});
