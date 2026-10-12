import test from 'node:test';
import assert from 'node:assert/strict';
import { emailBusinessDomain, searchDomain, buildSearchQuery } from '../web/src/business-search.js';
test('ignores personal email providers and malformed emails',()=>{
  for(const email of ['a@gmail.com','a@outlook.com','a@yahoo.com','a@cox.net','a@proton.me','a@icloud.com','invalid','a@b@acme.example'])assert.equal(emailBusinessDomain(email),'');
  assert.equal(emailBusinessDomain('owner@Acme.Example'),'acme.example');
});
test('searches by custom email domain then existing domain then business name with Arizona',()=>{
  assert.equal(searchDomain({email:'a@acme.example','Company domain':'other.example'}),'acme.example');
  assert.equal(searchDomain({email:'a@gmail.com','Company domain':'www.acme.example'}),'acme.example');
  assert.equal(buildSearchQuery({domain:'acme.example',company:'Other',address:'123 Main St',city:'Phoenix',zip:'85001',state:'CO'}),'acme.example 123 Main St Phoenix 85001 Arizona');
  assert.equal(buildSearchQuery({company:'Acme'}),'Acme in Arizona');
  assert.equal(buildSearchQuery({domain:'acme.example'}),'acme.example in Arizona');
});
