import { describe, expect, it } from 'vitest';

import { resumoSalvarAnuncios, type ListingSaveOutcome } from './listingSaveOutcome';

describe('resumoSalvarAnuncios', () => {
  it('says nothing when every listing landed', () => {
    // Each save already showed its own green notification; a summary repeating
    // them is noise, and noise is what makes people dismiss the real ones.
    expect(resumoSalvarAnuncios(['saved'])).toBeNull();
    expect(resumoSalvarAnuncios(['saved', 'saved'])).toBeNull();
  });

  it('says nothing for an empty click', () => {
    expect(resumoSalvarAnuncios([])).toBeNull();
  });

  // ⚠️ THE bug this function exists for. A conta can hold several listings
  // (#781), so one click drives N saves — and an invalid listing returns
  // SILENTLY while its sibling fires an unqualified green "Anúncio salvo.".
  // Without this the operator reads success for a click that saved half.
  it('reports the shortfall when a sibling was silently skipped', () => {
    const resumo = resumoSalvarAnuncios(['invalid', 'saved']);
    expect(resumo).toEqual({
      color: 'yellow',
      message: '1 de 2 anúncios salvos. Corrija os campos destacados.',
    });
  });

  it('goes red when NOTHING landed', () => {
    expect(resumoSalvarAnuncios(['invalid', 'invalid'])?.color).toBe('red');
  });

  it('speaks up for a lone invalid listing, the exit that shows nothing', () => {
    expect(resumoSalvarAnuncios(['invalid'])).toEqual({
      color: 'red',
      message: 'Anúncio não salvo. Corrija os campos destacados.',
    });
  });

  it('stays quiet for a lone listing that already failed loudly', () => {
    // The conflict modal and the red notification are louder and more specific
    // than a summary; repeating them trains people to dismiss toasts.
    expect(resumoSalvarAnuncios(['conflict'])).toBeNull();
    expect(resumoSalvarAnuncios(['failed'])).toBeNull();
  });

  it('still reports the count when a loud failure skipped a sibling', () => {
    // The modal names ONE listing. That the other did save is information only
    // the caller has.
    expect(resumoSalvarAnuncios(['conflict', 'saved'])).toEqual({
      color: 'yellow',
      message: '1 de 2 anúncios salvos. Revise as diferenças antes de salvar.',
    });
    expect(resumoSalvarAnuncios(['failed', 'saved'])?.message).toContain('Veja o erro informado.');
  });

  it('leads with the invalid fields, the only reason nothing else names', () => {
    const resumo = resumoSalvarAnuncios(['conflict', 'invalid', 'saved']);
    expect(resumo?.message).toContain('Corrija os campos destacados.');
  });

  it('counts a legitimate no-op as saved', () => {
    // `ListingNothingChangedError` shows its own notification and wrote nothing
    // because nothing needed writing — the operator was told, so it is not a
    // shortfall to report a second time.
    const outcomes: ListingSaveOutcome[] = ['saved', 'saved'];
    expect(resumoSalvarAnuncios(outcomes)).toBeNull();
  });
});
