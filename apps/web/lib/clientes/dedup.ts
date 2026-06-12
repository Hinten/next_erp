import { type Firestore, getDocs } from 'firebase/firestore';
import { execute } from 'firebase/firestore/pipelines';
import {
  PipelineUnsupportedError,
  buildPipeline,
  buildQuery,
  limit,
  orderByField,
  whereEqual,
  whereOp,
} from '@delfrance/data';
import { telefoneQueryShapes } from '@delfrance/core/phone';
import { clienteCollection } from '@/lib/data/clienteCollection';

const CANDIDATE_LIMIT = 5;
/** Firestore prefix-range upper sentinel — sorts above any string with the prefix. */
const PREFIX_MAX = String.fromCharCode(0xffff);

/** Minimal cliente projection the dedup UI renders. */
export interface DedupCandidate {
  id: string;
  nome: string | null;
  cpf_cnpj: string | null;
  idEstrangeiro: string | null;
  email: string | null;
  telefone: string | null;
}

export interface ClienteDedupInput {
  nome: string;
  cpf_cnpj: string;
  idEstrangeiro: string;
  email: string;
  telefone: string;
}

export interface ClienteDedupResult {
  /** Exact cpf_cnpj OR idEstrangeiro match — creation is blocked. */
  blocking: DedupCandidate[];
  /** Similar-nome candidates (pipeline regex), blocking ids excluded. */
  similarNome: DedupCandidate[];
  /** Same telefone (either wire shape) — warning only, never blocks. */
  telefoneMatches: DedupCandidate[];
  /** Same e-mail (case-insensitive) — warning only, never blocks. */
  emailMatches: DedupCandidate[];
}

export function hasDedupFindings(result: ClienteDedupResult): boolean {
  return (
    result.blocking.length > 0 ||
    result.similarNome.length > 0 ||
    result.telefoneMatches.length > 0 ||
    result.emailMatches.length > 0
  );
}

function readString(data: Record<string, unknown>, key: string): string | null {
  const v = data[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

function toCandidate(id: string, data: Record<string, unknown>): DedupCandidate {
  return {
    id,
    nome: readString(data, 'nome'),
    cpf_cnpj: readString(data, 'cpf_cnpj'),
    idEstrangeiro: readString(data, 'idEstrangeiro'),
    email: readString(data, 'email'),
    telefone: readString(data, 'telefone'),
  };
}

async function queryCandidates(
  db: Firestore,
  constraints: Parameters<typeof buildQuery>[1],
): Promise<DedupCandidate[]> {
  const snap = await getDocs(buildQuery(clienteCollection.ref(db, {}), constraints));
  return snap.docs.map((d) => toCandidate(d.id, d.data() as Record<string, unknown>));
}

/**
 * Similar-nome candidates via the pipeline regex search (case- and
 * accent-insensitive, same engine as the ClientePicker). Falls back to a
 * classic prefix-range query when the SDK lacks the Pipelines API; any
 * other error (FirebaseError, …) propagates to the caller.
 */
async function querySimilarNome(db: Firestore, term: string): Promise<DedupCandidate[]> {
  try {
    const pipeline = buildPipeline(db, {
      collection: clienteCollection.resolvePath({}),
      search: { fields: ['nome'], term },
      limit: CANDIDATE_LIMIT,
    });
    const snap = await execute(pipeline);
    return snap.results.map((r) =>
      toCandidate(r.ref?.id ?? r.id ?? '', r.data() as Record<string, unknown>),
    );
  } catch (err) {
    if (err instanceof PipelineUnsupportedError) {
      return queryCandidates(db, [
        orderByField('nome', 'asc'),
        whereOp('nome', '>=', term),
        whereOp('nome', '<=', `${term}${PREFIX_MAX}`),
        limit(CANDIDATE_LIMIT),
      ]);
    }
    throw err;
  }
}

/**
 * One-shot duplicate lookup before creating a cliente. Empty inputs skip
 * their sub-check; all sub-checks run in parallel. Telefone is matched
 * against BOTH wire shapes (normalized `55…` written by this app and the
 * raw 10/11-digit shape the live Flutter app still writes); e-mail is
 * matched case-insensitively via an `in` query on the typed and lowercased
 * forms.
 */
export async function checkClienteDuplicates(
  db: Firestore,
  input: ClienteDedupInput,
): Promise<ClienteDedupResult> {
  const cpfCnpj = input.cpf_cnpj.replace(/[.\-/\s]/g, '').toUpperCase();
  const idEstrangeiro = input.idEstrangeiro.trim();
  const nome = input.nome.trim();
  const email = input.email.trim();
  const telefoneShapes = telefoneQueryShapes(input.telefone);
  const emailShapes = [...new Set([email, email.toLowerCase()])];

  const [byCpfCnpj, byIdEstrangeiro, byNome, byTelefone, byEmail] = await Promise.all([
    cpfCnpj === ''
      ? []
      : queryCandidates(db, [whereEqual('cpf_cnpj', cpfCnpj), limit(CANDIDATE_LIMIT)]),
    idEstrangeiro === ''
      ? []
      : queryCandidates(db, [whereEqual('idEstrangeiro', idEstrangeiro), limit(CANDIDATE_LIMIT)]),
    nome === '' ? [] : querySimilarNome(db, nome),
    telefoneShapes.length === 0
      ? []
      : queryCandidates(db, [whereOp('telefone', 'in', telefoneShapes), limit(CANDIDATE_LIMIT)]),
    email === ''
      ? []
      : queryCandidates(db, [whereOp('email', 'in', emailShapes), limit(CANDIDATE_LIMIT)]),
  ]);

  const blocking = [...byCpfCnpj, ...byIdEstrangeiro.filter((c) => !hasId(byCpfCnpj, c.id))];
  const notBlocking = (c: DedupCandidate) => !hasId(blocking, c.id);

  return {
    blocking,
    similarNome: byNome.filter(notBlocking),
    telefoneMatches: byTelefone.filter(notBlocking),
    emailMatches: byEmail.filter(notBlocking),
  };
}

function hasId(list: DedupCandidate[], id: string): boolean {
  return list.some((c) => c.id === id);
}
