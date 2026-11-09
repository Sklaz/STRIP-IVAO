import { load } from 'cheerio';
import { retrievePassages } from './assistant-docs.mjs';
import { plainText } from './assistant-facts.mjs';

const DAY = 86400000;
const AIRAC_INTERVAL = 28 * DAY;
const AIRAC_REFERENCE = Date.UTC(2026,9,29);
const months = 'JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC'.split(' ');
const cache = new Map();
const clean = value => value.replace(/\s+/g,' ').trim();

function currentEdition(today) {
  // Dates AIRAC du Network Manager EUROCONTROL, espacées de 28 jours.
  const effective = new Date(AIRAC_REFERENCE +
    Math.floor((Date.parse(today) - AIRAC_REFERENCE) / AIRAC_INTERVAL) * AIRAC_INTERVAL);
  const date = effective.toISOString().slice(0,10);
  const folder = date.slice(-2) + '_' + months[effective.getUTCMonth()] + '_' + effective.getUTCFullYear();
  return {date,folder};
}

async function readAerodrome(airport,today) {
  const {date,folder} = currentEdition(today);
  const url = 'https://www.sia.aviation-civile.gouv.fr/media/dvd/eAIP_' + folder + '/FRANCE/AIRAC-' + date +
    '/html/eAIP/FR-AD-2.' + airport + '-fr-FR.html';
  const previous = cache.get(url);
  if (previous?.expires > Date.now()) return previous.doc;
  const response = await fetch(url,{redirect:'error',signal:AbortSignal.timeout(8000)});
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('SIA HTTP ' + response.status);
  const $ = load(await response.text(),{scriptingEnabled:false});
  const title = clean($('title').text());
  if (!title.includes('AD-2.' + airport) || !$('h3').first().text().includes(airport)) return null;
  const pages = $('h4').map((_index,element) => {
    const heading = $(element);
    const section = clean(heading.text());
    const number = heading.find('.Numbering').text().match(/AD\s+2\.(\d+)$/)?.[1];
    const container = heading.parent();
    const rows = container.find('tr').map((_row,row) => {
      const cells = $(row).children('th,td').map((_cell,cell) => clean($(cell).text())).get();
      return cells.some(Boolean) ? [cells] : null;
    }).get();
    const paragraphs = container.find('p,li').filter((_row,node) => !$(node).parents('table,li').length)
      .map((_row,node) => clean($(node).text())).get();
    const charts = number === '24' ? container.find('a[href]').map((_row,link) => $(link).attr('href')).get() : [];
    return {number,section,anchor:container.attr('id'),rows,charts,
      text:[section,...rows.map(cells => cells.join(' | ')),...paragraphs].join('\n')};
  }).get().filter(page => page.number);
  const doc = {airport,url,title:'eAIP France · SIA · ' + airport,validity:'Édition AIRAC du ' + date,pages};
  if (cache.size >= 32) cache.delete(cache.keys().next().value);
  cache.set(url,{doc,expires:Date.now() + 3600000});
  return doc;
}

const runway = /\b(?:piste|rwy|runway|ils|loc(?:alizer)?)\s+(0[1-9]|[12]\d|3[0-6])(?:[ \t]*(gauche|droite|centre|center|left|right|[lrc]))?\b/g;
const sides = {gauche:'L',droite:'R',centre:'C',center:'C',left:'L',right:'R',l:'L',r:'R',c:'C'};
const dimensions = /\b(?:dimensions?|longueur|largeur|length|width)\b/;
const frequency = /\b(?:frequences?|frequency|canal)\b/;
const navAid = /\b(?:ils|localizer|loc)\b/;
const distanceFields = ['TORA','TODA','ASDA','LDA'];

function source(doc,page) {
  return {type:'published',title:doc.title,category:'AIP / AIS',airport:doc.airport,
    section:page.section,validity:doc.validity,href:doc.url + (page.anchor ? '#' + encodeURIComponent(page.anchor) : '')};
}

function precisionApproaches(doc,ends) {
  const page = doc.pages.find(item => item.number === '24');
  if (!page) return [];
  const entries = new Map();
  for (const path of page.charts) {
    const pattern = new RegExp('^Cartes/' + doc.airport + '/AD_2_' + doc.airport +
      '_IAC_RWY(\\d{2}[LRC]?)_([A-Z0-9_-]+)\\.pdf$','i');
    const chart = path.match(pattern);
    if (!chart || (ends.length && !ends.includes(chart[1]))) continue;
    const [,end,label] = chart;
    const type = label.match(/(?:^|_)(ILS|GLS|MLS|PAR)(?:_|$)/)?.[1];
    if (!type) continue;
    const category = label.match(/(?:^|_)CAT([123]+)(?:_|$)/)?.[1];
    const categories = category?.split('').map(value => ['','I','II','III'][Number(value)]).join(', ');
    const text = type + ' piste ' + end + (categories ? ' · CAT ' + categories : '');
    const href = new URL(path,doc.url).href;
    entries.set(href,{text,source:{...source(doc,page),title:text + ' · Carte SIA',href}});
  }
  if (!entries.size) return [];
  const charts = [...entries.values()].sort((a,b) => a.text.localeCompare(b.text));
  const lines = [...new Set(charts.map(chart => chart.text))];
  return [{kind:'local',text:'Cartes d’approche de précision répertoriées à ' + doc.airport +
    ' dans l’eAIP du SIA (ILS, GLS, MLS et PAR).\n' + lines.map(line => '• ' + line).join('\n'),
    sources:charts.map(chart => chart.source)}];
}

export async function frenchAip(question,airport,today,{requested,search}) {
  const query = plainText(question);
  const ends = [...new Set([...query.matchAll(runway)].map(match => match[1] + (sides[match[2]] ?? '')))];
  const dimensionQuestion = dimensions.test(query);
  const localizerQuestion = frequency.test(query) && navAid.test(query) && !/\b(?:gp|glide|dme|vor)\b/.test(query);
  const distanceTypes = distanceFields.filter(field => new RegExp('\\b' + field + '\\b','i').test(query));
  const precision = /\b(?:approches? de precisions?|precision approaches?)\b/.test(query) &&
    !/\b(?:definition|signifie|difference|minimum|minima|pourquoi|comment|simultanees?)\b/.test(query);
  const simple = !/\b(?:utilisable|disponible|active|en service|notams?|sup aip|travaux|minimum|minima|approche interrompue|intersection|depuis)\b/.test(query);
  const exact = simple && ends.length === 1 && [dimensionQuestion,localizerQuestion,Boolean(distanceTypes.length)].filter(Boolean).length === 1;
  if (!/^LF[A-Z]{2}$/.test(airport) || /\b(?:ivao|manex|notams?|sup aip)\b/.test(query) ||
    (!requested && !search && !exact && !precision)) return null;
  const doc = await readAerodrome(airport,today);
  if (!doc) return null;
  if (precision && simple) {
    const parts = precisionApproaches(doc,ends);
    if (parts.length) return {parts,passages:[]};
  }
  if (exact && distanceTypes.length) {
    const page = doc.pages.find(item => item.number === '13');
    const rows = page?.rows.filter(cells => cells[0] === ends[0]) ?? [];
    if (rows.length === 1 && distanceTypes.every(field => /^\d+$/.test(rows[0][distanceFields.indexOf(field) + 1] ?? ''))) {
      const row = rows[0];
      const distances = distanceTypes.map(field => field + ' ' + row[distanceFields.indexOf(field) + 1] + ' m');
      const text = 'Piste ' + ends[0] + ' à ' + airport + ' · ' + distances.join(' · ') +
        '. Distances déclarées dans l’eAIP du SIA.' +
        (row[5] ? ' La ligne source contient des conditions d’utilisation.' : '');
      return {parts:[{kind:'local',text,sources:[{...source(doc,page),quote:row.join(' | ')}]}],passages:[]};
    }
  }
  if (exact && !distanceTypes.length) {
    const page = doc.pages.find(item => item.number === (dimensionQuestion ? '12' : '19'));
    const end = ends[0];
    const expected = new RegExp('^LOC\\s+' + end + '\\b','i');
    const rows = page?.rows.filter(cells => dimensionQuestion ? cells[0] === end : expected.test(cells[0])) ?? [];
    const values = new Map();
    for (const row of rows) {
      const value = dimensionQuestion ? row[2]?.match(/^(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)$/i) :
        row[2]?.match(/^(\d{3}[.,]\d{1,3})\s*MHz\b/i);
      if (value) values.set(value[0],row);
    }
    if (values.size === 1) {
      const [[value,row]] = values;
      const text = dimensionQuestion ?
        'La piste ' + end + ' de ' + airport + ' mesure ' + value.replace(/\s*[x×]\s*/i,' m × ') + ' m selon l’eAIP du SIA.' :
        'Le localizer ' + (row[1] ? row[1] + ' de la ' : 'de la ') + 'piste ' + end + ' à ' + airport +
          ' est publié à ' + value + ' dans l’eAIP du SIA.';
      return {parts:[{kind:'local',text,sources:[{...source(doc,page),quote:row.join(' | ')}]}],passages:[]};
    }
  }
  const matches = retrievePassages([doc],question).slice(0,4);
  return {parts:[],passages:matches.map(({page,excerpt}) => ({
    ...source(doc,doc.pages.find(item => item.number === page)),excerpt
  }))};
}
