import { describe, expect, it } from 'vitest';
import * as barrel from './index';
import {
  CABECALHO_CHAVE_RELAY_AMAZON,
  CAMINHO_RECEPTOR_AMAZON,
  CAMPO_CORPO_RELAY_AMAZON,
  MODELO_ENTRADA_RELAY_AMAZON,
} from './relayAmazon';

/** RFC 9110 §5.6.2 `token`: what a header field name may be. */
const TOKEN_HTTP = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

describe('the relay ⇄ receiver contract', () => {
  it('is exported from the barrel, so both sides import ONE copy', () => {
    expect(barrel.CABECALHO_CHAVE_RELAY_AMAZON).toBe(CABECALHO_CHAVE_RELAY_AMAZON);
    expect(barrel.CAMPO_CORPO_RELAY_AMAZON).toBe(CAMPO_CORPO_RELAY_AMAZON);
    expect(barrel.MODELO_ENTRADA_RELAY_AMAZON).toBe(MODELO_ENTRADA_RELAY_AMAZON);
    expect(barrel.CAMINHO_RECEPTOR_AMAZON).toBe(CAMINHO_RECEPTOR_AMAZON);
  });

  it('wraps the body in a one-field object, so a JSON body stays JSON', () => {
    expect(MODELO_ENTRADA_RELAY_AMAZON).toBe('{"body": <$.body>}');

    // What the Pipe does: the placeholder becomes the SQS body, verbatim.
    const corpo = { NotificationType: 'ORDER_CHANGE', Payload: { a: [1, 'x'] } };
    const enviado = MODELO_ENTRADA_RELAY_AMAZON.replace(
      `<$.${CAMPO_CORPO_RELAY_AMAZON}>`,
      JSON.stringify(corpo),
    );
    expect(JSON.parse(enviado)).toEqual({ [CAMPO_CORPO_RELAY_AMAZON]: corpo });
  });

  it('refuses the near-miss: a bare placeholder is not a JSON object', () => {
    // A bare `<$.body>` template is the shape that strips a JSON body's quotes.
    // The contract's template must never degrade to it.
    expect(MODELO_ENTRADA_RELAY_AMAZON).not.toBe(`<$.${CAMPO_CORPO_RELAY_AMAZON}>`);
    expect(MODELO_ENTRADA_RELAY_AMAZON.startsWith('{')).toBe(true);
    expect(MODELO_ENTRADA_RELAY_AMAZON.endsWith('}')).toBe(true);
  });

  it('names the key header with a lowercase HTTP token outside the reserved prefixes', () => {
    expect(CABECALHO_CHAVE_RELAY_AMAZON).toMatch(TOKEN_HTTP);
    expect(CABECALHO_CHAVE_RELAY_AMAZON).toBe(CABECALHO_CHAVE_RELAY_AMAZON.toLowerCase());
    expect(CABECALHO_CHAVE_RELAY_AMAZON.startsWith('x-')).toBe(true);
    expect(CABECALHO_CHAVE_RELAY_AMAZON).not.toBe('authorization');
    for (const prefixo of ['x-goog-', 'x-google-']) {
      expect(CABECALHO_CHAVE_RELAY_AMAZON.startsWith(prefixo)).toBe(false);
    }
  });

  it('puts the receiver under /api/, outside the CORS matcher', () => {
    expect(CAMINHO_RECEPTOR_AMAZON.startsWith('/api/')).toBe(true);
    expect(CAMINHO_RECEPTOR_AMAZON.startsWith('/api/marketplace/')).toBe(false);
    expect(CAMINHO_RECEPTOR_AMAZON.endsWith('/')).toBe(false);
  });
});
