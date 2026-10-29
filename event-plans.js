"use strict";

const express = require("express");
const { z } = require("zod");

const id = z.string().regex(/^\d+$/);
const unitHours = { hour: 1, day: 24, week: 168 };
const eventTypes = ["Birthday", "Wedding", "Conference", "Community gathering", "Concert", "Graduation", "Other"];
const eventSchema = z.object({
  eventType: z.enum(eventTypes), location: z.string().trim().min(2).max(255),
  startAt: z.string().datetime(), durationHours: z.number().int().min(1).max(24 * 31),
  budget: z.number().finite().min(0).max(9999999999.99),
  itemIds: z.array(id).min(1).max(30).refine(rows => new Set(rows).size === rows.length, "Choose each listing only once.")
}).strict();

function addHours(date, hours) { return new Date(date.getTime() + hours * 3600000); }
function sqlDate(date) { return date.toISOString().slice(0, 19).replace("T", " "); }
function createEventPlansRouter({ pool, authenticate }) {
  const router = express.Router();

  router.get("/event-inventory", authenticate, async (req, res) => {
    const start = new Date(String(req.query.startAt || "")), end = new Date(String(req.query.endAt || ""));
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return res.status(400).json({ error: "Choose a valid event date and duration first." });
    try {
      const [rows] = await pool.execute(`SELECT i.id,i.name,i.category,i.price,i.pricing_unit,i.min_period,i.max_period,i.location,i.image,i.owner_id,u.name owner_name,i.delivery_available,i.rider_delivery_available,i.delivery_fee,
        CASE WHEN i.paused=FALSE AND i.moderation_status='approved'
          AND (SELECT COALESCE(SUM(r.inventory_quantity),0) FROM rentals r WHERE r.item_id=i.id AND (r.status IN ('confirmed','active') OR (r.status='pending_payment' AND COALESCE(r.checkout_expires_at,DATE_ADD(r.created_at,INTERVAL 30 MINUTE))>UTC_TIMESTAMP())) AND r.start_at<? AND r.end_at>?)
            + (SELECT COALESCE(SUM(COALESCE(b.quantity,i.available_quantity)),0) FROM item_availability_blocks b WHERE b.item_id=i.id AND b.start_at<? AND b.end_at>?) < i.available_quantity
          THEN TRUE ELSE FALSE END AS available
        FROM items i JOIN users u ON u.id=i.owner_id WHERE i.paused=FALSE AND i.moderation_status='approved' AND i.category IN ('Events','Outdoor','Kitchen','Electronics','Music','Home & Furniture','Tools & Equipment') ORDER BY i.category,i.name LIMIT 300`, [sqlDate(end), sqlDate(start),sqlDate(end),sqlDate(start)]);
      return res.json(rows.map(row => ({ id:String(row.id), name:row.name, category:row.category, price:Number(row.price), pricingUnit:row.pricing_unit, minPeriod:Number(row.min_period), maxPeriod:Number(row.max_period), location:row.location, image:row.image||"", ownerId:String(row.owner_id), ownerName:row.owner_name, available:Boolean(row.available), deliveryAvailable:Boolean(row.delivery_available), riderDeliveryAvailable:Boolean(row.rider_delivery_available), deliveryFee:Number(row.delivery_fee||0) })));
    } catch (error) { console.error("Loading event inventory failed:", error.message); return res.status(500).json({ error:"Unable to load event inventory." }); }
  });

  router.get("/event-plans", authenticate, async (req, res) => {
    try {
      const [rows] = await pool.execute(`SELECT p.id,p.renter_id,p.event_type,p.event_location,p.event_start,p.event_end,p.estimated_budget,p.status,p.created_at,
        pi.id plan_item_id,pi.item_id,pi.owner_id,pi.requested_quantity,pi.estimated_subtotal,pi.status item_status,pi.response_note,pi.responded_at,i.name item_name,i.category,i.image,u.name owner_name,r.name renter_name
        FROM event_plans p JOIN event_plan_items pi ON pi.event_plan_id=p.id JOIN items i ON i.id=pi.item_id JOIN users u ON u.id=pi.owner_id JOIN users r ON r.id=p.renter_id
        WHERE p.renter_id=? OR pi.owner_id=? ORDER BY p.created_at DESC,pi.id`, [req.user.id,req.user.id]);
      const plans = new Map();
      for (const row of rows) { const key=String(row.id); if(!plans.has(key))plans.set(key,{id:key,renterId:String(row.renter_id),renterName:row.renter_name,eventType:row.event_type,location:row.event_location,startAt:new Date(row.event_start).toISOString(),endAt:new Date(row.event_end).toISOString(),budget:Number(row.estimated_budget),status:row.status,createdAt:new Date(row.created_at).toISOString(),items:[]}); plans.get(key).items.push({id:String(row.plan_item_id),itemId:String(row.item_id),ownerId:String(row.owner_id),ownerName:row.owner_name,name:row.item_name,category:row.category,image:row.image||"",quantity:Number(row.requested_quantity),estimatedSubtotal:Number(row.estimated_subtotal),status:row.item_status,note:row.response_note,respondedAt:row.responded_at?new Date(row.responded_at).toISOString():null}); }
      return res.json([...plans.values()]);
    } catch (error) { console.error("Loading event plans failed:",error.message); return res.status(500).json({error:"Unable to load event plans."}); }
  });

  router.post("/event-plans", authenticate, async (req,res) => {
    const parsed=eventSchema.safeParse(req.body);if(!parsed.success)return res.status(400).json({error:parsed.error.issues[0]?.message||"Check your event details."});if(!req.user.emailVerified)return res.status(403).json({error:"Verify your email before requesting event rentals."});
    const data=parsed.data,start=new Date(data.startAt),end=addHours(start,data.durationHours);if(start<=new Date())return res.status(400).json({error:"Choose a future event date."});
    const connection=await pool.getConnection();try{await connection.beginTransaction();const [listings]=await connection.execute(`SELECT id,owner_id,name,category,price,pricing_unit,min_period,max_period,paused,moderation_status FROM items WHERE id IN (${data.itemIds.map(()=>"?").join(",")}) ORDER BY id FOR UPDATE`,data.itemIds);
      if(listings.length!==data.itemIds.length){await connection.rollback();return res.status(404).json({error:"One or more selected listings are no longer available."});}
      const estimates=[];
      for(const item of listings){if(String(item.owner_id)===String(req.user.id)){await connection.rollback();return res.status(400).json({error:"Remove your own listing from the event collection."});}if(item.paused||item.moderation_status!=="approved"){await connection.rollback();return res.status(409).json({error:`${item.name} is not publicly available.`});}const units=Math.ceil(data.durationHours/unitHours[item.pricing_unit]);if(units<Number(item.min_period)||units>Number(item.max_period)){await connection.rollback();return res.status(400).json({error:`${item.name} does not support the selected event duration.`});}const [conflict]=await connection.execute(`SELECT id FROM rentals WHERE item_id=? AND (status IN ('confirmed','active') OR (status='pending_payment' AND COALESCE(checkout_expires_at,DATE_ADD(created_at,INTERVAL 30 MINUTE))>UTC_TIMESTAMP())) AND start_at<? AND end_at>? LIMIT 1 FOR UPDATE`,[item.id,sqlDate(end),sqlDate(start)]);if(conflict.length){await connection.rollback();return res.status(409).json({error:`${item.name} is unavailable for those dates. Refresh inventory and choose another listing.`});}estimates.push({item,units,subtotal:Number((Number(item.price)*units).toFixed(2))});}
      const [created]=await connection.execute("INSERT INTO event_plans(renter_id,event_type,event_location,event_start,event_end,estimated_budget) VALUES(?,?,?,?,?,?)",[req.user.id,data.eventType,data.location,sqlDate(start),sqlDate(end),data.budget]);
      for(const line of estimates){await connection.execute("INSERT INTO event_plan_items(event_plan_id,item_id,owner_id,requested_quantity,estimated_subtotal) VALUES(?,?,?,1,?)",[created.insertId,line.item.id,line.item.owner_id,line.subtotal]);await connection.execute("INSERT INTO notifications(user_id,type,message,related_id) VALUES (?,'event_rental_request',?,?)",[line.item.owner_id,`A renter requested ${line.item.name} for a ${data.eventType.toLowerCase()} event. Review the dates and respond to the request.`,created.insertId]);}
      await connection.commit();return res.status(201).json({id:String(created.insertId),status:"requested",itemCount:estimates.length,estimatedSubtotal:estimates.reduce((sum,row)=>sum+row.subtotal,0),message:"Requests sent separately to each listing owner. This plan does not reserve availability or start payment."});
    }catch(error){await connection.rollback();console.error("Creating event plan failed:",error.message);return res.status(500).json({error:"Unable to submit the event rental requests."});}finally{connection.release();}
  });

  router.post("/event-plans/:planId/items/:planItemId/respond",authenticate,async(req,res)=>{
    const planId=id.safeParse(req.params.planId),planItemId=id.safeParse(req.params.planItemId),body=z.object({action:z.enum(["accept","reject"]),note:z.string().trim().max(1000).optional().default("")}).strict().safeParse(req.body);if(!planId.success||!planItemId.success||!body.success)return res.status(400).json({error:"Invalid event request response."});
    const c=await pool.getConnection();try{await c.beginTransaction();const [rows]=await c.execute("SELECT pi.*,p.renter_id,p.event_start,p.event_end,p.status plan_status,i.name FROM event_plan_items pi JOIN event_plans p ON p.id=pi.event_plan_id JOIN items i ON i.id=pi.item_id WHERE p.id=? AND pi.id=? FOR UPDATE",[planId.data,planItemId.data]);if(!rows.length){await c.rollback();return res.status(404).json({error:"Event request not found."});}const line=rows[0];if(String(line.owner_id)!==String(req.user.id)){await c.rollback();return res.status(403).json({error:"Only this listing's owner can respond."});}if(line.plan_status==="cancelled"||line.status!=="requested"){await c.rollback();return res.status(409).json({error:"This request is no longer pending."});}
      if(body.data.action==="accept"){const [conflict]=await c.execute(`SELECT id FROM rentals WHERE item_id=? AND (status IN ('confirmed','active') OR (status='pending_payment' AND COALESCE(checkout_expires_at,DATE_ADD(created_at,INTERVAL 30 MINUTE))>UTC_TIMESTAMP())) AND start_at<? AND end_at>? LIMIT 1 FOR UPDATE`,[line.item_id,line.event_end,line.event_start]);if(conflict.length){await c.rollback();return res.status(409).json({error:"The listing has since been booked for those dates. Decline this event request."});}}
      const status=body.data.action==="accept"?"accepted":"rejected";await c.execute("UPDATE event_plan_items SET status=?,response_note=?,responded_at=UTC_TIMESTAMP() WHERE id=? AND status='requested'",[status,body.data.note||null,line.id]);const [remaining]=await c.execute("SELECT COUNT(*) count_pending,COUNT(*) count_all FROM event_plan_items WHERE event_plan_id=? AND status='requested'",[planId.data]);const next=Number(remaining[0].count_pending)===0?"responded":"partially_responded";await c.execute("UPDATE event_plans SET status=? WHERE id=? AND status<>'cancelled'",[next,planId.data]);await c.execute("INSERT INTO notifications(user_id,type,message,related_id) VALUES (?,?,?,?)",[line.renter_id,"event_rental_response",`${line.name}: the lister ${status} your event request. An accepted response is not a reservation; complete the listing's usual agreement and checkout.`,planId.data]);await c.commit();return res.json({status,planStatus:next,requiresSeparateAgreement:true});
    }catch(error){await c.rollback();console.error("Responding to event request failed:",error.message);return res.status(500).json({error:"Unable to respond to event request."});}finally{c.release();}
  });

  router.post("/event-plans/:id/cancel",authenticate,async(req,res)=>{const planId=id.safeParse(req.params.id);if(!planId.success)return res.status(400).json({error:"Invalid event plan."});try{const c=await pool.getConnection();try{await c.beginTransaction();const [rows]=await c.execute("SELECT id,renter_id,status FROM event_plans WHERE id=? FOR UPDATE",[planId.data]);if(!rows.length){await c.rollback();return res.status(404).json({error:"Event plan not found."});}if(String(rows[0].renter_id)!==String(req.user.id)){await c.rollback();return res.status(403).json({error:"Only the renter can cancel this event plan."});}if(rows[0].status==="cancelled"){await c.rollback();return res.json({status:"cancelled"});}const [owners]=await c.execute("SELECT DISTINCT owner_id FROM event_plan_items WHERE event_plan_id=? AND status IN ('requested','accepted')",[planId.data]);await c.execute("UPDATE event_plans SET status='cancelled' WHERE id=?",[planId.data]);await c.execute("UPDATE event_plan_items SET status='cancelled' WHERE event_plan_id=? AND status IN ('requested','accepted')",[planId.data]);for(const owner of owners)await c.execute("INSERT INTO notifications(user_id,type,message,related_id) VALUES (?,'event_rental_cancelled','The renter cancelled an event rental request.',?)",[owner.owner_id,planId.data]);await c.commit();return res.json({status:"cancelled"});}finally{c.release();}}catch(error){console.error("Cancelling event plan failed:",error.message);return res.status(500).json({error:"Unable to cancel event plan."});}});

  return router;
}
module.exports={createEventPlansRouter,eventTypes,eventSchema,addHours};
