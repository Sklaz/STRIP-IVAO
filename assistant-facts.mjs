export function plainText(value) {
  return value.normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
}

const positions = new Map([
  ['APP',/\b(?:approche|approach|app)\b/],['TWR',/\b(?:tour|tower|twr)\b/],
  ['GND',/\b(?:sol|ground|gnd)\b/],['DEL',/\b(?:prevol|delivery|del)\b/],
  ['DEP',/\b(?:depart|departure|dep)\b/],['ATIS',/\batis\b/]
]);

export function manexFrequency(question,doc,sourceFor) {
  if (!doc) return [];
  const query = plainText(question).replace(/_/g,' ');
  if (!/\b(?:frequences?|frequency|freq|canal)\b/.test(query) ||
    /\b(?:ils|loc|vor|atc actif|actuelle|actuellement|en service|active|maintenant|atis vocal|officiel|aip|notams?|piste|secteur|avant|apres|quand|pourquoi|comment)\b/.test(query)) return [];
  const requested = [...positions].filter(([,pattern]) => pattern.test(query));
  if (requested.length !== 1) return [];
  const [[position]] = requested;
  const callsign = doc.airport + '_' + position;
  const rows = new Map();
  for (const page of doc.pages) {
    for (const row of page.text.split('\n')) {
      const cells = row.split('|').map(cell => cell.trim());
      if (!cells.includes(callsign)) continue;
      for (const cell of cells.filter(value => /^\d{3}[.,]\d{2,3}$/.test(value))) {
        rows.set(cell.replace(',','.'),sourceFor({doc,page:page.number,section:page.section,anchor:page.anchor,excerpt:row}));
      }
    }
  }
  if (!rows.size) return [];
  const sources = [...rows.values()].map(({excerpt,...source}) => ({...source,quote:excerpt}));
  if (rows.size > 1) return [{kind:'local',text:callsign + ' figure avec plusieurs fréquences dans le MANEX IVAO. Consulte les sections citées pour vérifier les conditions.',sources}];
  return [{kind:'local',text:'Le MANEX IVAO indique ' + [...rows.keys()][0] + ' MHz pour ' + callsign + '.',sources}];
}

export function manexAltitude(question,doc,sourceFor) {
  if (!doc) return [];
  const query = plainText(question);
  if (/\b(?:quand|comment|pourquoi|definition|signifie|pistes?|qnh|niveau|level|horaire|vent)\b/.test(query)) return [];
  const transition = /\b(?:altitude de transition|transition altitude)\b/.test(query);
  const elevation = /\b(?:altitude (?:du terrain|de l['’]aerodrome|de l['’]aeroport|de reference)|airport elevation|aerodrome elevation)\b/.test(query);
  if (transition === elevation) return [];
  const values = new Map();
  for (const page of doc.pages) {
    for (const row of page.text.split('\n')) {
      const field = transition ? /\b(?:altitude de transition|transition altitude)\b/i : /\baltitude du terrain\b/i;
      if (!field.test(row)) continue;
      const value = row.match(/\b(\d{1,5})\s*ft\b|\bft\s*(\d{1,5})\b/i);
      if (!value) continue;
      const {excerpt,...source} = sourceFor({doc,page:page.number,section:page.section,anchor:page.anchor,excerpt:row});
      values.set(Number(value[1] ?? value[2]),{...source,quote:excerpt});
    }
  }
  if (values.size !== 1) return [];
  const [[value,source]] = values;
  const label = transition ? 'une altitude de transition' : 'une altitude de terrain';
  return [{kind:'local',text:'Le MANEX IVAO de ' + doc.airport + ' indique ' + label + ' de ' + value + ' ft.',sources:[source]}];
}

const weatherCache = new Map();
async function reportFor(href,airport,product) {
  const cached = weatherCache.get(href);
  if (cached?.expires > Date.now()) return cached.report;
  const response = await fetch(href,{redirect:'error',signal:AbortSignal.timeout(7000),
    headers:{'User-Agent':'E-Strips local simulator','Accept':'application/json'}});
  if (response.status !== 204 && !response.ok) throw new Error('Aviation Weather Center HTTP ' + response.status);
  const records = response.status === 204 ? [] : await response.json();
  const report = records.find(item => item.icaoId === airport &&
    typeof item[product === 'taf' ? 'rawTAF' : 'rawOb'] === 'string');
  if (weatherCache.size >= 64) weatherCache.delete(weatherCache.keys().next().value);
  weatherCache.set(href,{report,expires:Date.now() + 60000});
  return report;
}

function utc(seconds) {
  if (!Number.isFinite(seconds)) return '';
  return new Date(seconds * 1000).toISOString().slice(0,16).replace('T',' à ') + ' UTC';
}

export async function aviationWeather(question,airport) {
  const query = plainText(question);
  const forecast = /\b(?:taf|previsions?)\b/.test(query);
  const observation = /\b(?:metar|qnh|vents?|meteo|temperature|visibilite|weather)\b/.test(query);
  if (!forecast && !observation) return null;
  if (/\b(?:ivao|atis|hier|historique|archives?|composante|vent de travers|piste|pourquoi|comment|signifie|definition|notams?)\b/.test(query) ||
    /\b(?:\d{4}-\d{2}-\d{2}|\d{6}z)\b/.test(query)) return null;
  const product = forecast ? 'taf' : 'metar';
  const title = product.toUpperCase() + ' ' + airport;
  const href = 'https://aviationweather.gov/api/data/' + product + '?ids=' + airport + '&format=json';
  const report = await reportFor(href,airport,product);
  if (!report) return {parts:[],missing:'Aucun ' + title + ' trouvé auprès de l’Aviation Weather Center.'};
  const raw = forecast ? report.rawTAF : report.rawOb;
  const when = forecast ? utc(Date.parse(report.issueTime) / 1000) : utc(report.obsTime);
  const fields = [];
  if (forecast) {
    const from = utc(report.validTimeFrom);
    const to = utc(report.validTimeTo);
    if (from && to) fields.push('Période annoncée du ' + from + ' au ' + to + '.');
  } else {
    const qnh = raw.match(/\bQ(\d{4})\b/)?.[1];
    const altimeter = raw.match(/\bA(\d{2})(\d{2})\b/);
    if (/\bqnh\b/.test(query)) {
      if (qnh) fields.push('QNH ' + Number(qnh) + ' hPa.');
      else if (altimeter) fields.push('Calage altimétrique ' + altimeter[1] + ',' + altimeter[2] + ' inHg.');
      else fields.push('Calage altimétrique absent du bulletin.');
    }
    if (/\bvents?\b/.test(query)) {
      const wind = raw.match(/\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS)\b/);
      if (wind) {
        const unit = wind[4] === 'KT' ? ' kt' : ' m/s';
        const direction = wind[1] === 'VRB' ? 'variable' : 'du ' + wind[1] + '° vrai';
        fields.push(Number(wind[2]) === 0 ? 'Vent calme.' :
          'Vent ' + direction + ' à ' + Number(wind[2]) + unit + (wind[3] ? ', rafales à ' + Number(wind[3]) + unit : '') + '.');
      } else fields.push('Vent absent du bulletin.');
    }
    if (/\btemperature\b/.test(query) && Number.isFinite(report.temp)) fields.push('Température ' + report.temp + ' °C.');
    if (Number.isFinite(report.obsTime) && Date.now() - report.obsTime * 1000 > 90 * 60 * 1000) {
      fields.push('Dernière observation disponible âgée de plus de 90 minutes.');
    }
  }
  const text = [title + (when ? ' · ' + when : ''),fields.join(' '),raw].filter(Boolean).join('\n');
  const source = {type:'published',title:'Aviation Weather Center · ' + title,category:'Bulletin météo',airport,href,
    validity:when,quote:raw};
  return {parts:[{kind:'local',text,sources:[source]}],missing:''};
}
