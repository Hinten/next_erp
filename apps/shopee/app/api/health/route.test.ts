import { describe, expect, it } from 'vitest';

import { GET } from './route';

describe('GET /api/health', () => {
  it('answers ok for the shopee service', async () => {
    const res = GET();
    expect(res.status).toBe(200);

    const body = (await res.json()) as { status: string; service: string; timestamp: string };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('shopee');
    // A well-formed ISO timestamp, not a specific value — the route stamps `now`.
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });
});
