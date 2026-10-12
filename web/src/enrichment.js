import { COLUMNS, domain, text } from './processor.js';
import { searchDomain, isArizona, buildSearchQuery } from './business-search.js';
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
// Four workers share a start-rate limiter and in-flight query cache.
// At 600ms between starts, batches stay below the server's 120/minute limit.
export async function enrichRows(rows, lookup, {signal,onProgress=()=>{},wait=delay,interval=600,concurrency=4}={}) {
  const cache=new Map();let lastRequest=0;let unavailable='';let nextRow=0;
  let scheduling=Promise.resolve();
  const summary={processed:0,filled:0,matched:0,review:0,failed:0};
  const checkActive=()=>{if(signal?.aborted)throw new DOMException('Cancelled','AbortError');};
  function scheduledLookup(input) {
    // Reserve starts sequentially, then let the requests themselves overlap.
    const permit=scheduling.then(async()=>{
      checkActive();
      if(lastRequest)await wait(Math.max(0,interval-(Date.now()-lastRequest)),signal);
      checkActive();
      if(unavailable)throw new Error(unavailable);
      lastRequest=Date.now();
    });
    scheduling=permit.catch(()=>{});
    return permit.then(()=>lookup(input,signal)).catch(error=>{
      if([401,403,503].includes(error.status))unavailable=error.message;
      throw error;
    });
  }
  function cachedLookup(input) {
    const key=buildSearchQuery(input).toLowerCase();
    if(!cache.has(key)){
      const result=(async()=>{
        try{return await scheduledLookup(input);}
        catch(error){
          if(error.status!==429)throw error;
          onProgress({...summary,waiting:true});
          await wait(61000,signal);checkActive();
          return scheduledLookup(input);
        }
      })();
      // Store the promise before another worker can schedule the same query.
      cache.set(key,result);
    }
    return cache.get(key);
  }
  async function processRow(row) {
    if(!COLUMNS.some(field=>!text(row.values[field]))){row.enrichment={status:'complete',message:'All information already supplied.'};}
    else if(!text(row.values['company name']) && !searchDomain(row.values)){row.enrichment={status:'review',message:'No business name or custom domain for business lookup; missing values left blank.'};summary.review++;}
    else {
      try {
        checkActive();
        if(unavailable)throw new Error(unavailable);
        const result=await cachedLookup(lookupInput(row));
        checkActive();
        const match=selectMatch(row,result.candidates || []);
        if(match){
          const count=fillMissing(row,match);summary.filled+=count;summary.matched++;
          row.enrichment={status:'matched',message:`Google Maps: ${match.name}; ${count} missing fields filled.`,candidate:match};
        }else {summary.review++;row.enrichment={status:'review',message:'No unambiguous business/location match; missing values left blank. Use Find business details to review matches.'};}
      }catch(error){
        if(signal?.aborted || error.name==='AbortError')return;
        summary.failed++;row.enrichment={status:'failed',message:`Lookup unavailable; missing values left blank. ${error.message}`};
      }
    }
    if(signal?.aborted)return;
    summary.processed++;onProgress({...summary});
  }
  async function worker() {
    while(!signal?.aborted && nextRow<rows.length){
      const row=rows[nextRow++];await processRow(row);
    }
  }
  const workerCount=Math.min(rows.length,Math.max(1,Math.min(4,Math.floor(concurrency)||1)));
  await Promise.all(Array.from({length:workerCount},worker));
  return {...summary,cancelled:!!signal?.aborted};
}
