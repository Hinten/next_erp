/**
 * Message-timestamp formatter — a faithful port of the legacy `MsgStatusWidget`
 * date logic (`.old/lib/chat/basico/mensagem.dart:376-440`). Legacy formatted
 * `data_cadastro` against `DateTime.now()`:
 *   - within ±1 day  → `HH:mm`;
 *   - within ±365 days → `HH:mm (dd/MM)`   (legacy `DateFormat.Md`);
 *   - older          → `HH:mm (dd/MM/yyyy)` (legacy `DateFormat.yMd`).
 *
 * Pure (takes `now` as a parameter) so it is unit-testable across the
 * boundaries. `pt-BR` locale gives the `dd/MM[/yyyy]` ordering the Flutter app
 * rendered (`DateFormat.Md`/`yMd` under a pt_BR locale).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 365 * DAY_MS;

function hhmm(d: Date): string {
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function ddMM(d: Date): string {
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

function ddMMyyyy(d: Date): string {
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/**
 * Format a message timestamp (epoch ms) relative to `now`. Returns `''` for a
 * missing timestamp (legacy rendered nothing).
 */
export function formatMensagemTime(
  ms: number | null | undefined,
  now: number = Date.now(),
): string {
  if (ms == null) return '';
  const d = new Date(ms);
  const diff = Math.abs(now - ms);
  if (diff <= DAY_MS) return hhmm(d);
  if (diff <= YEAR_MS) return `${hhmm(d)} (${ddMM(d)})`;
  return `${hhmm(d)} (${ddMMyyyy(d)})`;
}

/**
 * The "visualizado" read-receipt tooltip text (legacy `mensagem.dart:480-481`:
 * `Visualizado: HH:mm (dd/MM/yyyy)`). Always the full date form, unlike the
 * relative message timestamp above.
 */
export function formatVisualizado(ms: number): string {
  const d = new Date(ms);
  return `Visualizado: ${hhmm(d)} (${ddMMyyyy(d)})`;
}
