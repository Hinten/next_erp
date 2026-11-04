import { describe, expect, it } from 'vitest';

import {
  MAX_APPLICATION_ID,
  URL_CONSENTIMENTO_BR,
  VERSAO_CONSENTIMENTO_RASCUNHO,
  applicationIdValido,
  montarUrlConsentimento,
} from '../src/consentimento';
import { AmazonConfigError, AmazonError } from '../src/errors';

/** The models' own sandbox placeholder for an application id — never a real one. */
const APPLICATION_ID = 'amzn1.sp.solution.00000000-0000-0000-0000-000000000000';
/** A state shaped like the shared seam's (`base64url.base64url`). */
const STATE = 'eyJpZCI6ImMxIn0.c2lnbmF0dXJlLXNlbnRpbmVsYQ';
const REDIRECT_URI = 'https://erp.example/api/oauth/amazon/callback';

function montar(over: Partial<Parameters<typeof montarUrlConsentimento>[0]> = {}): string {
  return montarUrlConsentimento({
    applicationId: APPLICATION_ID,
    state: STATE,
    redirectUri: REDIRECT_URI,
    ...over,
  });
}

function recusa(over: Partial<Parameters<typeof montarUrlConsentimento>[0]>): AmazonConfigError {
  try {
    montar(over);
  } catch (err) {
    if (err instanceof AmazonConfigError) return err;
    throw err;
  }
  throw new Error('esperava AmazonConfigError');
}

describe('montarUrlConsentimento', () => {
  it('pins the BR consent page and the Draft version', () => {
    expect(URL_CONSENTIMENTO_BR).toBe('https://sellercentral.amazon.com.br/apps/authorize/consent');
    expect(VERSAO_CONSENTIMENTO_RASCUNHO).toBe('beta');
    expect(MAX_APPLICATION_ID).toBe(200);
  });

  it('writes exactly application_id, state, version=beta and redirect_uri, in that order', () => {
    const url = new URL(montar());
    expect(`${url.origin}${url.pathname}`).toBe(URL_CONSENTIMENTO_BR);
    expect([...url.searchParams.keys()]).toEqual([
      'application_id',
      'state',
      'version',
      'redirect_uri',
    ]);
    expect(url.searchParams.get('application_id')).toBe(APPLICATION_ID);
    expect(url.searchParams.get('state')).toBe(STATE);
    expect(url.searchParams.get('version')).toBe('beta');
    // Decoded, it is the very string the exchange must repeat.
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.hash).toBe('');
  });

  it('carries no client id, secret or any other key', () => {
    const texto = montar();
    for (const proibido of ['client_id', 'client_secret', 'response_type', 'scope', 'code']) {
      expect(new URL(texto).searchParams.has(proibido), proibido).toBe(false);
    }
  });

  it('never trims: the state reaches the URL byte for byte', () => {
    const state = 'a.b-c_d';
    expect(new URL(montar({ state })).searchParams.get('state')).toBe(state);
  });

  it.each([
    ['empty', ''],
    ['with a space', 'amzn1.sp.solution.0000 0000'],
    ['with a line break', `${APPLICATION_ID}\n`],
    ['non-ASCII', 'amzn1.sp.solução'],
    ['too long', 'a'.repeat(MAX_APPLICATION_ID + 1)],
  ])('an application id %s → AmazonConfigError("application-id")', (_c, applicationId) => {
    const err = recusa({ applicationId });
    expect(err.motivo).toBe('application-id');
    expect(err.operacao).toBe('montarUrlConsentimento');
    expect(err.refCredencial).toBeNull();
    if (applicationId !== '') expect(err.message).not.toContain(applicationId);
  });

  it('accepts an application id of exactly the maximum length (near-miss of "too long")', () => {
    const applicationId = 'a'.repeat(MAX_APPLICATION_ID);
    expect(new URL(montar({ applicationId })).searchParams.get('application_id')).toBe(
      applicationId,
    );
  });

  it.each([
    ['empty', ''],
    ['with a space', 'abc def'],
    ['with a trailing line break', `${STATE}\n`],
    ['non-ASCII', 'estado-é'],
  ])('a state %s → AmazonConfigError("state"), never echoed', (_c, state) => {
    const err = recusa({ state });
    expect(err.motivo).toBe('state');
    if (state !== '') expect(err.message).not.toContain(state.trim());
  });

  it.each([
    ['http (a localhost dev URI)', 'http://localhost:3011/api/oauth/amazon/callback'],
    ['a fragment', `${REDIRECT_URI}#x`],
    ['userinfo', 'https://user:pass@erp.example/callback'],
    ['relative', '/api/oauth/amazon/callback'],
    ['empty', ''],
  ])('a redirect_uri with %s → AmazonConfigError("redirect-uri")', (_c, redirectUri) => {
    const err = recusa({ redirectUri });
    expect(err.motivo).toBe('redirect-uri');
  });

  it('checks application_id, then state, then redirect_uri', () => {
    expect(recusa({ applicationId: '', state: '', redirectUri: '' }).motivo).toBe('application-id');
    expect(recusa({ state: '', redirectUri: '' }).motivo).toBe('state');
  });

  it('a refusal is an AmazonError like every other config refusal', () => {
    expect(recusa({ state: '' })).toBeInstanceOf(AmazonError);
  });
});

describe('applicationIdValido — the one predicate the consent URL and the receiver share', () => {
  it.each([
    ['the placeholder id', APPLICATION_ID],
    ['exactly the maximum length', 'a'.repeat(MAX_APPLICATION_ID)],
    ['one character', 'a'],
  ])('accepts %s', (_c, valor) => {
    expect(applicationIdValido(valor)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['with a space', 'amzn1.sp.solution.0000 0000'],
    ['with a trailing space', `${APPLICATION_ID} `],
    ['with a trailing line break', `${APPLICATION_ID}\n`],
    ['non-ASCII', 'amzn1.sp.solução'],
    ['too long', 'a'.repeat(MAX_APPLICATION_ID + 1)],
    ['not a string', 42],
    ['null', null],
  ])('refuses %s', (_c, valor) => {
    expect(applicationIdValido(valor)).toBe(false);
  });

  it('montarUrlConsentimento refuses exactly what the predicate refuses', () => {
    for (const valor of ['', `${APPLICATION_ID} `, 'a'.repeat(MAX_APPLICATION_ID + 1)]) {
      expect(applicationIdValido(valor)).toBe(false);
      expect(recusa({ applicationId: valor }).motivo).toBe('application-id');
    }
    expect(applicationIdValido(APPLICATION_ID)).toBe(true);
    expect(() => montar({ applicationId: APPLICATION_ID })).not.toThrow();
  });
});
