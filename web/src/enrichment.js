import { COLUMNS, domain, text } from './processor.js';
import { searchDomain, emailBusinessDomain, isArizona, buildSearchQuery } from './business-search.js';
export const BUSINESS_FIELDS = ['company name','Company domain','phone','address','city','State','zip'];
const normalized = value => text(value).toLowerCase().replace(/[^a-z0-9]/g,'');
const companyKey = value => normalized(text(value).replace(/\b(incorporated|corporation|limited|inc|corp|llc|ltd)\.?$/i,''));
export function lookupInput(row) {
  return {company:row.values['company name'],domain:searchDomain(row.values),address:row.values.address,city:row.values.city,state:'AZ',zip:row.values.zip};
}
const STREET_WORDS = {north:'n',south:'s',east:'e',west:'w',street:'st',avenue:'ave',av:'ave',road:'rd',drive:'dr',boulevard:'blvd',lane:'ln',court:'ct',circle:'cir',parkway:'pkwy',highway:'hwy',place:'pl',terrace:'ter',trail:'trl'};
export function streetKey(value) {
  return text(value).toLowerCase()
    .replace(/(?:\b(?:suite|ste|unit|apt|apartment|floor|fl)\b\.?|#)\s*[a-z0-9-]+.*$/i,'')
    .replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(Boolean)
    .map(word=>STREET_WORDS[word] || word).join('');
}
function sameDomain(a,b) {
  const left=domain(a),right=domain(b);
  return !!left && !!right && (left===right || left.endsWith(`.${right}`) || right.endsWith(`.${left}`));
}
export function selectMatch(row, candidates) {
  const preferredDomain = searchDomain(row.values);
  const matches = candidates.filter(candidate => {
    if (!isArizona(candidate)) return false;
    const nameMatches=!!companyKey(row.values['company name']) && companyKey(candidate.name)===companyKey(row.values['company name']);
    const addressGiven=!!text(row.values.address);
    const addressMatches=addressGiven && !!streetKey(row.values.address) && streetKey(row.values.address)===streetKey(candidate.values.address);
    // Domain is preferred, but Google may omit a website or return a brand's
    // alternate domain. Exact business name plus the street confirms that branch.
    if(preferredDomain){
      if(!sameDomain(preferredDomain,candidate.values['Company domain']) && !(nameMatches && addressMatches))return false;
    }else if(!nameMatches)return false;
    if(addressGiven && !addressMatches)return false;
    for (const key of ['city','State','zip']) {
      if (!text(row.values[key])) continue;
      const normalize = value=>key==='zip'?text(value).split('-')[0]:key==='State' && normalized(value)==='arizona'?'az':normalized(value);
      const a=normalize(row.values[key]),b=normalize(candidate.values[key]);
      if(!b || a!==b)return false;
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
    // This information is already present in the input; Google is not needed.
    const inferred=emailBusinessDomain(row.values.email);
    if(!text(row.values['Company domain']) && inferred){
      row.values['Company domain']=inferred;row.domainSource='Company domain copied from the supplied business email.';summary.filled++;
    }
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
        }else {summary.review++;row.enrichment={status:'review',message:result.candidates?.length ? `${result.candidates.length} Google matches returned, but business or location could not be confirmed uniquely. Missing values left blank.` : 'Google returned no Arizona business matches. Missing values left blank.'};}
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
