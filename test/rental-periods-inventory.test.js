"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {addUnits,hasInventoryCapacity,calculateRentalSubtotalKobo}=require("../rentals");

test("rental periods calculate hourly, daily, weekly, monthly, and yearly end dates",()=>{
  const start=new Date("2032-01-31T12:00:00.000Z");
  assert.equal(addUnits(start,"hour",2).toISOString(),"2032-01-31T14:00:00.000Z");
  assert.equal(addUnits(start,"day",1).toISOString(),"2032-02-01T12:00:00.000Z");
  assert.equal(addUnits(start,"week",1).toISOString(),"2032-02-07T12:00:00.000Z");
  assert.equal(addUnits(start,"month",1).toISOString(),"2032-02-29T12:00:00.000Z");
  assert.equal(addUnits(start,"year",1).toISOString(),"2033-01-31T12:00:00.000Z");
});

test("inventory capacity allows partial room bookings and rejects overbooking",()=>{
  assert.equal(hasInventoryCapacity(8,3,2,3),true);
  assert.equal(hasInventoryCapacity(8,3,2,4),false);
  assert.equal(hasInventoryCapacity(1,1,0,1),false);
  assert.equal(hasInventoryCapacity(4,0,0,4),true);
});

test("checkout subtotal uses the selected rate duration and room quantity within processor limits",()=>{
  assert.equal(calculateRentalSubtotalKobo(125000,3,2),750000);
  assert.equal(calculateRentalSubtotalKobo(10000,0,1),null);
  assert.equal(calculateRentalSubtotalKobo(999999999999,2,1),null);
});
