import { describe, expect, it } from 'vitest';

import { lwaErroSchema, lwaTokenRespostaSchema, spApiErrosSchema } from '../src/types';
import * as fixtures from './_fixtures/sandbox';
import {
  erro400CodigoComEspaco,
  erro400InvalidInput,
  erro400InvalidInputComDetails,
  erro400Vazio,
  erro403Forbidden,
  erro409Duplicado,
  erro429RateLimited,
  erro500InternalFailure,
  erro503ServiceUnavailable,
  lwaInvalidClient,
  lwaInvalidGrant,
  MARCADOR_DESCRICAO,
  tokenRefresh200,
  tokenRefreshSemEco200,
} from './_fixtures/sandbox';
import { ACCESS_TOKEN, REFRESH_TOKEN, SEGREDOS } from './_helpers/mockFetch';

describe('lwaTokenRespostaSchema', () => {
  it("parses the docs' token response (synthetic tokens)", () => {
    expect(lwaTokenRespostaSchema.parse(tokenRefresh200)).toEqual({
      access_token: ACCESS_TOKEN,
      token_type: 'bearer',
      expires_in: 3600,
      refresh_token: REFRESH_TOKEN,
    });
  });

  it('refresh_token may be absent', () => {
    expect(lwaTokenRespostaSchema.safeParse(tokenRefreshSemEco200).success).toBe(true);
  });

  it('a quoted expires_in reads as a number', () => {
    expect(
      lwaTokenRespostaSchema.parse({ ...tokenRefresh200, expires_in: '3600' }).expires_in,
    ).toBe(3600);
  });

  it.each(['3600.5', 'abc', '1e3', '', '0x10'])('near-miss: expires_in %j fails', (expires_in) => {
    expect(lwaTokenRespostaSchema.safeParse({ ...tokenRefresh200, expires_in }).success).toBe(
      false,
    );
  });

  it('token_type is any string, not a "bearer" literal', () => {
    expect(
      lwaTokenRespostaSchema.safeParse({ ...tokenRefresh200, token_type: 'Bearer' }).success,
    ).toBe(true);
  });

  it('an empty access_token fails', () => {
    expect(lwaTokenRespostaSchema.safeParse({ ...tokenRefresh200, access_token: '' }).success).toBe(
      false,
    );
  });

  it('unknown keys survive passthrough', () => {
    const r = lwaTokenRespostaSchema.parse({ ...tokenRefresh200, scope: 'x' });
    expect(r.scope).toBe('x');
  });
});

describe('lwaErroSchema', () => {
  it('accepts {error, error_description}, keeping the description only through passthrough', () => {
    const r = lwaErroSchema.parse(lwaInvalidGrant);
    expect(r.error).toBe('invalid_grant');
    expect(Object.keys(lwaErroSchema.shape)).toEqual(['error']);
    expect(r.error_description).toContain(MARCADOR_DESCRICAO);
  });

  it('parses the documented invalid_client body', () => {
    expect(lwaErroSchema.parse(lwaInvalidClient).error).toBe('invalid_client');
  });

  it('a body without `error` fails', () => {
    expect(lwaErroSchema.safeParse({ error_description: 'x' }).success).toBe(false);
  });
});

describe('spApiErrosSchema', () => {
  it.each([
    ['getOrder 400', erro400InvalidInput, ['InvalidInput']],
    ['searchOrders 400 (with details)', erro400InvalidInputComDetails, ['InvalidInput']],
    ['confirmShipment 400 (a code with a space)', erro400CodigoComEspaco, ['Invalid Input']],
    ['listReturns 403', erro403Forbidden, ['Forbidden']],
    ['listReturns 409', erro409Duplicado, ['DuplicateRequest']],
    ['listReturns 429', erro429RateLimited, ['RateLimited']],
    ['listReturns 500', erro500InternalFailure, ['InternalFailure']],
    ['listReturns 503', erro503ServiceUnavailable, ['ServiceUnavailable']],
  ])('parses the sandbox %s body', (_caso, corpo, codigos) => {
    const r = spApiErrosSchema.parse(corpo);
    expect(r.errors.map((e) => e.code)).toEqual(codigos);
  });

  it('declares only `code` on an entry; message and details survive through passthrough', () => {
    const r = spApiErrosSchema.parse(erro400InvalidInputComDetails);
    expect(r.errors[0]).toMatchObject({ message: 'Invalid Input', details: 'Invalid Input' });
  });

  it('near-miss: the sandbox `{}` 400 fails (no errors key)', () => {
    expect(spApiErrosSchema.safeParse(erro400Vazio).success).toBe(false);
  });

  it('an entry without a code fails', () => {
    expect(spApiErrosSchema.safeParse({ errors: [{ message: 'm' }] }).success).toBe(false);
  });
});

describe('the fixtures', () => {
  it('no SP-API or error fixture carries a synthetic secret — the scrub tests would be vacuous', () => {
    const comTokens = new Set<unknown>([tokenRefresh200, tokenRefreshSemEco200]);
    const corpos = Object.values(fixtures).filter((v) => !comTokens.has(v));
    expect(corpos.length).toBeGreaterThan(10);
    for (const corpo of corpos) {
      const texto = typeof corpo === 'string' ? corpo : JSON.stringify(corpo);
      for (const s of SEGREDOS) expect(texto).not.toContain(s);
    }
  });
});
