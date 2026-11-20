const test = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');

test('build refuses privileged keys before writing public assets', () => {
  const before=fs.readFileSync('supabase-config.js','utf8');
  const child=spawnSync(process.execPath,['scripts/build.mjs'],{encoding:'utf8',env:{...process.env,SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_secret_test_example'}});
  assert.notEqual(child.status,0);
  assert.match(child.stderr,/publishable or anon key/);
  assert.equal(fs.readFileSync('supabase-config.js','utf8'),before);
});
