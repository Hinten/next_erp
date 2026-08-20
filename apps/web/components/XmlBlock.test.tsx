import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineTestProvider } from '@/lib/testing/mantine';

import { XmlBlock } from './XmlBlock';

function wrap(node: React.ReactNode) {
  return render(<MantineTestProvider>{node}</MantineTestProvider>);
}

describe('XmlBlock', () => {
  it('renders the value in a code block with a copy affordance', () => {
    wrap(<XmlBlock label="XML enviado" value="<enviNFe>...</enviNFe>" />);

    expect(screen.getByText('<enviNFe>...</enviNFe>')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Copiar XML enviado' })).toBeDefined();
  });

  it('pretty-prints JSON when prettyJson is set', () => {
    wrap(<XmlBlock label="Retorno SEFAZ" value='{"cStat":"100","xMotivo":"ok"}' prettyJson />);

    const code = screen.getByText(/"cStat": "100"/);
    expect(code.textContent).toContain('  "xMotivo": "ok"');
  });

  it('falls back to the raw text when the value is not JSON (SyntaxError only)', () => {
    wrap(<XmlBlock label="Retorno SEFAZ" value="<retEnviNFe/>" prettyJson />);

    expect(screen.getByText('<retEnviNFe/>')).toBeDefined();
  });

  it('renders an em-dash placeholder (and no copy button) on null / empty', () => {
    wrap(<XmlBlock label="XML enviado" value={null} />);

    expect(screen.getByText('—')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Copiar XML enviado' })).toBeNull();
  });

  it('memoizes the pretty-print — a same-props re-render does not re-parse', () => {
    const value = `{"retEnviNFe":{"cStat":"104","xMotivo":"${'x'.repeat(2048)}"}}`;
    const parseSpy = vi.spyOn(JSON, 'parse');
    const { rerender } = wrap(<XmlBlock label="Retorno SEFAZ" value={value} prettyJson />);
    expect(screen.getByText(/"cStat": "104"/)).toBeDefined();
    const callsAfterMount = parseSpy.mock.calls.length;

    rerender(
      <MantineTestProvider>
        <XmlBlock label="Retorno SEFAZ" value={value} prettyJson />
      </MantineTestProvider>,
    );
    expect(screen.getByText(/"cStat": "104"/)).toBeDefined();
    // useMemo on (value, prettyJson) — the re-render must not parse again.
    expect(parseSpy.mock.calls.length).toBe(callsAfterMount);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
