import {readFile,writeFile,copyFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
const marker="// EVALDOCK_RUN_GROUPING_V1";
export function patchClient(source){
 if(source.includes(marker))return source;
 function replace(old,next){if(source.split(old).length!==2)throw new Error("Unsupported DSH UI bundle: "+old.slice(0,90));source=source.replace(old,next);}
 replace('const UNGROUPED_LABEL = "Ungrouped";','const UNGROUPED_LABEL = "Ungrouped";\n'+marker+'\n'+"\n/** EvalDock display grouping. Titles carry human metadata; registry retains original hashes. */\nfunction evalRunMeta(session) {\n const match=/^EvalDock · (DSH(?: \\+ [^·\\r\\n]+)?) · (\\d{8}-\\d+) · (C\\d+) · (.+)$/.exec(session?.displayTitle ?? \"\");\n if(!match)return undefined;\n return {key:\"evalrun:\"+match[2], label:match[1]+\" · \"+match[2], title:match[3]+\" · \"+match[4], ordinal:Number(match[3].slice(1)),run:match[2]};\n}\nfunction groupEvalRuns(groups) {\n const runs=new Map();\n for(const group of groups)group.sessions=group.sessions.filter(session=>{\n  const meta=evalRunMeta(session);if(!meta)return true;\n  let run=runs.get(meta.key);\n  if(!run){run=buildGroup(meta.key,undefined,undefined,undefined,meta.label,[],\"account\");runs.set(meta.key,run);}\n  run.sessions.push(session);return false;\n });\n for(const run of runs.values())run.sessions.sort((a,b)=>evalRunMeta(a).ordinal-evalRunMeta(b).ordinal||byRecency(a,b));\n return [...runs.values()].sort((a,b)=>b.key.localeCompare(a.key,undefined,{numeric:true})).concat(groups.filter(g=>g.key!==\"\"||g.sessions.length));\n}\n");
 replace('return session.blank ? "New Session" : session.displayTitle;','return session.blank ? "New Session" : (evalRunMeta(session)?.title ?? session.displayTitle);');
 replace('if (stray.length > 0) groups.push(buildGroup("", void 0, void 0, void 0, UNGROUPED_LABEL, ungroupedOrder === void 0 ? stray : orderedUngrouped(stray, ungroupedOrder), ungroupedOrder === void 0 ? "recency" : "account"));\n\t\t\treturn groups;', 'if (stray.length > 0) groups.push(buildGroup("", void 0, void 0, void 0, UNGROUPED_LABEL, ungroupedOrder === void 0 ? stray : orderedUngrouped(stray, ungroupedOrder), ungroupedOrder === void 0 ? "recency" : "account"));\n\t\t\treturn groupEvalRuns(groups);');
 replace('containsCurrent: g.key === currentGroup,','containsCurrent: g.sessions.some(s=>s.id===list.current),');
 replace('const label = row.workspaceId === void 0 ? t("group.ungrouped") : row.label;','const label = row.key === "" ? t("group.ungrouped") : row.label;');
 replace('const currentGroup = current === void 0 ? void 0 : workspaces.find((w) => w.sessionIds.includes(current))?.workspaceId ?? "";','const currentGroup = current === void 0 ? void 0 : (evalRunMeta(list.byId[current])?.key ?? workspaces.find((w) => w.sessionIds.includes(current))?.workspaceId ?? "");');
 replace('Object.entries(d.groupExpansion).filter(([key]) => retained.has(key))','Object.entries(d.groupExpansion).filter(([key]) => retained.has(key) || key.startsWith("evalrun:"))');
 replace('}), (0, react_jsx_runtime.jsx)("button", {\n\t\t\t\t\t\t\ttype: "button",\n\t\t\t\t\t\t\tclassName: Rows_module_css_default.iconButton,\n\t\t\t\t\t\t\t"aria-label": t("actions.newSession.aria", { name: label }),','}), !row.key.startsWith("evalrun:") && (0, react_jsx_runtime.jsx)("button", {\n\t\t\t\t\t\t\ttype: "button",\n\t\t\t\t\t\t\tclassName: Rows_module_css_default.iconButton,\n\t\t\t\t\t\t\t"aria-label": t("actions.newSession.aria", { name: label }),');
 replace('onArchive: onSessionArchive,\n\t\t\t\t\t\t\t\t\t\t\tdrag: {','onArchive: onSessionArchive,\n\t\t\t\t\t\t\t\t\t\t\tdrag: group.key.startsWith("evalrun:") ? void 0 : {');
 // Keep full titles in flat/search views, where the parent group is not visible.
 replace('title: sessionTitle(s),','title: s.blank ? "New Session" : s.displayTitle,');
 replace('sessions: expanded ? g.sessions.map((session) => sessionNode(session, descendants)) : []','sessions: expanded ? g.sessions.map((session) => ({...sessionNode(session, descendants),title:sessionTitle(session)})) : []');
 replace('className: Rows_module_css_default.title,\n\t\t\t\t\t\t\tchildren: label','className: Rows_module_css_default.title,\n\t\t\t\t\t\t\ttitle: label,\n\t\t\t\t\t\t\tchildren: label');
 replace("onRename: onSessionRename,\n\t\t\t\t\t\t\t\t\t\t\tonFork: forkSession,\n\t\t\t\t\t\t\t\t\t\t\tonArchive: onSessionArchive,\n\t\t\t\t\t\t\t\t\t\t\tdrag: group.key.startsWith(\"evalrun:\")","onRename: (id) => onSessionRename(id, list.byId[id]?.displayTitle ?? \"\"),\n\t\t\t\t\t\t\t\t\t\t\tonFork: forkSession,\n\t\t\t\t\t\t\t\t\t\t\tonArchive: onSessionArchive,\n\t\t\t\t\t\t\t\t\t\t\tdrag: group.key.startsWith(\"evalrun:\")");
 replace("title: label,\n\t\t\t\t\t\t\tchildren: label","title: label,\n\t\t\t\t\t\t\tstyle: row.key.startsWith(\"evalrun:\") ? {display:\"flex\",flexDirection:\"column\",gap:\"3px\",whiteSpace:\"normal\"} : void 0,\n\t\t\t\t\t\t\tchildren: row.key.startsWith(\"evalrun:\") ? [(0, react_jsx_runtime.jsx)(\"span\",{style:{overflow:\"hidden\",textOverflow:\"ellipsis\",whiteSpace:\"nowrap\"},children:label.slice(0,label.lastIndexOf(\" · \"))},\"agent\"),(0, react_jsx_runtime.jsx)(\"span\",{children:label.slice(label.lastIndexOf(\" · \")+3)},\"run\")] : label");
 replace('className: clsx(Rows_module_css_default.projectRow, menuOpen && Rows_module_css_default.menuOpen),','className: clsx(Rows_module_css_default.projectRow, menuOpen && Rows_module_css_default.menuOpen),\n\t\t\t\tstyle: row.key.startsWith("evalrun:") ? {height:"auto",minHeight:"54px"} : void 0,');
 return source;
}

export function patchTitles(source){
 const marker="// EVALDOCK_RUN_TITLES_V1";
 if(source.includes(marker))return source;
 const old='return truncateTitleUtf8(cleanTitleText(input), maxBytes).trimEnd();';
 if(source.split(old).length!==2)throw new Error("Unsupported DSH title module");
 return source.replace(old, "// EVALDOCK_RUN_TITLES_V1\n\tconst text = cleanTitleText(input);\n\tconst evalTitle = /^EvalDock · DSH(?: \\+ [^·]+)? · \\d{8}-\\d+ · C\\d+ · .+$/.test(text);\n\treturn truncateTitleUtf8(text, evalTitle ? Math.max(maxBytes, 8192) : maxBytes).trimEnd();");
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const file=process.argv[2]??"/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js";
 const titleFile=file.replace("/dsh-client-ui-workspace/lib/client.js","/dsh-session-title/lib/index.js");
 const titleSource=await readFile(titleFile,"utf8"),titleNext=patchTitles(titleSource);
 const source=await readFile(file,"utf8"), next=patchClient(source);
 new Function(next);
 if(titleNext!==titleSource){
  await copyFile(titleFile,titleFile+".pre-evaldock-run-groups");
  await writeFile(titleFile,titleNext);
  console.log("Eval title limit extended; restart idle DSH to activate.");
 }
 if(source===next){console.log("Run grouping already installed");}
 else{
  new Function(next); // syntax guard before changing installed file
  await copyFile(file,file+".pre-evaldock-run-groups");
  await writeFile(file,next);
  console.log("Run grouping installed; reload DSH browser.");
 }
}
