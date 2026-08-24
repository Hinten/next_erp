import { useEffect } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';

import { ContaTabs } from './ContaTabs';

/**
 * ⚠️ These tests deliberately render WITHOUT `env="test"`.
 *
 * Under `MantineProvider env="test"` Mantine skips `<Activity>` entirely
 * (`TabsPanel.mjs:19`), which is exactly the machinery `ContaTabs` opts out of
 * with `keepMountedMode="display-none"`. An `env="test"` render therefore cannot
 * tell the two modes apart: delete the prop and the assertion still passes,
 * green and meaningless. Every other `ContaTabs` test keeps
 * `MantineTestProvider`; this file needs the real thing — the same carve-out,
 * for the same reason, as `SectionTabs.persistence.test.tsx`.
 *
 * What it pins is the invariant the produto's "Salvar alterações" rests on: each
 * `ListingForm` registers its save closure into the editor's `flushesRef` from
 * an effect, and the editor enumerates that registry at click time. Under
 * `<Activity>` an off-screen account's effects unmount, so its listings vanish
 * from the registry and their edits are skipped in silence — while the form's
 * own state survives, so the screen still looks right.
 */
function Probe({ log, name }: { log: string[]; name: string }) {
  useEffect(() => {
    log.push(`${name}:mount`);
    return () => {
      log.push(`${name}:unmount`);
    };
  }, [log, name]);
  return <div data-testid={`probe-${name}`}>painel {name}</div>;
}

function Harness({ log }: { log: string[] }) {
  return (
    <MantineProvider>
      <ContaTabs
        items={[
          { id: 'conta-a', label: 'Loja A' },
          { id: 'conta-b', label: 'Loja B' },
        ]}
        renderPanel={(contaId) => <Probe log={log} name={contaId} />}
      />
    </MantineProvider>
  );
}

function switchTo(name: string) {
  fireEvent.click(screen.getByRole('tab', { name }));
}

describe('ContaTabs persistence', () => {
  it('never mounts an account nobody opened', () => {
    const log: string[] = [];
    render(<Harness log={log} />);

    expect(log).toEqual(['conta-a:mount']);
    expect(screen.queryByTestId('probe-conta-b')).toBeNull();
  });

  it('keeps every opened account mounted across tab switches', () => {
    const log: string[] = [];
    render(<Harness log={log} />);

    switchTo('Loja B');
    expect(log).toEqual(['conta-a:mount', 'conta-b:mount']);

    switchTo('Loja A');
    switchTo('Loja B');

    // Not one unmount in three switches. Under Mantine's default
    // `keepMountedMode='activity'` this log would be littered with them.
    expect(log).toEqual(['conta-a:mount', 'conta-b:mount']);
    expect(screen.getByTestId('probe-conta-a')).toBeTruthy();
    expect(screen.getByTestId('probe-conta-b')).toBeTruthy();
  });
});
