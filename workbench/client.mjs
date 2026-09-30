
/** Browser/Node client. Keep tokens in local frontend configuration, never in URL query strings. */
export class WorkbenchClient {
  constructor({baseUrl='http://127.0.0.1:18766',token,fetchImpl=globalThis.fetch}){this.baseUrl=baseUrl;this.token=token;this.fetch=fetchImpl;}
  async request(path,{method='GET',body,signal}={}){
    const response=await this.fetch(this.baseUrl+path,{method,signal,headers:{Authorization:'Bearer '+this.token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    if(!response.ok){const value=await response.json();throw Object.assign(new Error(value.error?.message??'API error'),{status:response.status,code:value.error?.code});}
    return response.json();
  }
  capabilities(){return this.request('/api/v1/capabilities');}
  dsh(){return this.request('/api/v1/dsh');}
  controlDsh(action){return this.request('/api/v1/dsh/control',{method:'POST',body:{action}});}
  selectPlugins(plugins){return this.request('/api/v1/dsh/plugins',{method:'POST',body:{plugins}});}
  searchPlugins(q){return this.request('/api/v1/dsh/plugins/search?q='+encodeURIComponent(q));}
  targets(){return this.request('/api/v1/targets');}
  catalog(){return this.request('/api/v1/catalog');}
  start(input){return this.request('/api/v1/jobs',{method:'POST',body:input});}
  job(id){return this.request('/api/v1/jobs/'+encodeURIComponent(id));}
  result(id){return this.request('/api/v1/jobs/'+encodeURIComponent(id)+'/result');}
  events(id,after=0){return this.request('/api/v1/jobs/'+encodeURIComponent(id)+'/events?after='+after);}
  cancel(id){return this.request('/api/v1/jobs/'+encodeURIComponent(id)+'/cancel',{method:'POST',body:{}});}
  jobs(offset=0,limit=50){return this.request('/api/v1/jobs?offset='+offset+'&limit='+limit);}
  runs(offset=0,limit=50){return this.request('/api/v1/runs?offset='+offset+'&limit='+limit);}
  run(store,agent,run){return this.request('/api/v1/runs/'+[store,agent,run].map(encodeURIComponent).join('/'));}
  caseReport(store,agent,run,caseId){return this.request('/api/v1/runs/'+[store,agent,run,'cases',caseId].map(encodeURIComponent).join('/'));}
  /** Returns a blob URL; display in a sandboxed iframe or trigger download, then revokeObjectURL. */
  async file(apiPath){
    if(!apiPath.startsWith('/api/v1/runs/'))throw new Error('Expected a result API path');
    const r=await this.fetch(this.baseUrl+apiPath,{headers:{Authorization:'Bearer '+this.token}});
    if(!r.ok)throw new Error('Result download failed: '+r.status);
    return URL.createObjectURL(await r.blob());
  }
}
