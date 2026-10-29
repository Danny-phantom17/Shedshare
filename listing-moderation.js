"use strict";

const { generateText } = require("./ai");

const DEFAULT_POLICY = Object.freeze({
  prohibitedTerms: [],
  reviewTerms: [],
  policyText: "Review for illegal or prohibited goods, stolen or counterfeit claims, weapons or hazardous materials, fraud, spam, unsafe use, and materially misleading descriptions. Do not flag an item solely because it is cheap, small, unusual, or low in perceived value. Ask for human review when evidence is uncertain.",
  autoApprovalConfidence: 0.9
});

function policyMatch(text, terms) {
  const normalized=String(text||"").toLocaleLowerCase();
  return (Array.isArray(terms)?terms:[]).find(term=>{const value=String(term||"").trim().toLocaleLowerCase();if(!value)return false;if(value.includes(" "))return normalized.includes(value);return new RegExp(`(?:^|[^a-z0-9])${value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}(?:$|[^a-z0-9])`).test(normalized);})||null;
}

function parseAssessment(raw, input, policy=DEFAULT_POLICY) {
  let value;
  try { const cleaned=String(raw).trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/i,"");value=JSON.parse(cleaned); }
  catch { throw new Error("Gemini returned an invalid moderation response."); }
  if(!value||typeof value!="object"||typeof value.itemSummary!=="string"||typeof value.shortDescription!=="string"||!new Set(["approve","review"]).has(value.recommendation)||!Number.isFinite(Number(value.confidence))||!Array.isArray(value.concerns))throw new Error("Gemini returned incomplete moderation fields.");
  const confidence=Math.max(0,Math.min(1,Number(value.confidence))), concerns=value.concerns.filter(x=>typeof x==="string").map(x=>x.slice(0,240)).slice(0,8);
  const completeText=[input.name,input.category,input.description,value.itemSummary,value.shortDescription,...concerns].join(" ");
  const prohibited=policyMatch(completeText,policy.prohibitedTerms),reviewTerm=policyMatch(completeText,policy.reviewTerms);
  const clean=String(value.shortDescription).trim().slice(0,1000);
  const approved=value.recommendation==="approve"&&confidence>=Number(policy.autoApprovalConfidence??DEFAULT_POLICY.autoApprovalConfidence)&&concerns.length===0&&!prohibited&&!reviewTerm;
  const reason=prohibited?`Configured prohibited policy term matched: ${prohibited}`:reviewTerm?`Configured review policy term matched: ${reviewTerm}`:concerns.join("; ")||(!approved?"AI uncertainty requires administrator review.":"No configured policy concerns detected.");
  return { itemSummary:value.itemSummary.trim().slice(0,500), shortDescription:clean, confidence, concerns, outcome:approved?"auto_approved":"pending_review", reason };
}

async function assessListing(input, imageDataUrl, policy=DEFAULT_POLICY, generate=generateText) {
  const instructions=`You are ShedShare's listing safety screening assistant. Analyze the listing text and uploaded photo. Identify only what is visibly/evidentially supported. Draft a short factual description without invented brand, model, size, condition, contents, or safety claims. Assess only the platform policy supplied below. Cheap, small, unusual, or low perceived value items must not be treated as policy violations. Never make a final decision on an uncertain, prohibited, suspicious, spam, or safety concern: recommend review. Return JSON only with itemSummary, shortDescription, recommendation (approve or review), confidence (0 to 1), and concerns (array of short factual reasons). Policy: ${JSON.stringify(policy)}`;
  return parseAssessment(await generate(instructions,input,imageDataUrl),input,policy);
}

module.exports={DEFAULT_POLICY,policyMatch,parseAssessment,assessListing};
