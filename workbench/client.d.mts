
export type Action = 'inspect' | 'plan' | 'run';
export type JobState = 'STARTING' | 'RUNNING' | 'CANCELLING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED';
export interface StartJob {
  action: Action;
  targetId: string;
  /** CLI queue ID from result.caseQueue, not a question directory name. */
  caseId?: string;
  maxCases?: number;
  datasetCount?: number;
  caseCount?: number;
  casesPerDataset?: number;
  /** Omit to keep active plugins; [] selects only the required Web/base bundles. */
  plugins?: string[];
  stopAfterCase?: boolean;
  /** Only for the fixture target. It does not disable real Planner/Judge calls. */
  fixtureBehavior?: 'success' | 'bad-output' | 'insufficient-probe' | 'reset-mismatch';
}
export interface Job {
  schema: 'evaldock.workbench.job/v1';
  id: string; runId: string; action: Action; targetId: string; request: StartJob;
  state: JobState; createdAt: string; startedAt?: string; endedAt?: string; cancelRequestedAt?: string;
  exitCode: number | null; signal: string | null;
  sequence: number; eventsTruncated: boolean; outputTruncated?: boolean;
  summary: Record<string, unknown> | null; warnings: string[];
  recoveryNote?: string; links: {self:string;events:string;cancel:string;result:string};
}
export interface JobEvent {sequence:number;time:string;kind:'state'|'stdout'|'stderr'|'error'|'warning';text:string;}
export interface JobResult {
  summary: Record<string,unknown> | null;
  inspection: Record<string,unknown> | null;
  evaluationPlan: Record<string,unknown> | null;
  caseQueue: {datasetId:string;caseIndex:number;caseId:string}[];
  warnings:string[];
}
export interface Capabilities {
  version:'v1';cliBuilt:boolean;actions:Action[];progress:'CLI_LOGS_AND_FINAL_SUMMARY';
  executeFrozenPlan:false;selectDatasetIds:false;selectLabelIds:false;
  caseSelection:'FILTERS_PLANNER_QUEUE';cancel:'SIGINT_GRACEFUL';forceKill:false;
  judgeMode:string;actualWebTargetConfigured:boolean;apiConcurrentJobLimit:number;caseConcurrency:number;
}
export interface Target {
  id:string;name:string;fixture:boolean;descriptor:Record<string,unknown>|null;warnings:string[];error:string|null;
}
export interface RunItem {store:string;agentId:string;runId:string;status:string;createdAt?:string|null;links?:{self:string};}
export class WorkbenchClient {
  constructor(options:{baseUrl?:string;token:string;fetchImpl?:typeof fetch});
  request(path:string,options?:{method?:string;body?:unknown;signal?:AbortSignal}):Promise<unknown>;
  capabilities():Promise<Capabilities>;
  dsh():Promise<Record<string,unknown>>;
  controlDsh(action:'start'|'stop'|'restart'):Promise<Record<string,unknown>>;
  selectPlugins(plugins:string[]):Promise<Record<string,unknown>>;
  searchPlugins(q:string):Promise<{items:Record<string,unknown>[]}>;
  targets():Promise<{items:Target[]}>;
  catalog():Promise<{labels:Record<string,unknown>[];datasets:{directory:string;cases:Record<string,unknown>[]}[];catalogMarkdown:string;selectionMode:string;note:string}>;
  start(input:StartJob):Promise<Job>;
  job(id:string):Promise<Job>;
  result(id:string):Promise<JobResult>;
  events(id:string,after?:number):Promise<{items:JobEvent[];nextCursor:number;gap:boolean;state:JobState}>;
  cancel(id:string):Promise<Job>;
  jobs(offset?:number,limit?:number):Promise<{items:Job[];total:number}>;
  runs(offset?:number,limit?:number):Promise<{items:RunItem[];total:number}>;
  run(store:string,agent:string,run:string):Promise<{summary:Record<string,unknown>|null;caseIds:string[]}>;
  caseReport(store:string,agent:string,run:string,caseId:string):Promise<Record<string,unknown>>;
  file(apiPath:string):Promise<string>;
}
