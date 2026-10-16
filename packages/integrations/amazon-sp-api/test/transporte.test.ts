import { describe, expect, it } from 'vitest';

import { type ChamadaAmazon, criarEmissor, type ParteDoEvento } from '../src/transporte';

/*
 * The internal module, tested directly where a guarantee is STRUCTURAL and a
 * call site cannot show it: `lwa.ts` already passes `corpo: null`, so only a
 * test of the emitter itself proves the flag would still drop a body that a
 * future call site forgot to.
 */

const fixo = {
  destino: 'lwa',
  operacao: 'trocarRefreshToken',
  metodo: 'POST',
  caminho: '/auth/o2/token',
  query: [],
  correlationId: 'corr-1',
  refCredencial: 'ref-1',
} as const;

const parte: ParteDoEvento = {
  resultado: 'ok',
  status: 200,
  latenciaMs: 12,
  requestIdAmazon: 'req-1',
  limiteTaxa: null,
  corpo: '{"access_token":"MARCADOR-CORPO"}',
};

function emitirUma(levaCorpo: boolean, p: ParteDoEvento): ChamadaAmazon[] {
  const eventos: ChamadaAmazon[] = [];
  criarEmissor(fixo, levaCorpo, (e) => eventos.push(e))(p);
  return eventos;
}

describe('criarEmissor', () => {
  it('levaCorpo: false drops a body a call site passed — the LWA guarantee', () => {
    const [e] = emitirUma(false, parte);
    expect(e?.corpo).toBeNull();
    expect(JSON.stringify(e)).not.toContain('MARCADOR-CORPO');
  });

  it('near-miss: levaCorpo: true keeps it — the SP-API observer gets the (scrubbed) text', () => {
    const [e] = emitirUma(true, parte);
    expect(e?.corpo).toBe(parte.corpo);
  });

  it('builds the event from named fields only — an extra key never rides along', () => {
    const comExtra = { ...parte, headers: { 'x-amz-access-token': 'MARCADOR-HEADER' } };
    const [e] = emitirUma(true, comExtra);
    expect(Object.keys(e ?? {}).sort()).toEqual(
      [
        'caminho',
        'codigoLwa',
        'codigosErro',
        'corpo',
        'correlationId',
        'destino',
        'latenciaMs',
        'limiteTaxa',
        'metodo',
        'operacao',
        'query',
        'refCredencial',
        'requestIdAmazon',
        'resultado',
        'status',
      ].sort(),
    );
    expect(JSON.stringify(e)).not.toContain('MARCADOR-HEADER');
  });

  it('defaults the optional parts: no codes, no LWA code', () => {
    const [e] = emitirUma(true, parte);
    expect(e).toMatchObject({ codigosErro: [], codigoLwa: null });
  });

  it('does nothing without an observer', () => {
    expect(() => criarEmissor(fixo, true, undefined)(parte)).not.toThrow();
  });
});
