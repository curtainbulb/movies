// Uses the bundled Supabase SDK against a simulated HTTP service, not a hosted project.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {JSDOM, VirtualConsole} = require('jsdom');
const {IDBFactory, IDBKeyRange} = require('fake-indexeddb');
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate, label, timeout=8000) {
  const started=Date.now(); while(Date.now()-started<timeout){if(predicate())return;await sleep(25);}throw new Error(`Timed out: ${label}`);
}

test('bundled Supabase SDK connects the account UI to REST reads and revision writes', async t => {
  const user={id:'11111111-1111-4111-8111-111111111111',email:'sdk@example.test',aud:'authenticated',role:'authenticated',app_metadata:{provider:'email'},user_metadata:{},created_at:new Date().toISOString()};
  const payload=Buffer.from(JSON.stringify({sub:user.id,role:'authenticated',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url');
  const token=`e30.${payload}.test`;
  const requests=[]; let row=null;
  function reply(body,status=200){return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});}
  async function mockFetch(input,options={}) {
    const url=new URL(typeof input==='string'?input:input.url), method=options.method||'GET';
    const body=options.body?JSON.parse(options.body):null;
    requests.push({path:url.pathname,method,body});
    if(url.pathname==='/auth/v1/signup') return reply({...user,email:body.email});
    if(url.pathname==='/auth/v1/token') return reply({access_token:token,refresh_token:'test-refresh',token_type:'bearer',expires_in:3600,user});
    if(url.pathname==='/auth/v1/user') return reply(user);
    if(url.pathname==='/auth/v1/logout') return reply({});
    if(url.pathname==='/rest/v1/nightreel_archives') return reply(row ? [row] : []);
    if(url.pathname==='/rest/v1/rpc/nightreel_commit_archive') {
      if(body.expected_revision!==(row?.revision||0)) return reply({code:'P0001',message:'archive revision conflict'},400);
      row={revision:body.expected_revision+1,archive:body.document,updated_at:new Date().toISOString()}; return reply([row]);
    }
    return reply({message:'unexpected test request'},404);
  }
  let html=fs.readFileSync('index.html','utf8').replace(/<script src="([^"]+)"><\/script>/g,(_m,file)=>{
    if(file==='supabase-config.js') return '<script>window.NIGHTREEL_CONFIG={supabaseUrl:"https://example.supabase.co",supabasePublishableKey:"sb_publishable_example"};<\/script>';
    return `<script>${fs.readFileSync(file,'utf8')}<\/script>`;
  });
  const errors=[]; const console=new VirtualConsole();console.on('jsdomError',error=>errors.push(error.message));
  const dom=new JSDOM(html,{url:'https://nightreel.test/',runScripts:'dangerously',pretendToBeVisual:true,virtualConsole:console,beforeParse(w){
    w.indexedDB=new IDBFactory();w.IDBKeyRange=IDBKeyRange;w.structuredClone=structuredClone;
    w.fetch=mockFetch;w.Headers=Headers;w.Request=Request;w.Response=Response;
    w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});w.scrollTo=()=>{};
    w.HTMLElement.prototype.scrollIntoView=function(){};w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
  }}); t.after(()=>dom.window.close()); const w=dom.window;
  await until(()=>w.NightreelSync&&!w.NIGHTREEL_AUTH_PENDING,'app ready');
  w.NightreelSync.openDialog();
  for (const email of ['cinema@proton.me','viewer@fastmail.com','person@example.org']) {
    w.document.getElementById('nr-email').value=email;w.document.getElementById('nr-password').value='test-password';w.document.querySelector('[data-auth="signup"]').click();
    await until(()=>requests.some(request=>request.path==='/auth/v1/signup' && request.body?.email===email),`signup request for ${email}`);
    await until(()=>!w.document.querySelector('[data-auth="signup"]').disabled,`signup completed for ${email}`);
    assert.match(w.document.getElementById('nr-auth-message').textContent,/confirmation link/);
  }
  assert.equal(w.document.querySelector('[data-auth="google"]'),null);
  w.document.getElementById('nr-email').value=user.email;w.document.getElementById('nr-password').value='test-password';w.document.querySelector('[data-auth="signin"]').click();
  await until(()=>w.NightreelSync.isSignedIn()&&!w.NIGHTREEL_AUTH_PENDING,'SDK sign-in');
  await until(()=>row!==null,'SDK initial commit');
  w.eval(`archiveApp.archive.collections.push({id:'sdk-list',name:'SDK',sourceName:'',createdAt:new Date().toISOString(),films:[LedgerCore.makeFilm('SDK Film',{id:'sdk-film'})]}); archiveApp.archive.activeId='sdk-list'; void persistArchive(); renderArchive(false);`);
  await until(()=>row.archive.collections[0]?.films[0]?.title==='SDK Film','SDK archive write');
  assert.ok(requests.some(request=>request.path==='/auth/v1/token'));
  assert.ok(requests.some(request=>request.path==='/auth/v1/user'));
  assert.ok(requests.some(request=>request.path==='/rest/v1/nightreel_archives'));
  assert.ok(requests.some(request=>request.path==='/rest/v1/rpc/nightreel_commit_archive'));
  assert.deepEqual(errors,[]);
});
