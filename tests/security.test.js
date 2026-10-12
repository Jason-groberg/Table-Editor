import test from 'node:test';
import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import {authenticated,issueSession,sessionCookie,readJSON} from '../server/security.js';
import session from '../netlify/functions/session.js';
import lookup from '../netlify/functions/lookup.js';
process.env.APP_PASSWORD='a-long-test-password-only';process.env.SESSION_SECRET='test-secret-at-least-thirty-two-characters';
const request=(method='GET',body,origin='https://example.netlify.app',token)=>new Request('https://example.netlify.app/.netlify/functions/session',{method,headers:{origin,'content-type':'application/json',...(token?{cookie:sessionCookie(token)}:{})},...(body?{body:JSON.stringify(body)}:{})});
test('session has no time expiry and retains signature, cookie and rotation protections',()=>{
  const now=Date.now(), token=issueSession(now);assert.equal(authenticated(request('GET',null,undefined,token),now),true);
  assert.equal(authenticated(request('GET',null,undefined,token+'x'),now),false);
  assert.equal(authenticated(request('GET',null,undefined,token),now+9*3600000),true);
  const expires = now + 30 * 24 * 3600000;
  assert.equal(authenticated(request('GET',null,undefined,token),expires-1),true);
  assert.equal(authenticated(request('GET',null,undefined,token),expires),true);
  assert.match(sessionCookie(token),/HttpOnly; Secure; SameSite=Strict/);
  assert.match(sessionCookie(token),/Max-Age=34560000$/);
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
test('lookup returns review candidates, restricts results to Arizona, and hides upstream errors',async()=>{
  const originalFetch=globalThis.fetch;const originalKey=process.env.GOOGLE_API_KEY;process.env.GOOGLE_API_KEY='test-only-key';
  try{
    globalThis.fetch=async(url,options)=>{
      assert.equal(url,'https://places.googleapis.com/v1/places:searchText');assert.equal(JSON.parse(options.body).textQuery,'Acme Phoenix Arizona');
      return new Response(JSON.stringify({places:[{displayName:{text:'Acme'},websiteUri:'https://www.example.com/about',nationalPhoneNumber:'555-0100',addressComponents:[{types:['locality'],longText:'Phoenix'},{types:['administrative_area_level_1'],shortText:'AZ'}]}]}),{status:200});
    };
    const response=await lookup(request('POST',{company:'Acme',city:'Phoenix',state:'AZ'},undefined,issueSession()));
    assert.equal(response.status,200);const data=await response.json();assert.equal(data.candidates[0].values.State,'AZ');assert.equal(data.candidates[0].values['Company domain'],'example.com');
    globalThis.fetch=async()=>{throw new Error('secret upstream detail');};
    const error=await lookup(request('POST',{company:'Acme'},undefined,issueSession()));assert.equal(error.status,502);assert.ok(!(await error.text()).includes('secret upstream detail'));
  }finally{globalThis.fetch=originalFetch;if(originalKey===undefined)delete process.env.GOOGLE_API_KEY;else process.env.GOOGLE_API_KEY=originalKey;}
});

test('session remains valid years later; returning visitors renew their cookie',async()=>{
  const token=issueSession();
  assert.equal(authenticated(request('GET',null,undefined,token),Date.now()+10*365*86400000),true);
  const response=await session(request('GET',null,undefined,token));
  assert.equal((await response.json()).authenticated,true);
  assert.match(response.headers.get('set-cookie'),/Max-Age=34560000$/);
  assert.equal((await session(request())).headers.get('set-cookie'),null);
  const old=process.env.SESSION_SECRET;
  try {process.env.SESSION_SECRET='another-secret-at-least-thirty-two-characters';assert.equal(authenticated(request('GET',null,undefined,token)),false);}
  finally {process.env.SESSION_SECRET=old;}
});
test('upgrades valid legacy sessions but rejects expired legacy sessions',async()=>{
  const legacy=(expires)=>{
    const payload=Buffer.from(JSON.stringify({expires,nonce:'a'.repeat(32)})).toString('base64url');
    const signature=createHmac('sha256',process.env.SESSION_SECRET).update(`${process.env.APP_PASSWORD}\0${payload}`).digest('base64url');
    return `${payload}.${signature}`;
  };
  const response=await session(request('GET',null,undefined,legacy(Date.now()+60000)));
  assert.equal((await response.json()).authenticated,true);
  const cookie=response.headers.get('set-cookie');
  const token=cookie.split(';')[0].split('=')[1];
  assert.equal(JSON.parse(Buffer.from(token.split('.')[0],'base64url')).version,2);
  const expired=await session(request('GET',null,undefined,legacy(Date.now()-1)));
  assert.equal((await expired.json()).authenticated,false);
  assert.equal(expired.headers.get('set-cookie'),null);
});
test('domain search uses the address, makes one Google call, and removes non-Arizona candidates',async()=>{
  const oldFetch=globalThis.fetch;const oldKey=process.env.GOOGLE_API_KEY;process.env.GOOGLE_API_KEY='test-only-key';let calls=0;
  try {
    globalThis.fetch=async(url,options)=>{
      calls++;assert.equal(JSON.parse(options.body).textQuery,'acme.example 123 Main St Arizona');
      const place=state=>({displayName:{text:'Acme'},websiteUri:'https://acme.example',addressComponents:[{types:['administrative_area_level_1'],shortText:state}]});
      return new Response(JSON.stringify({places:[place('CO'),place('AZ')]}),{status:200});
    };
    const response=await lookup(request('POST',{domain:'acme.example',address:'123 Main St'},undefined,issueSession()));
    assert.equal(response.status,200);const data=await response.json();assert.equal(calls,1);assert.equal(data.candidates.length,1);assert.equal(data.candidates[0].values.State,'AZ');
  } finally {globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.GOOGLE_API_KEY;else process.env.GOOGLE_API_KEY=oldKey;}
});
test('Google permission errors expose safe diagnostic codes without leaking its raw message',async()=>{
  const oldFetch=globalThis.fetch,oldKey=process.env.GOOGLE_API_KEY;process.env.GOOGLE_API_KEY='test-only-key';
  try {
    globalThis.fetch=async()=>new Response(JSON.stringify({error:{status:'PERMISSION_DENIED',message:'secret request detail'}}),{status:403});
    const response=await lookup(request('POST',{company:'Acme'},undefined,issueSession()));const data=await response.json();
    assert.equal(response.status,502);assert.match(data.error,/403 PERMISSION_DENIED/);assert.ok(!data.error.includes('secret request detail'));
  }finally{globalThis.fetch=oldFetch;if(oldKey===undefined)delete process.env.GOOGLE_API_KEY;else process.env.GOOGLE_API_KEY=oldKey;}
});
