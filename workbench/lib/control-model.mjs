export const mandatoryPlugins=['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app'];
export function validateScale(datasetCount,caseCount){
  if(!Number.isSafeInteger(datasetCount)||datasetCount<1||datasetCount>50)throw new Error('Dataset 数量须为 1–50');
  if(!Number.isSafeInteger(caseCount)||caseCount<datasetCount||caseCount>1000)throw new Error('Case 总量须不小于 Dataset 数量，且不超过 1000');
}
export function selectedBundles(names,catalog){
  if(!Array.isArray(names)||names.some(n=>typeof n!=='string')||new Set(names).size!==names.length)throw new Error('插件选择无效');
  if(mandatoryPlugins.some(n=>!names.includes(n)))throw new Error('DSH 基础与 Web 插件必须保留');
  if(names.some(n=>!catalog.some(p=>p.name===n&&p.version)))throw new Error('只能选择已安装的有效插件');
  // Keep the existing layer order; deselection does not uninstall dependencies.
  return catalog.filter(p=>names.includes(p.name)).map(p=>p.name);
}
