// Does thread/fork + thread/rollback actually REDUCE the model's context, or only the turn-list metadata?
// Replicates b74's exact flow: fork the real permission spine 019ebb46-9fae, rollback to b57's turn
// (019ebb46-c788, dropping the 6 permission turns), then RUN ONE TURN asking what we discussed.
// If the answer mentions permission/bypass -> rollback does NOT isolate context (the live bug).
// If it mentions only install/unreal/plugin -> rollback works and the bug is elsewhere.
import { spawn } from 'node:child_process';
import { readdirSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

const SPINE='019ebb46-9fae-7f61-81ca-05d21858e33f';
const MARKER='019ebb46-c788-7552-8e6d-8b38d6955120'; // b57 install-help turn
const OUT=join(process.cwd(),'probe-codex-rollback-context-out.txt'); writeFileSync(OUT,'');
function log(...a){const l=a.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' ');console.log(l);try{appendFileSync(OUT,l+'\n')}catch{}}
function findExe(dir,d=4){let e=[];try{e=readdirSync(dir,{withFileTypes:true})}catch{return}for(const x of e)if(x.isFile()&&x.name.toLowerCase()==='codex.exe')return join(dir,x.name);if(d<=0)return;for(const x of e)if(x.isDirectory()){const h=findExe(join(dir,x.name),d-1);if(h)return h}}
function bin(){if(process.env.BRAID_CODEX_BIN&&existsSync(process.env.BRAID_CODEX_BIN))return process.env.BRAID_CODEX_BIN;for(const r of[join(homedir(),'.vscode','extensions'),join(homedir(),'.cursor','extensions')]){let n=[];try{n=readdirSync(r)}catch{continue}for(const c of n.filter(x=>/^openai\.(chatgpt|codex)-/i.test(x)).sort().reverse()){const h=findExe(join(r,c,'bin'));if(h)return h}}return 'codex'}
function client(){const cp=spawn(bin(),['app-server'],{stdio:['pipe','pipe','pipe']});cp.stderr.on('data',d=>log('[stderr]',String(d).trim().slice(0,160)));cp.on('error',e=>{log('!! spawn',String(e?.message??e));process.exit(1)});let id=0,buf='';const pend=new Map();const notif=[];
  function line(l){l=l.trim();if(!l)return;let m;try{m=JSON.parse(l)}catch{return}const hm=typeof m.method==='string',hi=m.id!=null;if(hm&&hi){cp.stdin.write(JSON.stringify({id:m.id,result:/requestApproval$/i.test(m.method)?{decision:'decline'}:{}})+'\n');return}if(hm){for(const w of notif.splice(0))w(m);return}if(hi&&pend.has(m.id)){const{res,t}=pend.get(m.id);clearTimeout(t);pend.delete(m.id);res(m)}}
  cp.stdout.on('data',d=>{buf+=d;let nl;while((nl=buf.indexOf('\n'))>=0){const x=buf.slice(0,nl);buf=buf.slice(nl+1);line(x)}});
  function req(method,params){const my=++id;cp.stdin.write(JSON.stringify({id:my,method,params:params??{}})+'\n');return new Promise(res=>{const t=setTimeout(()=>{pend.delete(my);res({__timeout:true,method})},90000);pend.set(my,{res,t})})}
  function notify(method,params){cp.stdin.write(JSON.stringify({method,params:params??{}})+'\n')}
  function onNotify(fn){notif.push(fn)}
  return {cp,req,notify,onNotify}}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ids=th=>Array.isArray(th?.turns)?th.turns.map(t=>t.id.slice(0,13)):'(none)';

async function main(){
  log('codex:',bin());
  const c=client();await sleep(400);
  await c.req('initialize',{clientInfo:{name:'braid-rbctx',title:'p',version:'0'},capabilities:{experimentalApi:true}});c.notify('initialized',{});await sleep(150);
  const acct=await c.req('account/read',{refreshToken:false});
  if(!(acct.result&&acct.result.account)){log('!! not logged in');c.cp.kill();process.exit(0)}

  log('\n=== fork the real spine WITH the adapter startOpts (read-only so the turn writes nothing) ===');
  const startOpts={cwd:tmpdir(),approvalPolicy:'never',sandbox:'read-only'};
  const fk=await c.req('thread/fork',{threadId:SPINE,...startOpts});
  const forked=fk.result?.thread;const fid=forked?.id;
  log('forked id=',fid,' turns=',JSON.stringify(ids(forked)));
  const idx=Array.isArray(forked?.turns)?forked.turns.findIndex(t=>t.id===MARKER):-1;
  const drop=idx>=0?forked.turns.length-(idx+1):0;
  log('marker idx=',idx,' drop=',drop);

  log('\n=== rollback the fork by drop (forkAt does exactly this) ===');
  const rb=await c.req('thread/rollback',{threadId:fid,numTurns:drop});
  const rolled=rb.result?.thread;
  log('rolled id=',rolled?.id,' turns=',JSON.stringify(ids(rolled)),' (expect only unreal x4 + b57 marker)');
  const runThread=rolled?.id??fid;

  log('\n=== run ONE turn on the rolled-back thread (what b74 did) ===');
  let answer='';
  c.onNotify(function cap(m){ if(m.method==='item/agentMessage/delta'&&typeof m.params?.delta==='string')answer+=m.params.delta;
    if(m.method==='item/completed'&&m.params?.item?.type==='agentMessage'&&typeof m.params.item.text==='string')answer=m.params.item.text;
    c.onNotify(cap); });
  await c.req('turn/start',{threadId:runThread,input:[{type:'text',text:'In ONE sentence: what were the last few things we discussed in THIS conversation?',text_elements:[]}],...startOpts});
  // wait for idle
  for(let i=0;i<60;i++){await sleep(800);const t=await c.req('thread/read',{threadId:runThread,includeTurns:false}).catch(()=>null);if(t?.result?.thread?.status==='idle')break;}
  log('\n>>> ANSWER:',answer.replace(/\s+/g,' ').trim().slice(0,400));
  const perm=/permission|bypass|sandbox|approval|writable|danger-full/i.test(answer);
  const unreal=/unreal|plugin|install|powershell|copy/i.test(answer);
  log('\nmentions PERMISSION terms:',perm,' | mentions INSTALL/UNREAL terms:',unreal);
  if(perm) log('!!! CONFIRMED LIVE BUG: rollback did NOT isolate context — the model still sees the dropped permission turns.');
  else if(unreal) log('=== rollback WORKED for context (answer is about install/unreal). Bug is upstream (at/resumeAt not passed).');
  else log('inconclusive answer — inspect text above.');
  c.cp.kill();log('\nDONE →',OUT);process.exit(0);
}
main().catch(e=>{log('err',String(e?.stack??e));process.exit(1)});
