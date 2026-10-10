// Explicit dependency injection for unrelated pipeline tests. Never exposed by CLI/config.
export const fixtureCompatibilityService={acquire:async()=>async()=>{},ensure:async()=>({status:'COMPATIBLE',fixture:true}),verify:async()=>{},validate:()=>[],quarantine:async()=>{},invalidate:async()=>{}};
