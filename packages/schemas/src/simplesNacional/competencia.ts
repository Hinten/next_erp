/**
 * Competências fiscais (`YYYY-MM`) e a janela de 12 meses da RBT12.
 *
 * ⚠️ **O mês fiscal é o mês de São Paulo, não o de UTC.** `data_emissao` é ms
 * epoch, e uma nota emitida em 28/02 às 23h30 em São Paulo é 01/03 02h30 em
 * UTC. Cortar a janela em UTC jogaria essa nota para março — um erro de uma
 * nota por virada de mês, sempre na fronteira, sempre plausível.
 *
 * O fuso é passado explicitamente e nunca lido do processo: `apps/nfe` roda com
 * `TZ=America/Sao_Paulo` e os demais backends em UTC, então a mesma função
 * responderia diferente conforme o serviço — que é exatamente o que a regra
 * `delfrance/no-ambient-timezone` existe para impedir.
 */

/** O fuso em que a apuração do Simples é feita. */
export const FUSO_FISCAL = 'America/Sao_Paulo';

/** `'2026-09'`. */
export type Competencia = string;

const COMPETENCIA_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Decompõe `'2026-09'` em `{ ano: 2026, mes: 9 }`; `null` se malformada. */
export function parseCompetencia(competencia: string): { ano: number; mes: number } | null {
  const m = COMPETENCIA_RE.exec(competencia);
  if (m == null) return null;
  return { ano: Number(m[1]), mes: Number(m[2]) };
}

/** `{ ano: 2026, mes: 9 }` → `'2026-09'`. */
export function formatCompetencia(ano: number, mes: number): Competencia {
  return `${String(ano).padStart(4, '0')}-${String(mes).padStart(2, '0')}`;
}

/**
 * O offset do fuso, em minutos, no instante dado — descoberto pelo próprio
 * `Intl` em vez de assumido.
 *
 * ⚠️ O Brasil aboliu o horário de verão em 2019 e São Paulo é UTC−3 fixo desde
 * então, mas assumir `-180` deixaria a conta errada para qualquer data anterior
 * (o corpus legado tem NF-e de 2018) e para qualquer mudança futura de regra.
 * Perguntar custa uma formatação por fronteira, duas por apuração.
 */
function offsetMinutos(instanteUtcMs: number, fuso: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: fuso,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(
    fmt.formatToParts(new Date(instanteUtcMs)).map((x) => [x.type, x.value]),
  );
  // `hour` can come back as '24' at midnight in some ICU versions.
  const hora = Number(p.hour) % 24;
  const comoUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    hora,
    Number(p.minute),
    Number(p.second),
  );
  return (comoUtc - instanteUtcMs) / 60_000;
}

/**
 * O primeiro instante de `YYYY-MM` no fuso fiscal, em ms epoch.
 *
 * Duas passadas: a primeira chuta o offset a partir da meia-noite UTC, a
 * segunda o corrige com o offset que vale no instante encontrado. Isso acerta
 * inclusive uma fronteira que caia dentro de uma mudança de offset.
 */
export function inicioDaCompetencia(
  competencia: string,
  fuso: string = FUSO_FISCAL,
): number | null {
  const partes = parseCompetencia(competencia);
  if (partes === null) return null;
  const meiaNoiteUtc = Date.UTC(partes.ano, partes.mes - 1, 1, 0, 0, 0);
  const primeiroChute = meiaNoiteUtc - offsetMinutos(meiaNoiteUtc, fuso) * 60_000;
  return meiaNoiteUtc - offsetMinutos(primeiroChute, fuso) * 60_000;
}

/** A competência seguinte: `'2026-12'` → `'2027-01'`. */
export function proximaCompetencia(competencia: string): Competencia | null {
  const p = parseCompetencia(competencia);
  if (p === null) return null;
  return p.mes === 12 ? formatCompetencia(p.ano + 1, 1) : formatCompetencia(p.ano, p.mes + 1);
}

/** `n` competências antes: `('2026-01', 1)` → `'2025-12'`. */
export function competenciaAnterior(competencia: string, n = 1): Competencia | null {
  const p = parseCompetencia(competencia);
  if (p === null || n < 0) return null;
  const total = p.ano * 12 + (p.mes - 1) - n;
  if (total < 0) return null;
  return formatCompetencia(Math.floor(total / 12), (total % 12) + 1);
}

/**
 * A janela da RBT12 de uma competência: os **12 meses ANTERIORES**, meia-aberta
 * `[inicio, fim)`.
 *
 * ⚠️ O mês da própria apuração fica **de fora**. A RBT12 é "a receita bruta
 * acumulada nos doze meses anteriores ao período de apuração" (LC 123 art. 18
 * §1º) — incluir o mês corrente inflaria a base e poderia subir a faixa.
 */
export function janelaRbt12(
  competencia: string,
  fuso: string = FUSO_FISCAL,
): { readonly inicioMs: number; readonly fimMs: number; readonly primeira: Competencia } | null {
  const primeira = competenciaAnterior(competencia, 12);
  if (primeira === null) return null;
  const inicioMs = inicioDaCompetencia(primeira, fuso);
  const fimMs = inicioDaCompetencia(competencia, fuso);
  if (inicioMs === null || fimMs === null) return null;
  return { inicioMs, fimMs, primeira };
}

/** A janela do próprio mês de apuração, meia-aberta `[inicio, fim)`. */
export function janelaDaCompetencia(
  competencia: string,
  fuso: string = FUSO_FISCAL,
): { readonly inicioMs: number; readonly fimMs: number } | null {
  const proxima = proximaCompetencia(competencia);
  if (proxima === null) return null;
  const inicioMs = inicioDaCompetencia(competencia, fuso);
  const fimMs = inicioDaCompetencia(proxima, fuso);
  if (inicioMs === null || fimMs === null) return null;
  return { inicioMs, fimMs };
}

/** A competência a que um instante pertence, no fuso fiscal. */
export function competenciaDe(instanteMs: number, fuso: string = FUSO_FISCAL): Competencia {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: fuso,
    year: 'numeric',
    month: '2-digit',
  });
  return fmt.format(new Date(instanteMs)).slice(0, 7);
}
