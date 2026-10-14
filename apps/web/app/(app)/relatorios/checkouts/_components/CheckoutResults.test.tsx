import { render } from '@testing-library/react';
import type { YAxisTickContentProps } from 'recharts';
import { describe, expect, it } from 'vitest';
import { UsuarioTick } from './CheckoutResults';

const NAME = 'e2e-38450602010-w0-inicio-colaborador';

// recharts hands a tick renderer the axis' own props; these are the ones the
// vertical BarChart's left axis passed in the 2026-10-13 audit failure.
const tickProps: YAxisTickContentProps = {
  x: 172,
  y: 27,
  angle: 0,
  fill: '#666',
  stroke: 'none',
  index: 0,
  visibleTicksCount: 5,
  textAnchor: 'end',
  verticalAnchor: 'middle',
  tickFormatter: undefined,
  orientation: 'left',
  padding: undefined,
  width: 180,
  className: 'recharts-yAxis yAxis m_a507a517 mantine-BarChart-axis',
  payload: { value: NAME, coordinate: 27, index: 0, offset: 0 },
};

// jsdom measures every string as 0px wide, so recharts never shortens a label
// here; the ellipsis itself is recharts' measured `maxLines` behaviour. These
// pin the inputs that behaviour depends on, each of which broke once.
describe('UsuarioTick', () => {
  function renderTick() {
    const { container } = render(
      <svg>
        <UsuarioTick {...tickProps} />
      </svg>,
    );
    return {
      title: container.querySelector('title'),
      text: container.querySelector('text')!,
    };
  }

  it('keeps the full user name in the SVG title, whatever the axis draws', () => {
    expect(renderTick().title?.textContent).toBe(NAME);
  });

  it('fits the label to the room left of the shifted tick, not to the axis width', () => {
    const { text } = renderTick();
    // 172 (tick x) - 10 (Mantine's tick shift) - 4 (gutter); the axis' own
    // 180 is what recharts wraps to by default, and it overflowed the edge.
    expect(text.getAttribute('width')).toBe('158');
    expect(text.getAttribute('transform')).toBe('translate(-10, 0)');
    expect(text.style.fontSize).toBe('12px');
  });

  it('paints in the chart text colour, never with the axis class the renderer is handed', () => {
    const { text } = renderTick();
    // Mantine's axis class colours axis lines with the faint grid colour; on
    // the label it measured 1.5:1. The default tick drops it, and so must this.
    expect(text.getAttribute('class')).not.toContain('mantine-BarChart-axis');
    expect(text.getAttribute('class')).toContain('recharts-cartesian-axis-tick-value');
    expect(text.getAttribute('fill')).toBe('currentColor');
    expect(text.getAttribute('stroke')).toBe('none');
  });
});
