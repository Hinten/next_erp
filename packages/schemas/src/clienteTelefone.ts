import { normalizeTelefoneInternacional } from '@delfrance/core/phone';
import { isSameTelefone, sanitizeTelefone } from './clienteIdentity';

/** Soft-read input: imported documents may omit every newly introduced field. */
export interface ClienteTelefoneState {
  readonly telefone?: unknown;
  readonly telefonesAdicionais?: unknown;
  readonly telefoneGerenciado?: unknown;
}

export type ClienteTelefoneChange =
  | { readonly tipo: 'observar'; readonly telefone: unknown }
  | { readonly tipo: 'manual'; readonly patch: Readonly<Record<string, unknown>> }
  | {
      readonly tipo: 'whatsapp';
      readonly telefone: unknown;
      readonly telefoneAnterior: unknown;
    };

export class ClienteTelefoneConflitoError extends Error {
  constructor() {
    super('O telefone atual mudou desde a identificação do telefone anterior.');
    this.name = 'ClienteTelefoneConflitoError';
  }
}

function storedPhone(value: unknown): string | null {
  return typeof value === 'string' ? normalizeTelefoneInternacional(value) : null;
}

/** The incoming value is already international: '+' disables the BR length heuristic. */
function samePhone(stored: unknown, incoming: string | null): boolean {
  const left = storedPhone(stored);
  return incoming == null ? left == null : left != null && isSameTelefone(left, `+${incoming}`);
}

function history(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const raw of value) {
    const phone = storedPhone(raw);
    if (phone != null && !result.some((existing) => samePhone(existing, phone))) result.push(phone);
  }
  return result;
}

/**
 * Derive the phone-only delta from a CURRENT transactional/preconditioned read.
 *
 * Manual input is already prepared for storage by the form (including its BR
 * local-number conversion). A WhatsApp phone already carries a country code.
 * Neither may be normalized as BR a second time: 14155552671 is a US number.
 *
 * The editable history is never an identity registry. Removing all its entries
 * cannot reset telefoneGerenciado and make an old order refill an intentional
 * blank. WhatsApp callers must separately reject stale provider events before
 * calling this function; the predecessor guard here also protects human edits.
 */
export function buildClienteTelefonePatch(
  current: ClienteTelefoneState | null,
  change: ClienteTelefoneChange,
): Record<string, unknown> {
  const old = current ?? {};
  const oldPhone = storedPhone(old.telefone);
  const oldHistory = history(old.telefonesAdicionais);

  if (change.tipo === 'observar') {
    const incoming = sanitizeTelefone(change.telefone);
    if (
      incoming == null ||
      oldPhone != null ||
      old.telefoneGerenciado === true ||
      oldHistory.some((phone) => samePhone(phone, incoming))
    ) {
      return {};
    }
    return { telefone: incoming };
  }

  const input = change.tipo === 'manual' ? change.patch : { telefone: change.telefone };
  const changesPhone = Object.hasOwn(input, 'telefone');
  const changesHistory = Object.hasOwn(input, 'telefonesAdicionais');
  const managesPhone = changesPhone || changesHistory || change.tipo === 'whatsapp';
  if (!managesPhone) {
    // A copied/defaulted false is not an instruction to undo a previous choice.
    return old.telefoneGerenciado === true && input.telefoneGerenciado === false
      ? { telefoneGerenciado: true }
      : {};
  }

  if (
    change.tipo === 'whatsapp' &&
    !samePhone(old.telefone, storedPhone(change.telefoneAnterior))
  ) {
    throw new ClienteTelefoneConflitoError();
  }

  const incoming = changesPhone ? storedPhone(input.telefone) : oldPhone;
  const nextPhone = samePhone(old.telefone, incoming) ? (old.telefone ?? null) : incoming;
  let nextHistory = changesHistory ? history(input.telefonesAdicionais) : [...oldHistory];
  if (changesPhone && oldPhone != null && !samePhone(oldPhone, incoming)) {
    if (!nextHistory.some((phone) => samePhone(phone, oldPhone))) nextHistory.push(oldPhone);
  }
  nextHistory = nextHistory.filter((phone) => !samePhone(phone, incoming));

  const patch: Record<string, unknown> = { telefoneGerenciado: true };
  if (changesPhone) patch.telefone = nextPhone;
  if (changesHistory || (changesPhone && !samePhone(oldPhone, incoming))) {
    patch.telefonesAdicionais = nextHistory;
  }
  return patch;
}
