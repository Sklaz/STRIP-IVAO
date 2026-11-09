import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = process.env.EFS_AI_DATA_DIR || fileURLToPath(new URL('./.atc-ai-data/', import.meta.url));
export const MAX_DOCUMENT = 15 * 1024 * 1024;
export const ICAO = /^[A-Z]{4}$/;
const DOCUMENT_ID = /^[a-f0-9-]{36}$/;
const categories = ['AIP / AIS','NOTAM','VAC / ADC','SID / STAR / IAC','MANEX IVAO','Information locale'];

export function requireInput(condition, message, status = 400) {
  if (!condition) throw Object.assign(new Error(message), {status});
}

export function httpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

function date(value) {
  if (!value) return '';
  const parsed = new Date(value);
  requireInput(/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(+parsed) &&
    parsed.toISOString().slice(0,10) === value, 'Date de validité invalide.');
  return value;
}

export function validity(doc) {
  const today = new Date().toISOString().slice(0,10);
  const {from, until} = doc;
  if (until && until < today) return {state:'expired', label:'Expiré · fin ' + until};
  if (from && from > today) return {state:'future', label:'Pas encore applicable · ' + from};
  if (from && until) return {state:'dated', label:from + ' → ' + until + ' · période déclarée'};
  if (from) return {state:'unknown', label:'À partir du ' + from + ' · validité actuelle à vérifier'};
  if (until) return {state:'unknown', label:'Fin déclarée le ' + until + ' · début inconnu'};
  return {state:'unknown', label:'Validité non renseignée'};
}

export function documentSummary(doc) {
  return {id:doc.id, title:doc.title, airport:doc.airport, category:doc.category, pdf:doc.pdf,
    pages:doc.pages.length, indexedPages:doc.pages.filter(page => page.text).length,
    from:doc.from, until:doc.until, validity:validity(doc), publisher:doc.publisher,
    href:'/api/assistant/documents/' + doc.id};
}

export async function listDocuments(airport) {
  await mkdir(directory,{recursive:true});
  const names = (await readdir(directory)).filter(name => DOCUMENT_ID.test(name.slice(0,-5)) && name.endsWith('.json'));
  const docs = await Promise.all(names.map(async name => JSON.parse(await readFile(join(directory,name),'utf8'))));
  return docs.filter(doc => !airport || doc.airport === airport).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
}

export async function pdfPages(bytes) {
  const {getDocument} = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({data:new Uint8Array(bytes),isEvalSupported:false,useSystemFonts:true,enableXfa:false,stopAtErrors:true});
  try {
    const pdf = await task.promise;
    requireInput(pdf.numPages <= 300,'Importe un extrait de 300 pages maximum.',413);
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.map(item => item.str ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim();
      pages.push({number,text:text.slice(0,35000)});
      page.cleanup();
    }
    return pages;
  } finally { await task.destroy(); }
}

export async function importDocument(form) {
  const airport = String(form.get('airport') ?? '').trim().toUpperCase();
  const file = form.get('file');
  const category = String(form.get('category') ?? '');
  const title = String(form.get('title') || file?.name || '').trim().slice(0,160);
  const origin = String(form.get('publisher') ?? '').trim();
  const publisher = httpsUrl(origin);
  const from = date(String(form.get('from') ?? ''));
  const until = date(String(form.get('until') ?? ''));
  requireInput(ICAO.test(airport) && title && categories.includes(category),'Aérodrome, titre ou catégorie invalide.');
  requireInput(!origin || publisher,'Renseigne un lien éditeur HTTPS valide.');
  requireInput(!from || !until || from <= until,'La fin de validité précède son début.');
  requireInput(file instanceof File && file.size && file.size <= MAX_DOCUMENT,'Choisis un PDF ou un TXT de 15 Mo maximum.');
  const bytes = Buffer.from(await file.arrayBuffer());
  const pdf = /\.pdf$/i.test(file.name);
  requireInput(pdf || /\.txt$/i.test(file.name),'Formats acceptés PDF et TXT.');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const previous = await listDocuments();
  requireInput(!previous.some(doc => doc.airport === airport && doc.hash === hash),'Ce fichier est déjà indexé pour cet aérodrome.',409);
  requireInput(previous.length < 60,'La bibliothèque locale est limitée à 60 documents.',413);
  let pages;
  if (pdf) {
    requireInput(bytes.subarray(0,1024).includes('%PDF-'),'Ce fichier ne contient pas un PDF lisible.');
    try { pages = await pdfPages(bytes); }
    catch (error) {
      if (error.status) throw error;
      requireInput(false,'Lecture du PDF impossible. Vérifie le format et l’absence de mot de passe.');
    }
  } else {
    requireInput(bytes.length <= 1024 * 1024,'Un extrait TXT est limité à 1 Mo.',413);
    const text = bytes.toString('utf8').trim();
    requireInput(text && !text.includes('\0'),'Le fichier TXT doit contenir du texte UTF-8.');
    const sections = text.split('\f',301);
    requireInput(sections.length <= 300,'Importe un extrait de 300 pages maximum.',413);
    pages = sections.map((part,index) => ({number:index+1,text:part.slice(0,35000)}));
  }
  const id = randomUUID();
  const doc = {id,airport,title,category,publisher,from,until,pdf,hash,createdAt:new Date().toISOString(),pages};
  const original = join(directory,id + (pdf ? '.pdf' : '.txt'));
  const pending = join(directory,id + '.tmp');
  try {
    await writeFile(original,bytes,{flag:'wx'});
    await writeFile(pending,JSON.stringify(doc),{flag:'wx'});
    await rename(pending,join(directory,id + '.json'));
  } catch (error) {
    await Promise.allSettled([rm(original,{force:true}),rm(pending,{force:true})]);
    throw error;
  }
  return documentSummary(doc);
}

export async function readDocument(id) {
  requireInput(DOCUMENT_ID.test(id),'Document introuvable.',404);
  try {
    const doc = JSON.parse(await readFile(join(directory,id + '.json'),'utf8'));
    return {doc,bytes:await readFile(join(directory,id + (doc.pdf ? '.pdf' : '.txt')))};
  } catch (error) {
    if (error.code === 'ENOENT') requireInput(false,'Document introuvable.',404);
    throw error;
  }
}

export async function visualPage(id,number,airport) {
  const {doc,bytes} = await readDocument(id);
  requireInput(doc.airport === airport && doc.pdf && Number.isInteger(number) && number >= 1 && number <= doc.pages.length,
    'Choisis une page PDF de cet aérodrome.');
  const {PDFDocument} = await import('pdf-lib');
  const original = await PDFDocument.load(bytes,{updateMetadata:false});
  const single = await PDFDocument.create();
  const [page] = await single.copyPages(original,[number - 1]);
  single.addPage(page);
  return {doc,page:number,base64:Buffer.from(await single.save()).toString('base64')};
}

const stop = new Set('avec dans donc pour quel quels quelle quelles comment sont cette quoi une des les sur son mon the and for what which how with from airport aeroport puis fait donne peux peut cet lui cela est estce connaitre savoir trouve trouver merci'.split(' '));
const aviationTerms = new Map([
  ['pistes','rwy'],['piste','rwy'],['runways','rwy'],['runway','rwy'],
  ['taxiways','twy'],['taxiway','twy'],['frequence','freq'],['frequences','freq'],['frequency','freq'],['frequencies','freq'],
  ['approche','app'],['approach','app'],['tour','twr'],['tower','twr'],
  ['parking','stand'],['parkings','stand'],['stands','stand'],['gate','stand'],['gates','stand']
]);
function terms(value) {
  return (value.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter(word => word.length > 1 && !stop.has(word)).map(word => aviationTerms.get(word) ?? word);
}

export function retrievePassages(docs,question,previous = '') {
  const primary = new Set(terms(question));
  const related = new Set(terms(previous));
  const identifiers = [...primary].filter(token => /^(?:\d{2}[lrc]?|[a-z]{2,}\d[a-z0-9]*)$/.test(token));
  const passages = [];
  for (const doc of docs) {
    for (const page of doc.pages) {
      const words = [...page.text.matchAll(/\S+/g)];
      const sectionTokens = new Set(terms(page.section ?? ''));
      for (let start = 0; start < words.length; start += 170) {
        const excerpt = page.text.slice(words[start].index,words[start + 220]?.index).trimEnd();
        const tokens = new Set(terms(excerpt));
        const matches = [...primary].filter(token => tokens.has(token));
        if (!matches.length || (identifiers.length && !identifiers.some(token => tokens.has(token)))) continue;
        const score = matches.reduce((sum,token) => sum + (/\d/.test(token) ? 7 : 2) + (sectionTokens.has(token) ? 1 : 0),0) +
          [...related].filter(token => tokens.has(token)).length * .25;
        const section = page.section || excerpt.match(/\b(?:AD|ENR|GEN)\s+\d+(?:\.\d+){1,3}\b/i)?.[0] || '';
        if (score) passages.push({doc,page:page.number,excerpt,score,section,anchor:page.anchor});
      }
    }
  }
  return passages.sort((a,b) => b.score - a.score).slice(0,9);
}
