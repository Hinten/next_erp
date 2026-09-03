#!/usr/bin/env node
// Shopee Open Platform docs → plain text, via the SPA's JSON API (no login needed).
//
//   node shopee-doc.mjs modules                 # every API module with its api names
//   node shopee-doc.mjs guides                  # developer-guide TOC with document ids
//   node shopee-doc.mjs guide <document_id> [lang=en|pt-br]
//   node shopee-doc.mjs api <api_name>          # e.g. v2.product.update_stock
//   node shopee-doc.mjs push-list               # push categories + push_api_ids
//   node shopee-doc.mjs push <push_api_id>      # e.g. 1 (order_status_push)
//
// Responses are cached under ./cache/ next to this script.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, 'cache');
mkdirSync(CACHE, { recursive: true });
const BASE = 'https://open.shopee.com/opservice/api/v1';

async function getJson(path, key) {
  const file = join(CACHE, key.replace(/[^a-z0-9_.-]/gi, '_') + '.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const res = await fetch(BASE + path, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  const text = await res.text();
  writeFileSync(file, text);
  return JSON.parse(text);
}

const stripHtml = (s) =>
  String(s ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

function rtText(n) {
  if (!n) return '';
  if (Array.isArray(n)) return n.map(rtText).join('');
  if (typeof n === 'string') return n;
  let s = '';
  if (n.data != null) s += n.data;
  if (n.name === 'softBreak') s += '\n';
  if (n.children) s += n.children.map(rtText).join('');
  if (n.attributes?.linkHref) s += ` <${n.attributes.linkHref}>`;
  return s;
}

function rtRender(nodes, out) {
  for (const n of nodes ?? []) {
    switch (n.name) {
      case 'heading1': out.push('\n# ' + rtText(n.children).trim()); break;
      case 'heading2': out.push('\n## ' + rtText(n.children).trim()); break;
      case 'heading3': out.push('\n### ' + rtText(n.children).trim()); break;
      case 'heading4': out.push('\n#### ' + rtText(n.children).trim()); break;
      case 'paragraph': { const t = rtText(n.children).trim(); if (t) out.push(t); break; }
      case 'listItem': out.push('  '.repeat(n.attributes?.listIndent ?? 0) + '- ' + rtText(n.children).trim()); break;
      case 'codeBlock': out.push('```\n' + rtText(n.children) + '\n```'); break;
      case 'table': {
        for (const row of n.children ?? []) {
          const cells = (row.children ?? []).map((c) => rtText(c.children).replace(/\s+/g, ' ').trim());
          out.push('| ' + cells.join(' | ') + ' |');
        }
        out.push('');
        break;
      }
      case 'imageBlock': out.push('[image]'); break;
      default:
        if (n.children) rtRender(n.children, out);
        else if (n.data) out.push(n.data);
    }
  }
}

function renderParams(list, depth = 0) {
  const out = [];
  for (const p of list ?? []) {
    const req = p.required === 'True' || p.required === true ? 'REQUIRED' : p.required === 'False' || p.required === false ? 'optional' : '';
    const bits = [p.type, req, p.limits ? `limits: ${p.limits}` : '', p.sample ? `sample: ${String(p.sample).slice(0, 80)}` : ''].filter(Boolean).join(', ');
    out.push(`${'  '.repeat(depth)}- ${p.name} (${bits}) — ${stripHtml(p.description).replace(/\s*\n\s*/g, ' ')}`);
    if (p.children?.length) out.push(...renderParams(p.children, depth + 1));
  }
  return out;
}

const safeParse = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };

const cmd = process.argv[2];
const arg = process.argv[3];
const out = [];

if (cmd === 'modules') {
  const j = await getJson('/doc/module/?version=2', 'modules');
  for (const m of j.modules) {
    out.push(`[${m.module_id}] ${m.module_name}`);
    for (const it of m.items ?? []) out.push(`   ${it.name}`);
  }
} else if (cmd === 'guides') {
  const j = await getJson('/developer_guide/list?language_code=en', 'dg_list_en');
  const walk = (items, d) => {
    for (const c of items ?? []) { out.push(`${'   '.repeat(d)}${c.item_id}: ${c.item_name}`); walk(c.children, d + 1); }
  };
  walk(j.developer_guide_list, 0);
} else if (cmd === 'guide') {
  const lang = process.argv[4] ?? 'en';
  const j = await getJson(`/developer_guide/detail?document_id=${arg}&language_code=${lang}`, `dg_${arg}_${lang}`);
  out.push(`# [guide ${arg}] ${j.title}  (category: ${j.category_name}; updated ${new Date(j.update_time * 1000).toISOString().slice(0, 10)})`);
  rtRender(safeParse(j.raw_content, []), out);
} else if (cmd === 'api') {
  const j = await getJson(`/doc/api/?version=2&api_name=${arg}`, `api_${arg}`);
  out.push(`# ${j.api_name}   [${j.module_name}]  type=${j.api_type}  ${j.is_get_method ? 'GET' : 'POST'} ${j.path}`);
  out.push(`url: ${j.url}\ntest_url: ${j.test_url}\nrate_limit: ${j.rate_limit}\napi_permission: ${JSON.stringify(j.api_permission)}`);
  out.push(`\n## Definition\n${stripHtml(j.define)}`);
  const params = safeParse(j.params, {});
  out.push('\n## Common params');
  out.push(...renderParams(safeParse(j.common_params, [])));
  out.push('\n## Request params');
  out.push(...renderParams(params.request_params));
  out.push('\n## Response params');
  out.push(...renderParams(params.response_params));
  for (const s of safeParse(j.request_sample, [])) out.push(`\n## Request sample (${s.type})\n${s.value}`);
  for (const s of safeParse(j.response_sample, [])) out.push(`\n## Response sample (${s.type})\n${s.value}`);
  for (const s of safeParse(j.error_example, [])) out.push(`\n## Error example (${s.type})\n${s.value}`);
  out.push('\n## Errors (api-specific)');
  for (const e of j.error_list ?? []) out.push(`- ${e.name}: ${stripHtml(e.description)}${e.solution?.content ? ' → ' + stripHtml(e.solution.content).replace(/\n/g, ' ') : ''}`);
  out.push('\n## Update log');
  for (const u of j.update_log_list ?? []) out.push(`- ${u.date}: ${stripHtml(u.content)}`);
  if (j.related_documents?.developer_guides?.length) out.push('\n## Related guides: ' + JSON.stringify(j.related_documents.developer_guides));
} else if (cmd === 'push-list') {
  const j = await getJson('/push/category', 'push_category');
  for (const c of j.category) {
    out.push(`[${c.category_id}] ${c.category_name}`);
    for (const p of c.push) out.push(`   push_api_id=${p.push_api_id}  ${p.push_api_name}`);
  }
} else if (cmd === 'push') {
  const j = await getJson(`/push/doc?push_api_id=${arg}`, `push_${arg}`);
  const p = j.push_api;
  out.push(`# push ${p.push_api_name}  (push_api_id=${p.push_api_id}, push_code=${p.push_code}, timeout=${p.push_timeout}, guarantee=${p.push_guarantee})`);
  out.push(`\n## Description\n${stripHtml(p.description)}`);
  out.push('\n## App rules');
  for (const r of p.app_rules ?? []) out.push(`- ${typeof r === 'string' ? stripHtml(r) : JSON.stringify(r)}`);
  out.push('\n## Retry strategy');
  for (const r of p.retry_strategy ?? []) out.push(`- ${typeof r === 'string' ? stripHtml(r) : JSON.stringify(r)}`);
  out.push('\n## Params');
  out.push(...renderParams(safeParse(p.push_params, [])));
  const content = safeParse(p.push_content, {});
  out.push(`\n## Sample\n${stripHtml(content.content ?? '')}`);
  out.push('\n## Update log');
  for (const u of j.update_logs ?? []) out.push(`- ${new Date((u.ctime ?? 0) * 1000).toISOString().slice(0, 10)}: ${stripHtml(u.description)}`);
} else if (cmd === 'announcements') {
  // announcements [category_id=3] [grep-regex]  — categories: 3 All, 55 OpenAPI Updates,
  // 2079 Logistics, 57 Platform Function, 56 Developer Policy, 2080 Brazil OpenAPI Updates, 2107 Seller Policy
  const cat = arg ?? '3';
  const re = process.argv[4] ? new RegExp(process.argv[4], 'i') : null;
  let page = 1;
  for (;;) {
    const j = await getJson(`/content/list?category_id=${cat}&page_size=50&page_index=${page}`, `ann_${cat}_p${page}`);
    const list = j.data ?? [];
    for (const c of list) {
      const body = stripHtml((safeParse(c.content, []) ?? []).map((b) => b.html ?? '').join('\n'));
      if (re && !re.test(c.title) && !re.test(body)) continue;
      out.push(`${c.id} | ${new Date(c.release_time * 1000).toISOString().slice(0, 10)} | ${c.title}`);
    }
    if (list.length < 50 || page * 50 >= (j.total ?? 0)) break;
    page += 1;
  }
} else if (cmd === 'announcement') {
  // announcement <id>  — full text of one announcement via /content/detail
  const j = await getJson(`/content/detail?id=${arg}`, `ann_detail_${arg}`);
  if (!j.id) out.push(`announcement ${arg} not found: ${JSON.stringify(j).slice(0, 200)}`);
  else {
    out.push(`# [announcement ${j.id}] ${j.title}  (${new Date(j.release_time * 1000).toISOString().slice(0, 10)})`);
    const blocks = safeParse(j.detail ?? j.content, []) ?? [];
    out.push(stripHtml(blocks.map((b) => b.html ?? (b.type === 'image' ? '[image]' : '')).join('\n')));
  }
} else {
  out.push('usage: modules | guides | guide <id> [lang] | api <name> | push-list | push <id> | announcements [category_id] [regex] | announcement <id>');
}

process.stdout.write(out.join('\n') + '\n');
