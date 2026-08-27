import { describe, expect, it } from 'vitest';
import { ORIGEM_CONVERSA, origemConversaSchema, type OrigemConversa } from '@delfrance/schemas';
import { CONFIRMACAO_ENVIO, confirmacaoEnvio } from './confirmacaoEnvio';
import { enviaPorRota } from './transporteEnvio';

/**
 * ⚠️ The origens come from the SCHEMA, never from `CONFIRMACAO_ENVIO` itself.
 * A test that iterates the constant it validates cannot catch a deleted key —
 * the row simply stops running and the suite still reports green.
 */
const ORIGENS = origemConversaSchema.options as readonly OrigemConversa[];

describe('CONFIRMACAO_ENVIO', () => {
  it('classifies every origem — no origem is missing from the table', () => {
    // The anti-vacuity anchor for everything below: `satisfies Record<…>` already
    // rejects a MISSING key at compile time, but this is what fails loudly if the
    // schema gains an origem and the table is regenerated from the wrong source.
    expect(Object.keys(CONFIRMACAO_ENVIO).sort()).toEqual(ORIGENS.slice().sort());
  });

  /**
   * ⚠️ THE cross-check, and the reason to read it twice.
   *
   * `ChatComposer` consults this table INSIDE its `porRota` branch — the reply is
   * confirmed on the way to the channel backend, not on the way to Firestore. So
   * a confirmation declared on a non-route origem is a promise the UI silently
   * never keeps: the dialog is configured, never shown, and the send goes through
   * unconfirmed with nothing failing anywhere.
   */
  it.each(ORIGENS)('%s: a declared confirmation is on an origem that can honour it', (origem) => {
    if (CONFIRMACAO_ENVIO[origem] !== null) {
      expect(
        enviaPorRota(origem),
        `${origem} declares a confirmation the composer never shows`,
      ).toBe(true);
    }
  });

  it('asks only on Mercado Livre questions', () => {
    // A question accepts exactly ONE answer: it is published on the anúncio, it
    // cannot be edited or retracted, and the successful send closes the thread.
    expect(confirmacaoEnvio(ORIGEM_CONVERSA.mercadoLivrePerguntas)).not.toBeNull();
  });

  it('does NOT ask on the multi-turn channels', () => {
    // ⚠️ Not an oversight — a deliberate scope. `mlped` and `mlclaims` take the
    // same single-shot route and are just as un-editable at the API, but both
    // leave `respostaBloqueada: null` and the operator keeps writing. Confirming
    // there is fatigue that trains people to click through the dialog above.
    expect(confirmacaoEnvio(ORIGEM_CONVERSA.mercadoLivrePedido)).toBeNull();
    expect(confirmacaoEnvio(ORIGEM_CONVERSA.mercadoLivreReclamacoes)).toBeNull();
    expect(confirmacaoEnvio(ORIGEM_CONVERSA.whatsapp)).toBeNull();
  });

  it('spells out both consequences in the warning it shows', () => {
    // The dialog earns its interruption only by saying WHY. Two facts do the
    // work — one answer only, and the atendimento ends — and a rewrite that
    // drops either turns this into a speed bump people learn to click past.
    const confirmacao = confirmacaoEnvio(ORIGEM_CONVERSA.mercadoLivrePerguntas);
    expect(confirmacao?.aviso).toMatch(/UMA resposta/);
    expect(confirmacao?.aviso).toMatch(/não pode ser desfeita/);
    expect(confirmacao?.aviso).toMatch(/encerrado/);
  });

  it('labels the confirm button with its own words, not the composer’s', () => {
    // The send affordance is an icon labelled "Enviar". Reusing that word on the
    // confirm button would make the dialog dismissable by muscle memory — the
    // operator would be repeating the click they already made, not deciding.
    expect(confirmacaoEnvio(ORIGEM_CONVERSA.mercadoLivrePerguntas)?.confirmar).not.toMatch(
      /^Enviar$/,
    );
  });

  it('rejects a mistyped origem AT COMPILE TIME', () => {
    // The property the narrow parameter buys. A widened `string` would let
    // `confirmacaoEnvio('mlpergunta')` compile and answer "no confirmation
    // needed" — the guard silently absent on the one origem that needs it.
    // @ts-expect-error — a value outside OrigemConversa must not be accepted.
    expect(() => confirmacaoEnvio('mlpergunta')).toBeDefined();
  });
});
