"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const express=require("express");
const {buildBudgetSearchQuery,createItemsRouter}=require("../items");

test("budget search validates inclusive budget boundaries and locks comparisons to a rental unit",()=>{
  const search=buildBudgetSearchQuery({minPrice:"100",maxPrice:"250",pricingUnit:"day"});
  assert.equal(search.error,undefined);
  assert.match(search.sql,/\)?>=\?/);
  assert.match(search.sql,/\)?<=\?/);
  assert.match(search.sql,/i\.pricing_unit=\?/);
  assert.ok(search.values.includes(100));assert.ok(search.values.includes(250));assert.ok(search.values.includes("day"));
  assert.equal(buildBudgetSearchQuery({minPrice:"250",maxPrice:"100",pricingUnit:"day"}).error,"Minimum budget cannot exceed maximum budget.");
  assert.match(buildBudgetSearchQuery({maxPrice:"100"}).error,/Choose a rental price unit/);
  assert.match(buildBudgetSearchQuery({maxPrice:"-1",pricingUnit:"week"}).error,/valid budget/);
});

test("budget query combines category, location, text, duration, availability, and pagination safely",()=>{
  const search=buildBudgetSearchQuery({q:"camera",location:"Yaba, Lagos",category:"Electronics",pricingUnit:"week",minPrice:"1000",maxPrice:"5000",duration:"2",availabilityStart:"2035-05-01T10:00:00.000Z",sort:"price_asc",page:"3",pageSize:"12"});
  assert.equal(search.error,undefined);
  assert.match(search.sql,/i\.category=\?/);assert.match(search.sql,/LOWER\(i\.city\) LIKE \? AND LOWER\(i\.state\) LIKE \?/);
  assert.match(search.sql,/LOWER\(i\.name\) LIKE \? OR LOWER\(i\.description\) LIKE \?/);
  assert.match(search.sql,/pd\.min_period<=\? AND pd\.max_period>=\?/);
  assert.match(search.sql,/SUM\(r\.inventory_quantity\)/);
  assert.match(search.sql,/r\.status IN \('confirmed','active'\)/);
  assert.match(search.sql,/r\.status='pending_payment'.*checkout_expires_at/s);
  assert.match(search.sql,/ORDER BY COALESCE\(\(SELECT ipo\.price/);assert.match(search.sql,/LIMIT \? OFFSET \?/);
  assert.equal(search.page,3);assert.equal(search.pageSize,12);assert.equal(search.values.at(-2),13);assert.equal(search.values.at(-1),24);
  assert.ok(search.values.includes("Electronics"));assert.ok(search.values.includes("week"));assert.ok(search.values.includes(1000));assert.ok(search.values.includes(5000));
});

test("search rejects unavailable units, invalid categories, duration, dates, and sort values",()=>{
  assert.equal(buildBudgetSearchQuery({pricingUnit:"month"}).error,undefined);
  assert.match(buildBudgetSearchQuery({category:"Unknown"}).error,/valid category/);
  assert.match(buildBudgetSearchQuery({duration:"0",pricingUnit:"hour"}).error,/duration/);
  assert.match(buildBudgetSearchQuery({availabilityStart:"tomorrow",pricingUnit:"day"}).error,/availability date/);
  assert.match(buildBudgetSearchQuery({sort:"random"}).error,/sort order/);
});

async function startSearchServer(t, rows) {
  const calls=[];
  const app=express();app.use("/api/items",createItemsRouter({pool:{execute:async(sql,values)=>{calls.push({sql,values});return [rows];}},authenticate:(_req,_res,next)=>next()}));
  const server=await new Promise(resolve=>{const instance=app.listen(0,"127.0.0.1",()=>resolve(instance));});
  t.after(()=>{server.closeAllConnections();server.close();});
  return {server,getCall:()=>calls[0]};
}

const row=id=>({id,owner_id:7,name:`Listing ${id}`,category:"Electronics",item_condition:"Good",price:"200.00",pricing_unit:"day",min_period:1,max_period:3,deposit:"0.00",delivery_fee:"0.00",paused:0});

test("server search paginates matching results and reports when more are available",async t=>{
  const {server,getCall}=await startSearchServer(t,[row(1),row(2),row(3)]);
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/items/search?maxPrice=200&pricingUnit=day&pageSize=2`);
  const body=await response.json();assert.equal(response.status,200);assert.deepEqual(body.items.map(item=>item.id),["1","2"]);assert.equal(body.hasMore,true);assert.equal(body.appliedBudget.max,200);assert.match(getCall().sql,/\)?<=\?/);
});

test("server search returns an honest empty result page",async t=>{
  const {server}=await startSearchServer(t,[]);
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/items/search?minPrice=100&pricingUnit=week`);
  const body=await response.json();assert.equal(response.status,200);assert.deepEqual(body.items,[]);assert.equal(body.hasMore,false);
});

test("server rejects incompatible or invalid budget query before running SQL",async t=>{
  const {server,getCall}=await startSearchServer(t,[]);
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/items/search?minPrice=5`);
  assert.equal(response.status,400);assert.match((await response.json()).error,/price unit/);assert.equal(getCall(),undefined);
});
