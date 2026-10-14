'use client';

import { BarChart } from '@mantine/charts';
import { Paper, Stack, Table, Text, Title } from '@mantine/core';
import { Text as SvgText, type YAxisTickContentProps } from 'recharts';
import type { CheckoutReport } from '@/lib/reports/aggregations';

const USER_AXIS_WIDTH = 180;
// Mantine's BarChart shifts its left-axis ticks 10px away from the bars at
// 12px in the theme's text colour. A custom tick replaces that default, so it
// restates all three — and the shift is room the label no longer has.
const TICK_SHIFT = 10;
const TICK_FONT_SIZE = 12;
// The measurement is a DOM span's advance width; SVG glyph layout can round a
// subpixel wider, so keep the first glyph clear of the SVG's clipping edge.
const TICK_GUTTER = 4;

/**
 * One user label on the y-axis. `usuarios.nome` is unbounded (a full legal
 * name, an e2e fixture's 37-character id) and recharts wraps only at spaces,
 * so a long name ran past the chart's left edge and was clipped (readability
 * audit, 2026-10-13). Fit it to the room measured left of the tick with an
 * ellipsis and keep the whole name in the SVG `<title>`; the bar tooltip and
 * the table below show it in full as well.
 */
export function UsuarioTick({ payload, x, y, textAnchor, verticalAnchor }: YAxisTickContentProps) {
  const label = String(payload.value);
  return (
    <g>
      <title>{label}</title>
      <SvgText
        x={x}
        y={y}
        textAnchor={textAnchor}
        verticalAnchor={verticalAnchor}
        // NOT the `className` recharts hands a tick renderer: it carries
        // Mantine's axis class, which paints in the faint grid colour (1.5:1).
        // The default tick drops it and inherits the chart's text colour.
        className="recharts-cartesian-axis-tick-value"
        transform={`translate(-${TICK_SHIFT}, 0)`}
        // `width` + `maxLines` make recharts measure the rendered string and
        // cut it with "…"; it measures with `style`, not the font attribute.
        width={Math.max(0, Number(x) - TICK_SHIFT - TICK_GUTTER)}
        maxLines={1}
        style={{ fontSize: TICK_FONT_SIZE }}
        fill="currentColor"
        stroke="none"
      >
        {label}
      </SvgText>
    </g>
  );
}

export function CheckoutResults({ report }: { report: CheckoutReport }) {
  return (
    <Stack>
      <Paper withBorder p="md">
        <Text c="dimmed" size="sm">
          Total de checkouts
        </Text>
        <Text size="xl" fw={700}>
          {report.total.toLocaleString('pt-BR')}
        </Text>
      </Paper>
      {report.total === 0 ? (
        <Text c="dimmed">Nenhum checkout encontrado no período.</Text>
      ) : (
        <>
          <Title order={2} size="h3">
            Checkouts por Usuário
          </Title>
          <Text size="sm" c="dimmed">
            Até 20 colaboradores atuais ou antigos entre os usuários com mais checkouts. Os demais e
            os não identificados entram em Outros usuários.
          </Text>
          <BarChart
            h={Math.max(300, report.rows.length * 36)}
            data={report.rows.map((row) => ({ usuario: row.label, Checkouts: row.count }))}
            dataKey="usuario"
            orientation="vertical"
            yAxisProps={{ width: USER_AXIS_WIDTH, tick: UsuarioTick }}
            xAxisProps={{ allowDecimals: false }}
            series={[{ name: 'Checkouts', color: 'blue.6' }]}
            withTooltip
          />
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Usuário</Table.Th>
                <Table.Th ta="right">Checkouts</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {report.rows.map((row) => (
                <Table.Tr key={row.userId === null ? 'other' : `user:${row.userId}`}>
                  {/* The same unbounded name: wrap it inside the cell rather than
                      widen the table past a phone viewport. */}
                  <Table.Td style={{ overflowWrap: 'anywhere' }}>{row.label}</Table.Td>
                  <Table.Td ta="right">{row.count.toLocaleString('pt-BR')}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </>
      )}
    </Stack>
  );
}
