/**
 * Generate a SELF-SIGNED test A1 `.pfx` for exercising the per-filial cert
 * UPLOAD flow locally (`POST /api/nfe/certificado`) — the same in-memory
 * generator the unit tests use (`test/helpers/pfx-fixture.ts`), but written to
 * disk so you can drop it into the filial "Certificado Digital" tab.
 *
 * **Self-signed — validates the upload/storage flow only, NOT real SEFAZ
 * emission** (SEFAZ rejects self-signed certs; a real ICP-Brasil A1 is needed
 * to authorize an NF-e).
 *
 * Usage:
 *   pnpm --filter @delfrance/integrations-nfe gen:test-cert -- \
 *     --cnpj=99999999000191 --senha=teste123 --out=./cert-teste.pfx --validade=365
 *
 * Flags (all optional):
 *   --cnpj=     CNPJ stamped in the cert CN ("EMPRESA TESTE LTDA:<cnpj>").
 *               MUST match (first 8 digits) the filial you upload to, or the
 *               route rejects it with 422 (rejection-213 guard). Default the
 *               universal SEFAZ test CNPJ.
 *   --senha=    PFX password (default `teste123`).
 *   --out=      Output path (default `./cert-teste.pfx`, relative to cwd).
 *   --validade= Validity in days (default 365). Negative = already expired,
 *               to exercise the upload's expiry rejection.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import forge from 'node-forge';

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const cnpj = arg('cnpj', '12345678000199');
const senha = arg('senha', 'teste123');
const out = resolve(arg('out', 'cert-teste.pfx'));
const validadeDias = Number(arg('validade', '365'));

// 2048-bit to mirror a real A1 (ICP-Brasil minimum). Self-signed: the SEFAZ
// chain isn't involved — the upload route only parses + validates the PFX.
const keys = forge.pki.rsa.generateKeyPair(2048);
const cert = forge.pki.createCertificate();
cert.publicKey = keys.publicKey;
cert.serialNumber = '01';
cert.validity.notBefore = new Date(Date.now() - 86_400_000);
cert.validity.notAfter = new Date(Date.now() + validadeDias * 86_400_000);
const attrs = [{ name: 'commonName', value: `EMPRESA TESTE LTDA:${cnpj}` }];
cert.setSubject(attrs);
cert.setIssuer(attrs);
cert.sign(keys.privateKey, forge.md.sha256.create());

const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], senha, { algorithm: '3des' });
writeFileSync(out, Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary'));

console.log(`✓ wrote ${out}`);
console.log(`  CN:       EMPRESA TESTE LTDA:${cnpj}`);
console.log(`  senha:    ${senha}`);
console.log(`  validade: ${cert.validity.notAfter.toISOString()}`);
console.log('  ⚠ self-signed — validates the UPLOAD flow only, not SEFAZ emission.');
