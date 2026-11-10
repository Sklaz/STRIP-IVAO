import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const REPOSITORY = 'Sklaz/STRIP-IVAO';
const LATEST = 'https://api.github.com/repos/' + REPOSITORY + '/releases/latest';
const MAX_BYTES = 2 * 1024 * 1024;
const VERSION = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/;
const REQUIRED = ['server.mjs','index.html','assistant.js','assistant.css','timezone-lookup.js'];
const BOOTSTRAP_FILES = new Set(['demarrer.mjs','updater.mjs','fabriquer-mise-a-jour.mjs']);
export const UPDATE_ASSET = 'E-Strips-Update.json';

export function stableVersion(tag) {
  const version = typeof tag === 'string' ? tag.replace(/^v/,'') : '';
  return VERSION.test(version) ? version : '';
}

function compare(a,b) {
  const other = b.split('.').map(Number);
  const [major,minor,patch] = a.split('.').map(Number);
  return major - other[0] || minor - other[1] || patch - other[2];
}

export function isUpdateFile(name) {
  return /^[a-z][a-z0-9.-]{0,78}\.(?:mjs|js|html|css|LICENSE)$/.test(name) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\./.test(name) && !BOOTSTRAP_FILES.has(name);
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export async function dependencyFingerprint(root) {
  const lock = JSON.parse(await readFile(join(root,'package-lock.json'),'utf8'));
  delete lock.version;
  delete lock.packages[''].version;
  return sha256(JSON.stringify(lock));
}

function validFiles(files) {
  return files && typeof files === 'object' && !Array.isArray(files) &&
    Object.entries(files).every(([name,contents]) => isUpdateFile(name) && typeof contents === 'string') &&
    REQUIRED.every(name => Object.hasOwn(files,name) && files[name].length > 0);
}

export async function buildUpdate(root,tag) {
  const version = stableVersion(tag);
  if (!version) throw new Error('Utilise un tag stable comme v1.2.0.');
  const entries = await readdir(root,{withFileTypes:true});
  const files = Object.fromEntries(await Promise.all(entries.filter(item => item.isFile() && isUpdateFile(item.name))
    .map(async item => [item.name,await readFile(join(root,item.name),'utf8')])));
  if (!validFiles(files)) throw new Error('Fichiers E-Strips incomplets.');
  const content = JSON.stringify({format:1,version,dependencies:await dependencyFingerprint(root),files});
  if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('Le paquet de mise à jour dépasse la taille autorisée.');
  return content;
}

async function getAsset(response,size) {
  if (!response.ok || !response.body) throw new Error('Téléchargement de la mise à jour impossible.');
  const destination = new URL(response.url);
  if (destination.protocol !== 'https:' || !['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(destination.hostname)) {
    await response.body.cancel();
    throw new Error('Adresse de téléchargement inattendue.');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > size) throw new Error('Taille du paquet inattendue.');
    chunks.push(chunk);
  }
  if (length !== size) throw new Error('Paquet incomplet.');
  return Buffer.concat(chunks);
}

async function stagedVersions(directory,baseVersion,dependencies) {
  const versions = [];
  for (const entry of await readdir(directory,{withFileTypes:true}).catch(() => [])) {
    const version = entry.name;
    if (!entry.isDirectory() || !VERSION.test(version) || compare(version,baseVersion) <= 0) continue;
    const path = join(directory,version);
    try {
      if (await readFile(join(path,'.dependencies'),'utf8') === dependencies) versions.push({version,path});
    } catch { /* Un dossier incomplet ne peut pas être sélectionné. */ }
  }
  return versions.sort((a,b) => compare(b.version,a.version));
}

async function stage(directory,update,dependencies) {
  await mkdir(directory,{recursive:true});
  const pending = await mkdtemp(join(directory,'.pending-'));
  const target = join(directory,update.version);
  try {
    for (const [name,contents] of Object.entries(update.files)) await writeFile(join(pending,name),contents,{flag:'wx'});
    await writeFile(join(pending,'.dependencies'),dependencies,{flag:'wx'});
    try { await rename(pending,target); }
    catch (error) {
      const existing = await readFile(join(target,'.dependencies'),'utf8').catch(() => '');
      if (existing !== dependencies) throw error;
    }
  } finally {
    await rm(pending,{recursive:true,force:true});
  }
}

export async function applicationVersions(root,{request = fetch,log = console.log,check = true} = {}) {
  const {version:baseVersion} = JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  const base = {version:baseVersion,path:root};
  if (!VERSION.test(baseVersion ?? '')) return [base];
  const dependencies = await dependencyFingerprint(root);
  const directory = join(root,'.efs-updates');
  const installed = await stagedVersions(directory,baseVersion,dependencies);
  if (!check) return [...installed,base];
  try {
    const response = await request(LATEST,{headers:{Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(3000)});
    if (response.status === 404) return [...installed,base];
    if (!response.ok) throw new Error('GitHub est temporairement inaccessible.');
    const release = await response.json();
    const version = stableVersion(release.tag_name);
    if (!version || release.draft || release.prerelease || compare(version,installed[0]?.version ?? baseVersion) <= 0) return [...installed,base];
    const asset = release.assets?.find(item => item.name === UPDATE_ASSET && item.state === 'uploaded');
    if (!asset) return [...installed,base];
    const digest = /^sha256:([a-f0-9]{64})$/.exec(asset.digest ?? '');
    if (!digest || !Number.isInteger(asset.size) || asset.size < 1 || asset.size > MAX_BYTES) throw new Error('Paquet GitHub non vérifiable.');
    const url = 'https://github.com/' + REPOSITORY + '/releases/download/' + encodeURIComponent(release.tag_name) + '/' + UPDATE_ASSET;
    const content = await getAsset(await request(url,{signal:AbortSignal.timeout(12000)}),asset.size);
    if (sha256(content) !== digest[1]) throw new Error('Empreinte SHA-256 incorrecte.');
    const update = JSON.parse(content.toString('utf8'));
    if (update?.format !== 1 || update.version !== version || !validFiles(update.files)) throw new Error('Paquet de mise à jour invalide.');
    if (update.dependencies !== dependencies) {
      log('E-Strips v' + version + ' change les dépendances. Télécharge la release complète pour l’installer.');
      return [...installed,base];
    }
    await stage(directory,update,dependencies);
    log('Mise à jour E-Strips v' + version + ' téléchargée.');
    return [{version,path:join(directory,version)},...installed,base];
  } catch {
    log('Vérification de mise à jour impossible. Démarrage avec la version locale.');
    return [...installed,base];
  }
}
