import type {Obj} from './graph.js';

export function groupingBudget(recordCount:number){
 return {version:'tag-reading-groups/1',maxGroups:Math.min(7,Math.max(1,Math.ceil(recordCount/25))),minRecords:8};
}

// Presentation only: union adjacent source groups; never split native pairs or remove evidence.
export function compactPresentation(presentation:Obj,recordCount:number):Obj{
 const policy=groupingBudget(recordCount),original:Obj[]=presentation.stages??[];
 if(!original.length)return {...presentation,policy};
 const groups=original.map((g):Obj=>({...g,recordIds:[...g.recordIds],sourceGroups:g.sourceGroups??[{title:g.title,reason:g.reason,recordIds:[...g.recordIds]}]}))
  .sort((a,b)=>a.from-b.from);
 const before=groups.length;
 while(groups.length>1){
  const sparse=groups.some(g=>g.recordIds.length<policy.minRecords);
  if(groups.length<=policy.maxGroups&&!sparse)break;
  let best=-1,weight=Infinity;
  for(let i=0;i<groups.length-1;i++){
   const a=groups[i]!,b=groups[i+1]!;
   if(sparse&&a.recordIds.length>=policy.minRecords&&b.recordIds.length>=policy.minRecords)continue;
   const size=a.recordIds.length+b.recordIds.length;
   if(size<weight){best=i;weight=size;}
  }
  const a=groups[best]!,b=groups[best+1]!,sourceGroups=[...a.sourceGroups,...b.sourceGroups];
  const title=sourceGroups.length===2&&`${a.title} / ${b.title}`.length<=36?`${a.title} / ${b.title}`:`${sourceGroups[0].title}等 ${sourceGroups.length} 个环节`;
  groups.splice(best,2,{...a,title,reason:'按分组数量与最小容量规则合并相邻阅读组；原始分组保留在 sourceGroups。',from:Math.min(a.from,b.from),to:Math.max(a.to,b.to),recordIds:[...a.recordIds,...b.recordIds],sourceGroups});
 }
 return {...presentation,stages:groups,policy:{...policy,sourceGroupCount:presentation.policy?.sourceGroupCount??before,displayGroupCount:groups.length}};
}
