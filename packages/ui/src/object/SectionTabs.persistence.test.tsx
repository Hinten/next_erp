import { useEffect, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';

import { SectionTabs, useSectionActive } from './SectionTabs';

/**
 * ⚠️ These tests deliberately render WITHOUT `env="test"`.
 *
 * Under `MantineProvider env="test"` Mantine skips `<Activity>` entirely
 * (`TabsPanel.mjs:19`) and so does `SectionTabs`, which means an `env="test"`
 * test cannot observe the behaviour this file exists to pin: an inactive panel
 * having its effects torn down and re-run. Every other SectionTabs test keeps
 * `env="test"`; these need the real thing.
 */
function Probe({ log, name }: { log: string[]; name: string }) {
  const active = useSectionActive();
  useEffect(() => {
    log.push(`${name}:mount`);
    return () => {
      log.push(`${name}:unmount`);
    };
  }, [log, name]);
  return <div data-testid={`probe-${name}`}>{active ? 'ativo' : 'inativo'}</div>;
}

function Harness({ log, persistent }: { log: string[]; persistent: boolean }) {
  const [value, setValue] = useState<string | null>('A');
  return (
    <MantineProvider>
      <SectionTabs
        sections={['A', 'B']}
        contents={{ A: <Probe log={log} name="A" />, B: <Probe log={log} name="B" /> }}
        value={value}
        onChange={setValue}
        persistentSections={persistent ? ['B'] : undefined}
      />
    </MantineProvider>
  );
}

function switchTo(name: string) {
  fireEvent.click(screen.getByRole('tab', { name }));
}

/** Order-agnostic: React may commit the hide and the show in either order. */
function count(log: string[], entry: string) {
  return log.filter((e) => e === entry).length;
}

describe('SectionTabs persistence', () => {
  it('suspends a non-persistent section: its effects are torn down and re-run', () => {
    const log: string[] = [];
    render(<Harness log={log} persistent={false} />);
    // B is hidden, so <Activity> withholds its effects entirely.
    expect(log).toEqual(['A:mount']);

    switchTo('B');
    expect(count(log, 'A:unmount')).toBe(1);
    expect(count(log, 'B:mount')).toBe(1);

    switchTo('A');
    // A's effects re-run from scratch — this is exactly the teardown that
    // discarded the Mercado Livre tab's unsaved work.
    expect(count(log, 'B:unmount')).toBe(1);
    expect(count(log, 'A:mount')).toBe(2);
  });

  it('keeps a persistent section mounted across tab switches', () => {
    const log: string[] = [];
    render(<Harness log={log} persistent />);
    // The cost of opting in: B's effects run from the start, even unopened.
    // That is why the Mercado Livre panel keeps its own lazy gate on top.
    expect(count(log, 'B:mount')).toBe(1);

    switchTo('B');
    switchTo('A');
    switchTo('B');

    // B was never suspended; A still is on every switch.
    expect(count(log, 'B:mount')).toBe(1);
    expect(count(log, 'B:unmount')).toBe(0);
    expect(count(log, 'A:unmount')).toBe(2);
  });

  /**
   * The consequence that costs data, pinned separately from the effect log: a
   * panel that registers a save-time callback into a parent-owned ref loses that
   * registration the moment its tab is hidden. The parent then calls
   * `ref.current?.()` on `null` and skips the writes with no error — which is
   * what happened to the produto Kit tab (#1374) and, before it, to Mercado
   * Livre (`728cb9cc`).
   */
  function FlushProbe({ flushRef }: { flushRef: { current: (() => void) | null } }) {
    useEffect(() => {
      flushRef.current = () => undefined;
      return () => {
        flushRef.current = null;
      };
    }, [flushRef]);
    return <div data-testid="flush-probe" />;
  }

  function FlushHarness({
    flushRef,
    persistent,
  }: {
    flushRef: { current: (() => void) | null };
    persistent: boolean;
  }) {
    const [value, setValue] = useState<string | null>('B');
    return (
      <MantineProvider>
        <SectionTabs
          sections={['A', 'B']}
          contents={{ A: <div />, B: <FlushProbe flushRef={flushRef} /> }}
          value={value}
          onChange={setValue}
          persistentSections={persistent ? ['B'] : undefined}
        />
      </MantineProvider>
    );
  }

  it('drops a non-persistent section’s flush registration when its tab is hidden', () => {
    const flushRef: { current: (() => void) | null } = { current: null };
    render(<FlushHarness flushRef={flushRef} persistent={false} />);
    expect(flushRef.current).not.toBeNull();

    switchTo('A');

    // The known-BAD control: this is the silent skip, reproduced.
    expect(flushRef.current).toBeNull();
  });

  it('keeps a persistent section’s flush registration across a tab switch', () => {
    const flushRef: { current: (() => void) | null } = { current: null };
    render(<FlushHarness flushRef={flushRef} persistent />);
    expect(flushRef.current).not.toBeNull();

    switchTo('A');

    // The fix: a save issued from another tab still finds the callback.
    expect(flushRef.current).not.toBeNull();
  });

  it('reports the active section to the subtree', () => {
    const log: string[] = [];
    render(<Harness log={log} persistent />);
    expect(screen.getByTestId('probe-A').textContent).toBe('ativo');
    expect(screen.getByTestId('probe-B').textContent).toBe('inativo');

    switchTo('B');
    expect(screen.getByTestId('probe-A').textContent).toBe('inativo');
    expect(screen.getByTestId('probe-B').textContent).toBe('ativo');
  });
});
