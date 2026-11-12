/**
 * The feed record's pure rules (step 12a, PR 12-b): forward-only status, the
 * processingStatus reading, the two clocks, the outcome of a terminal, and the
 * rung counter; and the two Admin handles' paths against the TTL policy.
 */
import { feedAmazonCollection, vezFeedAmazonCollection } from '@delfrance/data/admin/collections';
import { STATUS_FEED_AMAZON } from '@delfrance/integrations-amazon-sp-api';
import {
  DESFECHO_FEED_AMAZON,
  STATUS_REGISTRO_FEED_AMAZON,
  type StatusRegistroFeedAmazon,
  TTL_POLICIES,
  statusRegistroFeedAmazonSchema,
} from '@delfrance/schemas';
import { describe, expect, it } from 'vitest';

import {
  ABANDONO_FEED_MS,
  PRAZO_FEED_MS,
  abandonoDoFeed,
  atualizacaoDaRodadaFeed,
  desfechoDoStatus,
  prazoDoFeed,
  proximoStatusFeed,
  statusDoProcessamento,
  statusTerminalFeed,
} from './registroFeed';

const S = STATUS_REGISTRO_FEED_AMAZON;
const TODOS = statusRegistroFeedAmazonSchema.options;
const TERMINAIS: readonly StatusRegistroFeedAmazon[] = [
  S.concluido,
  S.falhou,
  S.cancelado,
  S.abandonado,
];
const ANTES = 1_800_000_000_000;
const HORA = 3_600_000;

describe('proximoStatusFeed — forward-only', () => {
  it('★ concluido → processando and concluido → concluido give null; enviado → falhou passes', () => {
    expect(proximoStatusFeed(S.concluido, S.processando)).toBeNull();
    expect(proximoStatusFeed(S.concluido, S.concluido)).toBeNull();
    expect(proximoStatusFeed(S.enviado, S.falhou)).toBe(S.falhou);
  });

  it('every forward pair passes, every equal or backward pair is suppressed', () => {
    const rank = (s: StatusRegistroFeedAmazon) =>
      s === S.enviado ? 0 : s === S.processando ? 1 : 2;
    for (const de of TODOS) {
      for (const para of TODOS) {
        expect(proximoStatusFeed(de, para), `${de} → ${para}`).toBe(
          rank(para) > rank(de) ? para : null,
        );
      }
    }
  });

  it('a terminal never moves to another terminal (one rank: the first stored wins)', () => {
    for (const de of TERMINAIS) {
      for (const para of TERMINAIS) expect(proximoStatusFeed(de, para)).toBeNull();
    }
  });

  it('a value outside the closed set (a raw read) is never written over and never written', () => {
    const estranho = 'DONE' as StatusRegistroFeedAmazon;
    expect(proximoStatusFeed(estranho, S.concluido)).toBeNull();
    expect(proximoStatusFeed(S.enviado, estranho)).toBeNull();
  });

  it('statusTerminalFeed names exactly the four terminals', () => {
    expect(TODOS.filter(statusTerminalFeed)).toEqual(TERMINAIS);
  });
});

describe('statusDoProcessamento — an open string, read exactly', () => {
  it('maps every value the model lists', () => {
    expect(statusDoProcessamento(STATUS_FEED_AMAZON.emFila)).toEqual({
      status: S.processando,
      reconhecido: true,
    });
    expect(statusDoProcessamento(STATUS_FEED_AMAZON.emProcessamento)).toEqual({
      status: S.processando,
      reconhecido: true,
    });
    expect(statusDoProcessamento(STATUS_FEED_AMAZON.concluido)).toEqual({
      status: S.concluido,
      reconhecido: true,
    });
    expect(statusDoProcessamento(STATUS_FEED_AMAZON.fatal)).toEqual({
      status: S.falhou,
      reconhecido: true,
    });
    expect(statusDoProcessamento(STATUS_FEED_AMAZON.cancelado)).toEqual({
      status: S.cancelado,
      reconhecido: true,
    });
  });

  it('an unknown value, or none, keeps the feed processing, flagged for the log', () => {
    for (const valor of ['IN_REVIEW', '', null, undefined]) {
      expect(statusDoProcessamento(valor)).toEqual({ status: S.processando, reconhecido: false });
    }
  });

  it('NEAR-MISS: no case fold or trim — `done` and ` DONE` never end a feed', () => {
    expect(statusDoProcessamento('done').reconhecido).toBe(false);
    expect(statusDoProcessamento(' DONE').status).toBe(S.processando);
    expect(statusDoProcessamento('fatal').status).toBe(S.processando);
  });
});

describe('the clocks', () => {
  it('the deadline is 12 h and the abandonment 48 h after antesDoEnvioMs', () => {
    expect(PRAZO_FEED_MS).toBe(12 * HORA);
    expect(ABANDONO_FEED_MS).toBe(48 * HORA);
    expect(prazoDoFeed(ANTES)).toBe(ANTES + 12 * HORA);
    expect(abandonoDoFeed(ANTES)).toBe(ANTES + 48 * HORA);
  });

  it('a clock that is not a ms instant is a programming error', () => {
    expect(() => prazoDoFeed(-1)).toThrow(RangeError);
    expect(() => abandonoDoFeed(1.5)).toThrow(RangeError);
    expect(() => prazoDoFeed(Number.NaN)).toThrow(RangeError);
  });
});

describe('desfechoDoStatus', () => {
  it('a terminal gives its outcome; an open status none', () => {
    expect(desfechoDoStatus(S.concluido)).toBe(DESFECHO_FEED_AMAZON.concluido);
    expect(desfechoDoStatus(S.falhou)).toBe(DESFECHO_FEED_AMAZON.falhou);
    expect(desfechoDoStatus(S.cancelado)).toBe(DESFECHO_FEED_AMAZON.cancelado);
    expect(desfechoDoStatus(S.abandonado)).toBe(DESFECHO_FEED_AMAZON.abandonado);
    expect(desfechoDoStatus(S.enviado)).toBeNull();
    expect(desfechoDoStatus(S.processando)).toBeNull();
  });

  it('no record status gives `incerto` (a lost createFeed answer leaves no record)', () => {
    expect(TODOS.map(desfechoDoStatus)).not.toContain(DESFECHO_FEED_AMAZON.incerto);
  });
});

describe('atualizacaoDaRodadaFeed — the rung counter', () => {
  const AGORA = ANTES + 7 * HORA;

  it('★ processando → processando writes no status but still advances rodadas and atualizadoEmMs', () => {
    const patch = atualizacaoDaRodadaFeed(
      { status: S.processando, rodadas: 4 },
      S.processando,
      5,
      AGORA,
    );
    expect(patch).toEqual({ rodadas: 5, atualizadoEmMs: AGORA });
    expect('status' in patch).toBe(false);
  });

  it('enviado → processando writes the status beside the counter', () => {
    expect(
      atualizacaoDaRodadaFeed({ status: S.enviado, rodadas: 0 }, S.processando, 0, AGORA),
    ).toEqual({ rodadas: 0, atualizadoEmMs: AGORA, status: S.processando });
  });

  it('rodadas is MAX-merged: a wake-up naming an older rung never lowers it', () => {
    expect(
      atualizacaoDaRodadaFeed({ status: S.processando, rodadas: 7 }, S.processando, 2, AGORA)
        .rodadas,
    ).toBe(7);
  });

  it('NEAR-MISS: a rung that reads a terminal writes at most processando — the terminal is the tail’s LAST write', () => {
    for (const lido of TERMINAIS) {
      expect(
        atualizacaoDaRodadaFeed({ status: S.enviado, rodadas: 1 }, lido, 2, AGORA).status,
      ).toBe(S.processando);
      expect(
        'status' in atualizacaoDaRodadaFeed({ status: S.processando, rodadas: 1 }, lido, 2, AGORA),
      ).toBe(false);
    }
  });

  it('a stale rung over a concluded record moves nothing back, and still stamps the counter', () => {
    expect(
      atualizacaoDaRodadaFeed({ status: S.concluido, rodadas: 9 }, S.processando, 3, AGORA),
    ).toEqual({ rodadas: 9, atualizadoEmMs: AGORA });
  });

  it('a negative or fractional rung, or a non-ms clock, is a programming error', () => {
    const r = { status: S.processando, rodadas: 1 };
    expect(() => atualizacaoDaRodadaFeed(r, S.processando, -1, AGORA)).toThrow(RangeError);
    expect(() => atualizacaoDaRodadaFeed(r, S.processando, 1.5, AGORA)).toThrow(RangeError);
    expect(() => atualizacaoDaRodadaFeed(r, S.processando, 1, -5)).toThrow(RangeError);
  });
});

describe('★ the two Admin handles', () => {
  it('the record handle writes exactly the collection group the TTL policy keys on; the lease handle, one no policy names', () => {
    const grupos = TTL_POLICIES.map((p) => p.collectionGroup);
    // A typo here would leave every record in a collection no policy expires.
    expect(feedAmazonCollection.resolvePath({})).toBe('feedsAmazon');
    expect(grupos).toContain(feedAmazonCollection.resolvePath({}));
    expect(vezFeedAmazonCollection.resolvePath({})).toBe('feedsAmazonEmCurso');
    expect(grupos).not.toContain(vezFeedAmazonCollection.resolvePath({}));
  });
});
