/**
 * Writing a clean run's fixtures into `__wire__/`, as close to all or nothing as
 * a file system allows.
 *
 * Two phases. Every fixture is first written to a temporary file beside it
 * (`.<nome>.json.tmp`); only when ALL of them are written is each renamed over
 * its `<nome>.json`. So a failed write (a full disk, a file locked by an editor
 * or an antivirus) leaves every fixture as it was. A rename can still fail
 * part-way; then `progresso` says exactly which fixtures were replaced, and the
 * script's unexpected-error handler prints it (`resumoDoProgressoAmazon`). Every
 * temporary still on disk is removed on the way out, failure or not.
 *
 * There is no `catch`: the error propagates unchanged to that handler, and the
 * clean-up runs in a `finally`. The content written is already sanitized, so a
 * partial write is a consistency problem, never a leak.
 *
 * Pure apart from the injected disk.
 */
import type { EscritaDeFixtureAmazon } from './executar';

/** What writing touches, bound by the script to `node:fs` (a test passes a fake). */
export interface DiscoDasFixturesAmazon {
  /** Writes `texto` to the temporary file of `nome`, beside `<nome>.json`. */
  readonly escreverTemporario: (nome: string, texto: string) => void;
  /** Renames the temporary file of `nome` over `<nome>.json`, replacing it. */
  readonly promover: (nome: string) => void;
  /** Removes the temporary file of `nome` when it exists; a missing one is not an error. */
  readonly descartarTemporario: (nome: string) => void;
}

/** How far the writing got, read by the unexpected-error handler. */
export interface ProgressoDaEscritaAmazon {
  /** The fixtures due, in order. */
  devidas: readonly string[];
  /** Those already renamed over their `<nome>.json`, in order. */
  readonly promovidas: string[];
}

export function novoProgressoDaEscritaAmazon(): ProgressoDaEscritaAmazon {
  return { devidas: [], promovidas: [] };
}

/** Writes every fixture: all temporaries first, then each rename. Throws whatever the disk throws. */
export function escreverFixturesAmazon(
  escritas: readonly EscritaDeFixtureAmazon[],
  disco: DiscoDasFixturesAmazon,
  progresso: ProgressoDaEscritaAmazon,
): void {
  progresso.devidas = escritas.map((e) => e.nome);
  const temporarios: string[] = [];
  try {
    for (const e of escritas) {
      temporarios.push(e.nome);
      disco.escreverTemporario(e.nome, e.texto);
    }
    for (const e of escritas) {
      disco.promover(e.nome);
      progresso.promovidas.push(e.nome);
    }
  } finally {
    for (const nome of temporarios) {
      if (!progresso.promovidas.includes(nome)) disco.descartarTemporario(nome);
    }
  }
}

const NOME_DE_CLASSE = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const CODIGO = /^[A-Z][A-Z0-9_]{0,63}$/;

/** An error as its class name and `code` (each only in its grammar): never its message, never a path. */
export function descreverErroAmazon(err: unknown): string {
  if (typeof err !== 'object' || err === null) return typeof err;
  const nome = err.constructor.name;
  const codigo = 'code' in err && typeof err.code === 'string' ? err.code : '';
  return [NOME_DE_CLASSE.test(nome) ? nome : 'Error', CODIGO.test(codigo) ? codigo : '']
    .filter((p) => p !== '')
    .join(' ');
}

/**
 * What the script's unexpected-error handler prints (stderr), whole: the class
 * and code, and how far the fixture writing got. Node's default printer would
 * print an `ERR_INVALID_URL`'s input or an fs error's path — the captures are
 * real production data.
 */
export function mensagemDoErroInesperadoAmazon(
  err: unknown,
  progresso: ProgressoDaEscritaAmazon,
): string {
  const escrita = resumoDoProgressoAmazon(progresso);
  return [
    `sanitizar: unexpected error (${descreverErroAmazon(err)}); no other detail of it is shown.\n`,
    escrita === null ? '' : `sanitizar: ${escrita}\n`,
  ].join('');
}

/**
 * One sentence on a write that stopped part-way, or `null` when nothing was due
 * or everything was written. Fixture names are printable: a clean run only
 * writes pairs whose name tripped nothing.
 */
export function resumoDoProgressoAmazon(p: ProgressoDaEscritaAmazon): string | null {
  const total = p.devidas.length;
  if (total === 0 || p.promovidas.length === total) return null;
  const faltam = p.devidas.filter((n) => !p.promovidas.includes(n));
  if (p.promovidas.length === 0) {
    return `no fixture was written (due: ${faltam.join(', ')}).`;
  }
  return `${String(p.promovidas.length)} of ${String(total)} fixture(s) had been written (${p.promovidas.join(', ')}); not written: ${faltam.join(', ')}.`;
}
