import { describe, expect, it } from 'vitest';

import {
  BASELINE_VAZIA,
  TOLERANCIA_PONTOS_PERCENTUAIS,
  type WatchBaseline,
  type WatchSignals,
  diffWatch,
  proximaBaseline,
  renderReport,
  temNovidade,
} from './watchDiff';
import type { ApplicationSnapshot, Notice } from './watchSignals';

const APP: ApplicationSnapshot = {
  id: '123',
  active: true,
  maxRequestsPerHour: 18000,
  certificationStatus: 'not_certified',
  siteId: 'MLB',
  scopes: ['offline_access', 'read', 'write'],
};

const notice = (id: string, label = `notice ${id}`): Notice => ({
  id,
  label,
  description: 'corpo',
  category: null,
  subCategory: null,
  fromDate: '2026-09-01T00:00:00.000Z',
  tags: [],
  links: [],
});

function signals(over: Partial<WatchSignals> = {}): WatchSignals {
  return {
    notices: [notice('1')],
    application: APP,
    consumption: {
      totalRequests: 1_000_000,
      byStatus: [
        { status: 200, percentage: 96 },
        { status: 403, percentage: 2.4 },
      ],
    },
    ...over,
  };
}

const BASELINE: WatchBaseline = {
  seenNoticeIds: ['1'],
  application: APP,
  consumption: { '200': 96, '403': 2.4 },
};

describe('diffWatch — notices', () => {
  it('reports a notice id the baseline has never seen', () => {
    const f = diffWatch(BASELINE, signals({ notices: [notice('1'), notice('2')] }));
    expect(f.novasNotices.map((n) => n.id)).toEqual(['2']);
    expect(f.noticesJaVistas).toBe(1);
    expect(temNovidade(f)).toBe(true);
  });

  it('CONTROL — an unchanged feed is NOT news, so the AI job never starts', () => {
    const f = diffWatch(BASELINE, signals());
    expect(f.novasNotices).toEqual([]);
    expect(temNovidade(f)).toBe(false);
  });
});

describe('diffWatch — application', () => {
  it('reports a lost scope, the change that silently breaks calls', () => {
    const f = diffWatch(
      BASELINE,
      signals({ application: { ...APP, scopes: ['offline_access', 'read'] } }),
    );
    expect(f.mudancasApp).toContain('scopes REMOVIDOS: write');
    expect(temNovidade(f)).toBe(true);
  });

  it('reports the application being deactivated', () => {
    const f = diffWatch(BASELINE, signals({ application: { ...APP, active: false } }));
    expect(f.mudancasApp).toContain('active: true → false');
  });

  it('reports a rate-limit change', () => {
    const f = diffWatch(BASELINE, signals({ application: { ...APP, maxRequestsPerHour: 9000 } }));
    expect(f.mudancasApp).toContain('max_requests_per_hour: 18000 → 9000');
  });

  it('CONTROL — an identical application reports nothing', () => {
    expect(diffWatch(BASELINE, signals()).mudancasApp).toEqual([]);
  });

  it('says nothing on a FIRST run, instead of reporting every field as changed', () => {
    // The one run nobody reads carefully is the first. Burying the real signal
    // under a full-object dump is how a new watch gets ignored from day one.
    expect(diffWatch(BASELINE_VAZIA, signals()).mudancasApp).toEqual([]);
  });
});

describe('diffWatch — consumption', () => {
  it('⭐ reports an HTTP status appearing for the FIRST time', () => {
    // This is the signal that catches ML rejecting us without announcing it.
    const f = diffWatch(
      BASELINE,
      signals({
        consumption: {
          totalRequests: 1_000_000,
          byStatus: [
            { status: 200, percentage: 96 },
            { status: 403, percentage: 2.4 },
            { status: 301, percentage: 0.01 },
          ],
        },
      }),
    );
    expect(f.novosStatus).toEqual([301]);
    expect(temNovidade(f)).toBe(true);
  });

  it('reports a share that moves beyond the tolerance', () => {
    const f = diffWatch(
      BASELINE,
      signals({
        consumption: {
          totalRequests: 1_000_000,
          byStatus: [
            { status: 200, percentage: 90 },
            { status: 403, percentage: 8.4 },
          ],
        },
      }),
    );
    expect(f.desviosStatus.join(' ')).toContain('HTTP 403');
    expect(f.desviosStatus.join(' ')).toContain('HTTP 200');
  });

  it('CONTROL — a wobble UNDER the tolerance is not news', () => {
    // Without a threshold this fires every week and the watch is muted within a
    // month; without any comparison, only brand-new status codes are ever seen.
    const dentro = TOLERANCIA_PONTOS_PERCENTUAIS / 2;
    const f = diffWatch(
      BASELINE,
      signals({
        consumption: {
          totalRequests: 1_000_000,
          byStatus: [
            { status: 200, percentage: 96 - dentro },
            { status: 403, percentage: 2.4 + dentro },
          ],
        },
      }),
    );
    expect(f.desviosStatus).toEqual([]);
    expect(temNovidade(f)).toBe(false);
  });

  it('says nothing about consumption on a FIRST run', () => {
    const f = diffWatch(BASELINE_VAZIA, signals());
    expect(f.novosStatus).toEqual([]);
    expect(f.desviosStatus).toEqual([]);
  });
});

describe('proximaBaseline', () => {
  it('⚠️ is APPEND-ONLY — a notice that vanished from the feed keeps its id', () => {
    // ML returns only notices "vigentes no momento da consulta". Rebuilding the
    // list from the current response drops the id of anything expired, and the
    // notice is re-reported as new the next time ML brings it back.
    const proxima = proximaBaseline(
      { ...BASELINE, seenNoticeIds: ['1', '2', '3'] },
      signals({ notices: [notice('4')] }),
    );
    expect(proxima.seenNoticeIds).toEqual(['1', '2', '3', '4']);
  });

  it('never duplicates an id it already had', () => {
    expect(proximaBaseline(BASELINE, signals({ notices: [notice('1')] })).seenNoticeIds).toEqual([
      '1',
    ]);
  });

  it('records the consumption shares so the next run has something to compare', () => {
    expect(proximaBaseline(BASELINE_VAZIA, signals()).consumption).toEqual({
      '200': 96,
      '403': 2.4,
    });
  });

  it('round-trips: applying a baseline then diffing the same signals yields no news', () => {
    // The property that keeps the watch quiet when nothing changes. If this
    // broke, every run would report and the AI would bill every week.
    const s = signals({ notices: [notice('7'), notice('8')] });
    const b = proximaBaseline(BASELINE_VAZIA, s);
    expect(temNovidade(diffWatch(b, s))).toBe(false);
  });
});

describe('renderReport', () => {
  it('names what it SKIPPED, even when the count is zero', () => {
    // A report that silently omits what it ignored reads as "covered everything".
    const s = signals({ notices: [notice('1'), notice('2')] });
    const texto = renderReport(diffWatch(BASELINE, s), s);
    expect(texto).toContain('1 comunicado(s) já triado(s) foram ignorados');
    expect(texto).toContain('2 vieram no feed');
  });

  it('includes the notice body and its links, which are what the AI triages on', () => {
    const s = signals({
      notices: [
        {
          ...notice('9', 'Solicitud revisión'),
          description: 'comenzaremos a rechazar las solicitudes… error 301',
          links: ['https://developers.mercadolibre.com.ar/x'],
        },
      ],
    });
    const texto = renderReport(diffWatch(BASELINE, s), s);
    expect(texto).toContain('Solicitud revisión');
    expect(texto).toContain('error 301');
    expect(texto).toContain('https://developers.mercadolibre.com.ar/x');
    expect(texto).toContain('`9`');
  });

  it('surfaces a first-seen status with its share', () => {
    const s = signals({
      consumption: {
        totalRequests: 1_000_000,
        byStatus: [
          { status: 200, percentage: 96 },
          { status: 403, percentage: 2.4 },
          { status: 301, percentage: 0.5 },
        ],
      },
    });
    const texto = renderReport(diffWatch(BASELINE, s), s);
    expect(texto).toContain('HTTP 301 apareceu pela primeira vez');
  });
});
