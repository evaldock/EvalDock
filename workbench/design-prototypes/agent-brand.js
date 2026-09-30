const agentBrands={dsh:'DSH',pi:'Pi',openclaw:'OpenClaw',hermes:'Hermes',workbuddy:'WorkBuddy',qwenwork:'千问办公',doubaowork:'豆包办公',langgraph:'LangGraph'};
function agentLogo(kind){
  if(!agentBrands[kind])return '';
  const extension=['qwenwork','doubaowork','hermes'].includes(kind)?'png':'svg';
  return '<img class="agent-logo" data-agent-logo="'+kind+'" src="assets/agents/'+kind+'.'+extension+'" width="22" height="22" alt="" aria-hidden="true">';
}

function consoleNavigation(){
  const entries=Object.entries(agentBrands),open=expandedGroups.consoles;
  return '<button class="nav group-nav" data-group="consoles" aria-expanded="'+open+'" aria-controls="console-tree"><span class="chevron">'+(open?'⌄':'›')+'</span>'+icon('grid')+'控制台<span class="nav-count">'+entries.length+'</span></button>'+(open?'<div class="nav-children console-tree" id="console-tree" role="group" aria-label="Agent 控制台列表" tabindex="0">'+entries.map(([kind,name])=>{const target=kind==='dsh'?'control':kind;return '<button class="tree-item control-nav '+(page===target?'selected':'')+'" data-page="'+target+'" aria-current="'+(page===target?'page':'false')+'" title="'+esc(name)+' 控制台">'+agentLogo(kind)+'<span>'+esc(name)+'</span></button>';}).join('')+'</div>':'');
}
