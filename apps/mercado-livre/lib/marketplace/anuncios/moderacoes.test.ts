import { describe, expect, it, vi } from 'vitest';
import {
  MercadoLivreHttpError,
  MercadoLivreNetworkError,
  MercadoLivreReauthRequiredError,
  type MlModeration,
} from '@delfrance/integrations-mercado-livre';
import { mlModeracaoSchema } from '@delfrance/schemas';

import {
  MAX_EVIDENCIAS,
  MAX_MODERACOES,
  consultarModeracoes,
  mapModeracoes,
  moderacoesArmazenadas,
  moderacoesIguais,
  moderationReferenceId,
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

  /**
   * ⚠️ KEEPS it, and the reason is the same one behind the 404 narrow and the
   * transient rethrow. Dropping this entry would store `moderacoes: []`, which
   * on disk is byte-identical to a healthy listing — recording "not moderated"
   * about a listing ML just told us IS moderated. The filter name plus the
   * section is also strictly more than the bare "pausado" this replaces.
   */
  it('KEEPS a moderation with no REASON when ML named the filter', () => {
    const semMotivo = {
      name: 'POOR_QUALITY_THUMBNAIL',
      evidences: [{ section_name: 'pictures', text_matched: null }],
    };
    expect(mapModeracoes([semMotivo as unknown as MlModeration])).toEqual([
      {
        nome: 'POOR_QUALITY_THUMBNAIL',
        dataCriacao: null,
        motivo: null,
        remedio: null,
        secoes: ['pictures'],
        evidencias: [],
      },
    ]);
  });

  it('keeps a REMEDY-only entry too, rather than throwing the verdict away', () => {
    const soRemedio = { name: 'X', wordings: [{ type: 'REMEDY', value: 'conserte' }] };
    expect(mapModeracoes([soRemedio as unknown as MlModeration])[0]).toMatchObject({
      nome: 'X',
      motivo: null,
      remedio: 'conserte',
    });
  });

  /**
   * ⚠️ Never promoted into `motivo`. A raw SCREAMING_SNAKE filter id sitting
   * where the operator expects ML's Portuguese prose reads as a translated
   * reason and is not one.
   */
  it('does NOT promote the filter name into motivo', () => {
    const m = mapModeracoes([{ name: 'DENYLIST' } as unknown as MlModeration])[0];
    expect(m?.motivo).toBeNull();
    expect(m?.nome).toBe('DENYLIST');
  });

  it('DROPS only an entry with neither a reason nor a name — that says nothing', () => {
    expect(mapModeracoes([{} as unknown as MlModeration])).toEqual([]);
    expect(mapModeracoes([{ name: '   ' } as unknown as MlModeration])).toEqual([]);
    expect(mapModeracoes([{ name: null, wordings: [] } as unknown as MlModeration])).toEqual([]);
  });

  it('warns when ML sends a moderation with no REASON, so a live run can count it', () => {
    // Every published ML sample carries `wordings`; this branch is defensive, and
    // only the live run can say how often it really fires. A silent degrade would
    // leave that permanently unanswerable.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mapModeracoes([{ name: 'POOR_QUALITY_THUMBNAIL' } as unknown as MlModeration]);
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockClear();
    mapModeracoes([DOCS_MODERATION]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
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

  /**
   * ⚠️ The read gate mirrors the write gate on purpose, and it cannot be left to
   * the schema. Every field is nullable (see `motivo`) and the shape is
   * `.passthrough()`, so `{ lixo: 1 }` PARSES clean — without the filter it would
   * count as a stored moderation, which is enough to win the family fold's
   * explainability tie-break and to render an alert saying nothing. What
   * `mapModeracoes` refuses to write, this refuses to read.
   */
  it('skips an entry carrying neither reason nor name, even though it parses', () => {
    expect(mlModeracaoSchema.safeParse({ lixo: 1 }).success).toBe(true); // the trap
    expect(
      moderacoesArmazenadas({ moderacoes: [{ lixo: 1 }, ...mapModeracoes([DOCS_PRECO])] }),
    ).toHaveLength(1);
  });

  it('keeps a name-only entry — a real moderation ML supplied no text for', () => {
    const semTexto = mapModeracoes([{ name: 'DENYLIST' } as unknown as MlModeration]);
    expect(semTexto).toHaveLength(1);
    expect(moderacoesArmazenadas({ moderacoes: semTexto })).toEqual(semTexto);
  });
});
