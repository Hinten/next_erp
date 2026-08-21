import { describe, expect, it } from 'vitest';
import {
  formatarPrazo,
  legendaTipoReclamacao,
  rotuloAcao,
  rotuloPapel,
  rotuloResolucaoEsperada,
  rotuloEtapaReclamacao,
  rotuloStatusExpectativa,
  rotuloStatusReclamacao,
} from './reclamacaoLabels';

describe('reclamacaoLabels — unknown ML vocabulary stays legible', () => {
  /**
   * ⚠️ The property that matters on this screen. ML adds vocabulary without
   * notice, and an operator deciding whether to refund must never be shown an
   * empty cell where a value exists — a blank reads as "nothing here", which is
   * a different claim from "ML said something we do not have copy for".
   */
  it.each([
    ['rotuloResolucaoEsperada', rotuloResolucaoEsperada],
    ['rotuloStatusExpectativa', rotuloStatusExpectativa],
    ['rotuloPapel', rotuloPapel],
  ])('%s falls back to the RAW value, not a blank', (_nome, fn) => {
    expect(fn('algo_que_o_ml_inventou')).toBe('algo_que_o_ml_inventou');
  });

  it('rotuloAcao falls back to the raw verb too', () => {
    expect(rotuloAcao('some_new_seller_action')).toBe('some_new_seller_action');
  });

  it('renders an em dash for a genuinely absent value', () => {
    // Distinct from the fallback above: absent is not the same as unrecognised,
    // and the operator should be able to tell them apart.
    expect(rotuloResolucaoEsperada(null)).toBe('—');
    expect(rotuloResolucaoEsperada('')).toBe('—');
    expect(rotuloPapel(null)).toBe('—');
  });

  it('translates the vocabulary ML documents today', () => {
    // The positive control — without it every fallback assertion above would
    // pass on a module that translated nothing at all.
    expect(rotuloResolucaoEsperada('return_product')).toBe(
      'Devolver o produto e receber o dinheiro',
    );
    expect(rotuloStatusExpectativa('pending')).toBe('pendente');
    expect(rotuloPapel('complainant')).toBe('Comprador');
    expect(rotuloAcao('allow_partial_refund')).toBe('Reembolso parcial…');
  });

  it('maps both allow_return verbs to the same button label', () => {
    // ML publishes two verbs for one outcome depending on whether it mints a
    // return label; the operator is taking the same decision either way.
    expect(rotuloAcao('allow_return')).toBe(rotuloAcao('allow_return_label'));
  });
});

describe('legendaTipoReclamacao', () => {
  it('captions PNR and PDD', () => {
    expect(legendaTipoReclamacao('PNR')).toMatch(/não recebido/);
    expect(legendaTipoReclamacao('PDD')).toMatch(/defeito/);
  });

  it('says nothing at all for an unknown type', () => {
    // ⚠️ Silence, not a guess. The caption is descriptive; inventing one for a
    // claim family we do not recognise would state something about the buyer
    // that nobody verified.
    expect(legendaTipoReclamacao(null)).toBeNull();
  });
});

describe('formatarPrazo', () => {
  it('formats a real ML due date', () => {
    expect(formatarPrazo('2026-09-01T15:30:00.000Z')).toMatch(/\d{2}\/\d{2}\/\d{4}/);
  });

  it('returns null rather than "Invalid Date" for junk', () => {
    // ⚠️ A deadline is the one field where a broken render is worse than none:
    // "Invalid Date" next to an action button invites the operator to assume
    // there is no deadline.
    expect(formatarPrazo('nao-e-uma-data')).toBeNull();
    expect(formatarPrazo(null)).toBeNull();
    expect(formatarPrazo('')).toBeNull();
  });
});

describe('rotuloStatusReclamacao / rotuloEtapaReclamacao', () => {
  it('translates the claim state and stage an operator reads FIRST', () => {
    // ⚠️ These were the two most prominent elements on the panel and the only
    // untranslated ones — raw English badges in a pt-BR screen.
    expect(rotuloStatusReclamacao('opened')).toBe('aberta');
    expect(rotuloStatusReclamacao('closed')).toBe('encerrada');
    expect(rotuloEtapaReclamacao('claim')).toBe('reclamação');
    expect(rotuloEtapaReclamacao('dispute')).toBe('mediação');
  });

  it('degrades to the raw value for a stage ML has not shipped yet', () => {
    expect(rotuloEtapaReclamacao('some_new_stage')).toBe('some_new_stage');
    expect(rotuloStatusReclamacao('archived')).toBe('archived');
  });

  it('renders an em dash for absent', () => {
    expect(rotuloStatusReclamacao(null)).toBe('—');
    expect(rotuloEtapaReclamacao('')).toBe('—');
  });
});
