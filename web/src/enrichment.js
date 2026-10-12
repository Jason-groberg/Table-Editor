import { COLUMNS, domain, text } from './processor.js';
import { searchDomain, isArizona } from './business-search.js';
export const BUSINESS_FIELDS = ['company name','Company domain','phone','address','city','State','zip'];
const normalized = value => text(value).toLowerCase().replace(/[^a-z0-9]/g,'');
const companyKey = value => normalized(text(value).replace(/\b(incorporated|corporation|limited|inc|corp|llc|ltd)\.?$/i,''));
export function lookupInput(row) {
  return {company:row.values['company name'],domain:searchDomain(row.values),address:row.values.address,city:row.values.city,state:'AZ',zip:row.values.zip};
}
export function selectMatch(row, candidates) {
  const preferredDomain = searchDomain(row.values);
  const matches = candidates.filter(candidate => {
    if (!isArizona(candidate)) return false;
    if (preferredDomain) {
      if (domain(candidate.values['Company domain']) !== preferredDomain) return false;
    } else if (!companyKey(row.values['company name']) || companyKey(candidate.name)!==companyKey(row.values['company name'])) return false;
    // An exact business/domain match must also agree with any supplied location.
    for (const key of ['address','city','State','zip']) {
      if (!text(row.values[key])) continue;
      const a = key==='State' && normalized(row.values[key])==='arizona'?'az':normalized(row.values[key]);
      const b = key==='State' && normalized(candidate.values[key])==='arizona'?'az':normalized(candidate.values[key]);
      if (!b || a!==b) return false;
    }
    return true;
  });
  return matches.length===1?matches[0]:null;
}
export function fillMissing(row, candidate) {
  let count=0;
  for (const field of BUSINESS_FIELDS) {
    if (!text(row.values[field]) && text(field==='company name'?candidate.name:candidate.values[field])) {row.values[field]=text(field==='company name'?candidate.name:candidate.values[field]);count++;}
  }
  return count;
}
export function delay(ms, signal) {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(new DOMException('Cancelled','AbortError'));return;}
    const abort=()=>{clearTimeout(timer);reject(new DOMException('Cancelled','AbortError'));};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
    signal?.addEventListener('abort',abort,{once:true});
  });
}
// Run short requests in the browser so the batch cannot hit a function timeout.
// Pace below the server's 20/minute per-IP limit; reuse duplicate queries.
export async function enrichRows(rows, lookup, {signal,onProgress=()=>{},wait=delay,interval=3200}={}) {
  const cache=new Map();let lastRequest=0;let unavailable='';
  const summary={processed:0,filled:0,matched:0,review:0,failed:0};
  for(const row of rows){
    if(signal?.aborted)break;
    if(!COLUMNS.some(field=>!text(row.values[field]))){row.enrichment={status:'complete',message:'All information already supplied.'};}
    else if(!text(row.values['company name']) && !searchDomain(row.values)){row.enrichment={status:'review',message:'No business name or custom domain for business lookup; missing values left blank.'};summary.review++;}
    else {
      try {
        if(unavailable)throw new Error(unavailable);
        const input=lookupInput(row);const key=JSON.stringify(Object.values(input).map(value=>text(value).toLowerCase()));
        let result=cache.get(key);
        if(!result){
          if(lastRequest)await wait(Math.max(0,interval-(Date.now()-lastRequest)),signal);
          if(signal?.aborted)break;
          lastRequest=Date.now();
          try { result=await lookup(input,signal); }
          catch(error){
            if(error.status!==429)throw error;
            onProgress({...summary,waiting:true});
            await wait(61000,signal);
            if(signal?.aborted)break;
            lastRequest=Date.now();result=await lookup(input,signal);
          }
          cache.set(key,result);
        }
        if(signal?.aborted)break;
        const match=selectMatch(row,result.candidates || []);
        if(match){
          const count=fillMissing(row,match);summary.filled+=count;summary.matched++;
          row.enrichment={status:'matched',message:`Google Maps: ${match.name}; ${count} missing fields filled.`,candidate:match};
        }else {summary.review++;row.enrichment={status:'review',message:'No unambiguous business/location match; missing values left blank. Use Find business details to review matches.'};}
      }catch(error){
        if(signal?.aborted || error.name==='AbortError')break;
        summary.failed++;row.enrichment={status:'failed',message:`Lookup unavailable; missing values left blank. ${error.message}`};
        // Do not repeatedly call an endpoint that needs credentials/configuration.
        if([401,403,503].includes(error.status))unavailable=error.message;
      }
    }
    summary.processed++;onProgress({...summary});
  }
  return {...summary,cancelled:!!signal?.aborted};
}
