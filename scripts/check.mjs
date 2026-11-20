/** Check JavaScript syntax, including scripts embedded in index.html. */
import {readFile} from 'node:fs/promises';
import {Script} from 'node:vm';
for (const file of ['app-sync.js', 'sync-core.js', 'supabase-config.js']) new Script(await readFile(file, 'utf8'), {filename: file});
const html = await readFile('index.html', 'utf8');
let number = 0;
for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) new Script(match[1], {filename: `index.html:inline-${++number}`});
console.log(`Syntax OK: 3 external files and ${number} inline scripts.`);
