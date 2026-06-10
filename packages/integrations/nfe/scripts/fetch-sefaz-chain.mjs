#!/usr/bin/env node
/**
 * One-shot helper: connect to SEFAZ once, capture the TLS certificate chain
 * the server actually sends, **then follow each cert's AIA (Authority
 * Information Access) extension up to the self-signed root**, and write
 * the whole bundle as PEM to
 * `packages/integrations/nfe/ca/sefaz-<uf>-<ambiente>.pem`.
 *
 * Why follow AIA? SEFAZ (and most TLS servers) does **not** include the
 * trust-anchor root in the handshake — clients are expected to have it.
 * Node's bundled Mozilla roots may include the ICP-Brasil root, may not
 * (the v10 generation is recent). Following AIA explicitly fetches the
 * full chain so we never depend on what's bundled.
 *
 * The homologação smoke test auto-loads `ca/sefaz-sp-homologacao.pem` if
 * present (override via `NFE_TLS_CA_PATH`), so once you've run this
 * script the handshake against SEFAZ-SP just works.
 *
 * **Trust model — TOFU (Trust On First Use):** the script connects with
 * `rejectUnauthorized: false` to fetch the chain, which means the first
 * fetch is vulnerable to a MITM. For **homologação** (test data, no
 * fiscal value) this is acceptable; for **produção** you should hand-
 * verify the captured chain against ICP-Brasil's published roots before
 * trusting it.
 *
 * Usage:
 *   pnpm --filter @delfrance/integrations-nfe fetch:sefaz-ca
 *   node scripts/fetch-sefaz-chain.mjs --uf=SP --ambiente=homologacao
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:tls';

import forge from 'node-forge';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);
const UF = (args.uf ?? 'SP').toUpperCase();
const AMBIENTE = args.ambiente ?? 'homologacao';

const HOSTS = {
  'SP:homologacao': 'homologacao.nfe.fazenda.sp.gov.br',
  'SP:producao': 'nfe.fazenda.sp.gov.br',
  // Contingency authorizers — the "UF" slot carries the authorizer id
  // (chain files land as `sefaz-svc-an-<ambiente>.pem` etc.).
  'SVC-AN:homologacao': 'hom.svc.fazenda.gov.br',
  'SVC-AN:producao': 'www.svc.fazenda.gov.br',
  'SVC-RS:homologacao': 'nfe-homologacao.svrs.rs.gov.br',
  'SVC-RS:producao': 'nfe.svrs.rs.gov.br',
  // Ambiente Nacional (EPEC evento drop-box).
  'AN:homologacao': 'hom1.nfe.fazenda.gov.br',
  'AN:producao': 'www.nfe.fazenda.gov.br',
};
const host = HOSTS[`${UF}:${AMBIENTE}`];
if (!host) {
  console.error(`No host wired for UF=${UF} ambiente=${AMBIENTE}.`);
  process.exit(2);
}

const outFile = join(PKG_ROOT, 'ca', `sefaz-${UF.toLowerCase()}-${AMBIENTE}.pem`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rawToPem(raw) {
  const b64 = raw
    .toString('base64')
    .match(/.{1,64}/g)
    .join('\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

/** node-forge X.509 → DER buffer. */
function forgeCertToDer(forgeCert) {
  return Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(forgeCert)).getBytes(), 'binary');
}

/** Parse a TLS-peer cert (raw DER buffer) into a node-forge certificate. */
function rawToForge(raw) {
  const asn1 = forge.asn1.fromDer(raw.toString('binary'));
  return forge.pki.certificateFromAsn1(asn1);
}

/**
 * Walk the certificate's AIA extension and return the first caIssuers URL.
 * node-forge doesn't structurally parse AIA, so we crack the raw extnValue
 * ASN.1 ourselves.
 *
 *   AuthorityInfoAccessSyntax ::= SEQUENCE OF AccessDescription
 *   AccessDescription ::= SEQUENCE { accessMethod OID, accessLocation GeneralName }
 *   caIssuers OID = 1.3.6.1.5.5.7.48.2
 *   GeneralName URI = [6] IMPLICIT IA5String
 */
function findCaIssuersUrl(forgeCert) {
  const aiaExt = (forgeCert.extensions ?? []).find(
    (e) => e.id === '1.3.6.1.5.5.7.1.1' || e.name === 'authorityInfoAccess',
  );
  if (!aiaExt) return null;
  // forge sometimes parses AIA into `accessDescriptions`; if so, use it.
  if (Array.isArray(aiaExt.accessDescriptions)) {
    for (const d of aiaExt.accessDescriptions) {
      if (d.accessMethod === '1.3.6.1.5.5.7.48.2' && d.accessLocation?.value) {
        return d.accessLocation.value;
      }
    }
  }
  // Otherwise: parse the raw extnValue ourselves.
  const raw = aiaExt.value ?? aiaExt.extnValue;
  if (!raw) return null;
  try {
    const asn1 = forge.asn1.fromDer(typeof raw === 'string' ? raw : raw.toString('binary'));
    for (const desc of asn1.value ?? []) {
      if (!desc.value || desc.value.length < 2) continue;
      const oidNode = desc.value[0];
      const locNode = desc.value[1];
      const oid = forge.asn1.derToOid(oidNode.value);
      if (oid !== '1.3.6.1.5.5.7.48.2') continue;
      // GeneralName URI = CONTEXT-SPECIFIC, tag 6 (IMPLICIT IA5String)
      if (locNode.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && locNode.type === 6) {
        // value is the IA5String bytes (as JS string in node-forge)
        return typeof locNode.value === 'string'
          ? locNode.value
          : Buffer.from(locNode.value, 'binary').toString();
      }
    }
  } catch (err) {
    console.warn(`  AIA parse failed: ${err.message}`);
  }
  return null;
}

/** HTTP/HTTPS GET → response body Buffer. Follows up to 3 redirects. */
async function fetchBuffer(url, redirects = 3) {
  return new Promise((resolveP, rejectP) => {
    const req = (url.startsWith('https:') ? httpsRequest : httpRequest)(
      url,
      { method: 'GET' },
      (res) => {
        if (
          [301, 302, 303, 307, 308].includes(res.statusCode ?? 0) &&
          res.headers.location &&
          redirects > 0
        ) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          fetchBuffer(next, redirects - 1).then(resolveP, rejectP);
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolveP(Buffer.concat(chunks)));
        res.on('error', rejectP);
      },
    );
    req.on('error', rejectP);
    req.setTimeout(15_000, () => req.destroy(new Error('AIA fetch timeout')));
    req.end();
  });
}

/**
 * Parse a downloaded cert body. CAs commonly serve:
 *   - DER (raw .cer/.crt)            — most common
 *   - PEM (base64 between markers)
 *   - PKCS#7 / .p7b (DER-encoded)    — chain bundle, take all certs
 *
 * Returns an array of node-forge certificates (usually 1, possibly more
 * for a .p7b bundle).
 */
function parseDownloadedBody(buffer) {
  const asString = buffer.toString('utf8');
  // PEM path
  if (asString.includes('-----BEGIN CERTIFICATE-----')) {
    return splitPem(asString).map((pem) => forge.pki.certificateFromPem(pem));
  }
  const binary = buffer.toString('binary');
  // Try DER cert
  try {
    const asn1 = forge.asn1.fromDer(binary);
    return [forge.pki.certificateFromAsn1(asn1)];
  } catch {
    // Fall through to PKCS#7
  }
  // PKCS#7 (.p7b / .p7c) — common for CA bundles
  try {
    const asn1 = forge.asn1.fromDer(binary);
    const p7 = forge.pkcs7.messageFromAsn1(asn1);
    if (p7.certificates?.length) return p7.certificates;
  } catch {
    // Fall through
  }
  throw new Error(
    `Could not parse downloaded body as PEM, DER, or PKCS#7 (${buffer.length} bytes)`,
  );
}

function splitPem(text) {
  const blocks = [];
  const re = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
  let m;
  while ((m = re.exec(text))) blocks.push(m[0]);
  return blocks;
}

function subjectCN(forgeCert) {
  const field = forgeCert.subject?.getField('CN');
  return field?.value ?? '(no CN)';
}
function issuerCN(forgeCert) {
  const field = forgeCert.issuer?.getField('CN');
  return field?.value ?? '(no CN)';
}
function isSelfSigned(forgeCert) {
  return (
    JSON.stringify(forgeCert.subject.attributes) === JSON.stringify(forgeCert.issuer.attributes)
  );
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

console.log(`Connecting to ${host}:443 (rejectUnauthorized=false — TOFU mode)…`);

const socket = connect({ host, port: 443, servername: host, rejectUnauthorized: false });
let captured = false;

socket.once('secureConnect', async () => {
  // 1. Capture whatever chain SEFAZ serves us.
  const chain = [];
  const seen = new Set();
  let curr = socket.getPeerCertificate(true);
  while (curr && curr.raw && !seen.has(curr.fingerprint256)) {
    seen.add(curr.fingerprint256);
    chain.push(rawToForge(curr.raw));
    if (!curr.issuerCertificate || curr.issuerCertificate === curr) break;
    curr = curr.issuerCertificate;
  }

  if (chain.length === 0) {
    console.error('No certs received from server.');
    process.exit(3);
  }
  // SEFAZ closed the socket as it served us; we don't need it anymore.
  socket.destroy();

  console.log(`Captured ${chain.length} cert(s) from the TLS handshake:`);
  for (const [i, c] of chain.entries()) {
    console.log(`  [${i}] subject="${subjectCN(c)}" issuer="${issuerCN(c)}"`);
  }

  // 2. Walk UP from the topmost cert via its AIA caIssuers URL until we hit
  //    a self-signed cert. Use a fingerprint set so a cycle can't loop us.
  const fingerprints = new Set(
    chain.map((c) =>
      forge.md.sha256.create().update(forgeCertToDer(c).toString('binary')).digest().toHex(),
    ),
  );
  let top = chain[chain.length - 1];
  while (!isSelfSigned(top)) {
    const url = findCaIssuersUrl(top);
    if (!url) {
      console.warn(`  ! "${subjectCN(top)}" has no AIA caIssuers URL — chain stops here.`);
      break;
    }
    console.log(`  ↑ following AIA: ${url}`);
    let body;
    try {
      body = await fetchBuffer(url);
    } catch (err) {
      console.warn(`    AIA fetch failed: ${err.message}`);
      break;
    }
    let parsed;
    try {
      parsed = parseDownloadedBody(body);
    } catch (err) {
      console.warn(`    Could not parse downloaded cert: ${err.message}`);
      break;
    }
    let progressed = false;
    for (const next of parsed) {
      const fp = forge.md.sha256
        .create()
        .update(forgeCertToDer(next).toString('binary'))
        .digest()
        .toHex();
      if (fingerprints.has(fp)) continue;
      fingerprints.add(fp);
      chain.push(next);
      console.log(`    + added subject="${subjectCN(next)}" issuer="${issuerCN(next)}"`);
      top = next;
      progressed = true;
    }
    if (!progressed) {
      console.warn('    No new cert in downloaded bundle — stopping.');
      break;
    }
  }
  if (isSelfSigned(top)) {
    console.log(`  ✓ reached self-signed root: "${subjectCN(top)}"`);
  }

  // 3. Skip the leaf (index 0) and write the trust bundle. If the leaf is
  //    the only cert we have (e.g. corporate TLS interception, or a server
  //    that sends just the leaf and no AIA), we can't build a useful trust
  //    bundle — report and abort.
  if (chain.length < 2) {
    console.error(
      '\nFatal: only the leaf certificate is available, and AIA walking ' +
        "couldn't extend the chain.",
    );
    console.error(
      `Leaf issuer: "${issuerCN(chain[0])}". If that doesn't look like an ` +
        'ICP-Brasil CA, your network may be intercepting TLS (e.g. an AV ' +
        'middlebox like Norton, or a corporate proxy). Run this script from ' +
        'a network without interception.',
    );
    process.exit(3);
  }
  const trustBundle = chain
    .slice(1)
    .map((c) => rawToPem(forgeCertToDer(c)))
    .join('');
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, trustBundle, 'utf8');
  console.log(`\nWrote ${chain.length - 1} CA cert(s) to:\n  ${outFile}`);
  console.log('\nVerify the captured chain against ICP-Brasil before trusting in produção.');

  captured = true;
  process.exit(0);
});

socket.once('error', (err) => {
  if (captured) return;
  console.error('TLS connect failed:', err.message);
  process.exit(1);
});
