import { authenticated, configured, equal, issueSession, json, readJSON, sameOrigin, sessionCookie } from '../../server/security.js';
export default async function handler(request) {
  if (!configured()) return json({error:'An administrator must configure access before this app can be used.'}, 503);
  if (request.method === 'GET') return json({authenticated:authenticated(request)});
  if (!['POST','DELETE'].includes(request.method)) return json({error:'Method not allowed'},405, {Allow:'GET, POST, DELETE'});
  if (!sameOrigin(request)) return json({error:'Request origin not allowed'},403);
  if (request.method === 'DELETE') return json({authenticated:false},200, {'Set-Cookie':sessionCookie('')});
  try {
    const body = await readJSON(request);
    if (typeof body.password !== 'string' || body.password.length > 1024 || !equal(body.password, process.env.APP_PASSWORD)) return json({error:'Password incorrect'},401);
    return json({authenticated:true},200,{'Set-Cookie':sessionCookie(issueSession())});
  } catch { return json({error:'Invalid login request'},400); }
}
export const config = {rateLimit:{action:'rate_limit', windowLimit:10, windowSize:60, aggregateBy:['ip','domain']}};
