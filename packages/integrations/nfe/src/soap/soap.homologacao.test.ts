/**
 * Live SEFAZ-SP homologação smoke test for the SOAP transport.
 *
 * Skipped automatically unless `NFE_CERT_BASE64` + `NFE_CERT_PASSWORD` are
 * set in the environment. Run locally with:
 *
 *   $env:NFE_CERT_BASE64 = (Get-Content cert.pfx -AsByteStream | %{ [Convert]::ToBase64String($_) })
 *   $env:NFE_CERT_PASSWORD = "your-pfx-password"
 *   pnpm --filter @delfrance/integrations-nfe test soap.homologacao
 *
 * The CI counterpart will live in `ci-nfe.yml` (Phase A follow-up) and read
 * the same env vars from GitHub Actions secrets `NF_CERT_BASE64` /
 * `NF_CERT_PASSWORD` (the secret names match the old Flutter pipeline so a
 * single homologação cert covers both repos).
 *
 * The test issues a `consStatServ` (NFeStatusServico4) — the lowest-impact
 * SEFAZ call: it only asks whether the service is up. No NF-e is issued.
 * Use sparingly — looping this still trips `cStat=656 Consumo Indevido`.
 */
import { describe, expect, it } from 'vitest';

import { loadCertificateFromEnv } from '../cert';
import { getEndpoints } from '../endpoints';
import { serialize } from '../xml';
import {
  createSefazAgent,
  nfeStatusServico,
  type SefazCall,
} from './index';

const hasCert =
  Boolean(process.env.NFE_CERT_BASE64) && process.env.NFE_CERT_PASSWORD != null;

const describeOrSkip = hasCert ? describe : describe.skip;

describeOrSkip('SEFAZ-SP homologação smoke', () => {
  it('responds to NFeStatusServico4 with cStat=107 (Serviço em Operação)', async () => {
    const cert = loadCertificateFromEnv();
    const agent = createSefazAgent(cert);
    const url = getEndpoints('SP', 'homologacao').NfeStatusServico;

    const consStatXml = serialize('consStatServ', {
      tpAmb: '2',
      cUF: '35',
      xServ: 'STATUS',
      versao: '4.00',
    });

    const call: SefazCall = { url, cert, agent, timeoutMs: 30_000 };
    const result = await nfeStatusServico(call, consStatXml);

    // SEFAZ returns <retConsStatServ versao="4.00"><tpAmb>2</tpAmb>
    // <verAplic>...</verAplic><cStat>107</cStat><xMotivo>Serviço em
    // Operação</xMotivo>...</retConsStatServ>
    expect(result.resultXml).toContain('<retConsStatServ');
    expect(result.resultXml).toContain('<tpAmb>2</tpAmb>');
    // 107 (up) is the happy path; 108/109 (paralisado) is a non-failure
    // outcome that still proves the round-trip works.
    expect(result.resultXml).toMatch(/<cStat>(107|108|109)<\/cStat>/);
    // Log the motivo so a CI failure leaves breadcrumbs.
    const motivoMatch = /<xMotivo>([^<]+)<\/xMotivo>/.exec(result.resultXml);
    if (motivoMatch) {
      // eslint-disable-next-line no-console
      console.log(`[SEFAZ-SP homologação] xMotivo: ${motivoMatch[1]}`);
    }
  }, 45_000);
});
