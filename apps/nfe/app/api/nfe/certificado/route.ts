/**
 * `POST /api/nfe/certificado`   — upload a filial's A1 certificate (.pfx/.p12).
 * `DELETE /api/nfe/certificado?filialId=…` — remove a filial's certificate.
 *
 * The PFX bytes + password arrive over HTTPS, are parsed + validated here
 * (server-only — OpenSSL 3 can't read ICP-Brasil PFX, so node-forge does it),
 * and split:
 *   - the **private key** is AES-256-GCM-encrypted with the env master key
 *     (`NFE_CERT_ENC_KEY`) and stored in the admin-only
 *     `filiais/{filialId}/certificadoSecreto/default` doc;
 *   - the **public** cert metadata (CN / CNPJ / validade / filename) is merged
 *     onto the filial doc for the UI badge.
 * The raw PFX + password are **discarded** after this request — never stored,
 * never logged. The response carries only public metadata, never the key.
 *
 * Required perm: `PERM.configuracoes.write` (same as editing the filial).
 *
 * Returns:
 *   200 { subjectCommonName, cnpj, notAfter, filename, uploadedAt }
 *   400  bad body / JSON
 *   401/403  auth
 *   404  filial not found
 *   422  invalid PFX (wrong password / malformed / expired / CNPJ mismatch)
 *   500  server (e.g. NFE_CERT_ENC_KEY misconfigured)
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { certificadoSecretoCollection, filialCollection } from '@delfrance/data/admin/collections';
import { CERTIFICADO_SECRETO_DOC_ID, type Filial } from '@delfrance/schemas';
import {
  NFeCertError,
  encryptSecret,
  getCertEncryptionKey,
  isCertExpired,
  loadCertificateFromBase64,
} from '@delfrance/integrations-nfe';

import { authError, PERM, verifyCaller } from '@/lib/nfe/auth';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { safeLog } from '@/lib/nfe/log';
import { evictFilialCert } from '@/lib/nfe/filial-cert';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const uploadSchema = z.object({
  filialId: z.string().min(1).max(200),
  /** Base-64 of the .pfx/.p12 bytes. */
  pfxBase64: z.string().min(1),
  /** PFX passphrase — empty string is legal PKCS#12, so no `.min(1)`. */
  password: z.string(),
  /** Original filename, for operator recognition on the badge. */
  filename: z.string().min(1).max(255),
});

/** First 8 chars (CNPJ base) — SEFAZ rejection 213 matches on the base. */
function cnpjBase(cnpj: string): string {
  return cnpj.replace(/[^0-9A-Z]/g, '').slice(0, 8);
}

export async function POST(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.configuracoes.write);
  if ('error' in auth) return auth.error;

  let body: z.infer<typeof uploadSchema>;
  try {
    body = uploadSchema.parse(await req.json());
  } catch (e) {
    if (e instanceof z.ZodError) {
      return authError(400, { error: 'Bad body', code: e.issues[0]?.message });
    }
    if (e instanceof SyntaxError) {
      return authError(400, { error: 'Bad JSON body' });
    }
    throw e;
  }

  const fs = getAdminFirestore();

  // Filial must exist + carry a CNPJ to validate against (rejection 213 guard).
  const filialSnap = await filialCollection.docRef(fs, {}, body.filialId).get();
  if (!filialSnap.exists) {
    return authError(404, { error: `Filial '${body.filialId}' não encontrada.` });
  }
  const filial = filialCollection.parseRead(
    filialSnap.data(),
    filialCollection.docPath({}, body.filialId),
  ) as Filial;

  // Parse the PFX. A failure here (wrong password / malformed file / not an
  // ICP-Brasil e-CNPJ cert) is a client-side problem — return a pt-BR message,
  // never the English library text or env-var hints. This upload NEVER contacts
  // SEFAZ. `safeLog` keeps the real (redacted) cause for ops.
  let cert;
  try {
    cert = loadCertificateFromBase64(body.pfxBase64, body.password);
  } catch (e) {
    if (e instanceof NFeCertError) {
      safeLog('warn', '[nfe/certificado] PFX inválido', e);
      return authError(422, {
        error: 'Senha incorreta ou arquivo de certificado (.pfx/.p12) inválido.',
        code: 'CERT_INVALIDO',
      });
    }
    throw e;
  }

  // Expired cert (using isCertExpired so we keep `cert.notAfter` for the date).
  if (isCertExpired(cert)) {
    return authError(422, {
      error:
        `Certificado expirado em ${cert.notAfter.toLocaleDateString('pt-BR')}. ` +
        'Renove o certificado A1 junto à sua AC (Autoridade Certificadora).',
      code: 'CERT_EXPIRADO',
    });
  }

  // The cert's CNPJ base must match the filial's — otherwise SEFAZ rejects
  // every emission with rejection 213. Catch it at upload, not at emit time.
  const filialBase = cnpjBase(filial.cnpj);
  if (!filialBase || cnpjBase(cert.cnpj) !== filialBase) {
    return authError(422, {
      error:
        `O CNPJ do certificado (${cert.cnpj}) não corresponde ao CNPJ da filial ` +
        `(${filial.cnpj || 'não informado'}). Envie o certificado A1 desta filial.`,
      code: 'CNPJ_DIVERGENTE',
    });
  }

  try {
    // Encrypt ONLY the private key. NFeCertError from here (missing/short
    // NFE_CERT_ENC_KEY) is a server misconfiguration → 500 via the outer catch.
    const encPrivateKey = encryptSecret(cert.privateKeyPem, getCertEncryptionKey());
    // Dates as ms since epoch (Dart/Flutter convention; SDK-agnostic, sortable).
    const uploadedAt = Date.now();

    await certificadoSecretoCollection.set(
      fs,
      { filialId: body.filialId },
      CERTIFICADO_SECRETO_DOC_ID,
      {
        encPrivateKey,
        certificatePem: cert.certificatePem,
        certificateDerBase64: cert.certificateDerBase64,
        subjectCommonName: cert.subjectCommonName,
        cnpj: cert.cnpj,
        notAfter: cert.notAfter.getTime(),
        algoritmo: 'aes-256-gcm',
        keyVersion: 1,
        uploadedAt,
      },
    );

    const certificado = {
      subjectCommonName: cert.subjectCommonName,
      cnpj: cert.cnpj,
      notAfter: cert.notAfter.getTime(),
      filename: body.filename,
      uploadedAt,
    };
    await filialCollection.merge(fs, {}, body.filialId, { certificado });

    // Pick up the new cert without an apps/nfe restart (this instance only).
    evictFilialCert(body.filialId);

    return NextResponse.json(certificado, { status: 200 });
  } catch (e) {
    // Never log the body (PFX + password) — only the redacted error shape.
    safeLog('error', '[nfe/certificado]', e);
    return authError(500, {
      error: e instanceof Error ? e.message : 'Erro interno ao salvar o certificado',
      code: e instanceof Error ? e.name : undefined,
    });
  }
}

export async function DELETE(req: Request): Promise<NextResponse> {
  const auth = await verifyCaller(req, PERM.configuracoes.write);
  if ('error' in auth) return auth.error;

  const filialId = new URL(req.url).searchParams.get('filialId');
  if (!filialId) {
    return authError(400, { error: 'filialId é obrigatório (?filialId=…).' });
  }

  const fs = getAdminFirestore();
  try {
    await certificadoSecretoCollection
      .docRef(fs, { filialId }, CERTIFICADO_SECRETO_DOC_ID)
      .delete();
    await filialCollection.merge(fs, {}, filialId, { certificado: null });
    evictFilialCert(filialId);
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (e) {
    safeLog('error', '[nfe/certificado:delete]', e);
    return authError(500, {
      error: e instanceof Error ? e.message : 'Erro interno ao remover o certificado',
      code: e instanceof Error ? e.name : undefined,
    });
  }
}
