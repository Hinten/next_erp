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
import { type ClienteIdentityKeys, isSameCliente, normalizeDocumento } from '@delfrance/schemas';
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
  /**
   * The candidate's strong identifiers CONTRADICT what was typed — same phone
   * or e-mail, different document, so it is probably a different person
   * (recycled mobile numbers and shared household e-mails are routine).
   *
   * Advisory only. It never promotes a candidate to `blocking` and never
   * demotes one: the same predicate that makes the server importer refuse to
   * merge here (`@delfrance/schemas`, #786) just labels the warning, because
   * on this screen a human is the one deciding.
   */
  identityConflict: boolean;
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
  /** Same e-mail (best-effort, see `checkClienteDuplicates`) — warning only. */
  emailMatches: DedupCandidate[];
}

function readString(data: Record<string, unknown>, key: string): string | null {
  const v = data[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

function toCandidate(
  id: string,
  data: Record<string, unknown>,
  typed: ClienteIdentityKeys,
): DedupCandidate {
  const cpf_cnpj = readString(data, 'cpf_cnpj');
  const idEstrangeiro = readString(data, 'idEstrangeiro');
  return {
    id,
    nome: readString(data, 'nome'),
    cpf_cnpj,
    idEstrangeiro,
    email: readString(data, 'email'),
    telefone: readString(data, 'telefone'),
    identityConflict: !isSameCliente({ cpf_cnpj, idEstrangeiro }, typed),
  };
}

async function queryCandidates(
  db: Firestore,
  constraints: Parameters<typeof buildQuery>[1],
  typed: ClienteIdentityKeys,
): Promise<DedupCandidate[]> {
  const snap = await getDocs(buildQuery(clienteCollection.ref(db, {}), constraints));
  return snap.docs.map((d) => toCandidate(d.id, d.data() as Record<string, unknown>, typed));
}

/**
 * Similar-nome candidates via the pipeline regex search (case- and
 * accent-insensitive, same engine as the ClientePicker). Falls back to a
 * classic prefix-range query when the SDK lacks the Pipelines API; any
 * other error (FirebaseError, …) propagates to the caller.
 */
async function querySimilarNome(
  db: Firestore,
  term: string,
  typed: ClienteIdentityKeys,
): Promise<DedupCandidate[]> {
  try {
    const pipeline = buildPipeline(db, {
      collection: clienteCollection.resolvePath({}),
      search: { fields: ['nome'], term },
      limit: CANDIDATE_LIMIT,
    });
    const snap = await execute(pipeline);
    return snap.results.map((r) =>
      toCandidate(r.ref?.id ?? r.id ?? '', r.data() as Record<string, unknown>, typed),
    );
  } catch (err) {
    if (err instanceof PipelineUnsupportedError) {
      return queryCandidates(
        db,
        [
          orderByField('nome', 'asc'),
          whereOp('nome', '>=', term),
          whereOp('nome', '<=', `${term}${PREFIX_MAX}`),
          limit(CANDIDATE_LIMIT),
        ],
        typed,
      );
    }
    throw err;
  }
}

/**
 * One-shot duplicate lookup before creating a cliente. Empty inputs skip
 * their sub-check; all sub-checks run in parallel. Telefone is matched
 * against BOTH wire shapes (normalized `55…` written by this app and the
 * raw 10/11-digit shape the live Flutter app still writes).
 *
 * E-mail is matched best-effort via an `in` query on the typed and lowercased
 * forms — Firestore has no case-insensitive operator, so a stored mixed-case
 * variant the user did not type is missed. That is acceptable here: e-mail is
 * a non-blocking warning, not a hard dedup key. True case-insensitivity would
 * need a normalized `emailLower` field written on every create (out of scope
 * while the Flutter app co-owns the collection).
 */
export async function checkClienteDuplicates(
  db: Firestore,
  input: ClienteDedupInput,
): Promise<ClienteDedupResult> {
  const cpfCnpj = normalizeDocumento(input.cpf_cnpj);
  const idEstrangeiro = input.idEstrangeiro.trim();
  const nome = input.nome.trim();
  const email = input.email.trim();
  const telefoneShapes = telefoneQueryShapes(input.telefone);
  const emailShapes = [...new Set([email, email.toLowerCase()])];
  const typed: ClienteIdentityKeys = { cpf_cnpj: cpfCnpj, idEstrangeiro };

  const [byCpfCnpj, byIdEstrangeiro, byNome, byTelefone, byEmail] = await Promise.all([
    cpfCnpj === ''
      ? []
      : queryCandidates(db, [whereEqual('cpf_cnpj', cpfCnpj), limit(CANDIDATE_LIMIT)], typed),
    idEstrangeiro === ''
      ? []
      : queryCandidates(
          db,
          [whereEqual('idEstrangeiro', idEstrangeiro), limit(CANDIDATE_LIMIT)],
          typed,
        ),
    nome === '' ? [] : querySimilarNome(db, nome, typed),
    telefoneShapes.length === 0
      ? []
      : queryCandidates(
          db,
          [whereOp('telefone', 'in', telefoneShapes), limit(CANDIDATE_LIMIT)],
          typed,
        ),
    email === ''
      ? []
      : queryCandidates(db, [whereOp('email', 'in', emailShapes), limit(CANDIDATE_LIMIT)], typed),
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
