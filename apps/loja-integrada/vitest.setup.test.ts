/**
 * Anti-vacuity for the unit config's network kill-switch (`vitest.setup.ts`):
 * a test that forgets to stub `fetch` must fail LOUDLY instead of reaching a
 * real host — Loja Integrada above all (D17).
 *
 * ⚠️ The hosts below are under `.invalid`, a name that never resolves: if the
 * setup file stopped being loaded, or stopped replacing `fetch`, these cases
 * fail with a DNS error instead of the switch's own message — red, and without
 * ever reaching a real platform. Never point this test at a real host: it is the
 * one test whose failure mode IS an unstubbed request — the first case below
 * enforces it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('the unit config’s network kill-switch', () => {
  it('⚠️ this file names no host but `.invalid` ones and this machine — a real host here would be reached the day the switch broke', () => {
    const texto = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const hosts = [...texto.matchAll(/\bhttps?:\/\/([^/'"`\s:]+)/g)].map((m) => m[1] ?? '');
    // Anti-vacuity: the scan sees the cases below.
    expect(hosts.length).toBeGreaterThanOrEqual(4);
    expect(hosts.filter((h) => !h.endsWith('.invalid') && h !== '127.0.0.1')).toEqual([]);
  });

  it.each([
    'https://api.loja.example.invalid/v1/situacao/',
    'https://exemplo.invalid/',
    new URL('https://api.loja.example.invalid/v1/pedido/1/'),
  ])('a fetch to %s throws the switch’s own refusal before anything is sent', async (alvo) => {
    await expect(globalThis.fetch(alvo)).rejects.toThrow(/rede bloqueada nos testes de unidade/);
  });

  it('a Request object is refused too', async () => {
    await expect(
      globalThis.fetch(new Request('https://api.loja.example.invalid/v1/')),
    ).rejects.toThrow(/rede bloqueada/);
  });

  it('⚠️ NEAR-MISS: a local host is NOT refused by the switch (the Admin SDK’s emulator traffic)', async () => {
    // Nothing listens on this port: whatever the outcome, it is NOT the switch's refusal.
    const desfecho = await globalThis
      .fetch('http://127.0.0.1:9/', { signal: AbortSignal.timeout(2_000) })
      .then(() => 'respondeu')
      .catch((err: unknown) => (err instanceof Error ? err.message : 'outro'));
    expect(desfecho).not.toMatch(/rede bloqueada/);
  });
});
