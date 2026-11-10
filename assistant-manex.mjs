import { load } from 'cheerio';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { ICAO, httpsUrl, pdfPages, requireInput } from './assistant-docs.mjs';

const cache = new Map();
const CACHE_MS = 20 * 60 * 1000;
const MAX_BYTES = 12 * 1024 * 1024;
const cacheDirectory = new URL('./.atc-ai-data/manex/',process.env.EFS_INSTALL_URL || import.meta.url);

function cacheFile(url) {
  return new URL(createHash('sha256').update(url).digest('hex') + '.json',cacheDirectory);
}

async function rememberManex(file,doc) {
  await mkdir(cacheDirectory,{recursive:true});
  const temp = new URL(randomUUID() + '.tmp',cacheDirectory);
  try {
    await writeFile(temp,JSON.stringify(doc));
    await rename(temp,file);
  } finally {
    await rm(temp,{force:true});
  }
}

export function manexAddress(value,airport) {
  const safe = httpsUrl(value);
  if (!safe || !ICAO.test(airport)) return '';
  const url = new URL(safe);
  if (url.port || url.search) return '';
  const code = airport.toLowerCase();
  const paths = {
    'wiki.ivao.fr':new RegExp('^/books/manex-aeroports-(?:civils|militaires)/page/' + code + '(?:-[a-z0-9-]+)?/?$'),
    'wiki.ivao.aero':new RegExp('^/(?:en|fr)/home/divisions/(?:[a-z0-9-]+/)+' + code + '/?$'),
    'storage.ivao.fr':new RegExp('^/(?:[a-zA-Z0-9_-]+/)*MANEX/MANEX_' + airport + '\\.pdf$','i')
  };
  if (!Object.hasOwn(paths,url.hostname) || !paths[url.hostname].test(url.pathname)) return '';
  url.hash = '';
  return url.href;
}

async function download(initial,airport) {
  const signal = AbortSignal.timeout(12000);
  let url = initial;
  for (let redirects = 0; redirects <= 2; redirects++) {
    const res = await fetch(url,{redirect:'manual',signal,headers:{Accept:'text/html, application/pdf'}});
    if ([301,302,303,307,308].includes(res.status)) {
      const location = res.headers.get('location');
      url = location ? manexAddress(new URL(location,url).href,airport) : '';
      await res.body?.cancel();
      requireInput(url,'Le MANEX redirige vers une adresse non reconnue.',502);
      continue;
    }
    requireInput(res.ok && res.body,'Le MANEX est inaccessible (HTTP ' + res.status + ').',502);
    if (Number(res.headers.get('content-length')) > MAX_BYTES) {
      await res.body.cancel();
      requireInput(false,'Le MANEX dépasse la limite de lecture automatique.',413);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      requireInput(size <= MAX_BYTES,'Le MANEX dépasse la limite de lecture automatique.',413);
      chunks.push(chunk);
    }
    return {url,bytes:Buffer.concat(chunks)};
  }
  requireInput(false,'Le MANEX contient trop de redirections.',502);
}

const clean = value => value.replace(/\s+/g,' ').trim();
const identifies = (value,airport) => new RegExp('\\b' + airport + '\\b','i').test(value);

export function manexSections(html,airport) {
  const $ = load(html,{scriptingEnabled:false});
  let root = $('.page-content, main .contents, .contents').first();
  if (!root.length) root = $('h1.toc-header').filter((_index,node) => identifies($(node).text(),airport)).first().parent();
  root.find('script,style,nav,.page-navigation,.toc-anchor,[hidden]').remove();
  const title = clean(root.find('h1').first().text() || $('title').text().split('|')[0]);
  requireInput(root.length && identifies(title,airport),'La page reçue ne permet pas d’identifier le MANEX de ' + airport + '.',502);
  root.find('br').replaceWith(' ');
  const pages = [];
  let section = title;
  let anchor = '';
  let lines = [];
  const finish = () => {
    if (lines.length) pages.push({number:null,section,anchor,text:section + '\n' + lines.join('\n')});
    lines = [];
  };
  root.find('h1,h2,h3,h4,h5,h6,p,li,table,pre').each((_index,element) => {
    const node = $(element);
    if (node.parentsUntil(root,'table,li').length) return;
    if (/^h[1-6]$/.test(element.name)) {
      finish();
      section = clean(node.text()) || title;
      anchor = node.attr('id') || node.find('a[id]').first().attr('id') || '';
    } else if (element.name === 'table') {
      node.find('tr').each((_row,element) => {
        const cells = $(element).children('th,td').map((_cell,cell) => clean($(cell).text())).get();
        if (cells.some(Boolean)) lines.push(cells.join(' | '));
      });
    } else {
      const value = clean(node.text());
      if (value) lines.push(value);
    }
  });
  finish();
  requireInput(pages.some(page => page.text.length > 120),'Le MANEX publié ne contient pas assez de texte lisible.',502);
  const intro = pages.slice(0,4).map(page => page.text).join('\n');
  const update = intro.match(/(?:mises? à jour|date\s*\|\s*indicatif)[\s\S]{0,230}?(\d{2}[/.]\d{2}[/.]\d{4})(?:\s*\|\s*(\d{4})\b)?/i);
  const lastUpdated = intro.match(/Last updated:\s*([a-z]+ \d{4})\b/i);
  const revision = update ? update[1] + (update[2] ? ' · AIRAC ' + update[2] : '') : lastUpdated?.[1] ?? '';
  return {title,pages,revision};
}

export function loadManex(value,airport) {
  const url = manexAddress(value,airport);
  if (!url) return Promise.resolve(null);
  const existing = cache.get(url);
  if (existing && existing.until > Date.now()) return existing.promise;
  if (cache.size >= 24) cache.delete(cache.keys().next().value);
  const entry = {until:Date.now()+CACHE_MS};
  const stored = cacheFile(url);
  entry.promise = (async () => {
    const file = await download(url,airport);
    const pdf = file.bytes.subarray(0,1024).includes('%PDF-');
    const parsed = pdf ? {title:'MANEX ' + airport,pages:await pdfPages(file.bytes),revision:''} :
      manexSections(file.bytes.toString('utf8'),airport);
    if (pdf) requireInput(parsed.pages.slice(0,3).some(page => identifies(page.text,airport)),
      'Le PDF du MANEX ne contient pas de texte permettant de vérifier l’aérodrome.',502);
    const doc = {...parsed,airport,url:file.url,pdf,fetchedAt:new Date().toISOString()};
    await rememberManex(stored,doc).catch(() => {});
    return doc;
  })().catch(async error => {
    entry.until = Date.now() + 60000;
    const doc = await readFile(stored,'utf8').then(JSON.parse).catch(() => null);
    if (doc?.airport === airport && manexAddress(doc.url,airport) && Array.isArray(doc.pages) &&
      typeof doc.fetchedAt === 'string') return {...doc,offline:true};
    throw error;
  });
  cache.set(url,entry);
  return entry.promise;
}
