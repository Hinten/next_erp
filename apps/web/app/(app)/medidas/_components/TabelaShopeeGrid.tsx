'use client';

import { Alert, Group, List, Paper, Stack, Table, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import {
  PROBLEMA_TABELA_SHOPEE,
  SHOPEE_SIZE_CHART_INPUT_TYPE,
  TIPO_CELULA_TABELA_SHOPEE,
  type CelulaTabelaShopee,
  type ColunaTabelaShopee,
  type ProblemaTabelaShopee,
  type TabelaShopeeProjetada,
} from '@delfrance/schemas';

/**
 * READ-ONLY render of ONE Shopee size-chart template, exactly as the shared
 * projector (`projetarTabelaShopee` in `@delfrance/schemas`) produced it.
 *
 * ⚠️ This file never re-projects anything (#1369). Shopee answers column-
 * oriented, and turning that into rows is a decision the projector makes ONCE —
 * type-first cells, rectangularity checked, every unreadable thing reported as a
 * `problema`. Here the output is only DRAWN:
 *
 * - `linhas` non-null → a normal grid, row i = `linhas[i]`.
 * - `linhas === null` (the projector's `tabela-irregular`) → each column is drawn
 *   ON ITS OWN, with its own numbered cells, side by side. Never zipped, padded
 *   or truncated into a grid: a measurement drawn on the wrong size is worse than
 *   a table that visibly does not line up.
 * - `problemas` → one readable pt-BR line each, in an `Alert` ABOVE the table. A
 *   `codigo` this build does not know (a newer `apps/shopee`, deploy skew) gets a
 *   generic line instead of being dropped.
 *
 * Problem positions are the projector's WIRE positions, shown 1-based ("coluna
 * 3"): an unreadable column is excluded from `colunas` but keeps its own number,
 * and its own problem line says so. Mapping a wire position back onto a drawn
 * column would be a second copy of the projector's exclusion rule.
 */
export interface TabelaShopeeGridProps {
  tabela: TabelaShopeeProjetada;
}

/** Width of the frozen first column, shared by the header and body cells (the ML grid's layout). */
const PRIMEIRA_COLUNA_LARGURA = 160;

const celulaFixa = {
  position: 'sticky' as const,
  left: 0,
  zIndex: 1,
  background: 'var(--mantine-color-body)',
  minWidth: PRIMEIRA_COLUNA_LARGURA,
};

/**
 * Display-only number format. Not a fold: nothing compares what it returns.
 * Six fraction digits so a fine measurement never renders rounded to a
 * neighbour (`Intl`'s default is three).
 */
const NUMERO = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 6 });

/** The `input_type`s whose cells are numbers — the only columns a unit belongs to. */
const TIPOS_NUMERICOS: ReadonlySet<string> = new Set([
  SHOPEE_SIZE_CHART_INPUT_TYPE.numero,
  SHOPEE_SIZE_CHART_INPUT_TYPE.faixa,
]);

const TIPOS_CONHECIDOS: ReadonlySet<string> = new Set(Object.values(SHOPEE_SIZE_CHART_INPUT_TYPE));

function unidadeVisivel(unit: string | null): string | null {
  return unit === null || unit.trim() === '' ? null : unit;
}

/**
 * The header of one column.
 *
 * ⚠️ The unit is appended ONLY on a numeric column. Shopee's own doc sample puts
 * `unit: "cm"` on a `Single Dropdown` column, and "01s cm" is not a size. A
 * column whose type this build does not know shows its raw type and its unit —
 * the operator sees what arrived rather than a guess.
 */
export function cabecalhoDaColunaShopee(coluna: ColunaTabelaShopee): {
  titulo: string;
  detalhe: string | null;
} {
  const nome = coluna.displayName ?? '—';
  const unidade = unidadeVisivel(coluna.unit);
  const tipo = coluna.inputType;
  if (tipo !== null && TIPOS_NUMERICOS.has(tipo)) {
    return { titulo: unidade === null ? nome : `${nome} (${unidade})`, detalhe: null };
  }
  if (tipo !== null && TIPOS_CONHECIDOS.has(tipo)) return { titulo: nome, detalhe: null };
  return {
    titulo: unidade === null ? nome : `${nome} (${unidade})`,
    detalhe: tipo === null ? 'tipo não informado' : `tipo “${tipo}”`,
  };
}

/**
 * The text of one cell. Each branch re-checks the value it prints, so a cell a
 * newer server tags differently (or an `invalida` one) renders `—` — never a
 * `null` printed as text.
 */
export function textoDaCelulaShopee(celula: CelulaTabelaShopee): string {
  switch (celula.tipo) {
    case TIPO_CELULA_TABELA_SHOPEE.opcao:
      return celula.option ?? '—';
    case TIPO_CELULA_TABELA_SHOPEE.numero:
      return celula.value === null ? '—' : NUMERO.format(celula.value);
    case TIPO_CELULA_TABELA_SHOPEE.faixa:
      return celula.minValue === null || celula.maxValue === null
        ? '—'
        : `${NUMERO.format(celula.minValue)}–${NUMERO.format(celula.maxValue)}`;
    default:
      return '—';
  }
}

function posicao(n: number | null): string {
  return n === null ? '?' : String(n + 1);
}

function naCelula(p: ProblemaTabelaShopee): string {
  return `linha ${posicao(p.linha)}, coluna ${posicao(p.coluna)}`;
}

/** One problem as one pt-BR sentence. An unknown `codigo` is a generic line, never dropped. */
export function descreverProblemaTabelaShopee(p: ProblemaTabelaShopee): string {
  switch (p.codigo) {
    case PROBLEMA_TABELA_SHOPEE.semColunas:
      return 'A tabela não tem nenhuma coluna legível.';
    case PROBLEMA_TABELA_SHOPEE.colunaIlegivel:
      return `A coluna ${posicao(p.coluna)} não pôde ser lida e foi omitida.`;
    case PROBLEMA_TABELA_SHOPEE.colunaSemMedida:
      return `A coluna ${posicao(p.coluna)} veio sem a descrição da medida.`;
    case PROBLEMA_TABELA_SHOPEE.tipoDeEntradaDesconhecido:
      return p.inputType === null
        ? `A coluna ${posicao(p.coluna)} veio sem tipo de entrada.`
        : `A coluna ${posicao(p.coluna)} tem um tipo de entrada desconhecido (“${p.inputType}”).`;
    case PROBLEMA_TABELA_SHOPEE.celulaIlegivel:
      return `A célula da ${naCelula(p)} não pôde ser lida.`;
    case PROBLEMA_TABELA_SHOPEE.celulaSemValor:
      return `A célula da ${naCelula(p)} está sem valor.`;
    case PROBLEMA_TABELA_SHOPEE.celulaAmbigua:
      return `A célula da ${naCelula(p)} tem mais de um valor; nenhum foi mostrado.`;
    case PROBLEMA_TABELA_SHOPEE.faixaIncompleta:
      return `A faixa da ${naCelula(p)} tem só um dos limites.`;
    case PROBLEMA_TABELA_SHOPEE.tabelaIrregular:
      return (
        'As colunas têm quantidades diferentes de linhas' +
        (p.comprimentos === null ? '' : ` (${p.comprimentos.join(', ')})`) +
        ' — cada coluna é mostrada separada, sem alinhar as linhas.'
      );
    case PROBLEMA_TABELA_SHOPEE.idDivergente:
      return `A Shopee devolveu a tabela #${p.recebido === null ? '?' : String(p.recebido)} ao pedir a #${p.pedido === null ? '?' : String(p.pedido)}.`;
    default:
      return `A tabela tem um problema que esta tela não reconhece (${p.codigo}).`;
  }
}

function Cabecalho({ coluna }: { coluna: ColunaTabelaShopee }) {
  const { titulo, detalhe } = cabecalhoDaColunaShopee(coluna);
  return (
    <Stack gap={0}>
      <Text size="sm" fw={600}>
        {titulo}
      </Text>
      {detalhe !== null && (
        <Text size="xs" c="dimmed">
          {detalhe}
        </Text>
      )}
    </Stack>
  );
}

/** The rectangular case: one row per size. */
function Grade({
  colunas,
  linhas,
}: {
  colunas: readonly ColunaTabelaShopee[];
  linhas: readonly (readonly CelulaTabelaShopee[])[];
}) {
  return (
    <Stack gap="xs">
      <Table.ScrollContainer minWidth={Math.max(360, 160 * colunas.length)} type="native">
        <Table stickyHeader withTableBorder withColumnBorders>
          <Table.Thead>
            <Table.Tr>
              {colunas.map((coluna, c) => (
                <Table.Th key={c} style={c === 0 ? celulaFixa : undefined}>
                  <Cabecalho coluna={coluna} />
                </Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {linhas.map((linha, l) => (
              <Table.Tr key={l} data-testid={`shopee-tabela-grid-linha-${String(l)}`}>
                {linha.map((celula, c) => (
                  <Table.Td key={c} style={c === 0 ? celulaFixa : undefined}>
                    {textoDaCelulaShopee(celula)}
                  </Table.Td>
                ))}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {linhas.length === 0 && (
        <Text size="sm" c="dimmed">
          Nenhuma linha nesta tabela.
        </Text>
      )}
    </Stack>
  );
}

/**
 * The ragged case: every column on its own, its cells numbered by their own
 * position. Side by side so the operator can still compare, but deliberately
 * NOT a table — a shared row line would claim an alignment the data does not have.
 */
function ColunasSeparadas({ colunas }: { colunas: readonly ColunaTabelaShopee[] }) {
  return (
    <Group align="flex-start" gap="sm" wrap="wrap">
      {colunas.map((coluna, c) => (
        <Paper
          key={c}
          withBorder
          p="xs"
          miw={140}
          data-testid={`shopee-tabela-grid-coluna-${String(c)}`}
        >
          <Cabecalho coluna={coluna} />
          {coluna.celulas.length === 0 ? (
            <Text size="sm" c="dimmed" mt={4}>
              (sem células)
            </Text>
          ) : (
            <List size="sm" mt={4} listStyleType="none" spacing={2}>
              {coluna.celulas.map((celula, l) => (
                <List.Item key={l}>
                  <Text span size="xs" c="dimmed">
                    {`${String(l + 1)}. `}
                  </Text>
                  {textoDaCelulaShopee(celula)}
                </List.Item>
              ))}
            </List>
          )}
        </Paper>
      ))}
    </Group>
  );
}

export function TabelaShopeeGrid({ tabela }: TabelaShopeeGridProps) {
  const { colunas, linhas, problemas } = tabela;
  return (
    <Stack gap="xs" data-testid="shopee-tabela-grid">
      {problemas.length > 0 && (
        <Alert
          color="yellow"
          variant="light"
          icon={<IconAlertTriangle size={16} />}
          title="A tabela da Shopee tem problemas de leitura"
          data-testid="shopee-tabela-grid-problemas"
        >
          <List size="sm" spacing={2}>
            {problemas.map((p, i) => (
              <List.Item key={i}>{descreverProblemaTabelaShopee(p)}</List.Item>
            ))}
          </List>
        </Alert>
      )}
      {colunas.length > 0 &&
        (linhas === null ? (
          <ColunasSeparadas colunas={colunas} />
        ) : (
          <Grade colunas={colunas} linhas={linhas} />
        ))}
    </Stack>
  );
}
