"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");
const crypto = require("node:crypto");
const { z } = require("zod");
const searchConfig = require("./external-search-config");

const memoryCache = new Map();
const leadTokens = new Map();
const TTL_MS = searchConfig.cacheTtlHours * 60 * 60 * 1000;
const normal = value => value.trim().replace(/\s+/g," ").toLocaleLowerCase("en-NG");
function makeKey(item,city,state){return crypto.createHash("sha256").update([normal(item),normal(city),normal(state)].join("|"),"utf8").digest("hex");}
function createExternalSearchRouter({pool,authenticate,placesKey,enabled=searchConfig.enabled,minListings=searchConfig.minListings,maxPerDay=searchConfig.maxPerUserPerDay}){
  const router=express.Router();
  const limiter=rateLimit({windowMs:searchConfig.rateWindowMinutes*60_000,limit:searchConfig.rateLimit,standardHeaders:"draft-8",legacyHeaders:false,message:{error:"Too many external searches. Try again later."}});
  router.post("/search",authenticate,limiter,async(req,res)=>{
    if(!enabled)return res.status(404).json({error:"External business search is disabled."});
    const parsed=z.object({item:z.string().trim().min(1).max(180),city:z.string().trim().min(1).max(100),state:z.string().trim().min(1).max(100)}).strict().safeParse(req.body);
    if(!parsed.success)return res.status(400).json({error:"Enter an item, city, and state before searching nearby businesses."});
    if(!placesKey)return res.status(503).json({error:"External Places search key is not configured. Please contact ShedShare support."});
    try{
      const [counts]=await pool.execute("SELECT COUNT(*) AS total FROM items WHERE paused=FALSE AND LOWER(city)=LOWER(?) AND LOWER(state)=LOWER(?)",[parsed.data.city,parsed.data.state]);
      if(Number(counts[0]?.total||0)<minListings)return res.status(403).json({error:`Nearby business search is available after ShedShare has ${minListings} active listings in ${parsed.data.city}, ${parsed.data.state}.`});
      const [centers]=await pool.execute("SELECT AVG(latitude) AS lat,AVG(longitude) AS lng,COUNT(*) AS count FROM items WHERE paused=FALSE AND LOWER(city)=LOWER(?) AND LOWER(state)=LOWER(?) AND latitude IS NOT NULL AND longitude IS NOT NULL",[parsed.data.city,parsed.data.state]);
      if(!centers[0]?.count)return res.status(400).json({error:"Choose a city and state with a saved map location before searching nearby businesses."});
      const key=makeKey(parsed.data.item,parsed.data.city,parsed.data.state),now=Date.now();
      let results=memoryCache.get(key)?.expiresAt>now?memoryCache.get(key).results:null;
      const today=new Date().toISOString().slice(0,10),connection=await pool.getConnection();
      try{await connection.beginTransaction();await connection.execute("INSERT IGNORE INTO external_search_daily_usage (user_id,usage_date,searches) VALUES (?,?,0)",[req.user.id,today]);const [usage]=await connection.execute("SELECT searches FROM external_search_daily_usage WHERE user_id=? AND usage_date=? FOR UPDATE",[req.user.id,today]);if(Number(usage[0].searches)>=maxPerDay){await connection.rollback();return res.status(429).json({error:`Daily nearby-business search limit (${maxPerDay}) reached. Try again tomorrow.`});}await connection.execute("UPDATE external_search_daily_usage SET searches=searches+1 WHERE user_id=? AND usage_date=?",[req.user.id,today]);await connection.commit();}catch(error){await connection.rollback();throw error;}finally{connection.release();}
      if(!results){
        await pool.execute("DELETE FROM external_place_search_cache WHERE expires_at<=UTC_TIMESTAMP()");
        const [cacheRows]=await pool.execute("SELECT place_ids,expires_at FROM external_place_search_cache WHERE cache_key=? AND expires_at>UTC_TIMESTAMP() LIMIT 1",[key]);
        const query=`${parsed.data.item} rental in ${parsed.data.city}, ${parsed.data.state}, Nigeria`;
        const headers={"Content-Type":"application/json","X-Goog-Api-Key":placesKey,"X-Goog-FieldMask":"places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.rating,places.currentOpeningHours.openNow,places.location,places.googleMapsUri"};
        const response=await fetch("https://places.googleapis.com/v1/places:searchText",{method:"POST",headers,body:JSON.stringify({textQuery:query,pageSize:searchConfig.maxResults,locationBias:{circle:{center:{latitude:Number(centers[0].lat),longitude:Number(centers[0].lng)},radius:searchConfig.biasRadiusMeters}},regionCode:"NG",languageCode:"en"}),signal:AbortSignal.timeout(8000)});
        const body=await response.json();
        if(!response.ok){console.error("Google Places Text Search failed with HTTP",response.status);return res.status(502).json({error:"Nearby business search is temporarily unavailable. Try again later."});}
        results=(body.places||[]).slice(0,searchConfig.maxResults).map(place=>({placeId:place.id,name:place.displayName?.text||"Business",address:place.formattedAddress||"Address unavailable",phone:place.nationalPhoneNumber||"",rating:Number.isFinite(place.rating)?place.rating:null,openNow:typeof place.currentOpeningHours?.openNow==="boolean"?place.currentOpeningHours.openNow:null,lat:place.location?.latitude??null,lng:place.location?.longitude??null,mapsUrl:place.googleMapsUri||""})).filter(place=>place.placeId);
        const placeIds=results.map(result=>result.placeId);
        await pool.execute("INSERT INTO external_place_search_cache (cache_key,item_term,city,state,place_ids,expires_at) VALUES (?,?,?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 24 HOUR)) ON DUPLICATE KEY UPDATE place_ids=VALUES(place_ids),expires_at=VALUES(expires_at)",[key,parsed.data.item,parsed.data.city,parsed.data.state,JSON.stringify(placeIds)]);
        memoryCache.set(key,{expiresAt:now+TTL_MS,results});
      }
      const origin={lat:Number(centers[0].lat),lng:Number(centers[0].lng)};
      const sorted=results.map(result=>({...result,distanceKm:result.lat==null||result.lng==null?null:haversine(origin,{lat:result.lat,lng:result.lng})})).sort((a,b)=>(a.distanceKm??Infinity)-(b.distanceKm??Infinity));
      for(const [code,value] of leadTokens)if(value.expiresAt<now)leadTokens.delete(code);
      const codeFor=(place,action)=>{const code=crypto.randomBytes(24).toString("base64url");leadTokens.set(code,{placeId:place.placeId,item:parsed.data.item,city:parsed.data.city,state:parsed.data.state,userId:String(req.user.id),action,phone:place.phone,name:place.name,mapsUrl:place.mapsUrl,expiresAt:Date.now()+searchConfig.redirectTtlMinutes*60_000});return code;};
      return res.json({results:sorted.map(place=>({...place,callUrl:place.phone?`/api/external-search/lead/${encodeURIComponent(codeFor(place,"call"))}`:null,whatsappUrl:place.phone?`/api/external-search/lead/${encodeURIComponent(codeFor(place,"whatsapp"))}`:null,directionsUrl:`/api/external-search/lead/${encodeURIComponent(codeFor(place,"directions"))}`})),attribution:"Powered by Google Maps",notice:"These businesses may rent this item. Call to confirm availability and price."});
    }catch(error){console.error("External business search failed:",error.message);return res.status(502).json({error:"Nearby business search is temporarily unavailable. Try widening the area."});}
  });
  router.get("/lead/:code",async(req,res)=>{
    const data=leadTokens.get(req.params.code);if(!data||data.expiresAt<Date.now())return res.status(400).send("This business link has expired. Search nearby businesses again.");
    if(!["call","whatsapp","directions"].includes(data.action))return res.status(400).send("Invalid business link.");
    try{await pool.execute("INSERT INTO external_business_leads (place_id,item_term,city,state,user_id,action) VALUES (?,?,?,?,?,?)",[data.placeId,data.item,data.city,data.state,data.userId||null,data.action]);
      const ref=crypto.randomBytes(4).toString("hex").toUpperCase();let target;
      if(data.action==="call")target=data.phone?`tel:${String(data.phone).replace(/[^+\d]/g,"")}`:`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(data.name)}`;
      else if(data.action==="whatsapp"){const digits=String(data.phone||"").replace(/\D/g,"").replace(/^0/,"234");target=`https://wa.me/${digits}?text=${encodeURIComponent(`Hi, I found you on ShedShare (ref ${ref}), do you have ${data.item} for rent?`)}`;}
      else {const mapsUrl=String(data.mapsUrl||"");target=/^https:\/\/(www\.)?google\.com\/maps\//i.test(mapsUrl)?mapsUrl:`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(data.name)}&query_place_id=${encodeURIComponent(data.placeId)}`;}
      return res.redirect(302,target);
    }catch(error){console.error("External business lead logging failed:",error.message);return res.status(500).send("Unable to open this business link right now.");}
  });
  return router;
}
function haversine(a,b){const r=v=>v*Math.PI/180,dLat=r(b.lat-a.lat),dLng=r(b.lng-a.lng),x=Math.sin(dLat/2)**2+Math.cos(r(a.lat))*Math.cos(r(b.lat))*Math.sin(dLng/2)**2;return 6371*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));}
module.exports={createExternalSearchRouter};
