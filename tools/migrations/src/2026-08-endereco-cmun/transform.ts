import { resolveCodigoMunicipioSync } from '@delfrance/core/cep/cmun';
import { codigoMunicipioMatchesUf } from '@delfrance/core/cep';

/**
 * The pure half of the `codigoMunicipio` backfill (#785) — one endereço in, a
 * decision out. No Firestore, so every branch is unit-testable.
 */

/** A well-formed IBGE município code: exactly 7 digits. */
const CMUN_RE = /^\d{7}$/;

export type CMunOutcome =
  /** Already carries a valid código — nothing to do. */
  | { kind: 'ok'; codigoMunicipio: string }
  /** Resolved offline from the CEP; `codigoMunicipio` is the value to write. */
  | { kind: 'resolve'; codigoMunicipio: string }
  /** Left alone; `reason` goes in the JSONL for a human to read. */
  | { kind: 'skip'; reason: string };

/** The endereço shape this migration reads. Structural — no schema import. */
export interface EnderecoLike {
  readonly cep?: unknown;
  readonly codigoMunicipio?: unknown;
  readonly estado?: unknown;
}

/**
 * Decide what to do with one endereço.
 *
 * Offline only — `resolveCodigoMunicipioSync` never touches the network.
 * Firing ~10k ViaCEP calls against a service that rate-limits without
 * documenting its limit would be a self-inflicted outage; the unresolvable
 * residue is logged instead, and the emission-time backstop
 * (`apps/nfe/lib/nfe/orchestrator/cmun.ts`) closes it one CEP at a time, when a
 * human is present.
 */
export function decideCodigoMunicipio(endereco: EnderecoLike): CMunOutcome {
  const stored = typeof endereco.codigoMunicipio === 'string' ? endereco.codigoMunicipio : null;
  const cep = typeof endereco.cep === 'string' ? endereco.cep : null;
  const estado = typeof endereco.estado === 'string' ? endereco.estado : null;

  if (stored != null && CMUN_RE.test(stored)) {
    // NEVER auto-correct operator data. A stored código whose UF prefix
    // disagrees with `estado` is a genuine conflict — one of the two is wrong,
    // and this migration cannot know which. Surface it and move on.
    if (estado != null && estado !== '' && !codigoMunicipioMatchesUf(stored, estado)) {
      return {
        kind: 'skip',
        reason: `código ${stored} não pertence à UF ${estado} — conflito, requer revisão humana`,
      };
    }
    return { kind: 'ok', codigoMunicipio: stored };
  }

  if (cep == null || !/^\d{8}$/.test(cep)) {
    return { kind: 'skip', reason: `cep ausente ou inválido (${JSON.stringify(endereco.cep)})` };
  }

  const resolved = resolveCodigoMunicipioSync({ cep, codigoMunicipio: null, estado });
  if (resolved == null) {
    return { kind: 'skip', reason: 'cep fora de todas as faixas da tabela offline' };
  }

  // A resolved value we can already tell is wrong is worse than no value: it
  // would sail through the NF-e generator and earn SEFAZ rejection 273.
  if (estado != null && estado !== '' && !codigoMunicipioMatchesUf(resolved, estado)) {
    return {
      kind: 'skip',
      reason: `tabela resolveu ${resolved}, que não pertence à UF ${estado} do endereço`,
    };
  }

  return { kind: 'resolve', codigoMunicipio: resolved };
}
