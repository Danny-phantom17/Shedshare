"use strict";

function maskPhone(value) {
  const phone = String(value || "").trim();
  if (!phone) return "";
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return "•••";
  return `${"•".repeat(Math.max(3, digits.length - 2))}${digits.slice(-2)}`;
}

function redactContactDetails(value) {
  return String(value || "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email hidden]")
    .replace(/(?:\+?\d[\d\s().-]{6,}\d)/g, (match) => {
      const digits = match.replace(/\D/g, "");
      return digits.length >= 8 ? "[phone hidden]" : match;
    });
}

function containsContactDetails(value) {
  const text = String(value || "");
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) return true;
  return /(?:\+?\d[\d\s().-]{6,}\d)/g.test(text.replace(/\s+/g, " "));
}

function privacyAndTermsNotice(){return "ShedShare may review in-app messages for safety, fraud prevention, and dispute resolution. Messages are accessible to the conversation participants and, under restricted role-based access with a recorded reason, authorized trust and safety personnel. Deals completed outside ShedShare are not verified by ShedShare and do not receive a platform payment receipt or verified rental record. Rental payments are processed through Paystack split checkout; informational deposits are arranged directly and are not collected or held by ShedShare. ShedShare does not promise insurance or compensation.";}

module.exports = { maskPhone, redactContactDetails, containsContactDetails, privacyAndTermsNotice };
