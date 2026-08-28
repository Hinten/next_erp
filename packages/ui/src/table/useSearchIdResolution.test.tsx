import { describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { type SearchIdResolution, useSearchIdResolution } from './useSearchIdResolution';

/**
 * The async half of `TableView`'s search box.
 *
 * What is worth pinning here is the TAG on a settled answer — term plus
 * generation. It is simultaneously the staleness guard (an out-of-order settle
 * is not the current term's) and the invalidation handle (a generation bump
 * re-asks). Both failure modes are silent: the wrong rows, rendered
 * confidently.
 */
type Props = {
  resolve?: (term: string) => Promise<SearchIdResolution | null>;
  term: string;
  gen?: number;
};

function render(initial: Props) {
  return renderHook(({ resolve, term, gen }: Props) => useSearchIdResolution(resolve, term, gen), {
    initialProps: initial,
  });
}

describe('useSearchIdResolution', () => {
  it('is idle with no resolver, and never calls one for an empty term', async () => {
    const resolve = vi.fn(() => Promise.resolve({ ids: ['a'] }));
    const { result } = render({ resolve, term: '' });
    expect(result.current).toEqual({
      ids: undefined,
      loading: false,
      error: null,
      truncated: false,
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('reports loading, then the resolved ids', async () => {
    const resolve = vi.fn(() => Promise.resolve({ ids: ['a', 'b'], truncated: true }));
    const { result } = render({ resolve, term: 'MLB1' });
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.ids).toEqual(['a', 'b']);
    expect(result.current.truncated).toBe(true);
  });

  it('keeps `undefined` ids when the resolver DECLINES, so the caller falls through', async () => {
    const resolve = vi.fn(() => Promise.resolve(null));
    const { result } = render({ resolve, term: 'camiseta' });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.ids).toBeUndefined();
  });

  it('distinguishes "handled, nothing matched" from a decline', async () => {
    const resolve = vi.fn(() => Promise.resolve({ ids: [] }));
    const { result } = render({ resolve, term: 'MLB1' });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.ids).toEqual([]);
  });

  it('surfaces a rejection as an Error', async () => {
    const resolve = vi.fn(() => Promise.reject(new Error('boom')));
    const { result } = render({ resolve, term: 'MLB1' });
    await waitFor(() => expect(result.current.error?.message).toBe('boom'));
    expect(result.current.ids).toBeUndefined();
  });

  it('does not re-ask while the term and generation both hold', async () => {
    const resolve = vi.fn(() => Promise.resolve({ ids: ['a'] }));
    const { result, rerender } = render({ resolve, term: 'MLB1', gen: 0 });
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ resolve, term: 'MLB1', gen: 0 });
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('re-asks when the generation bumps, and does not serve the old answer meanwhile', async () => {
    // ⚠️ The regression this exists for: without the generation in the tag, a
    // settled answer is cached for the life of the component. The update
    // monitor's "Atualizar" would then re-execute the row query against a
    // STALE id set — a fresh read of the wrong documents, which is exactly the
    // state that banner exists to get the operator out of.
    const resolve = vi
      .fn<(term: string) => Promise<SearchIdResolution | null>>()
      .mockResolvedValueOnce({ ids: ['antigo'] })
      .mockResolvedValueOnce({ ids: ['novo'] });

    const { result, rerender } = render({ resolve, term: 'MLB1', gen: 0 });
    await waitFor(() => expect(result.current.ids).toEqual(['antigo']));

    rerender({ resolve, term: 'MLB1', gen: 1 });
    // Serving the cached list here would be the bug wearing a loading state's
    // clothes: the caller would query the old ids and call them fresh.
    expect(result.current.loading).toBe(true);
    expect(result.current.ids).toBeUndefined();

    await waitFor(() => expect(result.current.ids).toEqual(['novo']));
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('ignores an answer that settles after the term moved on', async () => {
    // Two resolutions can be in flight at once and settle out of order; a slow
    // answer for `MLB1` landing after a fast one for `MLB12` is not the current
    // term's, and must not overwrite it.
    let releaseLento: (v: SearchIdResolution) => void = () => {};
    const resolve = vi
      .fn<(term: string) => Promise<SearchIdResolution | null>>()
      .mockImplementationOnce(
        () =>
          new Promise<SearchIdResolution>((res) => {
            releaseLento = res;
          }),
      )
      .mockResolvedValueOnce({ ids: ['rapido'] });

    const { result, rerender } = render({ resolve, term: 'MLB1' });
    rerender({ resolve, term: 'MLB12' });
    await waitFor(() => expect(result.current.ids).toEqual(['rapido']));

    releaseLento({ ids: ['lento'] });
    await Promise.resolve();
    expect(result.current.ids).toEqual(['rapido']);
  });
});
