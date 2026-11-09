import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { answerQuestion, assistantStatus } from './assistant-model.mjs';
import { documentSummary, ICAO, importDocument, listDocuments, MAX_DOCUMENT, readDocument, requireInput } from './assistant-docs.mjs';
import { loadManex } from './assistant-manex.mjs';

const port = Number(process.env.PORT || 4310);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT invalide.');
const hosts = new Set(['127.0.0.1:' + port,'localhost:' + port]);
const staticFiles = new Map([
  ['/',['index.html','text/html; charset=utf-8']],
  ['/index.html',['index.html','text/html; charset=utf-8']],
  ['/timezone-lookup.js',['timezone-lookup.js','text/javascript; charset=utf-8']],
  ['/assistant.js',['assistant.js','text/javascript; charset=utf-8']],
  ['/assistant.css',['assistant.css','text/css; charset=utf-8']]
]);
let importing = false;
let answering = false;

function send(res,status,body,type = 'application/json; charset=utf-8') {
  res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'no-referrer','Cross-Origin-Resource-Policy':'same-origin'});
  res.end(body);
}
function json(res,status,body) { send(res,status,JSON.stringify(body)); }

async function readBody(req,max) {
  requireInput(Number(req.headers['content-length'] ?? 0) <= max,'Requête trop volumineuse.',413);
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({destroyOnReturn:false})) {
    size += chunk.length;
    if (size > max) {
      req.resume();
      requireInput(false,'Requête trop volumineuse.',413);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const server = createServer(async (req,res) => {
  try {
    const host = req.headers.host;
    requireInput(hosts.has(host),'Hôte local requis.',403);
    const origin = 'http://' + host;
    const url = new URL(req.url,origin);
    requireInput(url.origin === origin,'Adresse locale requise.',403);
    const path = url.pathname;
    if (req.method === 'POST') requireInput(req.headers.origin === origin,'Requête depuis le simulateur local requise.',403);
    if (req.method === 'GET' && staticFiles.has(path)) {
      const [name,type] = staticFiles.get(path);
      return send(res,200,await readFile(new URL(name,import.meta.url)),type);
    }
    if (req.method === 'GET' && path === '/api/assistant/status') return json(res,200,assistantStatus());
    if (req.method === 'GET' && path === '/api/assistant/manex') {
      const airport = url.searchParams.get('airport') ?? '';
      requireInput(ICAO.test(airport),'Code OACI invalide.');
      const manex = await loadManex(url.searchParams.get('url'),airport);
      return json(res,200,manex ? {title:manex.title,href:manex.url,revision:manex.revision,
        offline:Boolean(manex.offline),fetchedAt:manex.fetchedAt} : null);
    }
    if (req.method === 'GET' && path === '/api/assistant/documents') {
      const airport = url.searchParams.get('airport') ?? '';
      requireInput(ICAO.test(airport),'Code OACI invalide.');
      return json(res,200,(await listDocuments(airport)).map(documentSummary));
    }
    if (req.method === 'GET' && path.startsWith('/api/assistant/documents/')) {
      const {doc,bytes} = await readDocument(path.slice('/api/assistant/documents/'.length));
      return send(res,200,bytes,doc.pdf ? 'application/pdf' : 'text/plain; charset=utf-8');
    }
    if (req.method === 'POST' && path === '/api/assistant/documents') {
      const type = req.headers['content-type'] ?? '';
      requireInput(type.startsWith('multipart/form-data;'),'Formulaire d’import requis.',415);
      requireInput(!importing,'Un document est déjà en cours d’indexation.',429);
      importing = true;
      try {
        const bytes = await readBody(req,MAX_DOCUMENT + 128 * 1024);
        let form;
        try { form = await new Response(bytes,{headers:{'Content-Type':type}}).formData(); }
        catch { requireInput(false,'Formulaire d’import invalide.'); }
        return json(res,201,await importDocument(form));
      } finally { importing = false; }
    }
    if (req.method === 'POST' && path === '/api/assistant/ask') {
      requireInput((req.headers['content-type'] ?? '').startsWith('application/json'),'Requête JSON requise.',415);
      requireInput(!answering,'Une réponse est déjà en cours. Réessaie dans un instant.',429);
      answering = true;
      try {
        const bytes = await readBody(req,256 * 1024);
        let input;
        try { input = JSON.parse(bytes.toString('utf8')); }
        catch { requireInput(false,'Requête JSON invalide.'); }
        return json(res,200,await answerQuestion(input));
      } finally { answering = false; }
    }
    json(res,404,{error:'Page introuvable.'});
  } catch (error) {
    if (!error.status) console.error('Assistant local',error.code || error.name);
    if (!res.headersSent) json(res,error.status || 500,{error:error.status ? error.message : 'Erreur du serveur local.'});
  }
});
server.listen(port,'127.0.0.1',() => console.log('E-Strips · http://127.0.0.1:' + port));
