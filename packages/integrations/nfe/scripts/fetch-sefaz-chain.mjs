#!/usr/bin/env node
/**
 * One-shot helper: connect to SEFAZ once, capture the TLS certificate chain
 * the server actually sends, and write it as a PEM bundle to
 * `packages/integrations/nfe/ca/sefaz-<uf>-<ambiente>.pem`.
 *
 * The homologação smoke test auto-loads `ca/sefaz-sp-homologacao.pem` if
 * present (override via `NFE_TLS_CA_PATH`), so once you've run this script
 * the test handshake against SEFAZ-SP just works.
 *
 * **Trust model — TOFU (Trust On First Use):** the script connects with
 * `rejectUnauthorized: false` to fetch the chain, which means the first
 * fetch is vulnerable to a MITM. For **homologação** (test data, no fiscal
 * value) this is acceptable; for **produção** you should hand-verify the
 * captured chain against ICP-Brasil's published root certificates before
 * trusting it.
 *
 * Usage:
 *   node packages/integrations/nfe/scripts/fetch-sefaz-chain.mjs
 *   node packages/integrations/nfe/scripts/fetch-sefaz-chain.mjs --uf=SP --ambiente=homologacao
 *
 * Or via the package script:
 *   pnpm --filter @delfrance/integrations-nfe fetch:sefaz-ca
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:tls';

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

// Only SP-homologação wired today; trivial to extend per UF.
const HOSTS = {
  'SP:homologacao': 'homologacao.nfe.fazenda.sp.gov.br',
  'SP:producao': 'nfe.fazenda.sp.gov.br',
};
const host = HOSTS[`${UF}:${AMBIENTE}`];
if (!host) {
  console.error(`No host wired for UF=${UF} ambiente=${AMBIENTE}.`);
  process.exit(2);
}

const outFile = join(PKG_ROOT, 'ca', `sefaz-${UF.toLowerCase()}-${AMBIENTE}.pem`);

function certToPem(raw) {
  const b64 = raw.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

console.log(`Connecting to ${host}:443 (rejectUnauthorized=false — TOFU mode)…`);

const socket = connect({
  host,
  port: 443,
  servername: host,
  rejectUnauthorized: false,
});

socket.once('secureConnect', () => {
  const pems = [];
  const seen = new Set();
  let curr = socket.getPeerCertificate(true);
  while (curr && curr.raw && !seen.has(curr.fingerprint256)) {
    seen.add(curr.fingerprint256);
    pems.push({
      subject: curr.subject?.CN ?? '(no CN)',
      issuer: curr.issuer?.CN ?? '(no CN)',
      pem: certToPem(curr.raw),
    });
    if (!curr.issuerCertificate || curr.issuerCertificate === curr) break;
    curr = curr.issuerCertificate;
  }

  console.log(`Captured ${pems.length} certs in chain:`);
  for (const [i, c] of pems.entries()) {
    console.log(`  [${i}] subject="${c.subject}" issuer="${c.issuer}"`);
  }

  // For trust, skip the leaf (index 0) — that's SEFAZ's own server cert.
  // We trust the intermediates + root (everything above the leaf).
  const chainPems = pems.slice(1).map((c) => c.pem).join('');
  if (chainPems.length === 0) {
    console.error(
      'No intermediate / root certificates in the chain. SEFAZ may only ' +
        'send the leaf — vendor the ICP-Brasil chain manually.',
    );
    process.exit(3);
  }

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, chainPems, 'utf8');
  console.log(`\nWrote ${pems.length - 1} CA cert(s) to:\n  ${outFile}`);
  console.log(
    '\nVerify the captured chain against ICP-Brasil before trusting in produção.',
  );
  socket.end();
});

socket.once('error', (err) => {
  console.error('TLS connect failed:', err.message);
  process.exit(1);
});
