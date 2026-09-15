/**
 * The pure half of `scripts/varrer-reservas.ts` (#1516, step 8) — argument
 * parsing, the **redacted** per-candidate summary, the report renderer and the
 * usage text.
 *
 * ⚠️ **It lives here rather than in the script because `scripts/` is outside
 * this app's vitest `include`** (`{app,lib,functions}/**\/*.test.ts`), so logic
 * written in a script file can never be tested. Same reasoning and same shape
 * as `importarPedidoCli.ts` and `liquidarPagamentosCli.ts` two files over. The
 * script keeps the I/O and nothing else.
 *
 * ⚠️ **Script-only, imported by no route, no sweep and no bundle.** Nothing here
 * reads `process.env`, opens a client or touches Firestore, and it converts no
 * clock: the ONE µs number it handles (`cutoffUs`) is DISPLAY, the position
 * `liquidarPagamentosCli.ts` already holds.
 *
 * ## Why the rehearsal is the load-bearing artefact of step 8
 *
 * The central question — *does Shopee auto-cancel an unpaid BR order, after how
 * long, and with which `cancel_by`/`cancel_reason`* — is answered by NO page of
 * the 215-page documentation cache, and the sandbox cannot produce an aged
 * unpaid order (order creation there has no payment step at all). So a few
 * weeks of DRY-RUN ticks over live data are the only instrument that exists,
 * and this CLI is how they are run before the master flag is ever turned on.
 *
 * ## The redaction is an ALLOW-LIST, and that is the whole design
 *
 * {@link resumoDoCandidato} copies no input object. Every field of
 * {@link ResumoReservaTravada} is named and constructed one at a time, so a
 * field that is not listed cannot appear in the output — including one a future
 * schema change adds, and including everything a Shopee buyer authored. A
 * denylist has the opposite property: it protects the fields somebody
 * remembered.
 *
 * The defence is layered, and this is the second layer: the sweep already never
 * lets a `get_order_detail` row out (it asks for three optional fields and
 * never `buyer_cancel_reason`), so the buyer's own words never reach this
 * process at all.
 */
import { microsToMillis } from '@delfrance/core/datetime';

import { ArgumentoInvalidoError, descreverErro } from './importarPedidoCli';
import { VEREDITOS_RESERVA_TRAVADA } from './reservaTravadaMapping';
// ⚠️ TYPE-ONLY, and structurally so: a VALUE import of the sweep would pull
// `firebase-admin/firestore` and the collection handles into the `--help` path,
// which the script keeps free of every heavy import behind `await import(...)`.
// It is also why the age buckets below are read off the result map's own keys
// instead of importing `BUCKETS_IDADE` — the map is zero-SEEDED from that same
// list, so its key order IS the list, with no second copy to drift.
import type { CandidatoObservado, ReservaTravadaSweepResult } from './reservaTravadaSweep';

export { ArgumentoInvalidoError };

/* -------------------------------------------------------------------------- */
/*                                  arguments                                  */
/* -------------------------------------------------------------------------- */

/**
 * ⚠️ No `--` separator in any documented invocation: pnpm forwards the literal
 * token INTO the script and every CLI in this repo parses `process.argv`
 * itself, so the separator would be read as an argument.
 * `packages/config-eslint/rules/pnpm-run-args.test.js` fails CI on the spelling
 * that carries one — a flag on both sides of the separator — including inside
 * this string. (`dotenv -e … -- tsx` in `package.json` is dotenv-cli's own
 * separator and is correct; a command after the separator never matches.)
 */
export const USO_VARRER_RESERVAS = `
Ensaia a varredura semanal de reservas travadas da Shopee.

  pnpm --filter @delfrance/shopee-app varrer:reservas [opções]

Escopo
  --integracao <id>   restringe o tick a UMA conta (ex.: int-1). Sem ele, todas
                      as contas ativas, como o agendamento faz.

Opções
  --max-idade-d <n>   sobrescreve SHOPEE_PEDIDO_TRAVADO_MAX_IDADE_D (>0).
  --dry-run           lê o Firestore E a Shopee, decide e conta; NÃO enfileira e
                      NÃO escreve aviso nenhum. É o PADRÃO.
  --live              executa o tick de verdade (enfileira + escreve avisos).
                      ⚠️ Exige SHOPEE_PEDIDO_TRAVADO_SWEEP_ENABLED=1 no ambiente:
                      este script não contorna a flag mestra.
  --project <id>      sobrescreve FIREBASE_PROJECT_ID antes de abrir o admin.
  --json              imprime o mesmo resumo redigido em JSON no stdout
                      (o cabeçalho vai para o stderr).
  --help, -h          mostra esta ajuda e sai com 0, sem abrir o Firestore nem
                      chamar a Shopee.

O dry-run CHAMA a Shopee (get_order_detail em lotes de 50) e lê o Firestore — ele
não grava. Ver apps/shopee/scripts/README.md §10.
`.trim();

export interface ArgsVarrerReservas {
  /** `null` ⇒ every active conta, exactly as the schedule runs. */
  readonly integracaoId: string | null;
  /** `null` ⇒ whatever `SHOPEE_PEDIDO_TRAVADO_MAX_IDADE_D` resolves to (default 7). */
  readonly maxIdadeDias: number | null;
  /** `false` — the DRY-RUN default. `--live` is the only way to write. */
  readonly live: boolean;
  /** `null` keeps whatever the environment resolves. */
  readonly projectId: string | null;
  readonly json: boolean;
  /** `--help`/`-h`, answered before ANY validation and before any import. */
  readonly help: boolean;
}

function valorDe(nome: string, inline: string | undefined, proximo: string | undefined): string {
  const bruto = (inline ?? proximo)?.trim();
  if (bruto == null || bruto.length === 0 || bruto.startsWith('--')) {
    throw new ArgumentoInvalidoError(`--${nome} exige um valor.`);
  }
  return bruto;
}

/**
 * A strictly positive whole-day horizon.
 *
 * ⚠️ `0` is refused rather than clamped: a zero horizon would make EVERY open
 * reservation a candidate, which is a 2 000-document scan and up to 200 Shopee
 * calls spent on orders nobody thinks are stuck. `Number()` rather than
 * `parseInt`, so `7d` and `x` are refused instead of silently reading as `7`
 * and `NaN`.
 */
function diasDe(bruto: string): number {
  const n = Number(bruto);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ArgumentoInvalidoError(
      `--max-idade-d precisa ser um número maior que zero: ${bruto}`,
    );
  }
  return n;
}

/**
 * Parse the command line. Pure — it reads no environment and no clock.
 *
 * ⚠️ `--help` is answered BEFORE anything is validated, so `--help` beside a
 * contradictory pair still exits 0 with the usage. The script's side of that
 * bargain is to return before its first `await import(...)`.
 *
 * ⚠️ **Dry-run is the default and `--live` is the only opt-in.** Passing both
 * `--dry-run` and `--live` is a contradiction and is REFUSED rather than
 * resolved by precedence: whichever way a precedence rule fell, half the
 * readers of the command line would expect the other.
 */
export function parseArgsVarrerReservas(argv: readonly string[]): ArgsVarrerReservas {
  if (argv.some((a) => a === '--help' || a === '-h')) {
    return {
      integracaoId: null,
      maxIdadeDias: null,
      live: false,
      projectId: null,
      json: false,
      help: true,
    };
  }

  let integracaoId: string | undefined;
  let maxIdade: string | undefined;
  let projectId: string | undefined;
  let live = false;
  let dryRunExplicito = false;
  let json = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--') {
      throw new ArgumentoInvalidoError(
        'Separador "--" recebido como argumento: o pnpm repassa esse token para o script. ' +
          'Remova-o e passe as flags direto (veja --help).',
      );
    }
    const igual = arg.indexOf('=');
    const nome = igual === -1 ? arg : arg.slice(0, igual);
    const inline = igual === -1 ? undefined : arg.slice(igual + 1);
    switch (nome) {
      case '--integracao':
        integracaoId = valorDe('integracao', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--max-idade-d':
        maxIdade = valorDe('max-idade-d', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--project':
        projectId = valorDe('project', inline, argv[i + 1]);
        if (inline === undefined) i += 1;
        break;
      case '--live':
        live = true;
        break;
      case '--dry-run':
        dryRunExplicito = true;
        break;
      case '--json':
        json = true;
        break;
      default:
        throw new ArgumentoInvalidoError(`Opção desconhecida: ${arg}`);
    }
  }

  if (live && dryRunExplicito) {
    throw new ArgumentoInvalidoError('--live e --dry-run são contraditórios; escolha um.');
  }

  return {
    integracaoId: integracaoId ?? null,
    maxIdadeDias: maxIdade === undefined ? null : diasDe(maxIdade),
    live,
    projectId: projectId ?? null,
    json,
    help: false,
  };
}

/* -------------------------------------------------------------------------- */
/*                            the redacted summary                             */
/* -------------------------------------------------------------------------- */

/**
 * ONE candidate, reduced to what a rehearsal needs and nothing else.
 *
 * It is {@link CandidatoObservado} itself — the sweep's observation seam was
 * designed as this allow-list, so re-declaring a parallel shape here would be
 * two types that drift toward plausible while disagreeing (root `CLAUDE.md`:
 * the copies read correct and the reviewer cannot diff them by eye). What this
 * module owns is the CONSTRUCTION — {@link resumoDoCandidato} — and the pinned
 * field list.
 */
export type ResumoReservaTravada = CandidatoObservado;

/**
 * The allow-list itself, exported so a test can pin the field COUNT.
 *
 * ⚠️ **Twelve fields.** `satisfies` proves every name is a real key; the test's
 * `Object.keys` round trip proves the reverse — that no key of the built object
 * is missing from this list, which is the direction a leak travels.
 */
export const CAMPOS_RESUMO_RESERVA_TRAVADA = [
  'pedidoId',
  'integracaoId',
  'orderSn',
  'veredito',
  'orderStatus',
  'pendingTerms',
  'temPayTime',
  'idadeDias',
  'cancelBy',
  'cancelReason',
  'enfileiraria',
  'avisaria',
] as const satisfies readonly (keyof ResumoReservaTravada)[];

/**
 * Build one candidate's summary — FIELD BY FIELD, never by spreading the input.
 *
 * ⚠️ The spread is the whole point of not using one: `{ ...c }` would carry
 * anything a future field adds to {@link CandidatoObservado}, and a cast that
 * smuggles extra keys onto the argument would carry those too. Pinned by a test
 * that passes exactly such a cast.
 */
export function resumoDoCandidato(c: CandidatoObservado): ResumoReservaTravada {
  return {
    pedidoId: c.pedidoId,
    integracaoId: c.integracaoId,
    orderSn: c.orderSn,
    veredito: c.veredito,
    orderStatus: c.orderStatus,
    pendingTerms: c.pendingTerms,
    temPayTime: c.temPayTime,
    idadeDias: c.idadeDias,
    cancelBy: c.cancelBy,
    cancelReason: c.cancelReason,
    enfileiraria: c.enfileiraria,
    avisaria: c.avisaria,
  };
}

/**
 * The `--json` document: the sweep's own result plus the redacted rows.
 *
 * ⚠️ The result is emitted whole and that is SAFE by construction — it carries
 * counters, per-conta rows and `erros: {pedidoId, message}[]`, and no wire row
 * has ever reached it. The rows are the redacted half, and they are the half a
 * test has to watch.
 */
export function documentoVarredura(
  resultado: ReservaTravadaSweepResult,
  linhas: readonly ResumoReservaTravada[],
): { resultado: ReservaTravadaSweepResult; candidatos: readonly ResumoReservaTravada[] } {
  return { resultado, candidatos: linhas };
}

/* -------------------------------------------------------------------------- */
/*                                 rendering                                   */
/* -------------------------------------------------------------------------- */

function txt(v: string | null): string {
  return v == null || v.length === 0 ? '—' : v;
}

function simNao(v: boolean): string {
  return v ? 'sim' : 'não';
}

/**
 * A µs stamp as `<raw> (<ISO UTC>)`.
 *
 * ⚠️ **UTC, never the ambient zone.** `apps/shopee` is a server surface for
 * `delfrance/no-ambient-timezone`, and the cutoff a rehearsal reports must not
 * depend on which machine ran it. DISPLAY only — this module converts no clock.
 */
function carimboUs(us: number): string {
  const ms = microsToMillis(us);
  if (!Number.isFinite(ms)) return String(us);
  return `${String(us)} (${new Date(ms).toISOString()})`;
}

function linhaContagem(rotulo: string, valor: number | string): string {
  return `  ${rotulo.padEnd(30, '.')} ${String(valor)}`;
}

/** `chave=valor` pairs on one line — a table row compacted. */
function vetor(entradas: readonly (readonly [string, number])[]): string {
  return entradas.map(([k, v]) => `${k}=${String(v)}`).join(' ');
}

/**
 * The whole report, as lines.
 *
 * ⚠️ **Every verdict arm is printed, including the zero-valued ones.** The
 * rehearsal instrument is a week-over-week diff, and an omitted key is
 * indistinguishable from an arm that did not exist last week — which is the
 * same reason the sweep seeds its counter map from the union rather than
 * building it as verdicts arrive.
 *
 * ⚠️ The five gate-1 counters print under their own heading because they are
 * **never summed with `candidatos`**: a verdict is a statement about a pedido
 * the channel PROVED it owns, and `Σ veredictos === candidatos` is only an
 * invariant while the rejects stay outside it.
 */
export function renderResumoVarredura(
  r: ReservaTravadaSweepResult,
  linhas: readonly ResumoReservaTravada[],
): string[] {
  const out: string[] = [];

  out.push(
    r.dryRun
      ? '== DRY-RUN — nada foi gravado, nada foi enfileirado =='
      : '== LIVE — a varredura de verdade ==',
  );
  out.push('');

  if (!r.enabled) {
    out.push(linhaContagem('habilitada ', 'NÃO'));
    out.push(linhaContagem('motivo ', txt(r.motivo)));
    out.push('');
    out.push(
      '  ⚠️ A flag mestra SHOPEE_PEDIDO_TRAVADO_SWEEP_ENABLED está desligada, então o tick ' +
        'não leu NADA.',
    );
    out.push('     Para ensaiar sem ligá-la, rode sem --live (o dry-run é o padrão).');
    return out;
  }

  out.push(linhaContagem('fila de tasks ', r.tasksDesabilitado ? 'DESABILITADA' : 'aberta'));
  out.push(linhaContagem('horizonte (dias) ', r.maxIdadeDias));
  out.push(linhaContagem('corte (timestamp <) ', carimboUs(r.cutoffUs)));
  out.push(
    linhaContagem(
      'documentos examinados ',
      `${String(r.examinados)} em ${String(r.paginas)} página(s)`,
    ),
  );
  out.push(
    linhaContagem('candidatos ', `${String(r.candidatos)}   truncado=${simNao(r.truncado)}`),
  );
  out.push('');

  out.push('### porteiras 1 — ⚠️ nunca somadas com candidatos');
  out.push(linhaContagem('naoMarketplace ', r.naoMarketplace));
  out.push(linhaContagem('adotado ', r.adotado));
  out.push(linhaContagem('contaInativa ', r.contaInativa));
  out.push(linhaContagem('foraDoEscopo ', r.foraDoEscopo));
  out.push(linhaContagem('semShopId ', r.semShopId));
  out.push('');

  out.push('### vereditos — Σ = candidatos');
  for (const v of VEREDITOS_RESERVA_TRAVADA) out.push(linhaContagem(`${v} `, r.veredictos[v]));
  out.push('');

  out.push('### efeitos (somados das contas)');
  const soma = (
    campo: 'chamadas' | 'enfileirados' | 'avisosEscritos' | 'avisosResolvidos',
  ): number => r.contas.reduce((a, c) => a + c[campo], 0);
  out.push(linhaContagem('chamadas get_order_detail ', soma('chamadas')));
  out.push(linhaContagem('enfileirados ', soma('enfileirados')));
  out.push(linhaContagem('avisos escritos ', soma('avisosEscritos')));
  out.push(linhaContagem('avisos resolvidos ', soma('avisosResolvidos')));
  out.push(linhaContagem('redrive sem efeito aparente ', r.redriveAparentementeNaoAplicado));
  out.push('');

  out.push('### reconciliação dos avisos abertos');
  out.push(linhaContagem('varridos ', r.avisosVarridos));
  out.push(linhaContagem('reconciliados ', r.reconciliados));
  out.push(linhaContagem('truncada ', simNao(r.reconciliacaoTruncada)));
  out.push('');

  out.push('### marketplace.status armazenado — a tabela do item 37');
  const statusChaves = Object.keys(r.statusArmazenado).sort();
  if (statusChaves.length === 0) out.push('  (nenhum)');
  for (const s of statusChaves) out.push(linhaContagem(`${s} `, r.statusArmazenado[s] ?? 0));
  out.push('');

  out.push('### idade do marketplace.statusEm (dias)');
  out.push(`  ${vetor(Object.entries(r.idadeStatusDias))}`);
  out.push('');

  out.push('### status armazenado × idade');
  const porIdade = Object.keys(r.statusPorIdade).sort();
  if (porIdade.length === 0) out.push('  (nenhum)');
  for (const s of porIdade) {
    const linha = r.statusPorIdade[s];
    if (linha === undefined) continue;
    out.push(`  ${s}: ${vetor(Object.entries(linha))}`);
  }
  out.push('');

  out.push('### status armazenado × veredito');
  const porVeredito = Object.keys(r.statusArmazenadoPorVeredito).sort();
  if (porVeredito.length === 0) out.push('  (nenhum)');
  for (const s of porVeredito) {
    const linha = r.statusArmazenadoPorVeredito[s];
    if (linha === undefined) continue;
    out.push(`  ${s}: ${vetor(VEREDITOS_RESERVA_TRAVADA.map((v) => [v, linha[v]] as const))}`);
  }
  out.push('');

  out.push(`### contas (${String(r.contas.length)})`);
  if (r.contas.length === 0) {
    out.push('  (nenhuma conta ATIVA no escopo — confira --integracao e o campo `ativo`)');
  }
  for (const c of r.contas) {
    out.push(
      `  ${c.integracaoId}  shop=${c.shopId == null ? '—' : String(c.shopId)}  pulada=${txt(c.pulada)}`,
    );
    out.push(
      `    candidatos=${String(c.candidatos)} lotes=${String(c.lotes)} fallback=${String(c.lotesComFallback)} chamadas=${String(c.chamadas)}`,
    );
    out.push(
      `    enfileirados=${String(c.enfileirados)} avisos=${String(c.avisosEscritos)} resolvidos=${String(c.avisosResolvidos)}`,
    );
    const codigos = Object.entries(c.codigosInexistente);
    if (codigos.length > 0) {
      out.push(`    códigos inexistente: ${vetor(codigos.map(([k, v]) => [k, v] as const))}`);
    }
    out.push(`    erro=${txt(c.error)}`);
  }
  out.push('');

  out.push(`### erros por candidato (${String(r.erros.length)})`);
  if (r.erros.length === 0) out.push('  (nenhum)');
  for (const e of r.erros) out.push(`  ${e.pedidoId}  ${e.message}`);
  out.push('');

  // A stable column order, so two weeks of output diff line by line.
  out.push(`### candidatos observados (${String(linhas.length)})`);
  if (linhas.length === 0) out.push('  (nenhum)');
  for (const l of linhas) {
    out.push(`  ${l.pedidoId}  ${l.integracaoId}  ${l.orderSn}  ${l.veredito}`);
    out.push(
      `    status=${txt(l.orderStatus)} pendingTerms=${l.pendingTerms == null || l.pendingTerms.length === 0 ? '—' : l.pendingTerms.join(',')} payTime=${simNao(l.temPayTime)} idade=${l.idadeDias == null ? '—' : `${String(l.idadeDias)}d`}`,
    );
    out.push(
      `    cancelBy=${txt(l.cancelBy)} cancelReason=${txt(l.cancelReason)} enfileiraria=${simNao(l.enfileiraria)} avisaria=${simNao(l.avisaria)}`,
    );
  }
  out.push('');
  out.push('  (a linha do get_order_detail nunca sai da varredura — nenhum dado do comprador)');
  return out;
}

/* -------------------------------------------------------------------------- */
/*                                   errors                                    */
/* -------------------------------------------------------------------------- */

/**
 * One failure, described by CLASS plus the fields that identify it.
 *
 * ⚠️ The Shopee half is `importarPedidoCli.ts`'s {@link descreverErro},
 * IMPORTED rather than re-implemented — the CLIs of this app face the same
 * error taxonomy and a second copy of that table is how one of them starts
 * printing a payload. Only the ARGUMENT arm is this module's, because the usage
 * text it has to print is this module's.
 */
export function descreverErroVarredura(err: unknown): string[] {
  if (err instanceof ArgumentoInvalidoError) {
    return [`❌ ${err.message}`, '', USO_VARRER_RESERVAS];
  }
  return descreverErro(err);
}
