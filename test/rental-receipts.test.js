"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const express=require("express");
const {createRentalsRouter}=require("../rentals");

const rental={id:41,item_name:"PA speaker",owner_id:7,renter_id:9,price_per_unit:12000,units:2,inventory_quantity:1,pricing_unit:"day",start_at:"2026-10-20T00:00:00.000Z",end_at:"2026-10-22T00:00:00.000Z",subtotal:24000,total:26500,deposit:0,informational_deposit:0,delivery_method:"pickup",delivery_fee:0,platform_fee_percent:5,platform_fee:1200,owner_payout:22800,payment_reference:"ref-12345678",payment_verified_at:"2026-10-19T12:00:00.000Z",status:"completed",agreement_terms:{pricingUnit:"day"},agreement_version:"v2",owner_name:"Lister",renter_name:"Renter"};
async function start(t,userId,row=rental){const pool={execute:async()=>[[row && [7,9].includes(Number(userId))?row:null].filter(Boolean)]};const app=express();app.use("/api",createRentalsRouter({pool,authenticate:(req,_res,next)=>{req.user={id:String(userId)};next();}}));const server=await new Promise(resolve=>{const s=app.listen(0,"127.0.0.1",()=>resolve(s));});t.after(()=>{server.closeAllConnections();server.close();});return `http://127.0.0.1:${server.address().port}/api/rentals/41/receipt`;}

test("both rental parties can download a receipt for a verified transaction",async t=>{for(const party of [7,9]){const response=await fetch(await start(t,party));assert.equal(response.status,200);const body=await response.json();assert.equal(body.receiptNumber,"SS-41-12345678");assert.equal(body.itemName,"PA speaker");assert.equal(body.rentalSubtotal,24000);assert.equal(body.platformFee,1200);assert.equal(body.agreementVersion,"v2");}});
test("receipt endpoint hides another user's rental and requires verified payment",async t=>{let response=await fetch(await start(t,11));assert.equal(response.status,404);response=await fetch(await start(t,7,{...rental,payment_verified_at:null}));assert.equal(response.status,409);});
