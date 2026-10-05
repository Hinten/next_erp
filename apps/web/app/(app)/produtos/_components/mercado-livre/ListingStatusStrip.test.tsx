import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';
import {
  ESTADO_PUBLICACAO_ML,
  ML_CAUSA_TIPO,
  type MlCausa,
  type MlModeracao,
  type ProdutoMercadoLivreLink,
} from '@delfrance/schemas';

import { linkFixture } from '@/lib/mercado-livre/linkFixture';
import { ListingStatusStrip, type ListingStatusStripProps } from './ListingStatusStrip';

const causaFixture = (over: Partial<MlCausa> = {}): MlCausa => ({
  code: null,
  causaId: null,
  tipo: ML_CAUSA_TIPO.erro,
  departamento: null,
  mensagem: 'algo deu errado',
  referencias: [],
  campos: [],
  ...over,
});

function renderStrip(
  over: Partial<ProdutoMercadoLivreLink> = {},
  onReverificar = vi.fn(),
  extra: Partial<ListingStatusStripProps> = {},
) {
  render(
    <MantineTestProvider>
      <ListingStatusStrip
        link={linkFixture({ status: null, ...over })}
        canWrite
        disabled={false}
        rechecking={false}
        onReverificar={onReverificar}
        {...extra}
      />
    </MantineTestProvider>,
  );
  return onReverificar;
}

/** A published User-Products family: `id` is the family, not an MLB item. */
const FAMILIA: Partial<ProdutoMercadoLivreLink> = {
  isUserProductModel: true,
  id: '6264141844942250',
};

describe('ListingStatusStrip', () => {
  it('keeps the assertions the existing e2e spec depends on', () => {
    renderStrip();
    expect(screen.getByText('Anúncio MLB777')).toBeDefined();
    expect(screen.getByText('Publicado')).toBeDefined();
  });

  it('names the listing model, because the two behave differently on publish', () => {
    renderStrip({ isUserProductModel: false });
    expect(screen.getByText('Variações do anúncio')).toBeDefined();
  });

  it('marks a User-Products listing distinctly', () => {
    renderStrip({ isUserProductModel: true, id: '6264141844942250' });
    expect(screen.getByText('User Products')).toBeDefined();
  });

  it('links to the live listing for a legacy listing', () => {
    renderStrip();
    const anchor = screen.getByRole('link', { name: 'ver no Mercado Livre' });
    expect(anchor.getAttribute('href')).toBe('https://produto.mercadolivre.com.br/MLB-777');
    // Opening in a new tab also dodges the unsaved-changes guard, which skips
    // target="_blank" anchors.
    expect(anchor.getAttribute('target')).toBe('_blank');
  });

  it('cannot build a href for a User-Products family, and offers to ask ML instead', () => {
    // `link.id` is the family id there; building an MLB URL from it would 404,
    // and there is no public URL keyed by family — so the affordance resolves on
    // click rather than not existing, which is what the old Flutter screen did.
    const onAbrirAnuncio = vi.fn();
    renderStrip(FAMILIA, vi.fn(), { onAbrirAnuncio });

    expect(screen.queryByRole('link', { name: 'ver no Mercado Livre' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'ver no Mercado Livre' }));
    expect(onAbrirAnuncio).toHaveBeenCalledTimes(1);
  });

  it('becomes an ordinary new-tab anchor once the URL is resolved', () => {
    // Which is also what stops a second click from costing another round trip.
    renderStrip(FAMILIA, vi.fn(), {
      onAbrirAnuncio: vi.fn(),
      urlResolvida: 'https://www.mercadolivre.com.br/up/MLBU1',
    });

    const anchor = screen.getByRole('link', { name: 'ver no Mercado Livre' });
    expect(anchor.getAttribute('href')).toBe('https://www.mercadolivre.com.br/up/MLBU1');
    expect(anchor.getAttribute('target')).toBe('_blank');
    expect(screen.queryByRole('button', { name: 'ver no Mercado Livre' })).toBeNull();
  });

  it('says it is working while the URL is being resolved', () => {
    renderStrip(FAMILIA, vi.fn(), { onAbrirAnuncio: vi.fn(), abrindo: true });

    expect(screen.getByRole('button', { name: 'abrindo…' })).toBeDefined();
  });

  it('offers nothing when there is no client to resolve with', () => {
    // `onAbrirAnuncio` is undefined while logged out — the pre-existing
    // behaviour, and the only case where a published listing shows no link.
    renderStrip(FAMILIA);

    expect(screen.queryByRole('link', { name: 'ver no Mercado Livre' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'ver no Mercado Livre' })).toBeNull();
  });

  it('offers nothing at all for a draft that was never published', () => {
    renderStrip({ id: null }, vi.fn(), { onAbrirAnuncio: vi.fn() });

    expect(screen.queryByRole('link', { name: 'ver no Mercado Livre' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'ver no Mercado Livre' })).toBeNull();
  });

  it('offers nothing for a UP family whose id is empty — the backend calls that unpublished', () => {
    // `''` is in the migrated corpus, which is why the schema has no `.min(1)`
    // and the strip must render it, not crash; the route answers 409 for it.
    renderStrip({ ...FAMILIA, id: '' }, vi.fn(), { onAbrirAnuncio: vi.fn() });

    expect(screen.queryByRole('button', { name: 'ver no Mercado Livre' })).toBeNull();
  });

  it('does not offer to resolve a LEGACY id that yields no URL', () => {
    // A legacy id with no digits is malformed, not User-Products — asking ML
    // could only come back with "o anúncio não existe mais", which misdescribes
    // it. The legacy path keeps behaving exactly as it did.
    renderStrip({ isUserProductModel: false, id: 'sem-digitos' }, vi.fn(), {
      onAbrirAnuncio: vi.fn(),
    });

    expect(screen.queryByRole('link', { name: 'ver no Mercado Livre' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'ver no Mercado Livre' })).toBeNull();
  });

  it("surfaces ML's raw status and sub_status", () => {
    // `paused` alone is the seller's own pause; `paused` + `out_of_stock` is ML
    // reacting to zero stock, and only the second resolves itself.
    renderStrip({
      estado: ESTADO_PUBLICACAO_ML.pausado,
      status: 'paused',
      sub_status: ['out_of_stock'],
    });
    expect(screen.getByText(/paused · out_of_stock/)).toBeDefined();
  });

  /**
   * #1226. The badge alone says "Removido pelo Mercado Livre" and no more, and
   * the operator's next step is neither on this listing nor obvious: Republicar
   * is disabled and Reverificar only re-confirms the removal. The line names the
   * two controls that DO help.
   */
  it('says a removed listing cannot come back, and where to go instead', () => {
    renderStrip({
      estado: ESTADO_PUBLICACAO_ML.removidoPorModeracao,
      status: 'under_review',
      sub_status: ['forbidden'],
    });

    expect(screen.getByText('Removido pelo Mercado Livre')).toBeDefined();
    const aviso = screen.getByTestId('ml-aviso-removido');
    expect(aviso.textContent).toContain('não pode ser reativado');
    expect(aviso.textContent).toContain('Descartar anúncio removido');
  });

  it('shows that notice on NO other estado', () => {
    // ⚠️ The near-miss: `emRevisao` is the same ML `status`, and a listing that
    // is merely under review is exactly the one that must NOT be written off.
    for (const estado of [
      ESTADO_PUBLICACAO_ML.emRevisao,
      ESTADO_PUBLICACAO_ML.cancelado,
      ESTADO_PUBLICACAO_ML.pausado,
      ESTADO_PUBLICACAO_ML.erro,
    ]) {
      cleanup();
      renderStrip({ estado, status: 'under_review', sub_status: ['forbidden'] });
      expect(screen.queryByTestId('ml-aviso-removido')).toBeNull();
    }
  });

  it('shows persisted errors under a neutral title', () => {
    // errors[] is written by publish, the price sync AND the stock sender, so
    // the title must not blame any one of them (#781).
    renderStrip({ estado: ESTADO_PUBLICACAO_ML.erro, errors: ['item.attributes.required'] });
    expect(screen.getByText('Última falha do Mercado Livre')).toBeDefined();
    expect(screen.getByText('item.attributes.required')).toBeDefined();
  });

  it('falls back to the raw errors when the doc predates structured causes', () => {
    // A Flutter-written doc, or one this app stamped before #1109, has
    // `causas: null` and must keep showing what it does have.
    renderStrip({
      estado: ESTADO_PUBLICACAO_ML.erro,
      errors: ['ML 400: Validation error'],
      causas: null,
    });
    expect(screen.getByText('ML 400: Validation error')).toBeDefined();
  });

  it('shows a cause with no control above the form, with its ML code', () => {
    renderStrip({
      estado: ESTADO_PUBLICACAO_ML.erro,
      errors: ['warning · shipping.me2_adoption_mandatory — …'],
      causas: [
        causaFixture({
          code: 'moderations.seller.not_authorized',
          mensagem: 'Marca não autorizada',
          referencias: ['item.seller_id'],
        }),
      ],
    });
    const alerta = screen.getByTestId('ml-causas-gerais');
    expect(alerta.textContent).toContain('Marca não autorizada');
    // The raw ML reference rides along: an unmapped path is still actionable.
    expect(alerta.textContent).toContain('item.seller_id');
    expect(alerta.textContent).toContain('moderations.seller.not_authorized');
  });

  it('lists a cause even when a control also shows it', () => {
    // #1118 review: this asserted the OPPOSITE, and that was the bug. Suppressing
    // the banner for a single-control cause assumed the control was on screen,
    // which `campos` never promised — it is resolved against the payload we SENT.
    renderStrip({
      estado: ESTADO_PUBLICACAO_ML.erro,
      causas: [causaFixture({ mensagem: 'Categoria inválida', campos: ['category_id'] })],
    });
    expect(screen.getByTestId('ml-causas-gerais').textContent).toContain('Categoria inválida');
  });

  it('shows a cause pinned to a control the editor never renders', () => {
    // The exact silent drop: `SELLER_PACKAGE_WIDTH` is derived and stripped
    // before the attribute grid, so nothing downstream could display this — and
    // `temCausas` suppresses the raw `errors` fallback for the whole doc.
    renderStrip({
      estado: ESTADO_PUBLICACAO_ML.erro,
      errors: ['ML 400: Validation error'],
      causas: [
        causaFixture({
          mensagem: 'Invalid package width',
          campos: ['attributes.SELLER_PACKAGE_WIDTH'],
        }),
      ],
    });
    expect(screen.getByTestId('ml-causas-gerais').textContent).toContain('Invalid package width');
  });

  it('keeps ML-applied warnings out of the red alert', () => {
    renderStrip({
      estado: ESTADO_PUBLICACAO_ML.publicado,
      causas: [
        causaFixture({
          tipo: ML_CAUSA_TIPO.aviso,
          code: 'shipping.me2_adoption_mandatory',
          mensagem: 'ME2 adoption is mandatory for the user',
        }),
      ],
    });
    expect(screen.queryByTestId('ml-causas-gerais')).toBeNull();
    expect(screen.getByTestId('ml-causas-avisos').textContent).toContain('ME2 adoption');
  });

  it('offers the latch escape hatch only for a PUBLISHED listing in error', () => {
    renderStrip({ estado: ESTADO_PUBLICACAO_ML.erro, id: 'MLB777' });
    expect(screen.getByRole('button', { name: 'Reverificar anúncio' })).toBeDefined();
  });

  it('does not offer it for a draft that merely failed validation', () => {
    renderStrip({ estado: ESTADO_PUBLICACAO_ML.erro, id: null });
    expect(screen.queryByRole('button', { name: 'Reverificar anúncio' })).toBeNull();
  });
});

/**
 * #1087. ML pauses or removes a listing for a policy reason; before this the
 * strip showed `paused · moderation_penalty` and the operator had nowhere at all
 * to learn what ML objected to.
 *
 * ⚠️ The distinction every test here defends: `remedio: null` means two
 * different things depending on `motivo`. With a reason it is ML saying there is
 * no way back; without one it is ML saying nothing. Rendering the second as the
 * first tells the operator to abandon a listing that may be perfectly fixable.
 */
describe('ListingStatusStrip — moderações do Mercado Livre (#1087)', () => {
  const moderacaoFixture = (over: Partial<MlModeracao> = {}): MlModeracao => ({
    nome: 'POOR_QUALITY_THUMBNAIL',
    dataCriacao: null,
    motivo: 'Pausamos o anúncio porque ele infringe nossas políticas.',
    remedio: 'Ajuste o título e/ou substitua as fotos.',
    secoes: ['pictures'],
    evidencias: [],
    ...over,
  });

  it('shows nothing at all for a listing with no moderation', () => {
    renderStrip({ moderacoes: null });
    expect(screen.queryByTestId('ml-moderacoes')).toBeNull();
  });

  it('shows the reason AND how to fix it', () => {
    renderStrip({
      estado: ESTADO_PUBLICACAO_ML.pausado,
      status: 'paused',
      sub_status: ['moderation_penalty'],
      moderacoes: [moderacaoFixture()],
    });

    const alerta = screen.getByTestId('ml-moderacoes');
    expect(alerta.textContent).toContain('infringe nossas políticas');
    expect(alerta.textContent).toContain('Como corrigir: Ajuste o título');
    // Where ML found it, translated — `pictures` means nothing to an operator.
    expect(alerta.textContent).toContain('Onde: Fotos');
    // The filter id rides along dimmed, exactly as a causa's `code` does.
    expect(alerta.textContent).toContain('POOR_QUALITY_THUMBNAIL');
  });

  /**
   * ML's docs are explicit: a removed listing returns REASON and no REMEDY
   * *because there is no way back*. Offering a fix here would send the operator
   * to edit a listing that can never be reactivated.
   */
  it('says plainly that a removed listing cannot be recovered, and offers no fix', () => {
    renderStrip({
      estado: ESTADO_PUBLICACAO_ML.emRevisao,
      status: 'under_review',
      sub_status: ['forbidden'],
      moderacoes: [
        moderacaoFixture({
          nome: 'DENYLIST',
          motivo: 'Seu anúncio foi cancelado porque a Apple confirmou a denúncia.',
          remedio: null,
          secoes: ['title'],
        }),
      ],
    });

    const alerta = screen.getByTestId('ml-moderacoes');
    expect(alerta.textContent).toContain('não pode ser reativado');
    expect(alerta.textContent).not.toContain('Como corrigir');
  });

  /**
   * ⚠️ THE mistake worth its own test. This entry also carries `remedio: null`,
   * so anything keying on `remedio` alone would render it as the removal above —
   * telling the operator to give up on a listing ML merely failed to explain.
   */
  it('an UNEXPLAINED moderation must not read as an unrecoverable one', () => {
    renderStrip({
      status: 'paused',
      sub_status: ['moderation_penalty'],
      moderacoes: [
        moderacaoFixture({ motivo: null, remedio: null, secoes: ['title', 'pictures'] }),
      ],
    });

    const alerta = screen.getByTestId('ml-moderacoes');
    expect(alerta.textContent).toContain('não informou o motivo');
    expect(alerta.textContent).not.toContain('não pode ser reativado');
    expect(alerta.textContent).not.toContain('Como corrigir');
    // It still says everything ML DID give — which is more than "pausado".
    expect(alerta.textContent).toContain('POOR_QUALITY_THUMBNAIL');
    expect(alerta.textContent).toContain('Onde: Título, Fotos');
  });

  /**
   * ⚠️ `motivo` and `remedio` are INDEPENDENT `wordings` lookups, so ML can send
   * a REMEDY with no REASON — and the backend deliberately keeps that shape
   * (`mapModeracoes`, "keeps a REMEDY-only entry"). Gating the remedy line on
   * `severidade === 'com-conserto'` threw away the one actionable sentence ML
   * had sent and left the operator with "não informou o motivo" and nothing to
   * do about it.
   *
   * The whole `motivo: null` family previously fixed `remedio: null` too, which
   * is exactly why no test could see it. The two now vary independently.
   */
  it('shows a remedy ML sent even when it sent no reason', () => {
    renderStrip({
      moderacoes: [
        moderacaoFixture({
          motivo: null,
          remedio: 'Troque a foto de capa por uma nítida.',
          secoes: ['pictures'],
        }),
      ],
    });

    const alerta = screen.getByTestId('ml-moderacoes');
    expect(alerta.textContent).toContain('Como corrigir: Troque a foto de capa');
    expect(alerta.textContent).toContain('não informou o motivo');
    // Still not a removal: ML withheld the reason, not the way back.
    expect(alerta.textContent).not.toContain('não pode ser reativado');
  });

  it('never shows a remedy and the no-remedy line at the same time', () => {
    // They are mutually exclusive by construction — `sem-conserto` implies
    // `remedio == null` — and this pins that so neither gate can drift.
    // All FOUR combinations of the two independent wordings, not just the two
    // the severity names.
    for (const moderacoes of [
      [moderacaoFixture()],
      [moderacaoFixture({ remedio: null })],
      [moderacaoFixture({ motivo: null })],
      [moderacaoFixture({ motivo: null, remedio: null })],
    ]) {
      renderStrip({ moderacoes });
      const texto = screen.getByTestId('ml-moderacoes').textContent ?? '';
      const temConserto = texto.includes('Como corrigir');
      const semConserto = texto.includes('não pode ser reativado');
      expect(temConserto && semConserto).toBe(false);
      cleanup();
    }
  });

  /**
   * ⚠️ Not gated on `estado`. `poor_quality_thumbnail` leaves the listing
   * `active` and merely strips its exposure — it is exactly the case that made
   * `moderacoes` a separate field from `errors`, whose stock re-arm would have
   * cleared the diagnosis on a sendable listing. Gating the block on an error
   * state would hide the one moderation nothing else can surface.
   */
  it('renders on a listing ML still calls ACTIVE', () => {
    renderStrip({
      estado: ESTADO_PUBLICACAO_ML.publicado,
      status: 'active',
      sub_status: ['poor_quality_thumbnail'],
      moderacoes: [moderacaoFixture({ nome: 'WATERMARK' })],
    });

    expect(screen.getByTestId('ml-moderacoes').textContent).toContain('infringe nossas políticas');
  });

  it('shows the offending value ML matched', () => {
    // For a `title` moderation this is the actual offending phrase, which is the
    // most actionable thing in the whole payload.
    renderStrip({
      moderacoes: [moderacaoFixture({ secoes: ['title'], evidencias: ['Apple - Iphone-BDM-BDS'] })],
    });

    expect(screen.getByTestId('ml-moderacoes').textContent).toContain('Apple - Iphone-BDM-BDS');
  });

  it('caps a long evidence list instead of flooding the strip', () => {
    renderStrip({
      moderacoes: [moderacaoFixture({ evidencias: ['a', 'b', 'c', 'd', 'e'] })],
    });

    const texto = screen.getByTestId('ml-moderacoes').textContent ?? '';
    expect(texto).toContain('a, b, c');
    expect(texto).toContain('(+2)');
    expect(texto).not.toContain('d, e');
  });

  /**
   * A moderação is ML's verdict on the LISTING; a causa is ML refusing a write
   * of ours. They are different problems and a listing can carry both, so
   * neither block may swallow the other.
   */
  it('sits alongside the causas alert rather than replacing it', () => {
    renderStrip({
      estado: ESTADO_PUBLICACAO_ML.erro,
      moderacoes: [moderacaoFixture()],
      causas: [causaFixture({ mensagem: 'Categoria inválida', campos: ['category_id'] })],
    });

    expect(screen.getByTestId('ml-moderacoes').textContent).toContain('infringe nossas políticas');
    expect(screen.getByTestId('ml-causas-gerais').textContent).toContain('Categoria inválida');
  });

  /**
   * ⚠️ The additive rule `listingCausas.ts` records the hard way. `title` DOES
   * resolve to a form control, and the entry is listed here anyway: resolving to
   * a control is not the same as being visible on one, and a block that depended
   * on the mapping is one refactor from displaying nothing.
   */
  it('lists a moderation even when a control will also show it', () => {
    renderStrip({ moderacoes: [moderacaoFixture({ secoes: ['title'] })] });

    expect(screen.getByTestId('ml-moderacoes').textContent).toContain('infringe nossas políticas');
  });

  it('renders every moderation when ML reports more than one', () => {
    renderStrip({
      moderacoes: [
        moderacaoFixture({ motivo: 'Primeira' }),
        moderacaoFixture({ nome: 'DENYLIST', motivo: 'Segunda', remedio: null }),
      ],
    });

    const texto = screen.getByTestId('ml-moderacoes').textContent ?? '';
    expect(texto).toContain('Primeira');
    expect(texto).toContain('Segunda');
  });

  it('drops an entry that carries neither a reason nor a filter name', () => {
    // It would paint an alert with no content — the "red alert saying nothing"
    // this feature exists to avoid.
    renderStrip({
      moderacoes: [moderacaoFixture({ motivo: null, nome: null, remedio: null, secoes: [] })],
    });

    expect(screen.queryByTestId('ml-moderacoes')).toBeNull();
  });
});

/**
 * The `moderacoes: null` third state (#1239) — ML reports a moderation and
 * nobody fetched the reason. It needs its OWN button: the latch one below is
 * gated on `isStockLatched` (`estado === 'E'`), and a moderated listing is `pa`,
 * `v` or an `active` `p`, so that affordance renders on none of these.
 */
describe('ListingStatusStrip — moderação não consultada (#1239)', () => {
  const MODERADO: Partial<ProdutoMercadoLivreLink> = {
    estado: ESTADO_PUBLICACAO_ML.pausado,
    status: 'paused',
    sub_status: ['moderation_penalty'],
    moderacoes: null,
  };

  it('tells the operator a reason exists and offers to fetch it', () => {
    renderStrip(MODERADO);
    expect(screen.getByTestId('ml-moderacao-nao-consultada').textContent).toContain(
      'ainda não foi consultado',
    );
    expect(screen.getByRole('button', { name: 'Consultar motivo' })).toBeTruthy();
  });

  it('asks for a moderation re-check, not a stock one', () => {
    const onReverificar = renderStrip(MODERADO);
    fireEvent.click(screen.getByRole('button', { name: 'Consultar motivo' }));
    expect(onReverificar).toHaveBeenCalledWith('moderacao');
  });

  /**
   * ⚠️ The reason the button had to be its own: on a moderated listing the latch
   * affordance is not on screen at all, so "prompt the existing button" was never
   * available.
   */
  it('is the ONLY affordance here — the stock-latch button is not rendered', () => {
    renderStrip(MODERADO);
    expect(screen.queryByRole('button', { name: 'Reverificar anúncio' })).toBeNull();
  });

  it('stays silent for an ASKED-and-none, even while the status still says moderated', () => {
    renderStrip({ ...MODERADO, moderacoes: [] });
    expect(screen.queryByTestId('ml-moderacao-nao-consultada')).toBeNull();
  });

  it('stays silent on a healthy listing whose field was never populated', () => {
    renderStrip({ status: 'active', sub_status: null, moderacoes: null });
    expect(screen.queryByTestId('ml-moderacao-nao-consultada')).toBeNull();
  });

  /**
   * ⚠️ Not gated on `estado`, for the same reason the moderation alert is not: a
   * `poor_quality_thumbnail` listing is ACTIVE and merely losing exposure, and it
   * is the case the operator has no other way to discover.
   */
  /**
   * ⚠️ The wording must be true on BOTH arms of the gate. `under_review` with no
   * moderation sub_status is ML REVIEWING — it can conclude with no moderation,
   * and it is what every freshly published anúncio looks like (#1252), so this is
   * the notice's most common appearance. Claiming a moderation exists would be
   * false exactly there.
   */
  it('does not claim a moderation EXISTS on a listing merely under review', () => {
    renderStrip({
      estado: ESTADO_PUBLICACAO_ML.publicado,
      status: 'under_review',
      sub_status: null,
      moderacoes: null,
    });

    const texto = screen.getByTestId('ml-moderacao-nao-consultada').textContent ?? '';
    expect(texto).toContain('ainda não foi consultado');
    expect(texto).toContain('possível');
    // The assertive phrasing this replaced — a moderation stated as fact.
    expect(texto).not.toContain('indica uma moderação');
  });

  it('renders on a listing ML still calls ACTIVE', () => {
    renderStrip({
      estado: ESTADO_PUBLICACAO_ML.publicado,
      status: 'active',
      sub_status: ['poor_quality_thumbnail'],
      moderacoes: null,
    });
    expect(screen.getByTestId('ml-moderacao-nao-consultada')).toBeTruthy();
  });

  it('never co-renders with the moderation alert — the two states are exclusive', () => {
    renderStrip({
      ...MODERADO,
      moderacoes: [
        {
          nome: 'POOR_QUALITY_THUMBNAIL',
          dataCriacao: null,
          motivo: 'Foto de baixa qualidade.',
          remedio: 'Suba outra foto.',
          secoes: ['pictures'],
          evidencias: [],
        },
      ],
    });
    expect(screen.getByTestId('ml-moderacoes')).toBeTruthy();
    expect(screen.queryByTestId('ml-moderacao-nao-consultada')).toBeNull();
  });

  it('cannot be pressed by a read-only operator', () => {
    renderStrip(MODERADO, vi.fn(), { canWrite: false });
    expect(screen.getByRole('button', { name: 'Consultar motivo' }).hasAttribute('disabled')).toBe(
      true,
    );
  });
});
