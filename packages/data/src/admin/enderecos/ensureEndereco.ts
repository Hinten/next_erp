/**
 * The content-addressed endereço id, and the create-if-absent write that uses
 * it — the channel-neutral half of what `apps/mercado-livre` used to own alone.
 *
 * ⚠️ **PROMOTED, not copied** (#1513, step 5). `apps/shopee` cannot import
 * `apps/mercado-livre` — apps have no dependency edge to one another and none is
 * possible — so a second marketplace importer needing the same endereço id had
 * exactly two options: share this, or fork a DIGEST. A forked digest is the
 * worst kind of fork, because the two copies keep working while disagreeing:
 * they simply address different documents, so the same buyer's address is
 * written twice and the legacy corpus stops matching for one of the channels.
 * `orderCliente.ts` is now a thin re-exporter and its golden-vector tests pass
 * byte-unedited, which is what proves the move changed nothing.
 */
import { createHash } from 'node:crypto';
import type { DocumentData, Firestore } from 'firebase-admin/firestore';
import type { EnderecoForcado } from '@delfrance/schemas';

import { enderecoCollection } from '../collections';
import { isAlreadyExists } from '../grpcErrors';

/**
 * Endereço fields mirroring `enderecoSchema`.
 *
 * The shared builder owns this shape (`EnderecoForcado`); the alias exists
 * because both channel importers name their variables after it.
 */
export type EnderecoImportFields = EnderecoForcado;

function sha1Hex(input: string): string {
  return createHash('sha1').update(input, 'utf8').digest('hex');
}

/**
 * `Endereco.generateUid` (legacy `models.dart:841-866`) — sha1 over the EXACT
 * legacy field concatenation order, nulls → `''`.
 *
 * ⚠️ The order and the empty-string coercion are byte-load-bearing: the migrated
 * corpus already sits at these digests (root `CLAUDE.md` rule 8 — the legacy
 * DATA survives the cutover), so a "harmless" reordering would fork every
 * existing endereço on its first re-import. `estado` uses the UF CODE (Dart's
 * `estado.value`, e.g. `'SP'`), which this schema already stores directly.
 */
export function makeEnderecoId(fields: EnderecoImportFields): string {
  const parts = [
    'endereco',
    fields.idExterno ?? '',
    fields.logradouro,
    fields.numero,
    fields.complemento ?? '',
    fields.bairro,
    fields.cep,
    fields.codigoMunicipio ?? '',
    fields.cidade,
    fields.estado,
    fields.cPais ?? '',
    fields.pais ?? '',
    fields.nome ?? '',
    fields.cpf_cnpj ?? '',
    fields.rg ?? '',
    fields.ie ?? '',
    fields.imun ?? '',
    fields.email ?? '',
    fields.telefone ?? '',
  ];
  return sha1Hex(parts.join(''));
}

/**
 * Create-if-absent at the deterministic {@link makeEnderecoId} under
 * `clientes/{clienteId}/enderecos` (legacy's `.save(forceAdd: true,
 * docIdString: generateUid())`).
 *
 * ADR 0011 tier 0: the id IS the precondition, so a concurrent create racing to
 * the same id is not an error — both callers converge on one document and the
 * loser's `ALREADY_EXISTS` is swallowed. Every other failure rethrows (rule 6).
 *
 * ⚠️ It CREATES and never overwrites, deliberately. A marketplace that masks
 * buyer data outside an unmask window will hash a masked delivery and a clear
 * one to different ids, so the cost of the difference is a duplicate endereço
 * document — never a good row overwritten by a masked one.
 */
export async function ensureEndereco(
  db: Firestore,
  clienteId: string,
  fields: EnderecoImportFields,
): Promise<string> {
  const id = makeEnderecoId(fields);
  const data = enderecoCollection.parse(fields) as DocumentData;
  try {
    await enderecoCollection.docRef(db, { clienteId }, id).create(data);
  } catch (err) {
    if (isAlreadyExists(err)) return id;
    throw err;
  }
  return id;
}
