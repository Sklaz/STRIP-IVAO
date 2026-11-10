import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildUpdate, UPDATE_ASSET } from './updater.mjs';

const root = fileURLToPath(new URL('./',import.meta.url));
const update = await buildUpdate(root,process.argv[2]);
await writeFile(UPDATE_ASSET,update);
console.log(UPDATE_ASSET + ' généré.');
