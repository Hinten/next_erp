/**
 * SOAP 1.2 transport for SEFAZ NF-e web services.
 *
 * **Server-only.** Uses the `soap` package's HttpClient (axios-backed) for
 * mTLS POSTing and hand-builds the SOAP 1.2 envelope. The envelope is hand-
 * built because:
 *
 *   1. Each SEFAZ operation uses a different `xmlns` on `<nfeDadosMsg>` and a
 *      matching SOAPAction header — the WSDL parser added little value here.
 *   2. SEFAZ rejects messages on subtle namespace-ordering differences
 *      (`cStat=215`/`225`). A template gives us byte-exact control.
 *   3. The signed `<NFe>` byte stream **must not be re-serialized** — any
 *      re-parsing in the SOAP layer would invalidate the digest.
 *
 * The body parameter inside the envelope is `<nfeDadosMsg>` (the SEFAZ v4.00
 * shape). `nfeCabecMsg` was retired in 4.00 and is not emitted here.
 *
 * Ports `.old/packages/nfe_client/lib/src/client.dart` — call sites,
 * `https.Agent`, and the operation list match one-for-one.
 */
import https from 'node:https';
import { rootCertificates } from 'node:tls';

import { HttpClient } from 'soap';

import type { NFeCertificate } from '../cert';
import { assertSafeTpAmb, type TpAmb } from '../safety';
import { validateXsd, type XsdRootKey } from '../xsd';

const NFE_WSDL_BASE = 'http://www.portalfiscal.inf.br/nfe/wsdl';

/** WSDL namespace + SOAPAction header per SEFAZ web service. */
const SOAP_NS = {
  NFeAutorizacao: `${NFE_WSDL_BASE}/NFeAutorizacao4`,
  NFeRetAutorizacao: `${NFE_WSDL_BASE}/NFeRetAutorizacao4`,
  NFeConsultaProtocolo: `${NFE_WSDL_BASE}/NFeConsultaProtocolo4`,
  NFeStatusServico: `${NFE_WSDL_BASE}/NFeStatusServico4`,
  NFeInutilizacao: `${NFE_WSDL_BASE}/NFeInutilizacao4`,
  // SEFAZ's WSDL service name (and thus the nfeDadosMsg xmlns + SOAPAction)
  // for the event service is `NFeRecepcaoEvento4` — same `NFe<Service>4`
  // pattern as the others. Without the `NFe` prefix SEFAZ rejects the POST
  // with a SOAP Fault: "The action '…/RecepcaoEvento4' was not recognized."
  RecepcaoEvento: `${NFE_WSDL_BASE}/NFeRecepcaoEvento4`,
} as const;

export type SoapOperation = keyof typeof SOAP_NS;

export class NFeTransportError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly responseBody?: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'NFeTransportError';
  }
}

/** Options for `createSefazAgent`. */
export interface SefazAgentOptions {
  /**
   * Extra root / intermediate CAs to trust on top of Node's default
   * Mozilla bundle. SEFAZ endpoints chain through Brazilian CAs (the
   * ICP-Brasil hierarchy: AC Raiz → SERPRO / SAFEWEB / VALID → leaf)
   * which aren't all in Node's defaults; without them the TLS handshake
   * fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.
   *
   * For Windows local dev, `NODE_OPTIONS=--use-system-ca` (Node 22+)
   * uses the OS trust store and avoids needing this option. For Linux
   * CI containers, vendor the chain and pass it here.
   */
  readonly ca?: string | Buffer | ReadonlyArray<string | Buffer>;
}

/**
 * Build the mTLS `https.Agent` for SEFAZ.
 *
 * Uses the PEM-encoded key + cert (already extracted from the PFX by
 * `node-forge` during `loadCertificate*`) rather than feeding the raw
 * `pfxBuffer` to OpenSSL. **Why**: Node 17+ ships with OpenSSL 3.0, which
 * deprecated the legacy PKCS#12 algorithms (`RC2-40-CBC` for cert bags,
 * `3DES-CBC` for the MAC). ICP-Brasil A1 certs exported from the Receita
 * Federal portal still use those legacy ciphers, so passing the PFX
 * directly trips `ERR_CRYPTO_UNSUPPORTED_OPERATION: Unsupported PKCS12
 * PFX data`. The PEM path bypasses OpenSSL's PFX parser entirely —
 * node-forge already did the parsing in pure JS.
 *
 * ICP-Brasil endpoints mandate TLS 1.2; some refuse TLS 1.3. Reuse one
 * agent per certificate to enable keep-alive between requests.
 */
export function createSefazAgent(
  cert: NFeCertificate,
  options: SefazAgentOptions = {},
): https.Agent {
  // Setting `ca` on https.Agent **replaces** Node's bundled Mozilla roots.
  // SEFAZ chains through Brazilian intermediates we vendor → the intermediate
  // would be trusted, but it must itself chain UP to a trusted root — and
  // dropping Mozilla's roots means losing the ICP-Brasil root that lives
  // there. Always merge: defaults + caller's extras.
  const extras: ReadonlyArray<string | Buffer> =
    options.ca === undefined ? [] : Array.isArray(options.ca) ? options.ca : [options.ca];
  return new https.Agent({
    key: cert.privateKeyPem,
    cert: cert.certificatePem,
    keepAlive: true,
    minVersion: 'TLSv1.2',
    ca: [...rootCertificates, ...extras],
  });
}

interface PostInput {
  readonly url: string;
  readonly operation: SoapOperation;
  /** Inner payload XML — e.g. `<enviNFe ...>...</enviNFe>` from the serializer. */
  readonly dadosMsg: string;
  readonly agent: https.Agent;
  readonly timeoutMs?: number;
}

export interface PostResult {
  /** Inner XML — the content of `<nfeResultMsg>`, ready to be `parse()`d. */
  readonly resultXml: string;
  /** Raw SOAP body for diagnostics. */
  readonly rawBody: string;
}

/**
 * Strip a leading `<?xml ... ?>` declaration. SEFAZ rejects (HTTP 400) any
 * payload that contains an XML declaration in the middle of the document —
 * a declaration is only valid at the very top. Our `serialize(...)` emits
 * a full document (with declaration); inside the SOAP envelope we need the
 * element only.
 */
function stripXmlDeclaration(xml: string): string {
  return xml.replace(/^\s*<\?xml[^?]*\?>\s*/, '');
}

/** SOAP 1.2 envelope template. Whitespace inside is irrelevant — only namespaces matter. */
function buildEnvelope(operation: SoapOperation, dadosMsg: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">` +
    `<soap12:Body>` +
    `<nfeDadosMsg xmlns="${SOAP_NS[operation]}">${stripXmlDeclaration(dadosMsg)}</nfeDadosMsg>` +
    `</soap12:Body>` +
    `</soap12:Envelope>`
  );
}

// The standard v4.00 wrapper is `<nfeResultMsg>`, but the **Ambiente
// Nacional**'s NFeRecepcaoEvento4 (classic .NET ASMX) wraps the payload in
// the `{operation}Result` style instead — `<nfeRecepcaoEventoNFResult>`.
// Accept both: any `nfe…Result`/`nfe…ResultMsg` element, closed by the same
// tag (backreference), with the payload in group 2.
const RE_RESULT_MSG =
  /<((?:[A-Za-z0-9_]+:)?nfe[A-Za-z0-9_]*Result(?:Msg)?)\b[^>]*>([\s\S]*?)<\/\1>/i;
// Any-prefix Fault — classic ASMX answers `<soap:Fault>`/`<soap12:Fault>`,
// WCF-based services answer `<s:Fault>`.
const RE_SOAP_FAULT = /<(?:[A-Za-z0-9_]+:)?Fault\b[\s\S]*?<\/(?:[A-Za-z0-9_]+:)?Fault>/i;

/**
 * Project an axios / Node error onto a safe shape for use as
 * `NFeTransportError.cause`. The raw error embeds the full `httpsAgent`
 * options — which includes our PEM-encoded **private key** and the
 * cert. Without this sanitisation, a single failed POST dumps both into
 * stack traces, logs, and Vitest output.
 */
function sanitizeTransportError(err: unknown): {
  message?: string;
  code?: string;
  status?: number;
} {
  if (typeof err !== 'object' || err === null) {
    return { message: err instanceof Error ? err.message : String(err) };
  }
  const e = err as { message?: string; code?: string; response?: { status?: number } };
  return {
    message: e.message,
    code: e.code,
    status: e.response?.status,
  };
}

/**
 * POST a SOAP envelope and return the unwrapped `<nfeResultMsg>` payload.
 *
 * Why a regex instead of an XML parse? The result body is itself NF-e XML
 * (e.g. `<retEnviNFe>...`) and we want to hand it straight to the typed
 * parser. Parsing the SOAP envelope twice (once here, once in `xml.parse`)
 * would risk losing CDATA boundaries and is unnecessary.
 */
async function postSoap(input: PostInput): Promise<PostResult> {
  const envelope = buildEnvelope(input.operation, input.dadosMsg);
  const client = new HttpClient();
  const action = SOAP_NS[input.operation];

  const { statusCode, body } = await new Promise<{ statusCode: number; body: string }>(
    (resolve, reject) => {
      // Fire-and-forget: the callback resolves/rejects the surrounding Promise;
      // the request handle itself is intentionally not awaited.
      void client.request(
        input.url,
        envelope,
        (err: unknown, res: { status?: number } | undefined, responseBody: unknown) => {
          if (err) {
            const statusFromError =
              typeof err === 'object' && err !== null && 'response' in err
                ? ((err as { response?: { status?: number } }).response?.status ?? 0)
                : 0;
            const bodyFromError =
              typeof err === 'object' && err !== null && 'response' in err
                ? String((err as { response?: { data?: unknown } }).response?.data ?? '')
                : err instanceof Error
                  ? err.message
                  : String(err);
            // Pass a sanitized cause so the agent's PEM key + cert never
            // leak into stack traces / Vitest output. Also fold the
            // underlying error code + message into the wrapper's own
            // message — without it, the failure says only "SOAP request
            // to … failed", which is uselessly opaque for diagnosis.
            const sanitized = sanitizeTransportError(err);
            const detail = [
              sanitized.code,
              sanitized.status ? `HTTP ${sanitized.status}` : undefined,
              sanitized.message,
            ]
              .filter((s) => s != null && s !== '')
              .join(' — ');
            reject(
              new NFeTransportError(
                `SOAP request to ${input.url} failed${detail ? ': ' + detail : ''}`,
                statusFromError,
                bodyFromError,
                sanitized,
              ),
            );
            return;
          }
          resolve({
            statusCode: res?.status ?? 0,
            body: typeof responseBody === 'string' ? responseBody : String(responseBody ?? ''),
          });
        },
        {
          'Content-Type': `application/soap+xml; charset=utf-8; action="${action}"`,
          SOAPAction: action,
        },
        {
          httpsAgent: input.agent,
          timeout: input.timeoutMs ?? 60_000,
          responseType: 'text',
          // Never follow redirects with a signed fiscal payload — SEFAZ
          // services don't redirect a valid POST, so a 3xx (observed from
          // the AN's fronting load balancer) must surface as a transport
          // error, not be silently re-POSTed somewhere else.
          maxRedirects: 0,
          // SEFAZ never returns 5xx in the SOAP body for app-level errors;
          // genuine 4xx/5xx mean transport/cert/firewall problems.
          validateStatus: (s: number) => s >= 200 && s < 300,
        },
      );
    },
  );

  if (RE_SOAP_FAULT.test(body)) {
    throw new NFeTransportError(
      `SEFAZ returned a SOAP Fault (HTTP ${statusCode})`,
      statusCode,
      body,
    );
  }
  const match = RE_RESULT_MSG.exec(body);
  if (!match || match[2] === undefined) {
    // Sanitized diagnosis hint: only the ROOT TAG of whatever came back (an
    // HTML error page, a load-balancer stub, …) — never the body itself,
    // which is redacted from logs because it can echo signed XML.
    const rootTag = /<\s*([A-Za-z!?][A-Za-z0-9:_-]*)/.exec(body)?.[1] ?? '(empty body)';
    throw new NFeTransportError(
      `SEFAZ response missing the result wrapper (<nfeResultMsg> or ASMX-style ` +
        `<nfe…Result>) — HTTP ${statusCode}; body root <${rootTag}>`,
      statusCode,
      body,
    );
  }
  return { resultXml: match[2].trim(), rawBody: body };
}

// ---------------------------------------------------------------------------
// Operation wrappers — one per SEFAZ method Phase A needs.
// ---------------------------------------------------------------------------

export interface SefazCall {
  readonly url: string;
  readonly cert: NFeCertificate;
  readonly agent: https.Agent;
  /**
   * SEFAZ ambiente literal — `'2'` homologação, `'1'` produção. Checked by
   * `assertSafeTpAmb` before every POST: `'1'` is rejected unless the
   * `NFE_ALLOW_PRODUCAO=true` env var is set. The call site must pass this
   * explicitly; relying on a regex over the body is a worse safety boundary.
   */
  readonly tpAmb: TpAmb;
  readonly timeoutMs?: number;
}

/**
 * Configuration for one SOAP roundtrip: request root + response root.
 *
 * Used by `postSoapValidated` to pick the right XSD on each side. Hard-coded
 * per operation wrapper because the operation already knows its contract;
 * exposing the root choice to callers would just be a footgun.
 */
interface OperationContract {
  readonly soapOp: SoapOperation;
  readonly requestRoot: XsdRootKey;
  readonly responseRoot: XsdRootKey;
}

const CONTRACTS: Record<string, OperationContract> = {
  nfeAutorizacaoLote: {
    soapOp: 'NFeAutorizacao',
    requestRoot: 'enviNFe',
    responseRoot: 'retEnviNFe',
  },
  nfeRetAutorizacao: {
    soapOp: 'NFeRetAutorizacao',
    requestRoot: 'consReciNFe',
    responseRoot: 'retConsReciNFe',
  },
  nfeConsultaProtocolo: {
    soapOp: 'NFeConsultaProtocolo',
    requestRoot: 'consSitNFe',
    responseRoot: 'retConsSitNFe',
  },
  nfeStatusServico: {
    soapOp: 'NFeStatusServico',
    requestRoot: 'consStatServ',
    responseRoot: 'retConsStatServ',
  },
  nfeRecepcaoEvento: {
    soapOp: 'RecepcaoEvento',
    requestRoot: 'envEvento',
    responseRoot: 'retEnvEvento',
  },
  nfeInutilizacao: {
    soapOp: 'NFeInutilizacao',
    requestRoot: 'inutNFe',
    responseRoot: 'retInutNFe',
  },
};

/**
 * The full gated send: production-guard → XSD-validate request →
 * `postSoap` → XSD-validate response → return.
 *
 * Every public operation wrapper goes through here. There is no escape
 * hatch from public callers, on purpose — the XSD gate is what prevents
 * `cStat=656 Consumo Indevido` bans, and the safety guard is what stops
 * accidental produção traffic.
 */
async function postSoapValidated(
  contract: OperationContract,
  call: SefazCall,
  dadosMsg: string,
): Promise<PostResult> {
  assertSafeTpAmb(call.tpAmb);
  await validateXsd(contract.requestRoot, dadosMsg);
  const result = await postSoap({
    url: call.url,
    operation: contract.soapOp,
    dadosMsg,
    agent: call.agent,
    timeoutMs: call.timeoutMs,
  });
  await validateXsd(contract.responseRoot, result.resultXml);
  return result;
}

/** `NFeAutorizacao4 / nfeAutorizacaoLote` — send an `<enviNFe>` lote. */
export async function nfeAutorizacaoLote(call: SefazCall, enviNFeXml: string): Promise<PostResult> {
  return postSoapValidated(CONTRACTS.nfeAutorizacaoLote!, call, enviNFeXml);
}

/** `NFeRetAutorizacao4 / nfeRetAutorizacao` — poll a lote by `nRec`. */
export async function nfeRetAutorizacao(
  call: SefazCall,
  consReciNFeXml: string,
): Promise<PostResult> {
  return postSoapValidated(CONTRACTS.nfeRetAutorizacao!, call, consReciNFeXml);
}

/** `NfeConsultaProtocolo4 / nfeConsultaNF` — query one NF-e by chave. */
export async function nfeConsultaProtocolo(
  call: SefazCall,
  consSitNFeXml: string,
): Promise<PostResult> {
  return postSoapValidated(CONTRACTS.nfeConsultaProtocolo!, call, consSitNFeXml);
}

/** `NFeStatusServico4 / nfeStatusServicoNF` — service availability. */
export async function nfeStatusServico(
  call: SefazCall,
  consStatServXml: string,
): Promise<PostResult> {
  return postSoapValidated(CONTRACTS.nfeStatusServico!, call, consStatServXml);
}

/** `RecepcaoEvento4 / nfeRecepcaoEvento` — send an `<envEvento>` lote (cancelamento, CC-e). */
export async function nfeRecepcaoEvento(
  call: SefazCall,
  envEventoXml: string,
): Promise<PostResult> {
  return postSoapValidated(CONTRACTS.nfeRecepcaoEvento!, call, envEventoXml);
}

/** `NFeInutilizacao4 / nfeInutilizacaoNF` — burn an unused número range. */
export async function nfeInutilizacao(call: SefazCall, inutNFeXml: string): Promise<PostResult> {
  return postSoapValidated(CONTRACTS.nfeInutilizacao!, call, inutNFeXml);
}

// Exposed for offline tests that exercise envelope shape / response unwrap.
export const __internal = { buildEnvelope, RE_RESULT_MSG, RE_SOAP_FAULT };
