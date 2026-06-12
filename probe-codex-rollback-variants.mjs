// Can ANY native sequence make a fork truncated-at-a-midpoint actually isolate model context?
// V1 (known bad): fork -> rollback -> turn/start.
// V2: fork -> rollback -> thread/resume(rolled.id) -> turn/start   (does resume reload the truncated rollout?)
// V3: fork -> rollback -> close+reopen app-server -> thread/resume -> turn/start (fresh process, no cached ctx)
// Each asks "what did we discuss?" on a fork of the real permission spine, rolled back to b57 (install).
// PASS = answer is about install/unreal, FAIL = answer is about permission.
import { spawn } from 'node:child_process';
import { readdirSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const SPINE='019ebb46-9fae-7f61-81ca-05d21858e33f';
const MARKER='019ebb46-c788-7552-8e6d-8b38d6955120';
const OUT=join(process.cwd(),'probe-codex-rollback-variants-out.txt'); writeFileSync(OUT,'');
function log(...a){const l=a.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' ');console.log(l);try{appendFileSync(OUT,l+'\n')}catch{}}
function findExe(dir,d=4){let e=[];try{e=readdirSync(dir,{withFileTypes:true})}catch{return}for(const x of e)if(x.isFile()&&x.name.toLowerCase()==='codex.exe')return join(dir,x.name);if(d<=0)return;for(const x of e)if(x.isDirectory()){const h=findExe(join(dir,x.name),d-1);if(h)return h}}
function getBin(){if(process.env.BRAID_CODEX_BIN&&existsSync(process.env.BRAID_CODEX_BIN))return process.env.BRAID_CODEX_BIN;for(const r of[join(homedir(),'.vscode','extensions'),join(homedir(),'.cursor','extensions')]){let n=[];try{n=readdirSync(r)}catch{continue}for(const c of n.filter(x=>/^openai\.(chatgpt|codex)-/i.test(x)).sort().reverse()){const h=findExe(join(r,c,'bin'));if(h)return h}}return 'codex'}
const BIN=getBin();
function client(){const cp=spawn(BIN,['app-server'],{stdio:['pipe','pipe','pipe']});cp.on('error',e=>{log('!! spawn',String(e?.message??e));process.exit(1)});let id=0,buf='';const pend=new Map();const notif=[];
  function line(l){l=l.trim();if(!l)return;let m;try{m=JSON.parse(l)}catch{return}const hm=typeof m.method==='string',hi=m.id!=null;if(hm&&hi){cp.stdin.write(JSON.stringify({id:m.id,result:/requestApproval$/i.test(m.method)?{decision:'decline'}:{}})+'\n');return}if(hm){for(const w of notif.slice())w(m);return}if(hi&&pend.has(m.id)){const{res,t}=pend.get(m.id);clearTimeout(t);pend.delete(m.id);res(m)}}
  cp.stdout.on('data',d=>{buf+=d;let nl;while((nl=buf.indexOf('\n'))>=0){const x=buf.slice(0,nl);buf=buf.slice(nl+1);line(x)}});
  function req(method,params){const my=++id;cp.stdin.write(JSON.stringify({id:my,method,params:params??{}})+'\n');return new Promise(res=>{const t=setTimeout(()=>{pend.delete(my);res({__timeout:true,method})},90000);pend.set(my,{res,t})})}
  function notify(method,params){cp.stdin.write(JSON.stringify({method,params:params??{}})+'\n')}
  function onNotify(fn){notif.push(fn)}
  return {cp,req,notify,onNotify}}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ids=th=>Array.isArray(th?.turns)?th.turns.map(t=>t.id.slice(0,13)):'(none)';
const SO={cwd:tmpdir(),approvalPolicy:'never',sandbox:'read-only'};

async function handshake(c){await c.req('initialize',{clientInfo:{name:'braid-rbv',title:'p',version:'0'},capabilities:{experimentalApi:true}});c.notify('initialized',{});await sleep(150);const a=await c.req('account/read',{refreshToken:false});return !!(a.result&&a.result.account);}
async function ask(c,threadId,prompt){let ans='';const cap=m=>{if(m.method==='item/agentMessage/delta'&&typeof m.params?.delta==='string')ans+=m.params.delta;if(m.method==='item/completed'&&m.params?.item?.type==='agentMessage'&&typeof m.params.item.text==='string')ans=m.params.item.text;};c.onNotify(cap);await c.req('turn/start',{threadId,input:[{type:'text',text:prompt,text_elements:[]}],...SO});for(let i=0;i<60;i++){await sleep(800);const t=await c.req('thread/read',{threadId,includeTurns:false}).catch(()=>null);if(t?.result?.thread?.status==='idle')break;}return ans.replace(/\s+/g,' ').trim();}
function verdict(ans){const perm=/permission|bypass|sandbox|approval|writable|danger-full/i.test(ans);const unreal=/unreal|plugin|install|powershell|copy/i.test(ans);return perm?'FAIL(permission)':unreal?'PASS(install/unreal)':'INCONCLUSIVE';}
const Q='In ONE sentence: what were the last few things we discussed in THIS conversation?';

async function forkRollback(c){const fk=await c.req('thread/fork',{threadId:SPINE,...SO});const f=fk.result?.thread;const idx=f.turns.findIndex(t=>t.id===MARKER);const drop=f.turns.length-(idx+1);const rb=await c.req('thread/rollback',{threadId:f.id,numTurns:drop});const r=rb.result?.thread;return {forkId:f.id,rolledId:r?.id??f.id,rolledTurns:ids(r)};}

async function main(){
  log('codex:',BIN);
  // V2: fork -> rollback -> thread/resume(rolled) -> ask
  log('\n##### V2: fork -> rollback -> thread/resume -> turn/start #####');
  {const c=client();await sleep(400);if(!await handshake(c)){log('not logged in');process.exit(0);}
   const {rolledId,rolledTurns}=await forkRollback(c);log('rolled turns:',JSON.stringify(rolledTurns));
   const rs=await c.req('thread/resume',{threadId:rolledId,...SO});log('resume ok, resumed turns:',JSON.stringify(ids(rs.result?.thread)));
   const ans=await ask(c,rolledId,Q);log('ANSWER:',ans.slice(0,300));log('V2 =>',verdict(ans));c.cp.kill();await sleep(300);}
  // V3: fork -> rollback (proc A) ; then NEW proc B -> resume(rolled) -> ask  (no cached runtime ctx)
  log('\n##### V3: fork+rollback in proc A, then FRESH proc B resume+ask #####');
  {const a=client();await sleep(400);if(!await handshake(a)){log('not logged in');process.exit(0);}
   const {rolledId,rolledTurns}=await forkRollback(a);log('rolled turns:',JSON.stringify(rolledTurns));a.cp.kill();await sleep(500);
   const b=client();await sleep(400);await handshake(b);
   const rs=await b.req('thread/resume',{threadId:rolledId,...SO});log('proc B resumed turns:',JSON.stringify(ids(rs.result?.thread)));
   const ans=await ask(b,rolledId,Q);log('ANSWER:',ans.slice(0,300));log('V3 =>',verdict(ans));b.cp.kill();await sleep(300);}
  log('\nDONE →',OUT);process.exit(0);
}
main().catch(e=>{log('err',String(e?.stack??e));process.exit(1)});
