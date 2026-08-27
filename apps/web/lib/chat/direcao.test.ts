import { describe, expect, it } from 'vitest';
import { ESTADO_ENVIO, ORIGEM_CONVERSA, ORIGEM_RULES } from '@delfrance/schemas';
import type { EstadoEnvioMensagem, OrigemConversa } from '@delfrance/schemas';

import { mensagemEhNossa, type DirecaoMensagem } from './direcao';

const ML = ORIGEM_CONVERSA.mercadoLivrePedido;
const WA = ORIGEM_CONVERSA.whatsapp;
const EU = 'op1';

function m(partial: Partial<DirecaoMensagem> = {}): DirecaoMensagem {
  return { user_id: null, estadoEnvio: ESTADO_ENVIO.enviado, ...partial };
}

describe('mensagemEhNossa', () => {
  describe('an author outranks everything', () => {
    it('my own uid is mine, whatever the state says', () => {
      for (const estadoEnvio of Object.values(ESTADO_ENVIO)) {
        expect(mensagemEhNossa(m({ user_id: EU, estadoEnvio }), { myUid: EU, origem: WA })).toBe(
          true,
        );
      }
    });

    it('another operator is NOT mine — a state rule must not override an author', () => {
      expect(
        mensagemEhNossa(m({ user_id: 'op2', estadoEnvio: ESTADO_ENVIO.enviado }), {
          myUid: EU,
          origem: WA,
        }),
      ).toBe(false);
    });

    it('the contact is not mine', () => {
      expect(
        mensagemEhNossa(m({ user_id: 'cli', estadoEnvio: ESTADO_ENVIO.recebido }), {
          myUid: EU,
          origem: WA,
        }),
      ).toBe(false);
    });

    it('an authored message with no viewer uid belongs to nobody in particular', () => {
      expect(mensagemEhNossa(m({ user_id: 'op2' }), { origem: WA })).toBe(false);
    });
  });

  describe('authorless on a marketplace thread — the send state decides', () => {
    it.each([
      [ESTADO_ENVIO.salva, true],
      [ESTADO_ENVIO.enviando, true],
      [ESTADO_ENVIO.enviado, true],
      [ESTADO_ENVIO.erro, true],
      [ESTADO_ENVIO.recebido, false],
      [ESTADO_ENVIO.excluido, false],
      [ESTADO_ENVIO.banida, false],
      [ESTADO_ENVIO.desconhecido, false],
    ] as ReadonlyArray<readonly [EstadoEnvioMensagem, boolean]>)(
      'estado %i ⇒ %s',
      (estadoEnvio, esperado) => {
        expect(mensagemEhNossa(m({ estadoEnvio }), { myUid: EU, origem: ML })).toBe(esperado);
      },
    );
  });

  describe('⚠️ authorless on WhatsApp — ours whatever the state, because `recebido` is overloaded', () => {
    // `processStatus.ts` writes `recebido` onto OUR OWN message when the Cloud
    // API reports `read`, and `excluido` on `deleted`. WhatsApp inbound always
    // carries a `user_id`, so an authorless WhatsApp doc can only be ours — and
    // the answer has to survive the whole delivery lifecycle, or the auto-reply
    // bubble jumps to the customer's side the instant they read it.
    it.each([
      ['created', ESTADO_ENVIO.salva],
      ['sent', ESTADO_ENVIO.enviando],
      ['delivered', ESTADO_ENVIO.enviado],
      ['READ — writes estadoEnvio: recebido', ESTADO_ENVIO.recebido],
      ['DELETED — writes estadoEnvio: excluido', ESTADO_ENVIO.excluido],
      ['failed', ESTADO_ENVIO.erro],
    ] as ReadonlyArray<readonly [string, EstadoEnvioMensagem]>)(
      'stays ours after %s',
      (_label, estadoEnvio) => {
        expect(mensagemEhNossa(m({ estadoEnvio }), { myUid: EU, origem: WA })).toBe(true);
      },
    );

    it('is stable across the whole lifecycle — no state flips the answer', () => {
      const respostas = Object.values(ESTADO_ENVIO).map((estadoEnvio) =>
        mensagemEhNossa(m({ estadoEnvio }), { myUid: EU, origem: WA }),
      );
      expect(new Set(respostas)).toEqual(new Set([true]));
    });
  });

  describe('an unknown origem falls back to the state', () => {
    it('is inbound-leaning, which is the safe half', () => {
      // Misplacing OUR message on the contact's side is obvious to an operator;
      // the reverse is a misattribution they cannot detect.
      expect(mensagemEhNossa(m({ estadoEnvio: ESTADO_ENVIO.recebido }), { myUid: EU })).toBe(false);
      expect(mensagemEhNossa(m({ estadoEnvio: ESTADO_ENVIO.enviado }), { myUid: EU })).toBe(true);
    });

    it('treats an absent estadoEnvio as not ours', () => {
      expect(mensagemEhNossa({ user_id: null }, { myUid: EU })).toBe(false);
    });
  });

  it('classifies every origem in ORIGEM_RULES — a new channel must be decided, not defaulted', () => {
    // Iterating the table, so adding an origem without thinking about direction
    // fails here rather than silently landing on one side.
    const semAutorRecebido = Object.keys(ORIGEM_RULES).map((origem) => [
      origem,
      mensagemEhNossa(m({ estadoEnvio: ESTADO_ENVIO.recebido }), {
        myUid: EU,
        origem: origem as OrigemConversa,
      }),
    ]);
    expect(Object.fromEntries(semAutorRecebido)).toEqual({
      site: true,
      facebook: true,
      comentario: true,
      whatsapp: true,
      mlperg: false,
      mlped: false,
      mlclaims: false,
    });
  });
});
