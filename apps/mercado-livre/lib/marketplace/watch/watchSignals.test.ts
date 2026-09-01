import { describe, expect, it } from 'vitest';

import { WatchShapeError, parseApplication, parseConsumption, parseNotices } from './watchSignals';

/**
 * The INTEGRATOR sample from ML's Comunicações page — the one addressed to the
 * application owner rather than to a seller. Note what it does and does not
 * carry: `dismiss_key` and `title`, no `category`, no `sub_category`, and
 * `tags: []`.
 *
 * ⚠️ That absence is why nothing in this module filters on `category`. Its own
 * content is a breaking API change ("começaremos a rejeitar as solicitações que
 * não enviem o token mediante header, respondendo com um erro 301") — precisely
 * the notice a category filter would have dropped on the floor.
 */
const AMOSTRA_INTEGRADOR = {
  paging: { total: 1, offset: 0, limit: 10 },
  results: [
    {
      actions: [
        {
          text: 'Ver documentación',
          link: 'https://developers.mercadolibre.com.ar/es_ar/recomendaciones-de-autorizacion-y-token',
        },
      ],
      id: '18168',
      label: ' Solicitud revisión. ',
      description:
        'Hemos identificado que su integración actualmente envía el access token a través de query parameters…',
      highlighted: false,
      from_date: '2025-02-12T03:00:00.000Z',
      tags: [],
      dismiss_key: 'public-dismiss_1410022527_18168',
      title: ' Solicitud revisión.',
    },
  ],
};

/** The SELLER sample from the same page — tags are objects, not strings. */
const AMOSTRA_VENDEDOR = {
  paging: { total: 1, offset: 0, limit: 10 },
  results: [
    {
      actions: [{ text: 'Mais informações', link: 'https://developers.mercadolibre.com.ar/x' }],
      id: '3691',
      label: 'Bem-vindos integradores à central de novidades!',
      description: 'Estamos disponibilizando a informação da CDN…',
      highlighted: true,
      from_date: '2021-07-12T15:00:00.000Z',
      tags: [
        { tag: 'BLACK_FRIDAY', type: 'EVENTS' },
        { tag: 'BILLING', type: 'BILLING' },
      ],
    },
  ],
};

describe('parseNotices', () => {
  it('reads the integrator sample, category absent and all', () => {
    const [n] = parseNotices(AMOSTRA_INTEGRADOR);
    expect(n?.id).toBe('18168');
    expect(n?.label).toBe(' Solicitud revisión. ');
    expect(n?.category).toBeNull();
    expect(n?.subCategory).toBeNull();
    expect(n?.tags).toEqual([]);
    expect(n?.links).toEqual([
      'https://developers.mercadolibre.com.ar/es_ar/recomendaciones-de-autorizacion-y-token',
    ]);
  });

  it('reads the seller sample, whose tags are OBJECTS rather than strings', () => {
    const [n] = parseNotices(AMOSTRA_VENDEDOR);
    expect(n?.tags).toEqual(['BLACK_FRIDAY', 'BILLING']);
  });

  it('⚠️ does NOT drop a notice for having no category', () => {
    // The regression this guards: an earlier draft filtered on
    // `category ∈ {ALERT, NEW}`, which neither published sample populates. That
    // filter matches nothing and reports zero for ever — a watcher whose silence
    // is indistinguishable from ML having nothing to say.
    expect(parseNotices(AMOSTRA_INTEGRADOR)).toHaveLength(1);
    expect(parseNotices(AMOSTRA_VENDEDOR)).toHaveLength(1);
  });

  it('keeps category when ML DOES send it, as data rather than as a filter', () => {
    const [n] = parseNotices({
      results: [
        { id: '1', label: 'x', description: '', category: 'ALERT', sub_category: 'Bloqueante' },
      ],
    });
    expect(n?.category).toBe('ALERT');
    expect(n?.subCategory).toBe('Bloqueante');
  });

  it('accepts a numeric id, since ML is inconsistent about quoting them', () => {
    expect(parseNotices({ results: [{ id: 18168, label: 'x' }] })[0]?.id).toBe('18168');
  });

  it('falls back to `title` when `label` is missing — the integrator shape has both', () => {
    expect(parseNotices({ results: [{ id: '1', title: 'Só title' }] })[0]?.label).toBe('Só title');
  });

  describe('fails loud instead of reporting nothing', () => {
    // ⚠️ Every case here would otherwise become "no news this week".
    it('throws when `results` is missing', () => {
      expect(() => parseNotices({ paging: { total: 0 } })).toThrow(WatchShapeError);
    });

    it('throws when `results` is not a list', () => {
      expect(() => parseNotices({ results: 'nenhum' })).toThrow(WatchShapeError);
    });

    it('throws when the body is not an object at all', () => {
      expect(() => parseNotices('<html>proxy error</html>')).toThrow(WatchShapeError);
      expect(() => parseNotices(null)).toThrow(WatchShapeError);
    });

    it('throws on an entry with no id, because the id IS the dedup key', () => {
      // Skipping it silently would re-report that notice every week for ever.
      expect(() => parseNotices({ results: [{ label: 'sem id' }] })).toThrow(WatchShapeError);
    });
  });

  it('CONTROL — an empty feed is legitimately empty, and does not throw', () => {
    // The counterpart to the four throws above: a genuinely empty `results` is a
    // real answer, and treating it as a failure would make the watch cry wolf.
    expect(parseNotices({ paging: { total: 0 }, results: [] })).toEqual([]);
  });
});

describe('parseApplication', () => {
  const CORPO = {
    id: 213123928883922,
    site_id: 'MLB',
    active: true,
    max_requests_per_hour: 18000,
    certification_status: 'not_certified',
    scopes: ['write', 'read', 'offline_access'],
  };

  it('reads the documented shape', () => {
    const app = parseApplication(CORPO);
    expect(app.id).toBe('213123928883922');
    expect(app.active).toBe(true);
    expect(app.maxRequestsPerHour).toBe(18000);
    expect(app.certificationStatus).toBe('not_certified');
  });

  it('SORTS scopes, so ML reordering them is not reported as a change', () => {
    expect(parseApplication(CORPO).scopes).toEqual(['offline_access', 'read', 'write']);
  });

  it('throws on a body with no id rather than inventing one', () => {
    expect(() => parseApplication({ active: true })).toThrow(WatchShapeError);
  });
});

describe('parseConsumption', () => {
  const CORPO = {
    app_id: 5555737222442288,
    total_request: 3773948444,
    request_by_status: [
      { total_request: 3624100808, status: 200, percentage: 96.0294202 },
      { total_request: 91749024, status: 403, percentage: 2.4311149 },
      { total_request: 4764611, status: 429, percentage: 0.12625 },
    ],
  };

  it('reads counts and shares, sorted by status', () => {
    const c = parseConsumption(CORPO);
    expect(c.totalRequests).toBe(3773948444);
    expect(c.byStatus.map((r) => r.status)).toEqual([200, 403, 429]);
    expect(c.byStatus[0]?.percentage).toBeCloseTo(96.0294202);
  });

  it('throws when `request_by_status` is missing — the signal would be silent', () => {
    expect(() => parseConsumption({ total_request: 1 })).toThrow(WatchShapeError);
  });

  it('throws on a row with a non-numeric status', () => {
    expect(() =>
      parseConsumption({ request_by_status: [{ status: 'duzentos', percentage: 1 }] }),
    ).toThrow(WatchShapeError);
  });
});
