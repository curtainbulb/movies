/** Build static browser assets from a local .env or public environment variables. */
import { copyFile, readFile, writeFile, mkdir } from 'node:fs/promises';

let file = '';
try { file = await readFile('.env', 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const values = {};
for (const line of file.split(/\r?\n/)) {
  const match = line.match(/^\s*(SUPABASE_URL|SUPABASE_PUBLISHABLE_KEY)\s*=\s*(.*?)\s*$/);
  if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
}
const url = process.env.SUPABASE_URL ?? values.SUPABASE_URL ?? '';
const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? values.SUPABASE_PUBLISHABLE_KEY ?? '';
if (url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('SUPABASE_URL must be a valid URL.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || !(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && local))) {
    throw new Error('SUPABASE_URL must use HTTPS (or localhost) and contain no credentials, query, or fragment.');
  }
}
if (key && !key.startsWith('sb_publishable_')) {
  let role = '';
  if (key.startsWith('eyJ')) {
    try { role = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8')).role; } catch { /* Invalid keys are rejected below. */ }
  }
  if (role !== 'anon') throw new Error('Use a publishable or anon key, never a secret or service-role key.');
}
await mkdir('vendor', {recursive: true});
await copyFile('node_modules/@supabase/supabase-js/dist/umd/supabase.js', 'vendor/supabase.js');
await writeFile('supabase-config.js', `// Generated public browser configuration.\nwindow.NIGHTREEL_CONFIG = ${JSON.stringify({supabaseUrl:url,supabasePublishableKey:key},null,2)};\n`);
console.log(url && key ? 'Built with public Supabase configuration.' : 'Built without Supabase configuration; guest mode remains available.');
