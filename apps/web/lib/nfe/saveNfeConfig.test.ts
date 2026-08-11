/**
 * #824 — the Contingência panel used to build its write from the TanStack cache
 * it rendered with, then apply it inside a transaction without re-deriving from
 * the fresh doc. With `refetchOnWindowFocus: false` and no `onSnapshot`, a
 * mounted tab holds that snapshot indefinitely.
 *
 * The damage is asymmetric: an operator who flips only the RTC switch would
 * write the `none` mode from their stale `cfg` and silently switch contingency
 * OFF mid-outage — routing every emission back at the dead SEFAZ while
 * `ContingenciaBanner`, which queries for a mode other than `none`, stops
 * warning.
 */
import { describe, expect, it, vi } from 'vitest';
import { CONTINGENCIA_MODO, type NFeConfig } from '@delfrance/schemas';

import {
  NfeConfigConflictError,
  NfeConfigMissingError,
  saveNfeConfig,
  type NfeConfigSavePort,
} from './saveNfeConfig';

const NOW = 1_700_000_000_000;

const cfg = (over: Partial<NFeConfig> = {}): NFeConfig =>
  ({
    serie: 1,
    numeracao_atual: 10,
    idLote: 5,
    ambiente: 2,
    contingencia_modo: CONTINGENCIA_MODO.none,
    contingencia_justificativa: null,
    contingencia_dataInicio: null,
    emitirReformaTributaria: false,
    timestamp: 1,
    ...over,
  }) as NFeConfig;

/** A port whose `update` feeds `stored` in and captures what came back. */
function fakePort(stored: NFeConfig | null): NfeConfigSavePort & { written: NFeConfig | null } {
  const port = {
    written: null as NFeConfig | null,
    now: () => NOW,
    update: vi.fn(async (nextFor: (c: NFeConfig | null) => NFeConfig) => {
      port.written = nextFor(stored);
    }),
  };
  return port;
}

describe('saveNfeConfig', () => {
  it('re-derives untouched fields from the TX-FRESH doc, not the stale baseline', async () => {
    // The exact reported shape: the tab rendered while contingency was off, an
    // outage turned it on meanwhile, and this operator touches only RTC.
    const baseline = cfg({ contingencia_modo: CONTINGENCIA_MODO.none });
    const fresh = cfg({
      contingencia_modo: CONTINGENCIA_MODO.svc,
      contingencia_justificativa: 'SEFAZ fora do ar desde 08h',
      contingencia_dataInicio: 1_699_000_000_000,
      numeracao_atual: 42,
    });
    const port = fakePort(fresh);

    await saveNfeConfig(
      port,
      { modo: null, justificativa: null, rtc: true, baseline },
      { force: true },
    );

    expect(port.written).toMatchObject({
      // The whole point: contingency stays ON.
      contingencia_modo: CONTINGENCIA_MODO.svc,
      contingencia_justificativa: 'SEFAZ fora do ar desde 08h',
      contingencia_dataInicio: 1_699_000_000_000,
      emitirReformaTributaria: true,
      // And the server-owned counter is never rolled back.
      numeracao_atual: 42,
    });
  });

  it('raises a conflict when a field this save writes changed remotely', async () => {
    const baseline = cfg({ contingencia_modo: CONTINGENCIA_MODO.none });
    const fresh = cfg({
      contingencia_modo: CONTINGENCIA_MODO.svc,
      contingencia_justificativa: 'outage',
    });

    await expect(
      saveNfeConfig(fakePort(fresh), {
        modo: CONTINGENCIA_MODO.epec,
        justificativa: 'preciso emitir agora mesmo',
        rtc: null,
        baseline,
      }),
    ).rejects.toBeInstanceOf(NfeConfigConflictError);
  });

  it('names the overlapping fields on the conflict', async () => {
    const baseline = cfg();
    const fresh = cfg({ contingencia_modo: CONTINGENCIA_MODO.svc, emitirReformaTributaria: true });

    const err = await saveNfeConfig(fakePort(fresh), {
      modo: CONTINGENCIA_MODO.epec,
      justificativa: 'preciso emitir agora mesmo',
      rtc: null,
      baseline,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NfeConfigConflictError);
    // `emitirReformaTributaria` changed remotely too, but this save does not
    // write it — a remote change the operator is not touching is not a conflict.
    expect((err as NfeConfigConflictError).fields).toEqual(['contingencia_modo']);
  });

  it('does not raise a conflict for a remote change to a field it never writes', async () => {
    const baseline = cfg();
    // Only the counter moved — an emission, which happens constantly.
    const port = fakePort(cfg({ numeracao_atual: 99, idLote: 12 }));

    await saveNfeConfig(port, { modo: null, justificativa: null, rtc: true, baseline });

    expect(port.written).toMatchObject({ emitirReformaTributaria: true, numeracao_atual: 99 });
  });

  it('force skips the comparison (the operator reviewed the remote version)', async () => {
    const baseline = cfg({ contingencia_modo: CONTINGENCIA_MODO.none });
    const port = fakePort(cfg({ contingencia_modo: CONTINGENCIA_MODO.svc }));

    await saveNfeConfig(
      port,
      { modo: CONTINGENCIA_MODO.none, justificativa: null, rtc: null, baseline },
      { force: true },
    );

    expect(port.written).toMatchObject({ contingencia_modo: CONTINGENCIA_MODO.none });
  });

  it('stamps dhCont when the mode turns on and clears it on the way back', async () => {
    const on = fakePort(cfg());
    await saveNfeConfig(on, {
      modo: CONTINGENCIA_MODO.svc,
      justificativa: 'SEFAZ fora do ar desde 08h',
      rtc: null,
      baseline: cfg(),
    });
    expect(on.written).toMatchObject({ contingencia_dataInicio: NOW });

    const off = fakePort(
      cfg({ contingencia_modo: CONTINGENCIA_MODO.svc, contingencia_dataInicio: 123 }),
    );
    await saveNfeConfig(
      off,
      {
        modo: CONTINGENCIA_MODO.none,
        justificativa: null,
        rtc: null,
        baseline: cfg({ contingencia_modo: CONTINGENCIA_MODO.svc }),
      },
      { force: true },
    );
    expect(off.written).toMatchObject({
      contingencia_modo: CONTINGENCIA_MODO.none,
      contingencia_dataInicio: null,
      contingencia_justificativa: null,
    });
  });

  it('keeps an existing dhCont while the mode stays on', async () => {
    const port = fakePort(
      cfg({ contingencia_modo: CONTINGENCIA_MODO.svc, contingencia_dataInicio: 123 }),
    );
    await saveNfeConfig(
      port,
      {
        modo: CONTINGENCIA_MODO.epec,
        justificativa: 'mudanca de modo durante a mesma queda',
        rtc: null,
        baseline: cfg({ contingencia_modo: CONTINGENCIA_MODO.svc, contingencia_dataInicio: 123 }),
      },
      { force: true },
    );
    expect(port.written).toMatchObject({ contingencia_dataInicio: 123 });
  });

  it('throws instead of silently succeeding when the doc is gone', async () => {
    // Before #824 this was `if (!snap.exists()) return;` — the edit was
    // discarded and the panel still showed "Configuração de NF-e salva."
    await expect(
      saveNfeConfig(fakePort(null), {
        modo: CONTINGENCIA_MODO.none,
        justificativa: null,
        rtc: true,
        baseline: cfg(),
      }),
    ).rejects.toBeInstanceOf(NfeConfigMissingError);
  });
});
