import test from 'node:test';
import assert from 'node:assert/strict';
import {authenticated,issueSession,sessionCookie,readJSON} from '../server/security.js';
import session from '../netlify/functions/session.js';
import lookup from '../netlify/functions/lookup.js';
process.env.APP_PASSWORD='a-long-test-password-only';process.env.SESSION_SECRET='test-secret-at-least-thirty-two-characters';
const request=(method='GET',body,origin='https://example.netlify.app',token)=>new Request('https://example.netlify.app/.netlify/functions/session',{method,headers:{origin,'content-type':'application/json',...(token?{cookie:sessionCookie(token)}:{})},...(body?{body:JSON.stringify(body)}:{})});
test('session verifies signature, expiry, cookie protections, and password rotation',()=>{
  const now=Date.now(), token=issueSession(now);assert.equal(authenticated(request('GET',null,undefined,token),now),true);
  assert.equal(authenticated(request('GET',null,undefined,token+'x'),now),false);
  assert.equal(authenticated(request('GET',null,undefined,token),now+9*3600000),false);
  assert.match(sessionCookie(token),/HttpOnly; Secure; SameSite=Strict/);
  const old=process.env.APP_PASSWORD;process.env.APP_PASSWORD='rotated-password-for-tests';assert.equal(authenticated(request('GET',null,undefined,token),now),false);process.env.APP_PASSWORD=old;
});
test('login requires correct password and same origin; password query parameter does not authenticate',async()=>{
  assert.equal((await session(request('POST',{password:'incorrect'}))).status,401);
  assert.equal((await session(request('POST',{password:process.env.APP_PASSWORD},'https://evil.example'))).status,403);
  const response=await session(request('POST',{password:process.env.APP_PASSWORD}));assert.equal(response.status,200);assert.ok(response.headers.get('set-cookie'));
  const query=new Request('https://example.netlify.app/.netlify/functions/session?pwd='+process.env.APP_PASSWORD);assert.equal((await (await session(query)).json()).authenticated,false);
});
test('logout expires the cookie; oversized input is rejected',async()=>{
  const response=await session(request('DELETE'));assert.match(response.headers.get('set-cookie'),/Max-Age=0/);
  await assert.rejects(readJSON(request('POST',{password:'a'.repeat(5000)})),/too large/);
});
test('business lookup rejects unauthenticated access and cross-origin requests',async()=>{
  assert.equal((await lookup(request('POST',{company:'Acme'}))).status,401);
  assert.equal((await lookup(request('POST',{company:'Acme'},'https://evil.example',issueSession()))).status,403);
});
test('misconfigured auth fails closed',async()=>{
  const old=process.env.SESSION_SECRET;delete process.env.SESSION_SECRET;assert.equal((await session(request())).status,503);process.env.SESSION_SECRET=old;
});
test('lookup returns review candidates, honors the input state, and hides upstream errors',async()=>{
  const originalFetch=globalThis.fetch;const originalKey=process.env.GOOGLE_API_KEY;process.env.GOOGLE_API_KEY='test-only-key';
  try{
    globalThis.fetch=async(url,options)=>{
      assert.equal(url,'https://places.googleapis.com/v1/places:searchText');assert.equal(JSON.parse(options.body).textQuery,'Acme Denver CO');
      return new Response(JSON.stringify({places:[{displayName:{text:'Acme'},websiteUri:'https://www.example.com/about',nationalPhoneNumber:'555-0100',addressComponents:[{types:['locality'],longText:'Denver'},{types:['administrative_area_level_1'],shortText:'CO'}]}]}),{status:200});
    };
    const response=await lookup(request('POST',{company:'Acme',city:'Denver',state:'CO'},undefined,issueSession()));
    assert.equal(response.status,200);const data=await response.json();assert.equal(data.candidates[0].values.State,'CO');assert.equal(data.candidates[0].values['Company domain'],'example.com');
    globalThis.fetch=async()=>{throw new Error('secret upstream detail');};
    const error=await lookup(request('POST',{company:'Acme'},undefined,issueSession()));assert.equal(error.status,502);assert.ok(!(await error.text()).includes('secret upstream detail'));
  }finally{globalThis.fetch=originalFetch;if(originalKey===undefined)delete process.env.GOOGLE_API_KEY;else process.env.GOOGLE_API_KEY=originalKey;}
});
