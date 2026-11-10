import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applicationVersions } from './updater.mjs';

const root = fileURLToPath(new URL('./',import.meta.url));
const port = Number(process.env.PORT || 4310);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port E-Strips invalide.');
const address = 'http://127.0.0.1:' + port + '/';
process.env.EFS_INSTALL_URL = new URL('./',import.meta.url).href;

async function ready() {
  try {
    const response = await fetch(address + 'api/assistant/status',{signal:AbortSignal.timeout(1000)});
    return response.ok && typeof (await response.json()).configured === 'boolean';
  } catch { return false; }
}

if (!await ready()) {
  const versions = await applicationVersions(root,{check:process.env.EFS_AUTO_UPDATE !== '0'}).catch(() => [{path:root}]);
  let listening = await ready();
  for (const {version,path} of versions) {
    if (listening) break;
    try {
      await import(pathToFileURL(join(path,'server.mjs')).href);
      listening = await ready();
      if (listening && version) console.log('E-Strips v' + version);
    } catch (error) {
      listening = await ready();
      if (!listening) console.warn('Impossible de démarrer E-Strips' + (version ? ' v' + version : '') + '. ' + error.message);
    }
  }
  if (!listening) {
    console.error('Vérifie que le port ' + port + ' est libre.');
    process.exit(1);
  }
}

console.log('E-Strips est accessible sur ' + address);
console.log('Garde cette fenêtre ouverte pendant la session.');
if (process.platform === 'win32' && !process.argv.includes('--sans-navigateur')) {
  execFile('rundll32.exe',['url.dll,FileProtocolHandler',address],{windowsHide:true},error => {
    if (error) console.log('Ouvre cette adresse dans ton navigateur ' + address);
  });
}
