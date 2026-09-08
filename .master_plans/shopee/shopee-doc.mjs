#!/usr/bin/env node
// Shopee Open Platform docs → plain text, via the SPA's JSON API (no login needed).
//
//   node shopee-doc.mjs modules                 # every API module with its api names
//   node shopee-doc.mjs guides                  # developer-guide TOC with document ids
//   node shopee-doc.mjs guide <document_id> [lang=en|pt-br]
//   node shopee-doc.mjs api <api_name>          # e.g. v2.product.update_stock
//   node shopee-doc.mjs push-list               # push categories + push_api_ids
//   node shopee-doc.mjs push <push_api_id>      # e.g. 1 (order_status_push)
//   node shopee-doc.mjs announcements [category_id] [regex]
//   node shopee-doc.mjs announcement <id>       # full text of one announcement
//   node shopee-doc.mjs faqs [category_id]      # FAQ category tree, or one category's FAQs
//   node shopee-doc.mjs faq <faq_id>            # e.g. 144 (the refresh_token backup plan)
//
// The legacy `faq=NNN` ids that developer guides link to are NOT today’s faq_ids
// (guide 20’s faq=216 is faq_id=144, "refresh_token Backup Plan"), so reach a
// linked FAQ through `faqs` and its category listing, never by the linked number.
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

const day = (secs) => new Date((secs ?? 0) * 1000).toISOString().slice(0, 10);

// error_list and common_error_list carry the same {name, description, solution} shape.
const errLine = (e) =>
  `- ${e.name}: ${stripHtml(e.description)}` +
  (e.solution?.content ? ' → ' + stripHtml(e.solution.content).replace(/\n/g, ' ') : '');

const faqCategories = () => getJson('/category/list?category_type=2&language_code=en', 'faq_categories_en');

const findCategory = (list, id) => {
  for (const c of list ?? []) {
    if (String(c.category_id) === String(id)) return c;
    const hit = findCategory(c.children, id);
    if (hit) return hit;
  }
  return null;
};

// Only LEAF categories hold FAQs — a parent id answers total=0, never its children's rows.
async function faqList(categoryId) {
  const rows = [];
  const seen = new Set();
  for (let page = 1; ; page += 1) {
    const j = await getJson(
      `/portal_faq/list?category_id=${categoryId}&language_code=en&page_size=50&page_no=${page}`,
      `faq_list_${categoryId}_p${page}`,
    );
    const list = j.faq_list ?? [];
    // page_no IS honoured (measured: page_size=10 on 2026 gives 3 disjoint pages), but a page
    // that adds nothing new still ends the loop — its neighbour /content/list spells the
    // parameter page_index, and repeating page 1 forever would read as a longer category, not
    // as a bug. An unknown total means "keep going", never "already done".
    const fresh = list.filter((f) => !seen.has(f.faq_id));
    for (const f of fresh) seen.add(f.faq_id);
    rows.push(...fresh);
    if (list.length < 50 || !fresh.length || rows.length >= (j.total ?? Infinity)) break;
  }
  return rows;
}

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
  for (const e of j.error_list ?? []) out.push(errLine(e));
  out.push('\n## Errors (common — the same list on every API page)');
  for (const e of j.common_error_list ?? []) out.push(errLine(e));
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
} else if (cmd === 'faqs') {
  // faqs                — the FAQ category tree with per-category counts
  // faqs <category_id>  — one category's FAQs; a parent id fans out over its children
  const tree = (await faqCategories()).category_list ?? [];
  if (!arg) {
    const walk = (list, d) => {
      for (const c of list ?? []) { out.push(`${'   '.repeat(d)}${c.category_id}: ${c.name}  (${c.count})`); walk(c.children, d + 1); }
    };
    walk(tree, 0);
    out.push('\nfaqs <category_id> lists one category; a parent id lists every child category.');
  } else {
    const node = findCategory(tree, arg);
    // Collect LEAVES, not direct children: on a deeper tree a mid-level parent would answer
    // total=0 and print (no FAQs) — the very failure the fan-out exists to prevent.
    const leavesOf = (n) => (n.children?.length ? n.children.flatMap(leavesOf) : [n]);
    const leaves = node ? leavesOf(node) : [{ category_id: arg, name: `category ${arg}` }];
    for (const leaf of leaves) {
      out.push(`\n## [${leaf.category_id}] ${leaf.name}`);
      const rows = await faqList(leaf.category_id);
      if (!rows.length) out.push('(no FAQs)');
      for (const f of rows) out.push(`${f.faq_id} | ${day(f.update_time)} | ${String(f.short_info ?? '').replace(/\s+/g, ' ').trim()}`);
    }
  }
} else if (cmd === 'faq') {
  // faq <faq_id>  — one FAQ as text. NOT the legacy `faq=NNN` id guides link to; see the header.
  const j = await getJson(`/portal_faq/detail?faq_id=${arg}&language_code=en`, `faq_${arg}_en`);
  if (!j.faq_id) out.push(`faq ${arg} not found: ${JSON.stringify(j).slice(0, 200)}`);
  else {
    const cat = findCategory((await faqCategories()).category_list ?? [], j.category_id);
    const where = cat ? `${cat.name} (${j.category_id})` : j.category_id;
    out.push(`# [faq ${j.faq_id}] ${j.short_info}  (category: ${where}; updated ${day(j.update_time)})`);
    rtRender(safeParse(j.raw_content, []), out);
  }
} else {
  out.push('usage: modules | guides | guide <id> [lang] | api <name> | push-list | push <id> | announcements [category_id] [regex] | announcement <id> | faqs [category_id] | faq <id>');
}

process.stdout.write(out.join('\n') + '\n');
