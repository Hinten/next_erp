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

import { HttpClient } from 'soap';

import type { NFeCertificate } from '../cert';

const NFE_WSDL_BASE = 'http://www.portalfiscal.inf.br/nfe/wsdl';

/** WSDL namespace + SOAPAction header per SEFAZ web service. */
const SOAP_NS = {
  NFeAutorizacao: `${NFE_WSDL_BASE}/NFeAutorizacao4`,
  NFeRetAutorizacao: `${NFE_WSDL_BASE}/NFeRetAutorizacao4`,
  NFeConsultaProtocolo: `${NFE_WSDL_BASE}/NFeConsultaProtocolo4`,
  NFeStatusServico: `${NFE_WSDL_BASE}/NFeStatusServico4`,
  NFeInutilizacao: `${NFE_WSDL_BASE}/NFeInutilizacao4`,
  RecepcaoEvento: `${NFE_WSDL_BASE}/RecepcaoEvento4`,
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

/**
 * Build the mTLS `https.Agent` for SEFAZ. ICP-Brasil endpoints mandate
 * TLS 1.2; some refuse TLS 1.3. Reuse one agent per certificate to enable
 * keep-alive between requests.
 */
export function createSefazAgent(cert: NFeCertificate): https.Agent {
  return new https.Agent({
    pfx: cert.pfxBuffer,
    passphrase: cert.password,
    keepAlive: true,
    minVersion: 'TLSv1.2',
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

interface PostResult {
  /** Inner XML — the content of `<nfeResultMsg>`, ready to be `parse()`d. */
  readonly resultXml: string;
  /** Raw SOAP body for diagnostics. */
  readonly rawBody: string;
}

/** SOAP 1.2 envelope template. Whitespace inside is irrelevant — only namespaces matter. */
function buildEnvelope(operation: SoapOperation, dadosMsg: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">` +
    `<soap12:Body>` +
    `<nfeDadosMsg xmlns="${SOAP_NS[operation]}">${dadosMsg}</nfeDadosMsg>` +
    `</soap12:Body>` +
    `</soap12:Envelope>`
  );
}

const RE_RESULT_MSG = /<nfeResultMsg\b[^>]*>([\s\S]*?)<\/nfeResultMsg>/i;
const RE_SOAP_FAULT = /<(?:soap12?:)?Fault\b[\s\S]*?<\/(?:soap12?:)?Fault>/i;

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
      client.request(
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
            reject(
              new NFeTransportError(
                `SOAP request to ${input.url} failed`,
                statusFromError,
                bodyFromError,
                err,
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
          // SEFAZ never returns 5xx in the SOAP body for app-level errors;
          // genuine 4xx/5xx mean transport/cert/firewall problems.
          validateStatus: (s: number) => s >= 200 && s < 300,
        },
      );
    },
  );

  if (RE_SOAP_FAULT.test(body)) {
    throw new NFeTransportError(`SEFAZ returned a SOAP Fault (HTTP ${statusCode})`, statusCode, body);
  }
  const match = RE_RESULT_MSG.exec(body);
  if (!match || match[1] === undefined) {
    throw new NFeTransportError(
      `SEFAZ response missing <nfeResultMsg> (HTTP ${statusCode})`,
      statusCode,
      body,
    );
  }
  return { resultXml: match[1].trim(), rawBody: body };
}

// ---------------------------------------------------------------------------
// Operation wrappers — one per SEFAZ method Phase A needs.
// ---------------------------------------------------------------------------

export interface SefazCall {
  readonly url: string;
  readonly cert: NFeCertificate;
  readonly agent: https.Agent;
  readonly timeoutMs?: number;
}

/** `NFeAutorizacao4 / nfeAutorizacaoLote` — send an `<enviNFe>` lote. */
export async function nfeAutorizacaoLote(
  call: SefazCall,
  enviNFeXml: string,
): Promise<PostResult> {
  return postSoap({
    url: call.url,
    operation: 'NFeAutorizacao',
    dadosMsg: enviNFeXml,
    agent: call.agent,
    timeoutMs: call.timeoutMs,
  });
}

/** `NFeRetAutorizacao4 / nfeRetAutorizacao` — poll a lote by `nRec`. */
export async function nfeRetAutorizacao(
  call: SefazCall,
  consReciNFeXml: string,
): Promise<PostResult> {
  return postSoap({
    url: call.url,
    operation: 'NFeRetAutorizacao',
    dadosMsg: consReciNFeXml,
    agent: call.agent,
    timeoutMs: call.timeoutMs,
  });
}

/** `NfeConsultaProtocolo4 / nfeConsultaNF` — query one NF-e by chave. */
export async function nfeConsultaProtocolo(
  call: SefazCall,
  consSitNFeXml: string,
): Promise<PostResult> {
  return postSoap({
    url: call.url,
    operation: 'NFeConsultaProtocolo',
    dadosMsg: consSitNFeXml,
    agent: call.agent,
    timeoutMs: call.timeoutMs,
  });
}

/** `NFeStatusServico4 / nfeStatusServicoNF` — service availability. */
export async function nfeStatusServico(
  call: SefazCall,
  consStatServXml: string,
): Promise<PostResult> {
  return postSoap({
    url: call.url,
    operation: 'NFeStatusServico',
    dadosMsg: consStatServXml,
    agent: call.agent,
    timeoutMs: call.timeoutMs,
  });
}

// Exposed for offline tests that exercise envelope shape / response unwrap.
export const __internal = { buildEnvelope, RE_RESULT_MSG, RE_SOAP_FAULT };
