"use strict";

function int(name,fallback,min,max){const value=Number(process.env[name]);return Number.isInteger(value)&&value>=min&&value<=max?value:fallback;}
const enabled=/^(1|true|yes)$/i.test(process.env.EXTERNAL_SEARCH_ENABLED||"false");
module.exports=Object.freeze({
  enabled,
  minListings:int("MIN_LISTINGS_FOR_EXTERNAL",100,1,1_000_000),
  maxPerUserPerDay:int("EXTERNAL_SEARCH_MAX_PER_USER_PER_DAY",5,1,100),
  biasRadiusMeters:int("EXTERNAL_SEARCH_BIAS_RADIUS_METERS",5000,1000,50000),
  cacheTtlHours:24,
  redirectTtlMinutes:15,
  maxResults:10,
  rateWindowMinutes:15,
  rateLimit:20
});
