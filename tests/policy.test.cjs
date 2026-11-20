// Executes the real migration and RLS policies in embedded PostgreSQL.
// The Supabase auth schema and JWT helper are simulated; this is not a live-project test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {PGlite} = require('@electric-sql/pglite');

const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const archive = {
  schema:'nightreel-archive',version:3,activeId:'list-one',settings:{},preferences:{},
  collections:[{id:'list-one',name:'Films',films:[{id:'film-one',title:'Example',watched:false,rating:0,note:'private',genres:[]}]}],
  paths:[{id:'path-one',name:'Watch',collectionId:'list-one',filmIds:['film-one']}],savedViews:[],profiles:[],feedback:[],cloudSources:[]
};
async function expectCode(operation, code) {
  await assert.rejects(operation, error => error.code === code, `expected PostgreSQL error ${code}`);
}

test('database enforces account isolation, ownership, integrity and atomic revisions', async t => {
  const db=new PGlite(); t.after(()=>db.close());
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
    grant usage on schema auth to anon, authenticated;`);
  await db.exec(fs.readFileSync('supabase/migrations/20261119000100_archive.sql','utf8'));
  await db.query('insert into auth.users(id) values ($1),($2)',[alice,bob]);
  await db.exec('set role authenticated');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[alice]);
  let result=await db.query('select * from public.nightreel_commit_archive($1,$2::jsonb)',[0,JSON.stringify(archive)]);
  assert.equal(Number(result.rows[0].revision),1);
  await expectCode(()=>db.query('select * from public.nightreel_commit_archive($1,$2::jsonb)',[0,JSON.stringify(archive)]),'P0001');
  await expectCode(()=>db.query('insert into public.nightreel_archives(user_id,archive) values ($1,$2::jsonb)',[bob,JSON.stringify(archive)]),'42501');
  await expectCode(()=>db.query('update public.nightreel_archives set user_id=$1 where user_id=$2',[bob,alice]),'42501');
  await expectCode(()=>db.query('delete from public.nightreel_archives where user_id=$1',[alice]),'42501');
  const invalid=structuredClone(archive); invalid.paths[0].filmIds=['not-in-collection'];
  await expectCode(()=>db.query('select * from public.nightreel_commit_archive($1,$2::jsonb)',[1,JSON.stringify(invalid)]),'23514');
  const malformed=structuredClone(archive); delete malformed.schema;
  await expectCode(()=>db.query('select * from public.nightreel_commit_archive($1,$2::jsonb)',[1,JSON.stringify(malformed)]),'23514');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[bob]);
  result=await db.query('select * from public.nightreel_archives where user_id=$1',[alice]);
  assert.equal(result.rows.length,0,'Bob cannot read Alice');
  result=await db.query('select * from public.nightreel_commit_archive($1,$2::jsonb)',[0,JSON.stringify(archive)]);
  assert.equal(Number(result.rows[0].revision),1);
  result=await db.query('select user_id from public.nightreel_archives');
  assert.deepEqual(result.rows.map(row=>row.user_id),[bob]);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[alice]);
  result=await db.query('select * from public.nightreel_archives');
  assert.deepEqual(result.rows.map(row=>row.user_id),[alice]);
  assert.equal(Number(result.rows[0].revision),1,'invalid and conflicting writes made no change');
  await db.query("select set_config('request.jwt.claim.sub','',false)");
  result=await db.query('select * from public.nightreel_archives');
  assert.equal(result.rows.length,0,'missing subject sees no rows');
  await expectCode(()=>db.query('select * from public.nightreel_commit_archive($1,$2::jsonb)',[0,JSON.stringify(archive)]),'42501');
  await db.exec('reset role; set role anon');
  await expectCode(()=>db.query('select * from public.nightreel_archives'),'42501');
  await expectCode(()=>db.query('select * from public.nightreel_commit_archive($1,$2::jsonb)',[0,JSON.stringify(archive)]),'42501');
});
