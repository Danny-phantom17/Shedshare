"use strict";

const express=require("express");
const rateLimit=require("express-rate-limit");
const {z}=require("zod");

const idSchema=z.string().regex(/^\d+$/);
const rating=z.number().int().min(1).max(5);
const reviewBody=z.object({overallRating:rating,communicationRating:rating,accuracyRating:rating.optional(),reliabilityRating:rating,fulfillmentRating:rating,body:z.string().trim().min(20).max(2000)}).strict();
const reportBody=z.object({reason:z.enum(["abusive","fraudulent","irrelevant","private_information","other"]),details:z.string().trim().min(10).max(1000)}).strict();

function trustSummary(row,role,reviews=[]){
  const prefix=role==="lister"?"lister":"renter";
  const average=row[`${prefix}_average_rating`];
  return {
    role,
    account:{emailVerified:Number(row.email_verified)===1,verificationLabel:Number(row.email_verified)===1?"Email verified":"Email not verified"},
    completedVerifiedRentals:Number(row[`${prefix}_completed_rentals`]||0),
    averageRating:average==null?null:Number(Number(average).toFixed(2)),
    reviewCount:Number(row[`${prefix}_review_count`]||0),
    categoryAverages:{communication:row[`${prefix}_communication_rating`]==null?null:Number(Number(row[`${prefix}_communication_rating`]).toFixed(2)),accuracy:row[`${prefix}_accuracy_rating`]==null?null:Number(Number(row[`${prefix}_accuracy_rating`]).toFixed(2)),reliability:row[`${prefix}_reliability_rating`]==null?null:Number(Number(row[`${prefix}_reliability_rating`]).toFixed(2)),fulfillment:row[`${prefix}_fulfillment_rating`]==null?null:Number(Number(row[`${prefix}_fulfillment_rating`]).toFixed(2))},
    reviews:reviews.map(review=>({id:String(review.id),rating:Number(review.overall_rating),communication:Number(review.communication_rating),accuracy:review.accuracy_rating==null?null:Number(review.accuracy_rating),reliability:Number(review.reliability_rating),fulfillment:Number(review.fulfillment_rating),body:review.body,itemName:review.item_name,createdAt:new Date(review.created_at).toISOString(),verifiedRental:true,authorRole:review.target_role==="lister"?"renter":"lister"}))
  };
}

function createRentalTrustRouter({pool,authenticate}){
  const router=express.Router();
  const reviewLimiter=rateLimit({windowMs:60*60_000,limit:5,standardHeaders:"draft-8",legacyHeaders:false,keyGenerator:req=>String(req.user.id),message:{error:"You have submitted several rental reviews recently. Try again later."}});
  const reportLimiter=rateLimit({windowMs:60*60_000,limit:5,standardHeaders:"draft-8",legacyHeaders:false,keyGenerator:req=>String(req.user.id),message:{error:"You have submitted several review reports recently. Try again later."}});

  async function loadSummary(userId,role){
    const other=role==="lister"?"renter":"lister",userRentalColumn=role==="lister"?"owner_id":"renter_id";
    const [rows]=await pool.execute(`SELECT u.email_verified,
      (SELECT COUNT(*) FROM rentals r WHERE r.${userRentalColumn}=u.id AND r.status='completed' AND (r.payment_verified_at IS NOT NULL OR EXISTS(SELECT 1 FROM rental_manual_installments mi WHERE mi.rental_id=r.id GROUP BY mi.rental_id HAVING COUNT(*)=SUM(mi.status='confirmed'))) AND r.safety_hold=FALSE) AS ${role}_completed_rentals,
      (SELECT AVG(rv.overall_rating) FROM rental_party_reviews rv WHERE rv.target_user_id=u.id AND rv.target_role=? AND rv.status='approved') AS ${role}_average_rating,
      (SELECT COUNT(*) FROM rental_party_reviews rv WHERE rv.target_user_id=u.id AND rv.target_role=? AND rv.status='approved') AS ${role}_review_count,
      (SELECT AVG(rv.communication_rating) FROM rental_party_reviews rv WHERE rv.target_user_id=u.id AND rv.target_role=? AND rv.status='approved') AS ${role}_communication_rating,
      (SELECT AVG(rv.accuracy_rating) FROM rental_party_reviews rv WHERE rv.target_user_id=u.id AND rv.target_role=? AND rv.status='approved') AS ${role}_accuracy_rating,
      (SELECT AVG(rv.reliability_rating) FROM rental_party_reviews rv WHERE rv.target_user_id=u.id AND rv.target_role=? AND rv.status='approved') AS ${role}_reliability_rating,
      (SELECT AVG(rv.fulfillment_rating) FROM rental_party_reviews rv WHERE rv.target_user_id=u.id AND rv.target_role=? AND rv.status='approved') AS ${role}_fulfillment_rating
      FROM users u WHERE u.id=? LIMIT 1`,[role,role,role,role,role,role,userId]);
    if(!rows.length)return null;
    const [reviews]=await pool.execute(`SELECT rv.id,rv.target_role,rv.overall_rating,rv.communication_rating,rv.accuracy_rating,rv.reliability_rating,rv.fulfillment_rating,rv.body,rv.created_at,r.item_name FROM rental_party_reviews rv JOIN rentals r ON r.id=rv.rental_id WHERE rv.target_user_id=? AND rv.target_role=? AND rv.status='approved' ORDER BY rv.created_at DESC,rv.id DESC LIMIT 30`,[userId,role]);
    return trustSummary(rows[0],role,reviews);
  }

  router.get("/listers/:id",async(req,res)=>{
    const id=idSchema.safeParse(req.params.id);if(!id.success)return res.status(400).json({error:"Invalid lister."});
    try{const [listings]=await pool.execute("SELECT id FROM items WHERE owner_id=? LIMIT 1",[id.data]);if(!listings.length)return res.status(404).json({error:"Lister profile not found."});const lister=await loadSummary(id.data,"lister");return res.json({lister});}
    catch(error){console.error("Loading lister trust profile failed:",error.message);return res.status(500).json({error:"Unable to load lister trust profile."});}
  });

  router.get("/renters/:id",authenticate,async(req,res)=>{
    const id=idSchema.safeParse(req.params.id);if(!id.success)return res.status(400).json({error:"Invalid renter."});
    try{const [access]=await pool.execute("SELECT id FROM rentals WHERE owner_id=? AND renter_id=? LIMIT 1",[req.user.id,id.data]);if(!access.length)return res.status(403).json({error:"Renter trust information is available only to listers who have a rental record with this renter."});const [renter,lister]=await Promise.all([loadSummary(id.data,"renter"),loadSummary(id.data,"lister")]);return res.json({renter,lister});}
    catch(error){console.error("Loading renter trust profile failed:",error.message);return res.status(500).json({error:"Unable to load renter trust profile."});}
  });

  router.get("/rentals",authenticate,async(req,res)=>{
    try{const [rows]=await pool.execute(`SELECT r.id,r.item_name,r.status,r.payment_verified_at,r.safety_hold,r.owner_id,r.renter_id,EXISTS(SELECT 1 FROM rental_manual_installments mi WHERE mi.rental_id=r.id GROUP BY mi.rental_id HAVING COUNT(*)=SUM(mi.status='confirmed')) manual_payment_confirmed,
      IF(r.renter_id=?, 'lister','renter') AS target_role,target.email_verified AS target_email_verified,
      (SELECT COUNT(*) FROM rentals tr WHERE ((r.renter_id=? AND tr.owner_id=target.id) OR (r.owner_id=? AND tr.renter_id=target.id)) AND tr.status='completed' AND (tr.payment_verified_at IS NOT NULL OR EXISTS(SELECT 1 FROM rental_manual_installments mi WHERE mi.rental_id=tr.id GROUP BY mi.rental_id HAVING COUNT(*)=SUM(mi.status='confirmed'))) AND tr.safety_hold=FALSE) AS target_completed_rentals,
      (SELECT AVG(rv2.overall_rating) FROM rental_party_reviews rv2 WHERE rv2.target_user_id=target.id AND rv2.target_role=IF(r.renter_id=?, 'lister','renter') AND rv2.status='approved') AS target_average_rating,
      (SELECT COUNT(*) FROM rental_party_reviews rv3 WHERE rv3.target_user_id=target.id AND rv3.target_role=IF(r.renter_id=?, 'lister','renter') AND rv3.status='approved') AS target_review_count,
      owner.name AS owner_name,renter.name AS renter_name,rv.id AS review_id,rv.status AS review_status
      FROM rentals r JOIN users owner ON owner.id=r.owner_id JOIN users renter ON renter.id=r.renter_id
      JOIN users target ON target.id=IF(r.renter_id=?,r.owner_id,r.renter_id)
      LEFT JOIN rental_party_reviews rv ON rv.rental_id=r.id AND rv.author_id=?
      WHERE (r.renter_id=? OR r.owner_id=?) AND ((r.status='completed' AND (r.payment_verified_at IS NOT NULL OR EXISTS(SELECT 1 FROM rental_manual_installments mi WHERE mi.rental_id=r.id GROUP BY mi.rental_id HAVING COUNT(*)=SUM(mi.status='confirmed'))) AND r.safety_hold=FALSE) OR rv.id IS NOT NULL)
      ORDER BY r.return_at DESC,r.id DESC LIMIT 500`,[req.user.id,req.user.id,req.user.id,req.user.id,req.user.id,req.user.id,req.user.id,req.user.id,req.user.id]);
      return res.json(rows.map(row=>({rentalId:String(row.id),itemName:row.item_name,targetRole:row.target_role,targetUserId:String(row.target_role==="lister"?row.owner_id:row.renter_id),targetName:row.target_role==="lister"?row.owner_name:row.renter_name,targetTrust:{emailVerified:Number(row.target_email_verified)===1,completedVerifiedRentals:Number(row.target_completed_rentals||0),averageRating:Number(row.target_review_count)>0?Number(Number(row.target_average_rating).toFixed(2)):null,reviewCount:Number(row.target_review_count||0)},verifiedRental:(Boolean(row.payment_verified_at)||Boolean(row.manual_payment_confirmed))&&row.status==="completed",eligible:row.status==="completed"&&(Boolean(row.payment_verified_at)||Boolean(row.manual_payment_confirmed))&&Number(row.safety_hold)!==1,reviewId:row.review_id==null?null:String(row.review_id),reviewStatus:row.review_status||null})));}
    catch(error){console.error("Loading eligible rental reviews failed:",error.message);return res.status(500).json({error:"Unable to load review eligibility."});}
  });

  router.post("/rentals/:id/reviews",authenticate,reviewLimiter,async(req,res)=>{
    const id=idSchema.safeParse(req.params.id),parsed=reviewBody.safeParse(req.body);if(!id.success||!parsed.success)return res.status(400).json({error:!id.success?"Invalid rental.":parsed.error.issues[0]?.message||"Enter a valid rental review."});
    const connection=await pool.getConnection();
    try{await connection.beginTransaction();const [rows]=await connection.execute("SELECT id,owner_id,renter_id,status,payment_verified_at,safety_hold FROM rentals WHERE id=? FOR UPDATE",[id.data]);if(!rows.length){await connection.rollback();return res.status(404).json({error:"Rental not found."});}const rental=rows[0];let paymentComplete=Boolean(rental.payment_verified_at);if(!paymentComplete&&rental.status==="completed"&&!rental.safety_hold){const [manualRows]=await connection.execute("SELECT COUNT(*) count,SUM(status='confirmed') confirmed FROM rental_manual_installments WHERE rental_id=?",[id.data]);paymentComplete=Number(manualRows[0]?.count)>0&&Number(manualRows[0].count)===Number(manualRows[0].confirmed);}const author=String(req.user.id),asRenter=String(rental.renter_id)===author,asLister=String(rental.owner_id)===author;if(!asRenter&&!asLister){await connection.rollback();return res.status(403).json({error:"Only a renter or lister in this rental can leave a review."});}if(rental.status!=="completed"||!paymentComplete||Number(rental.safety_hold)===1){await connection.rollback();return res.status(409).json({error:"Reviews are available only after a completed, payment-verified rental without an active safety hold."});}const targetRole=asRenter?"lister":"renter",targetUserId=asRenter?rental.owner_id:rental.renter_id;if(targetRole==="lister"&&!parsed.data.accuracyRating){await connection.rollback();return res.status(400).json({error:"Rate item accuracy from 1 to 5 for a lister review."});}if(targetRole==="renter"&&parsed.data.accuracyRating!==undefined){await connection.rollback();return res.status(400).json({error:"Item accuracy applies only when reviewing a lister."});}
      const [existing]=await connection.execute("SELECT id FROM rental_party_reviews WHERE rental_id=? AND author_id=? LIMIT 1 FOR UPDATE",[id.data,req.user.id]);if(existing.length){await connection.rollback();return res.status(409).json({error:"You have already submitted a review for this rental."});}
      const [insert]=await connection.execute("INSERT INTO rental_party_reviews(rental_id,author_id,target_user_id,target_role,overall_rating,communication_rating,accuracy_rating,reliability_rating,fulfillment_rating,body,status) VALUES(?,?,?,?,?,?,?,?,?,?,'pending')",[id.data,req.user.id,targetUserId,targetRole,parsed.data.overallRating,parsed.data.communicationRating,parsed.data.accuracyRating??null,parsed.data.reliabilityRating,parsed.data.fulfillmentRating,parsed.data.body]);
      await connection.execute("INSERT INTO notifications(user_id,type,message,related_id) SELECT id,'rental_review_pending','A rental review is awaiting trust and safety moderation.',? FROM users WHERE is_admin=TRUE OR trust_role IN ('super_admin','trust_and_safety')",[insert.insertId]);
      await connection.commit();return res.status(201).json({id:String(insert.insertId),status:"pending",message:"Review submitted for moderation. It will appear on the profile only if approved."});
    }catch(error){await connection.rollback();if(error.code==="ER_DUP_ENTRY")return res.status(409).json({error:"You have already submitted a review for this rental."});console.error("Submitting rental review failed:",error.message);return res.status(500).json({error:"Unable to submit your rental review."});}finally{connection.release();}
  });

  router.post("/reviews/:id/reports",authenticate,reportLimiter,async(req,res)=>{
    const id=idSchema.safeParse(req.params.id),parsed=reportBody.safeParse(req.body);if(!id.success||!parsed.success)return res.status(400).json({error:!id.success?"Invalid review.":parsed.error.issues[0]?.message||"Describe the review concern."});
    try{const [reviews]=await pool.execute("SELECT id,author_id FROM rental_party_reviews WHERE id=? AND status='approved' LIMIT 1",[id.data]);if(!reviews.length)return res.status(404).json({error:"Published review not found."});if(String(reviews[0].author_id)===String(req.user.id))return res.status(403).json({error:"You cannot report your own review."});const [result]=await pool.execute("INSERT INTO rental_party_review_reports(review_id,reporter_id,reason,details) VALUES(?,?,?,?)",[id.data,req.user.id,parsed.data.reason,parsed.data.details]);await pool.execute("INSERT INTO notifications(user_id,type,message,related_id) SELECT id,'rental_review_report','A rental review was reported for moderation.',? FROM users WHERE is_admin=TRUE OR trust_role IN ('super_admin','trust_and_safety')",[result.insertId]);return res.status(201).json({id:String(result.insertId),status:"open",message:"Report sent to ShedShare trust and safety."});}
    catch(error){if(error.code==="ER_DUP_ENTRY")return res.status(409).json({error:"You have already reported this review."});console.error("Reporting rental review failed:",error.message);return res.status(500).json({error:"Unable to report this review."});}
  });
  return router;
}

module.exports={createRentalTrustRouter,trustSummary,reviewBody,reportBody};
