import { describe, expect, it } from 'vitest';
import { ESTADO_CONVERSA } from '@delfrance/schemas';
import { composerGate } from './composerGate';

describe('composerGate', () => {
  it('returns no-uid when there is no authenticated user', () => {
    expect(
      composerGate({ usuarios: ['op1'], estadoConversa: ESTADO_CONVERSA.emResposta, uid: null }),
    ).toBe('no-uid');
  });

  it('returns compose when the operator is a participant of an in-progress conversa', () => {
    expect(
      composerGate({
        usuarios: ['op1', 'op2'],
        estadoConversa: ESTADO_CONVERSA.emResposta,
        uid: 'op1',
      }),
    ).toBe('compose');
  });

  it('returns enter when the operator is not a participant', () => {
    expect(
      composerGate({ usuarios: ['op2'], estadoConversa: ESTADO_CONVERSA.emResposta, uid: 'op1' }),
    ).toBe('enter');
  });

  it('returns enter when the conversa is not in the emResposta state', () => {
    expect(
      composerGate({
        usuarios: ['op1'],
        estadoConversa: ESTADO_CONVERSA.naoRespondido,
        uid: 'op1',
      }),
    ).toBe('enter');
  });

  it('treats a null/undefined usuarios array as "not a participant"', () => {
    expect(
      composerGate({ usuarios: null, estadoConversa: ESTADO_CONVERSA.emResposta, uid: 'op1' }),
    ).toBe('enter');
    expect(
      composerGate({ usuarios: undefined, estadoConversa: ESTADO_CONVERSA.emResposta, uid: 'op1' }),
    ).toBe('enter');
  });
});
