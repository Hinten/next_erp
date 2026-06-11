import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';

import { SectionTabs } from './SectionTabs';

function wrap(node: React.ReactNode) {
  // `env="test"` disables Mantine transitions/portals so panels render
  // synchronously and are queryable.
  return render(<MantineProvider env="test">{node}</MantineProvider>);
}

const CONTENTS = { A: <div>conteúdo A</div>, B: <div>conteúdo B</div> };

describe('SectionTabs', () => {
  it('uncontrolled: first tab active by default, clicking switches', () => {
    wrap(<SectionTabs sections={['A', 'B']} contents={CONTENTS} />);
    expect(screen.getByRole('tab', { name: 'A' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'B' }));
    expect(screen.getByRole('tab', { name: 'B' }).getAttribute('aria-selected')).toBe('true');
  });

  it('controlled: renders the given value and reports clicks via onChange', () => {
    const onChange = vi.fn();
    const { rerender } = wrap(
      <SectionTabs sections={['A', 'B']} contents={CONTENTS} value="A" onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'B' }));
    expect(onChange).toHaveBeenCalledWith('B');
    // Controlled: the active tab only moves when the prop does.
    expect(screen.getByRole('tab', { name: 'A' }).getAttribute('aria-selected')).toBe('true');
    rerender(
      <MantineProvider env="test">
        <SectionTabs sections={['A', 'B']} contents={CONTENTS} value="B" onChange={onChange} />
      </MantineProvider>,
    );
    expect(screen.getByRole('tab', { name: 'B' }).getAttribute('aria-selected')).toBe('true');
  });

  it('marks only the erroring tabs with the error icon', () => {
    wrap(<SectionTabs sections={['A', 'B']} contents={CONTENTS} errorSections={new Set(['B'])} />);
    // The icon's aria-label joins the tab's accessible name — match loosely.
    const tabB = screen.getByRole('tab', { name: /B/ });
    expect(within(tabB).getByRole('img', { name: 'contém campos inválidos' })).toBeTruthy();
    expect(tabB.getAttribute('data-error')).toBe('true');
    const tabA = screen.getByRole('tab', { name: /^A/ });
    expect(within(tabA).queryByRole('img')).toBeNull();
    expect(tabA.hasAttribute('data-error')).toBe(false);
  });
});
