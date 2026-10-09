import { authenticated, json, readJSON, sameOrigin } from '../../server/security.js';
import { domain } from '../../web/src/processor.js';
export default async function handler(request) {
  if (request.method !== 'POST') return json({error:'Method not allowed'},405,{Allow:'POST'});
  if (!sameOrigin(request)) return json({error:'Request origin not allowed'},403);
  if (!authenticated(request)) return json({error:'Please sign in again.'},401);
  if (!process.env.GOOGLE_API_KEY) return json({error:'Business lookup is not configured. You can still enter missing details manually.'},503);
  let body;
  try {
    body = await readJSON(request);
    if (!body || !['company','address','city','state','zip'].every(key=> body[key] === undefined || (typeof body[key] === 'string' && body[key].length <= 250)) || !body.company?.trim()) throw new Error();
  } catch { return json({error:'Enter a company name and valid location fields.'},400); }
  try {
    const result = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method:'POST', signal:AbortSignal.timeout(10000),
      headers:{'Content-Type':'application/json', 'X-Goog-Api-Key':process.env.GOOGLE_API_KEY,
        'X-Goog-FieldMask':'places.displayName,places.formattedAddress,places.websiteUri,places.nationalPhoneNumber,places.addressComponents,places.googleMapsUri,places.attributions'},
      body:JSON.stringify({textQuery:[body.company,body.address,body.city,body.state,body.zip].filter(Boolean).join(' '),pageSize:3}),
    });
    if (!result.ok) return json({error:'Business lookup is unavailable. Check the API configuration or try again later.'},502);
    const data = await result.json();
    return json({candidates:(data.places || []).slice(0,3).map(place=> {
      const part = (type, short=false) => {const c = place.addressComponents?.find(c=>c.types?.includes(type)); return c?.[short?'shortText':'longText'] || '';};
      return {name:place.displayName?.text || '', address:place.formattedAddress || '', maps:place.googleMapsUri || '',
        attributions:place.attributions || [], values:{'Company domain':domain(place.websiteUri), phone:place.nationalPhoneNumber || '',
          address:[part('street_number'),part('route')].filter(Boolean).join(' '), city:part('locality') || part('postal_town'),
          State:part('administrative_area_level_1',true), zip:part('postal_code')}};
    })});
  } catch { return json({error:'Business lookup timed out or failed. Your imported data has not changed.'},502); }
}
export const config = {rateLimit:{action:'rate_limit', windowLimit:20, windowSize:60, aggregateBy:['ip','domain']}};
