/**
 * NF-e XML (de)serializer.
 *
 * Walks the ordered field metadata generated from the SEFAZ XSDs
 * (`../types/nfe-schema`, see ADR 0004) to build and parse documents in the
 * exact `xs:sequence` order SEFAZ requires. Output carries no formatting
 * whitespace (MOC §4.2.1.3) so the signed `infNFe` digest is stable.
 */
import { META, ROOTS } from '../types/nfe-schema';

const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';

export class NFeXmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NFeXmlError';
  }
}

/** A document value: nested objects, string leaves, and arrays of either. */
export type XmlValue = { [key: string]: unknown };

type RootKey = keyof typeof ROOTS;

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------
export function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, '&quot;');
}

/** Serialize a value into the XML for a root element (e.g. `enviNFe`). */
export function serialize(root: RootKey, value: XmlValue): string {
  const { xmlName, type } = ROOTS[root];
  return `<?xml version="1.0" encoding="UTF-8"?>${buildElement(xmlName, type, value, true)}`;
}

/** Serialize a value as a bare element (no XML declaration, no namespace). */
export function serializeFragment(type: string, tag: string, value: XmlValue): string {
  return buildElement(tag, type, value, false);
}

function buildElement(tag: string, typeName: string, value: XmlValue, isRoot: boolean): string {
  const defs = META[typeName];
  if (!defs) throw new NFeXmlError(`Unknown complexType '${typeName}'`);
  let attrs = isRoot ? ` xmlns="${NFE_NS}"` : '';
  let body = '';
  for (const d of defs) {
    const raw = value[d.name];
    if (raw == null) continue;
    if (d.kind === 'attribute') {
      attrs += ` ${d.name}="${escapeAttr(String(raw))}"`;
      continue;
    }
    const items = d.list ? (Array.isArray(raw) ? raw : [raw]) : [raw];
    for (const item of items) {
      if (item == null) continue;
      if (d.type === '#raw') {
        body += String(item); // pre-built XML (e.g. the <Signature> block)
      } else if (d.type === '#string') {
        body += `<${d.name}>${escapeText(String(item))}</${d.name}>`;
      } else {
        body += buildElement(d.name, d.type, item as XmlValue, false);
      }
    }
  }
  return `<${tag}${attrs}>${body}</${tag}>`;
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------
interface XNode {
  tag: string;
  attrs: Record<string, string>;
  children: XNode[];
  text: string;
  /** Outer XML of this node — used for `#raw` fields. */
  raw: string;
}

function unescapeText(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

const localName = (tag: string): string => (tag.includes(':') ? tag.slice(tag.indexOf(':') + 1) : tag);

/** Minimal XML parser — enough for SEFAZ payloads (no DTD). */
function parseXml(text: string): XNode {
  const root: XNode = { tag: '#root', attrs: {}, children: [], text: '', raw: '' };
  const stack: { node: XNode; start: number }[] = [{ node: root, start: 0 }];
  // The stack always holds at least `root`; close tags never pop past it.
  const top = (): { node: XNode; start: number } => stack[stack.length - 1] as never;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt === -1) {
      top().node.text += text.slice(i);
      break;
    }
    if (lt > i) top().node.text += text.slice(i, lt);
    if (text.startsWith('<?', lt)) {
      i = text.indexOf('?>', lt) + 2;
      continue;
    }
    if (text.startsWith('<!--', lt)) {
      i = text.indexOf('-->', lt) + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt);
      top().node.text += text.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      i = text.indexOf('>', lt) + 1;
      continue;
    }
    const gt = text.indexOf('>', lt);
    if (gt === -1) break;
    let inner = text.slice(lt + 1, gt).trim();
    if (inner.startsWith('/')) {
      const closed = stack.pop();
      if (closed) closed.node.raw = text.slice(closed.start, gt + 1);
      i = gt + 1;
      continue;
    }
    const selfClose = inner.endsWith('/');
    if (selfClose) inner = inner.slice(0, -1).trim();
    const sp = inner.search(/\s/);
    const tag = sp === -1 ? inner : inner.slice(0, sp);
    const attrs: Record<string, string> = {};
    if (sp !== -1) {
      const attrRe = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
      let m: RegExpExecArray | null;
      while ((m = attrRe.exec(inner.slice(sp)))) {
        const [, key, val] = m;
        if (key !== undefined && val !== undefined) attrs[key] = unescapeText(val);
      }
    }
    const node: XNode = { tag, attrs, children: [], text: '', raw: '' };
    top().node.children.push(node);
    if (selfClose) node.raw = text.slice(lt, gt + 1);
    else stack.push({ node, start: lt });
    i = gt + 1;
  }
  return root;
}

function findNode(node: XNode, name: string): XNode | undefined {
  for (const c of node.children) {
    if (localName(c.tag) === name) return c;
    const deep = findNode(c, name);
    if (deep) return deep;
  }
  return undefined;
}

function parseElement(node: XNode, typeName: string): XmlValue {
  const defs = META[typeName];
  if (!defs) throw new NFeXmlError(`Unknown complexType '${typeName}'`);
  const obj: XmlValue = {};
  for (const d of defs) {
    if (d.kind === 'attribute') {
      if (d.name in node.attrs) obj[d.name] = node.attrs[d.name];
      continue;
    }
    const matches = node.children.filter((c) => localName(c.tag) === d.name);
    const first = matches[0];
    if (first === undefined) continue;
    const convert = (c: XNode): unknown =>
      d.type === '#raw'
        ? c.raw
        : d.type === '#string'
          ? unescapeText(c.text)
          : parseElement(c, d.type);
    obj[d.name] = d.list ? matches.map(convert) : convert(first);
  }
  return obj;
}

/** Parse the XML for a root element into a typed object. */
export function parse<T = XmlValue>(root: RootKey, xml: string): T {
  const { xmlName, type } = ROOTS[root];
  const doc = parseXml(xml);
  const node = findNode(doc, xmlName);
  if (!node) throw new NFeXmlError(`Root element <${xmlName}> not found`);
  return parseElement(node, type) as T;
}
