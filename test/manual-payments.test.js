"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const express=require("express");
const {createManualPaymentsRouter}=require("../manual-payments");

async function fixture(t){
  const state={status:"awaiting_payment",rentalStatus:"pending_payment",confirmedBy:null,events:[],notifications:[],scheduleUpdates:0};
  const installment={id:1,rental_id:41,agreement_id:9,installment_number:1,amount:10000,currency:"NGN",due_at:new Date(Date.now()+3600000),status:state.status,bank_name:"Test Bank",account_name:"Lister Name",account_number:"0123456789",transfer_reference:null,transfer_at:null,renter_note:null,reported_at:null,confirmed_at:null,confirmed_by:null,rejection_reason:null,owner_id:10,renter_id:20,rental_status:"pending_payment",subtotal:100,platform_fee_percent:10};
  const connection={beginTransaction:async()=>{},commit:async()=>{},rollback:async()=>{},release:()=>{},execute:async(sql,values=[])=>{
    if(sql.startsWith("SELECT status FROM rentals WHERE id=? FOR UPDATE"))return [[{status:state.rentalStatus}],[]];
    if(sql.includes("SELECT i.*,r.renter_id,r.owner_id,r.status rental_status"))return [[{...installment,status:state.status,rental_status:state.rentalStatus,confirmed_by:state.confirmedBy}],[]];
    if(sql.includes("SELECT i.*,r.renter_id,r.owner_id,r.id rental_id"))return [[{...installment,status:state.status,rental_id:41,confirmed_by:state.confirmedBy}],[]];
    if(sql.startsWith("UPDATE rental_manual_installments SET status='payment_reported'")){state.status="payment_reported";return [{affectedRows:1},[]];}
    if(sql.startsWith("UPDATE rental_manual_installments SET status='confirmed'")){if(state.status!=="payment_reported")return [{affectedRows:0},[]];state.status="confirmed";state.confirmedBy=values[0];return [{affectedRows:1},[]];}
    if(sql.startsWith("UPDATE rental_manual_installments SET status='rejected'")){state.status="rejected";return [{affectedRows:1},[]];}
    if(sql.startsWith("INSERT INTO rental_manual_payment_events")){const type=sql.includes("'reported'")?"reported":sql.includes("'confirmed'")?"confirmed":"rejected";state.events.push({type,actor:values[1]});return [{insertId:state.events.length},[]];}
    if(sql.startsWith("SELECT COUNT(*) count FROM rental_manual_installments"))return [[{count:state.status==="confirmed"?0:1}],[]];
    if(sql.startsWith("UPDATE rentals SET status='confirmed'")){state.rentalStatus="confirmed";return [{affectedRows:1},[]];}
    if(sql.startsWith("INSERT INTO notifications")){state.notifications.push(values);return [{insertId:1},[]];}
    throw new Error(`Unexpected transaction SQL: ${sql}`);
  }};
  const pool={getConnection:async()=>connection,execute:async(sql,values=[])=>{
    if(sql.startsWith("UPDATE rental_manual_installments SET status='awaiting_payment'")){state.scheduleUpdates++;return [{affectedRows:0},[]];}
    if(sql.startsWith("UPDATE rental_manual_installments SET status='overdue'"))return [{affectedRows:0},[]];
    if(sql.startsWith("SELECT id,owner_id,renter_id,item_name,subtotal,platform_fee_percent,status,agreement_version FROM rentals"))return [String(values[1])==="10"||String(values[2])==="10"||String(values[1])==="20"||String(values[2])==="20"? [{id:41,owner_id:10,renter_id:20,item_name:"Camera",subtotal:100,platform_fee_percent:10,status:state.rentalStatus,agreement_version:"3"}] : [],[]];
    if(sql.startsWith("SELECT i.id,i.installment_number"))return [[{...installment,status:state.status,confirmed_by:state.confirmedBy,transfer_reference:state.status==="payment_reported"?"BANK-REF":null,reported_at:state.status==="payment_reported"?new Date():null,confirmed_at:state.status==="confirmed"?new Date():null,confirmer_name:state.confirmedBy?"Lister":null}],[]];
    if(sql.startsWith("SELECT e.installment_id"))return [state.events.map(e=>({installment_id:1,actor_id:e.actor,event_type:e.type,note:null,created_at:new Date(),actor_name:"Participant"})),[]];
    throw new Error(`Unexpected SQL: ${sql}`);
  }};
  const app=express();app.use(express.json());app.use("/api/manual-payments",createManualPaymentsRouter({pool,authenticate:(req,_res,next)=>{req.user={id:req.header("x-user-id")||"20",isAdmin:req.header("x-admin")==="true"};next();}}));const server=await new Promise(resolve=>{const instance=app.listen(0,"127.0.0.1",()=>resolve(instance));});t.after(()=>{server.closeAllConnections();server.close();});return {server,state};
}
async function request(server,path,{method="GET",user="20",admin=false,body}={}){return fetch(`http://127.0.0.1:${server.address().port}/api/manual-payments${path}`,{method,headers:{"content-type":"application/json","x-user-id":user,"x-admin":String(admin),Connection:"close"},...(body?{body:JSON.stringify(body)}:{})});}

test("renter transfer reports remain unconfirmed until the lister verifies receipt",async t=>{
  const {server,state}=await fixture(t);
  const outsider=await request(server,"/installments/1/report",{method:"POST",user:"30",body:{transferReference:"BANK-REF"}});assert.equal(outsider.status,403);
  const report=await request(server,"/installments/1/report",{method:"POST",body:{transferReference:"BANK-REF"}});assert.equal(report.status,200);assert.equal(state.status,"payment_reported");assert.equal(state.rentalStatus,"pending_payment");
  const duplicateReport=await request(server,"/installments/1/report",{method:"POST",body:{transferReference:"BANK-REF"}});assert.equal(duplicateReport.status,200);assert.equal((await duplicateReport.json()).idempotent,true);assert.equal(state.events.length,1);assert.equal(state.notifications.length,1);
  const summary=await request(server,"/rentals/41");const view=await summary.json();assert.equal(view.confirmedAmount,0);assert.equal(view.reportedAmount,100);assert.equal(view.paymentStatus,"payment_confirmation_pending");
  const renterConfirm=await request(server,"/installments/1/decision",{method:"POST",body:{action:"confirm"}});assert.equal(renterConfirm.status,403);assert.equal(state.status,"payment_reported");
  const listerConfirm=await request(server,"/installments/1/decision",{method:"POST",user:"10",body:{action:"confirm"}});assert.equal(listerConfirm.status,200);assert.equal(state.status,"confirmed");assert.equal(state.rentalStatus,"confirmed");
  const duplicate=await request(server,"/installments/1/decision",{method:"POST",user:"10",body:{action:"confirm"}});assert.equal(duplicate.status,409);assert.equal(state.events.length,2);
});

test("rejected transfers require a reason and remain retryable",async t=>{
  const {server,state}=await fixture(t);await request(server,"/installments/1/report",{method:"POST",body:{transferReference:"bad-ref"}});
  const bad=await request(server,"/installments/1/decision",{method:"POST",user:"10",body:{action:"reject",reason:"no"}});assert.equal(bad.status,400);assert.equal(state.status,"payment_reported");
  const rejected=await request(server,"/installments/1/decision",{method:"POST",user:"10",body:{action:"reject",reason:"No matching deposit arrived."}});assert.equal(rejected.status,200);assert.equal(state.status,"rejected");
});

test("outsiders cannot trigger payment schedule updates and cancelled bookings cannot confirm reports",async t=>{
  const {server,state}=await fixture(t);
  const outsider=await request(server,"/rentals/41",{user:"30"});assert.equal(outsider.status,404);assert.equal(state.scheduleUpdates,0);
  await request(server,"/installments/1/report",{method:"POST",body:{transferReference:"BANK-REF"}});
  state.rentalStatus="cancelled";
  const decision=await request(server,"/installments/1/decision",{method:"POST",user:"10",body:{action:"confirm"}});assert.equal(decision.status,409);assert.equal(state.status,"payment_reported");
});

test("a disputed booking cannot accept a new manual transfer report",async t=>{
  const {server,state}=await fixture(t);state.rentalStatus="disputed";
  const response=await request(server,"/installments/1/report",{method:"POST",body:{transferReference:"BANK-REF"}});
  assert.equal(response.status,409);assert.equal(state.status,"awaiting_payment");assert.equal(state.events.length,0);
});
