import {createServer} from 'vite';
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const server=await createServer({root,configFile:false,server:{middlewareMode:true,hmr:false},appType:'custom'});
let state=0x20ff105;
const integer=()=>state=(Math.imul(state,1664525)+1013904223)>>>0;
const random=()=>integer()/4294967296;
try{
 const {LEVELS,levelSnapshot}=await server.ssrLoadModule('/src/game/content.ts');
 const {simulate}=await server.ssrLoadModule('/src/core/simulation.ts');
 const {makeDesign,makeSign,MODEL}=await server.ssrLoadModule('/src/core/scene.ts');
 const {validateLevelDesign}=await server.ssrLoadModule('/src/game/evaluation.ts');
 const cases=[],errors=[];
 for(const level of LEVELS){
  let tested=0,rejected=0;
  for(let attempt=0;attempt<800&&tested<24;attempt++){
   const seed=integer(),snapshot=levelSnapshot(level,seed);
   const signs=Array.from({length:level.tools},(_,i)=>makeSign({x:1.3+random()*25.4,y:1.9+random()*14.7},{id:i+1,target:i===1?'A':'B',normal:[{x:0,y:1},{x:1,y:0},{x:0,y:-1},{x:-1,y:0}][integer()%4],from:Math.floor(random()*8),until:20+Math.floor(random()*80)}));
   const barrier=level.allowBarrier&&random()<.5?{position:{x:2+random()*24,y:3+random()*12},vertical:random()<.5}:null;
   const design=makeDesign(barrier?signs.slice(0,1):signs,barrier);
   try{validateLevelDesign(level,snapshot,design);}catch{rejected++;continue;}
   tested++;
   try{const run=simulate(snapshot,design);cases.push({level:level.id,seed,design,mean:run.metrics.meanArrival,tail:run.metrics.lastArrival,completed:run.metrics.completed,unfinished:run.metrics.unfinished,hash:run.fingerprint});}
   catch(error){errors.push({level:level.id,seed,design,message:error.message});}
  }
  console.log(JSON.stringify({level:level.id,tested,rejected,errors:errors.filter(e=>e.level===level.id).length}));
 }
 await writeFile(resolve(root,'output/DEV-002-自由布局审计.json'),JSON.stringify({model:MODEL,timestamp:new Date().toISOString(),scope:'96份程序生成的合法布局执行检查，不替代逐帧运动审计或人类试玩',randomStart:0x20ff105,cases,errors},null,2));
 console.log(JSON.stringify({total:cases.length+errors.length,errorCount:errors.length,unfinished:cases.filter(c=>c.unfinished).length}));
 if(errors.length)process.exitCode=1;
}finally{await server.close();}
