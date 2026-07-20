import { describe, expect, it } from 'vitest';
import { ESTADO_ENVIO } from '@delfrance/schemas';
import { countAwaitingReply, formatBadgeCount } from './badges';

describe('formatBadgeCount', () => {
  it('hides the badge at zero', () => {
    expect(formatBadgeCount(0)).toBeNull();
    expect(formatBadgeCount(-1)).toBeNull();
  });

  it('shows the exact count up to 9', () => {
    expect(formatBadgeCount(1)).toBe('1');
    expect(formatBadgeCount(9)).toBe('9');
  });

  it('caps at "9+" for 10 or more (legacy limit-10 stream)', () => {
    expect(formatBadgeCount(10)).toBe('9+');
    expect(formatBadgeCount(42)).toBe('9+');
  });
});

describe('countAwaitingReply', () => {
  it('counts only conversas whose last message is from the customer (recebido)', () => {
    const last = [
      { estadoEnvio: ESTADO_ENVIO.recebido }, // customer → awaiting reply
      { estadoEnvio: ESTADO_ENVIO.enviado }, // operator delivered
      { estadoEnvio: ESTADO_ENVIO.recebido }, // customer → awaiting reply
      { estadoEnvio: ESTADO_ENVIO.salva }, // outbound queued
      null, // not yet loaded / empty
      undefined,
    ];
    expect(countAwaitingReply(last)).toBe(2);
  });

  it('is zero for an empty set', () => {
    expect(countAwaitingReply([])).toBe(0);
  });
});
