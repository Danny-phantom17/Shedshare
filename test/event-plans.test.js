"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const express=require("express");
const {eventSchema,addHours,createEventPlansRouter}=require("../event-plans");

const valid={eventType:"Wedding",location:"Ikeja, Lagos",startAt:"2030-05-10T10:00:00.000Z",durationHours:8,budget:250000,itemIds:["10","11"]};
test("event request accepts a custom collection across several listings",()=>{
  const parsed=eventSchema.safeParse(valid);assert.equal(parsed.success,true);assert.equal(parsed.data.itemIds.length,2);
});
test("event request rejects duplicate listings and invalid durations",()=>{
  assert.equal(eventSchema.safeParse({...valid,itemIds:["10","10"]}).success,false);
  assert.equal(eventSchema.safeParse({...valid,durationHours:0}).success,false);
  assert.equal(eventSchema.safeParse({...valid,durationHours:745}).success,false);
});
test("event end time uses the selected number of hours",()=>{
  assert.equal(addHours(new Date("2030-05-10T10:00:00.000Z"),8).toISOString(),"2030-05-10T18:00:00.000Z");
});

test("event inventory query excludes unapproved listings and checks manual availability blocks",async t=>{
  let sqlSeen="";const app=express();app.use("/api",createEventPlansRouter({pool:{execute:async sql=>{sqlSeen=sql;return [[]];}},authenticate:(req,_res,next)=>{req.user={id:"2",emailVerified:true};next();}}));const server=await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s));});t.after(()=>{server.closeAllConnections();server.close();});const response=await fetch(`http://127.0.0.1:${server.address().port}/api/event-inventory?startAt=2030-05-10T10%3A00%3A00.000Z&endAt=2030-05-10T18%3A00%3A00.000Z`);assert.equal(response.status,200);assert.match(sqlSeen,/i\.moderation_status='approved'/);assert.match(sqlSeen,/item_availability_blocks/);
});

test("event request rejects a listing hidden for moderation even when the client submits its id",async t=>{
  const connection={beginTransaction:async()=>{},rollback:async()=>{},commit:async()=>{},release:()=>{},execute:async sql=>sql.includes("SELECT id,owner_id,name,category,price,pricing_unit,min_period,max_period,paused,moderation_status FROM items")?[[{id:10,owner_id:8,name:"Chairs",category:"Events",price:1000,pricing_unit:"day",min_period:1,max_period:2,paused:0,moderation_status:"pending_review"}]]:[]};const app=express();app.use(express.json());app.use("/api",createEventPlansRouter({pool:{getConnection:async()=>connection},authenticate:(req,_res,next)=>{req.user={id:"2",emailVerified:true};next();}}));const server=await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s));});t.after(()=>{server.closeAllConnections();server.close();});const response=await fetch(`http://127.0.0.1:${server.address().port}/api/event-plans`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...valid,itemIds:["10"]})});assert.equal(response.status,409);assert.match((await response.json()).error,/not publicly available/);
});
