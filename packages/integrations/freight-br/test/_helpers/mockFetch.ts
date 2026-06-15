import { vi } from 'vitest';

/**
 * A `fetch` mock whose `.mock.calls` are typed as `[input, init?]` (the
 * real fetch params), so tests can assert on the URL + RequestInit. A
 * bare `vi.fn(async () => …)` infers a zero-arg signature and types
 * `.mock.calls[0]` as `[]`, which breaks indexing.
 *
 * Pass a factory so each call yields a fresh `Response` (bodies are
 * single-read).
 */
export function mockFetch(factory: () => Response | Promise<Response>) {
  return vi.fn(async (..._args: Parameters<typeof globalThis.fetch>) => factory());
}
