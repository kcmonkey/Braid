// probe-codex-realfork.mjs — test forkAt's marker lookup against the REAL problematic thread.
// b70 ("what we talked about?") forked b57's session 019ebb46-9fae with at = b57.messageUuid
// 019ebb46-c788, but inherited the later permission turns (b59..b65) → forkAt's
// findIndex(t => t.id === at) must have returned -1 on the fork. This thread was itself
// fork-created (from unreal 019ebb2d) then resumed 6x — unlike the flat probe. Read it + fork it
// and check whether the marker survives. READ-ONLY (thread/read + thread/fork, no turns run).
import { spawn } from 'node:child_process';
import { readdirSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SPINE = '019ebb46-9fae-7f61-81ca-05d21858e33f';   // b57.sessionId (the shared permission spine)
const MARKER = '019ebb46-c788-7552-8e6d-8b38d6955120';  // b57.messageUuid (forkAt `at`)
const UNREAL = '019ebb2d-5b52-74c1-9699-f99a214f8942';   // the thread 019ebb46-9fae was forked from
const KNOWN = { // muid → board, to label what each turn is
  '019ebb46-c788-7552-8e6d-8b38d6955120': 'b57 install-help (MARKER)',
  '019ebb4c-f19b-7d62-b7d6-83c178a97e37': 'b59 sandbox-blocked',
  '019ebb4f-2c92-7e13-9f51-68af6ae9006c': 'b60 bypass-perm',
  '019ebb51-0f17-7a42-a5e8-6b2b70a739ee': 'b61 perm',
  '019ebb53-d793-7062-9feb-5110fa20b9a2': 'b62 perm',
  '019ebb58-7032-70d0-b086-d40d4929b6ab': 'b64 perm',
  '019ebb5e-e140-78f0-b27c-1584ecac49ff': 'b65 perm',
};
const OUT = join(process.cwd(), 'probe-codex-realfork-out.txt'); writeFileSync(OUT, '');
function log(...a){const l=a.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' ');console.log(l);try{appendFileSync(OUT,l+'\n')}catch{}}
function findExe(dir,d=4){let e=[];try{e=readdirSync(dir,{withFileTypes:true})}catch{return}for(const x of e)if(x.isFile()&&x.name.toLowerCase()==='codex.exe')return join(dir,x.name);if(d<=0)return;for(const x of e)if(x.isDirectory()){const h=findExe(join(dir,x.name),d-1);if(h)return h}}
function bin(){if(process.env.BRAID_CODEX_BIN&&existsSync(process.env.BRAID_CODEX_BIN))return process.env.BRAID_CODEX_BIN;for(const r of[join(homedir(),'.vscode','extensions'),join(homedir(),'.cursor','extensions')]){let n=[];try{n=readdirSync(r)}catch{continue}for(const c of n.filter(x=>/^openai\.(chatgpt|codex)-/i.test(x)).sort().reverse()){const h=findExe(join(r,c,'bin'));if(h)return h}}return 'codex'}
function client(){const cp=spawn(bin(),['app-server'],{stdio:['pipe','pipe','pipe']});cp.stderr.on('data',d=>log('[stderr]',String(d).trim().slice(0,200)));cp.on('error',e=>{log('!! spawn',String(e?.message??e));process.exit(1)});let id=0,buf='';const pend=new Map();
  function line(l){l=l.trim();if(!l)return;let m;try{m=JSON.parse(l)}catch{return}const hm=typeof m.method==='string',hi=m.id!=null;if(hm&&hi){cp.stdin.write(JSON.stringify({id:m.id,result:{}})+'\n');return}if(hm)return;if(hi&&pend.has(m.id)){const{res,t}=pend.get(m.id);clearTimeout(t);pend.delete(m.id);res(m)}}
  cp.stdout.on('data',d=>{buf+=d;let nl;while((nl=buf.indexOf('\n'))>=0){const x=buf.slice(0,nl);buf=buf.slice(nl+1);line(x)}});
  function req(method,params){const my=++id;cp.stdin.write(JSON.stringify({id:my,method,params:params??{}})+'\n');return new Promise(res=>{const t=setTimeout(()=>{pend.delete(my);res({__timeout:true,method})},60000);pend.set(my,{res,t})})}
  function notify(method,params){cp.stdin.write(JSON.stringify({method,params:params??{}})+'\n')}
  return {cp,req,notify}}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ids=th=>Array.isArray(th?.turns)?th.turns.map(t=>t.id):'(no turns[])';
const label=arr=>Array.isArray(arr)?arr.map(x=>KNOWN[x]?`${x.slice(0,13)}=${KNOWN[x]}`:x.slice(0,13)):arr;

async function main(){
  log('codex:',bin());
  const c=client();await sleep(400);
  await c.req('initialize',{clientInfo:{name:'braid-realfork',title:'p',version:'0'},capabilities:{experimentalApi:true}});c.notify('initialized',{});await sleep(150);
  const acct=await c.req('account/read',{refreshToken:false});
  if(!(acct.result&&acct.result.account)){log('!! not logged in');c.cp.kill();process.exit(0)}
  log('account:',JSON.stringify(acct.result.account));

  log('\n=== 1. thread/read the REAL spine 019ebb46-9fae (includeTurns) ===');
  const rd=await c.req('thread/read',{threadId:SPINE,includeTurns:true});
  if(rd.error||rd.__timeout){log('read error/timeout:',JSON.stringify(rd.error??rd));}
  const rt=ids(rd.result?.thread);
  log('spine turn ids:',JSON.stringify(label(rt)));
  log('MARKER present in persisted spine?',Array.isArray(rt)?rt.includes(MARKER):'n/a','idx=',Array.isArray(rt)?rt.indexOf(MARKER):'n/a');

  log('\n=== 2. thread/fork the REAL spine (what b70 did) → does the MARKER survive? ===');
  const fk=await c.req('thread/fork',{threadId:SPINE});
  if(fk.error||fk.__timeout){log('fork error/timeout:',JSON.stringify(fk.error??fk));}
  const ft=ids(fk.result?.thread);
  log('forked.id=',fk.result?.thread?.id,' forkedFromId=',fk.result?.thread?.forkedFromId);
  log('forked turn ids:',JSON.stringify(label(ft)));
  const idx=Array.isArray(ft)?ft.indexOf(MARKER):-1;
  log('>>> forkAt findIndex(MARKER) =',idx,' → drop =',Array.isArray(ft)&&idx>=0?ft.length-(idx+1):0);
  if(idx<0) log('!!! REPRODUCED: forkAt cannot find b57 marker in the fork → drop 0 → b59..b65 (permission) bleed into b70.');
  else log('=== marker found; forkAt would have dropped the permission turns. Look elsewhere.');

  log('\n=== 3. compare: persisted spine ids vs forked spine ids (id stability across fork) ===');
  log('same sequence?',JSON.stringify(rt)===JSON.stringify(ft));

  c.cp.kill();log('\nDONE →',OUT);process.exit(0);
}
main().catch(e=>{log('err',String(e?.stack??e));process.exit(1)});
