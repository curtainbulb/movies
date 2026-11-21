// DOM integration with a simulated Supabase endpoint; live authorization is tested separately.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM, VirtualConsole} = require('jsdom');
const {IDBFactory, IDBKeyRange} = require('fake-indexeddb');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, message, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { if (condition()) return; await sleep(25); }
  throw new Error(`Timed out: ${message}`);
}
function backend() { return {rows: new Map(), users: new Map(), fail: false, revoked:new Set(), confirmSignup:false, blockedReads:new Map(), conflictOnce:false, artwork: new Map()}; }
function simulatedClient(window, server) {
  let user = JSON.parse(window.localStorage.getItem('test-auth') || 'null');
  let listener;
  const emit = event => listener?.(event, user ? {user} : null);
  const offline = () => ({message:'Simulated network failure', status:503});
  const auth = {
    onAuthStateChange(callback) { listener = callback; window.setTimeout(() => emit('INITIAL_SESSION'), 0); return {data:{subscription:{unsubscribe(){}}}}; },
    async signInWithPassword({email}) {
      if (!server.users.has(email)) server.users.set(email, {id: email, email});
      user = server.users.get(email); window.localStorage.setItem('test-auth', JSON.stringify(user)); emit('SIGNED_IN'); return {data:{user},error:null};
    },
    async signUp(args) { return server.confirmSignup ? {data:{session:null},error:null} : this.signInWithPassword(args); },
    async signOut() { user = null; window.localStorage.removeItem('test-auth'); emit('SIGNED_OUT'); return {error:null}; },
    async getUser() { return server.fail ? {data:{user:null},error:offline()} : {data:{user},error:user && !server.revoked.has(user.id) ? null : {status:401,message:'Session revoked'}}; },
    async resetPasswordForEmail() { return {error:null}; },
    async resend() { return {error:null}; },
    async signInWithOAuth() { return {error:null}; },
    async updateUser() { return {error:null}; }
  };
  return {auth,
    from(table) {
      if (table === 'nightreel_artwork_cache') return {select(){return this;},eq(_key,id){this.id=id;return this;},async maybeSingle(){
        if (server.fail) return {error:offline()};
        if (!user) return {error:{status:401,message:'No session'}};
        const entry = server.artwork.get(this.id);
        return {data: entry ? structuredClone(entry) : null, error:null};
      }};
      return {select(){return this;},eq(_key,id){this.id=id;return this;},async maybeSingle(){
        if (server.fail) return {error:offline()};
        const row = user?.id === this.id ? server.rows.get(user.id) : null;
        const copy = row ? structuredClone(row) : null;
        const gate = server.blockedReads.get(this.id);
        if(gate){gate.started=true; await gate.promise;}
        return {data:copy,error:null};
      }};
    },
    async rpc(name, args) {
      if (name === 'nightreel_upsert_artwork') {
        if (server.fail) return {error:offline()};
        if (!user) return {error:{status:401,message:'No session'}};
        server.artwork.set(args.key, {match: args.match_data, fetched_at: new Date().toISOString()});
        return {data:null,error:null};
      }
      const {expected_revision,document} = args;
      if (server.fail) return {error:offline()};
      if (!user) return {error:{status:401,message:'No session'}};
      const row=server.rows.get(user.id);
      if(server.conflictOnce && row) {
        server.conflictOnce=false;
        const changed=structuredClone(row); changed.revision++; changed.archive.settings.motion='reduced'; server.rows.set(user.id,changed);
        return {error:{code:'P0001',message:'archive revision conflict'}};
      }
      if ((row?.revision || 0)!==expected_revision) return {error:{code:'P0001',message:'archive revision conflict'}};
      const saved={revision:expected_revision+1,archive:structuredClone(document)};
      server.rows.set(user.id,saved); return {data:[structuredClone(saved)],error:null};
    }
  };
}
function openApp(server, idb = new IDBFactory(), restoredUser = null, locks = null) {
  const errors=[];
  let html=fs.readFileSync('index.html','utf8').replace(/<script src="([^"]+)"><\/script>/g,(_match,file)=>{
    if(file==='vendor/supabase.js') return '';
    if(file==='supabase-config.js') return '<script>window.NIGHTREEL_CONFIG={supabaseUrl:"https://example.supabase.co",supabasePublishableKey:"sb_publishable_test_key"};<\/script>';
    return `<script>${fs.readFileSync(file,'utf8')}<\/script>`;
  });
  const console = new VirtualConsole();
  console.on('jsdomError',error=>errors.push(error.message));
  const dom=new JSDOM(html,{url:'https://nightreel.test/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:console,beforeParse(window){
    window.indexedDB=idb; window.IDBKeyRange=IDBKeyRange; window.structuredClone=structuredClone;
    if(locks)Object.defineProperty(window.navigator,'locks',{value:locks});
    if(restoredUser)window.localStorage.setItem('test-auth',JSON.stringify(restoredUser));
    window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
    window.scrollTo=()=>{}; window.HTMLElement.prototype.scrollIntoView=function(){};
    window.URL.createObjectURL=blob=>{window.capturedDownload=blob; return 'blob:nightreel-test';}; window.URL.revokeObjectURL=()=>{};
    window.HTMLAnchorElement.prototype.click=function(){};
    window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
    window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
    window.supabase={createClient:()=>simulatedClient(window,server)};
  }});
  return {window:dom.window,errors,close:()=>dom.window.close()};
}
const run = (window, code) => window.eval(code);
async function ready(window) { await until(()=>window.NightreelSync && !window.NIGHTREEL_AUTH_PENDING && run(window,'realmState.ready'), 'app ready'); }
async function signIn(window,email) {
  window.NightreelSync.openDialog();
  window.document.getElementById('nr-email').value=email;
  window.document.getElementById('nr-password').value='test-password';
  window.document.querySelector('[data-auth="signin"]').click();
  await until(()=>window.NightreelSync.isSignedIn() && !window.NIGHTREEL_AUTH_PENDING, `signed in: ${email}`);
}
async function signOut(window) {
  window.NightreelSync.openDialog();
  window.document.querySelector('[data-auth="signout"]').click();
  await until(()=>!window.NightreelSync.isSignedIn() && !window.NIGHTREEL_AUTH_PENDING,'signed out');
}
async function syncNow(window) {
  window.NightreelSync.openDialog();
  window.document.querySelector('[data-auth="sync"]').click();
  await sleep(150);
}
async function pasteGuestFilm(window) {
  window.document.getElementById('open-import').click();
  window.document.getElementById('import-tab-paste').click();
  const input=window.document.getElementById('import-text');
  input.value='The Guest Film (2001)'; input.dispatchEvent(new window.Event('input',{bubbles:true}));
  await until(()=>!window.document.getElementById('commit-import').disabled,'import preview');
  window.document.getElementById('commit-import').click();
  await until(()=>run(window,'archiveApp.archive.collections.length')===1,'guest film imported');
}

test('guest import is explicit, account switching isolates archives and restores each cache', async t => {
  const server=backend(), app=openApp(server); t.after(app.close); const w=app.window;
  await ready(w); await pasteGuestFilm(w);
  w.localStorage.setItem('HK_DIRECT_AI_KEYS_V1',JSON.stringify({openai:'private-key-example'}));
  run(w,`archiveApp.archive.aiSettings=KingdomDomain.sanitizeAISettings({profiles:{openai:{enabled:true,model:'sample',base:'https://api.openai.com/v1',key:'private-key-example'}}}); void persistArchive();`);
  await signIn(w,'alice@example.test');
  assert.equal(run(w,'archiveApp.archive.collections.length'),0,'guest data must not be uploaded automatically');
  await until(()=>server.rows.has('alice@example.test'),'initial cloud row');
  w.NightreelSync.openDialog();
  w.document.querySelector('[data-auth="import"]').click();
  await until(()=>run(w,'archiveApp.archive.collections.length')===1,'explicit guest import');
  await until(()=>server.rows.get('alice@example.test').archive.collections.length===1,'guest import uploaded');
  assert.ok(!JSON.stringify(server.rows.get('alice@example.test')).includes('private-key-example'),'provider key must not be uploaded');
  w.document.getElementById('open-studio').click(); w.document.querySelector('[data-st-tab="models"]').click();
  assert.equal(w.document.querySelector('[data-profile="openai"] [data-field="key"]').placeholder,'Paste your key','guest key must not be reused in the account');
  await signOut(w);
  assert.equal(run(w,'archiveApp.archive.collections[0].films[0].title'),'The Guest Film');
  await signIn(w,'bob@example.test');
  assert.equal(run(w,'archiveApp.archive.collections.length'),0,'another account must start without Alice data');
  await until(()=>server.rows.has('bob@example.test'),'Bob cloud row');
  assert.equal(server.rows.get('bob@example.test').archive.collections.length,0);
  await signOut(w); await signIn(w,'alice@example.test');
  assert.equal(run(w,'archiveApp.archive.collections[0].films[0].title'),'The Guest Film');
  assert.deepEqual(app.errors,[]);
});

test('two simulated devices reconcile edits, offline changes, and deletion', async t => {
  const server=backend(), first=openApp(server), second=openApp(server); t.after(first.close); t.after(second.close);
  const a=first.window,b=second.window; await Promise.all([ready(a),ready(b)]);
  await signIn(a,'shared@example.test'); await until(()=>server.rows.has('shared@example.test'),'initial cloud row');
  run(a,`archiveApp.archive.collections.push({id:'collection-test',name:'Test',createdAt:new Date().toISOString(),sourceName:'',films:[LedgerCore.makeFilm('One',{id:'film-one'}),LedgerCore.makeFilm('Two',{id:'film-two'})]}); archiveApp.archive.activeId='collection-test'; archiveApp.archive.paths.push({id:'path-test',name:'Later',collectionId:'collection-test',filmIds:['film-two'],createdAt:new Date().toISOString()}); archiveApp.archive.preferences.languages=['French']; archiveApp.archive.settings.textSize='large'; void persistArchive(); renderArchive(false); NightreelCloud.add({name:'Source',url:'https://example.org/list.md',collectionId:'collection-test',intervalMinutes:0});`);
  await until(()=>server.rows.get('shared@example.test').archive.collections[0]?.films.length===2,'initial films uploaded');
  await signIn(b,'shared@example.test'); await syncNow(b);
  await until(()=>run(b,'archiveApp.archive.collections[0]?.films.length')===2,'second device hydrated');
  assert.equal(run(b,"archiveApp.archive.paths[0].filmIds[0]"),'film-two');
  assert.equal(run(b,"archiveApp.archive.preferences.languages[0]"),'French');
  assert.equal(run(b,"archiveApp.archive.settings.textSize"),'large');
  assert.equal(run(b,"NightreelCloud.list()[0].name"),'Source');
  Object.defineProperty(b.navigator,'onLine',{configurable:true,value:false});
  run(b,`mutateFilms(['film-two'], film => {film.note='offline note';}, 'note');`);
  await sleep(100);
  run(a,`mutateFilms(['film-two'], film => {film.rating=4;}, 'rating'); archiveApp.archive.collections[0].films=archiveApp.archive.collections[0].films.filter(f=>f.id!=='film-one'); void persistArchive(); renderArchive(false);`);
  await until(()=>server.rows.get('shared@example.test').archive.collections[0].films.length===1,'deletion uploaded');
  Object.defineProperty(b.navigator,'onLine',{configurable:true,value:true}); b.dispatchEvent(new b.Event('online'));
  await until(()=>{const films=server.rows.get('shared@example.test').archive.collections[0].films;return films.length===1&&films[0].note==='offline note'&&films[0].rating===4;},'offline change reconciled with deletion');
  await syncNow(a);
  await until(()=>run(a,"archiveApp.archive.collections[0].films[0].note")==='offline note','remote change visible');
  assert.equal(run(a,'archiveApp.archive.collections[0].films.length'),1);
  assert.deepEqual(first.errors,[]); assert.deepEqual(second.errors,[]);
});


test('simulated signup, recovery, session restoration, transient failure and revocation', async t => {
  const server=backend(), idb=new IDBFactory(); server.confirmSignup=true;
  let app=openApp(server,idb); t.after(()=>app.close()); let w=app.window; await ready(w);
  w.NightreelSync.openDialog(); w.document.getElementById('nr-email').value='restore@example.test';
  w.document.getElementById('nr-password').value='test-password'; w.document.querySelector('[data-auth="signup"]').click();
  await until(()=>w.document.getElementById('nr-auth-message').textContent.includes('confirmation link'),'verification message');
  w.document.querySelector('[data-auth="reset"]').click();
  await until(()=>w.document.getElementById('nr-auth-message').textContent.includes('recovery link'),'recovery message');
  server.confirmSignup=false; await signIn(w,'restore@example.test');
  await until(()=>server.rows.has('restore@example.test'),'cloud baseline');
  server.fail=true;
  run(w,`archiveApp.archive.collections.push({id:'pending',name:'Pending',createdAt:new Date().toISOString(),sourceName:'',films:[LedgerCore.makeFilm('Pending Film',{id:'pending-film'})]}); archiveApp.archive.activeId='pending'; void persistArchive(); renderArchive(false);`);
  await until(()=>w.document.getElementById('nr-sync-status').textContent.includes('Sync failed'),'failure shown');
  assert.equal(server.rows.get('restore@example.test').archive.collections.length,0);
  app.close();
  app=openApp(server,idb,server.users.get('restore@example.test')); w=app.window; await ready(w);
  assert.equal(run(w,'archiveApp.archive.collections[0].films[0].title'),'Pending Film','unsynced cache restored');
  server.fail=false; w.dispatchEvent(new w.Event('online'));
  await until(()=>server.rows.get('restore@example.test').archive.collections.length===1,'pending data retried');
  server.revoked.add('restore@example.test'); await syncNow(w);
  await until(()=>!w.NightreelSync.isSignedIn() && !w.NIGHTREEL_AUTH_PENDING,'revoked session signed out');
  assert.equal(run(w,'archiveApp.archive.collections.length'),0,'revoked account data must not become guest data');
});

test('a delayed response from a previous account cannot replace the next account', async t => {
  const server=backend(), app=openApp(server); t.after(app.close); const w=app.window; await ready(w);
  await signIn(w,'first@example.test'); await until(()=>server.rows.has('first@example.test'),'first baseline');
  let release; const gate={started:false,promise:new Promise(resolve=>{release=resolve;})};
  server.blockedReads.set('first@example.test',gate);
  w.dispatchEvent(new w.Event('focus')); await until(()=>gate.started,'delayed first read');
  await signOut(w); await signIn(w,'second@example.test');
  await until(()=>server.rows.has('second@example.test'),'second baseline');
  release(); server.blockedReads.delete('first@example.test'); await sleep(200);
  assert.equal(run(w,'ArchiveStorage.scope().includes("second@example.test")'),true);
  assert.equal(run(w,'archiveApp.archive.collections.length'),0);
});


test('a revision conflict is retried without losing unrelated remote changes', async t => {
  const server=backend(), app=openApp(server);t.after(app.close);const w=app.window;await ready(w);
  await signIn(w,'conflict@example.test'); await until(()=>server.rows.has('conflict@example.test'),'initial row');
  server.conflictOnce=true;
  run(w,`archiveApp.archive.collections.push({id:'conflict-list',name:'List',sourceName:'',createdAt:new Date().toISOString(),films:[LedgerCore.makeFilm('Kept',{id:'conflict-film'})]}); archiveApp.archive.activeId='conflict-list'; void persistArchive(); renderArchive(false);`);
  await until(()=>{const row=server.rows.get('conflict@example.test');return row.archive.collections.length===1&&row.archive.settings.motion==='reduced';},'revision conflict reconciled');
  assert.equal(server.conflictOnce,false);
});

test('a second tab cannot concurrently open the same protected local cache', async t => {
  const held=new Set();
  const locks={request(name,_options,callback){
    if(held.has(name))return Promise.resolve(callback(null));
    held.add(name);return Promise.resolve(callback({name})).finally(()=>held.delete(name));
  }};
  const server=backend(), idb=new IDBFactory(), first=openApp(server,idb,null,locks), second=openApp(server,idb,null,locks);
  t.after(first.close);t.after(second.close);await ready(first.window);
  await until(()=>second.window.document.getElementById('nr-session-loading')?.textContent.includes('another tab'),'second tab locked');
  assert.equal(second.window.document.getElementById('nr-session-loading').hidden,false);
});


function readBlob(window, blob) {
  return new Promise((resolve,reject)=>{const reader=new window.FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsText(blob);});
}

test('complete JSON backup restores all archive data, view settings, and syncs to a second client', async t => {
  const server=backend(), first=openApp(server), second=openApp(server);t.after(first.close);t.after(second.close);
  const a=first.window,b=second.window;await Promise.all([ready(a),ready(b)]);await signIn(a,'backup@example.test');
  await until(()=>server.rows.has('backup@example.test'),'initial row');
  a.localStorage.setItem('HK_DIRECT_AI_KEYS_V1',JSON.stringify({openai:'secret-never-export'}));
  run(a,`{
    const film=LedgerCore.makeFilm('Backup Film',{id:'backup-film',yearLabel:'1999',genres:['Drama'],watched:true,rating:5,note:'Line one\\nLine two',favorite:true,posterUrl:'data:image/png;base64,aGVsbG8=',posterSource:'Uploaded',description:'Description',addedAt:'2024-01-01T00:00:00.000Z',watchedAt:'2024-03-01T00:00:00.000Z',updatedAt:'2024-03-02T00:00:00.000Z',runtime:110,director:'Director',languages:['French'],countries:['France'],sections:['Classics'],tags:['personal'],watchHistory:[{id:'viewing-one',date:'2024-03-01T00:00:00.000Z',completed:true,minutes:null,edition:'Cut',companions:'Friend',note:'Viewing note'}],noteHistory:[{id:'revision-one',text:'Old note',savedAt:'2024-02-01T00:00:00.000Z'}],privateNote:true,mediaType:'movie',metadata:{provider:'manual',sourceUrl:'https://example.org/film',checkedAt:'2024-03-01T00:00:00.000Z',externalId:'abc'},availability:{US:{link:'https://example.org',rent:[]}}});
    const other=LedgerCore.makeFilm('Second',{id:'backup-second',queue:'soon',queueOrder:123});
    const archive=LedgerCore.emptyArchive();
    Object.assign(archive,{collections:[{id:'backup-list',name:'All progress',films:[film,other],createdAt:'2024-01-01T00:00:00.000Z',sourceName:'source.md'}],activeId:'backup-list',settings:{autoPosters:false,textSize:'large',motion:'reduced',provider:'wikipedia',ratingScale:'10point',effects:'minimal'},preferences:{languages:['French'],excludedKeywords:['spoiler'],region:'GB',exploration:20},paths:[{id:'path-one',name:'Watch later',collectionId:'backup-list',filmIds:['backup-second'],createdAt:'2024-01-01T00:00:00.000Z'}],savedViews:[{id:'view-one',name:'My view',filters:{filter:'watched'}}],profiles:[{id:'profile-one',name:'Friend',languages:['French'],vetoes:['Horror']}],feedback:[{filmId:'backup-film',action:'more',at:'2024-02-01T00:00:00.000Z'}],cloudSources:[{id:'source-one',name:'Source',url:'https://example.org/list.md',collectionId:'backup-list',intervalMinutes:0,identities:[],removedKeys:[],paused:true}],viewState:{view:'list',filter:'favorites',query:'Backup',sort:'title',grouping:true},aiSettings:{profiles:{openai:{enabled:true,model:'example',base:'https://api.openai.com/v1',remember:false}},maxTitles:300}});
    archiveApp.archive=LedgerCore.validateArchive(archive); NightreelCloud.useArchive(); applyArchiveView(); void persistArchive(); renderArchive(false);
  }`);
  await until(()=>server.rows.get('backup@example.test').archive.collections[0]?.id==='backup-list','backup archive uploaded');
  const expected=JSON.parse(JSON.stringify(run(a,'archiveApp.archive')));
  assert.equal(expected.collections[0].films[0].watchHistory[0].minutes,null,'unknown runtime stays unknown');
  a.document.getElementById('open-export').click();a.document.getElementById('export-json').click();
  assert.ok(a.capturedDownload,'backup download created');
  const text=await readBlob(a,a.capturedDownload), exported=JSON.parse(text);delete exported.exportedAt;
  assert.deepEqual(exported,expected);
  assert.ok(!text.includes('secret-never-export'),'API keys are excluded');
  run(a,`archiveApp.archive.collections[0].films[0].note='Different current note'; archiveApp.archive.preferences.region='US'; void persistArchive();`);
  await until(()=>server.rows.get('backup@example.test').archive.collections[0].films[0].note==='Different current note','current state changed');
  const input=a.document.getElementById('restore-file');
  const file=new a.File([text],'nightreel-backup.json',{type:'application/json'});file.text=async()=>text;
  Object.defineProperty(input,'files',{configurable:true,value:[file]});input.dispatchEvent(new a.Event('change',{bubbles:true}));
  await until(()=>a.document.getElementById('confirm-dialog').open,'restore confirmation');
  a.document.getElementById('confirm-action').click();
  await until(()=>run(a,"archiveApp.archive.collections[0].films[0].note")==='Line one\nLine two','restored locally');
  await until(()=>server.rows.get('backup@example.test').archive.collections[0].films[0].note==='Line one\nLine two','restore synced');
  assert.deepEqual(JSON.parse(JSON.stringify(run(a,'archiveApp.archive'))),expected);
  assert.equal(run(a,'archiveApp.view'),'list');assert.equal(run(a,'archiveApp.filter'),'favorites');assert.equal(run(a,'archiveApp.query'),'Backup');
  const checkpoints=await run(a,'ArchiveStorage.checkpoints()');assert.ok(checkpoints.some(item=>item.label==='Before restoring a backup'&&item.archive.collections[0].films[0].note==='Different current note'));
  await signIn(b,'backup@example.test'); await syncNow(b);
  await until(()=>run(b,'archiveApp.archive.collections[0]?.id')==='backup-list','second client restored archive');
  assert.deepEqual(JSON.parse(JSON.stringify(run(b,'archiveApp.archive'))),expected);
  assert.deepEqual(first.errors,[]);assert.deepEqual(second.errors,[]);
});

test('CSV movie import retains basic progress and does not overwrite existing notes or ratings', async t => {
  const server=backend(),app=openApp(server);t.after(app.close);const w=app.window;await ready(w);
  run(w,`{
    const old=LedgerCore.makeFilm('Existing',{id:'existing',yearLabel:'2000',note:'Keep this',rating:4});
    const incoming=LedgerCore.makeFilm('Existing',{id:'incoming',yearLabel:'2000',watched:true,note:'Do not overwrite',rating:5,favorite:true,posterUrl:'https://example.org/poster.jpg'});
    const csv=LedgerCore.exportCsv({films:[incoming]});
    const file=new File([csv],'films.csv',{type:'text/csv'});
    readImportFiles([file]);
    archiveApp.archive.collections.push({id:'csv-list',name:'CSV',films:[old],createdAt:new Date().toISOString(),sourceName:''});archiveApp.archive.activeId='csv-list';renderArchive(false);
  }`);
  await until(()=>run(w,'archiveApp.importDraft?.films?.length')===1,'CSV import preview');
  assert.equal(run(w,'archiveApp.importDraft.films[0].favorite'),true);
  assert.equal(run(w,'archiveApp.importDraft.films[0].watched'),true);
  assert.equal(run(w,'archiveApp.importDraft.films[0].posterUrl'),'https://example.org/poster.jpg');
  w.document.getElementById('import-target').value='append';run(w,'commitImport()');
  assert.equal(run(w,'archiveApp.archive.collections[0].films.length'),1);
  assert.equal(run(w,'archiveApp.archive.collections[0].films[0].note'),'Keep this');
  assert.equal(run(w,'archiveApp.archive.collections[0].films[0].rating'),4);
  assert.equal(run(w,'archiveApp.archive.collections[0].films[0].watched'),true);
  assert.equal(run(w,'archiveApp.archive.collections[0].films[0].favorite'),true);
});


test('invalid backups leave current progress unchanged', async t => {
  const server=backend(),app=openApp(server);t.after(app.close);const w=app.window;await ready(w);await pasteGuestFilm(w);
  const before=JSON.stringify(run(w,'archiveApp.archive'));
  w.document.getElementById('open-export').click();
  const input=w.document.getElementById('restore-file');
  const broken=new w.File(['{broken'],'broken.json',{type:'application/json'});broken.text=async()=>'{broken';
  Object.defineProperty(input,'files',{configurable:true,value:[broken]});input.dispatchEvent(new w.Event('change',{bubbles:true}));
  await until(()=>w.document.getElementById('export-status').textContent.includes('not valid JSON'),'invalid backup error');
  assert.equal(JSON.stringify(run(w,'archiveApp.archive')),before);
  assert.equal(w.document.getElementById('confirm-dialog').open,false);
});

test('removed provider hosts are not offered or fetched as default integrations', async t => {
  const server=backend(),app=openApp(server);t.after(app.close);const w=app.window;await ready(w);
  w.NightreelSync.openDialog();assert.equal(w.document.querySelector('[data-auth="google"]'),null);
  const blocked=run(w,"NightreelCloud.inspectUrl('https://drive.google.com/file/d/example/view')");assert.equal(blocked.valid,false);
  const resources=[...w.document.querySelectorAll('script[src], link[href]')].map(node=>node.getAttribute('src')||node.getAttribute('href'));
  assert.ok(resources.every(url=>!/(googleapis|gstatic|google\.)/i.test(url)));
  run(w,`archiveApp.archive.collections.push({id:'legacy-image-list',name:'List',createdAt:new Date().toISOString(),sourceName:'',films:[LedgerCore.makeFilm('Film',{id:'legacy-image',posterUrl:'https://images.googleusercontent.com/old.png'})]}); archiveApp.archive.activeId='legacy-image-list'; renderArchive(false);`);
  const images=[...w.document.querySelectorAll('img[src]')].map(node=>node.getAttribute('src'));
  assert.ok(images.every(url=>!/(googleusercontent|googleapis|gstatic)/i.test(url)));
  assert.equal(run(w,'archiveApp.archive.collections[0].films[0].posterUrl'),'https://images.googleusercontent.com/old.png','legacy URL remains in backups');
});

test('poster lookups for the same title/year are shared across accounts via the Supabase cache', async t => {
  const server = backend();
  const app = openApp(server); t.after(app.close); const w = app.window; await ready(w);
  await signIn(w, 'poster-one@example.test');
  run(w, `
    archiveApp.archive.settings.provider = 'wikipedia';
    archiveApp.archive.collections.push({id:'poster-list',name:'Posters',createdAt:new Date().toISOString(),sourceName:'',
      films:[LedgerCore.makeFilm('Shared Poster Film',{id:'film-a',yearLabel:'1999'})]});
    archiveApp.archive.activeId='poster-list'; renderArchive(false);
    window.__artworkSearchCalls = 0;
    ArtworkLookup.search = async () => { window.__artworkSearchCalls += 1; return [{posterUrl:'https://example.org/shared.jpg',sourceUrl:'https://en.wikipedia.org/wiki/Shared',source:'Wikipedia',overview:'An example.',title:'Shared Poster Film',year:1999,portrait:true}]; };
    queueArtwork('film-a', true, 0);
  `);
  await until(() => run(w, "archiveApp.artwork.get('wikipedia:film-a')?.match?.posterUrl") === 'https://example.org/shared.jpg', 'first lookup resolved');
  assert.equal(run(w, 'window.__artworkSearchCalls'), 1);
  assert.equal(server.artwork.size, 1, 'the lookup was written to the shared cache');

  await signOut(w);
  await signIn(w, 'poster-two@example.test');
  run(w, `
    archiveApp.archive.settings.provider = 'wikipedia';
    archiveApp.archive.collections.push({id:'poster-list-2',name:'Posters',createdAt:new Date().toISOString(),sourceName:'',
      films:[LedgerCore.makeFilm('Shared Poster Film',{id:'film-b',yearLabel:'1999'})]});
    archiveApp.archive.activeId='poster-list-2'; renderArchive(false);
    window.__artworkSearchCalls = 0;
    ArtworkLookup.search = async () => { window.__artworkSearchCalls += 1; return []; };
    queueArtwork('film-b', true, 0);
  `);
  await until(() => run(w, "archiveApp.artwork.get('wikipedia:film-b')?.match?.posterUrl") === 'https://example.org/shared.jpg', 'second account reused the cached poster');
  assert.equal(run(w, 'window.__artworkSearchCalls'), 0, 'a second account with the same title/year never calls the provider');
});
