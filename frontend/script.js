/* ============================================================
   ShedShare frontend.
   The complete backend specification lives in BACKEND_PROMPT.md.
   Set API_BASE to your server and the built-in mock data turns off
   completely (a failed request then shows an error, it never
   silently falls back to fake data). Leave API_BASE empty to
   demo the whole app on in-memory mock data.

   Endpoints this file calls:
     GET    /api/items                     public browse (excludes paused)
     GET    /api/items?mine=1              the signed-in owner's own items
     POST   /api/items                     create
     PATCH  /api/items/{id}                owner edit / pause / resume
     DELETE /api/items/{id}                owner delete
     GET    /api/items/{id}/bookings       [{startAt,endAt}] for confirmed/active rentals
     GET    /api/rentals?role=renter|owner|admin
     POST   /api/rentals                   { itemId, pricePerUnit, units, startAt, deliveryMethod }
     POST   /api/rentals/{id}/activate | complete | cancel
     POST   /api/auth/login | signup
   Errors: respond with a non-2xx status and { "error": "message" }.
   ============================================================ */
const PREVIEW_MODE = new URLSearchParams(window.location.search).get("preview");
const REFERRAL_CODE_FROM_LINK = new URLSearchParams(window.location.search).get("ref") || "";
const USER_PREVIEW = PREVIEW_MODE === "user";
const ADMIN_PREVIEW = PREVIEW_MODE === "admin";
const configuredApiBaseValue = String(window.SHEDSHARE_CONFIG?.apiBaseUrl || "").trim();
const configuredApiBase = configuredApiBaseValue.startsWith("__") ? "" : configuredApiBaseValue.replace(/\/+$/, "");
const API_BASE = PREVIEW_MODE ? "" : configuredApiBase || (window.location.protocol === "file:" ? "http://localhost:3000" : window.location.origin);
const PLATFORM_FEE_PERCENT = 0; // fees stay off until Paystack is configured
const MAX_DISCOUNT_NAIRA = 500; // renter may go at most this far below the listed per-unit price
const MAX_VIDEO_MB = 20; // demo-only cap — see the Video note in BACKEND_PROMPT.md before shipping real uploads
const ADMIN_EMAIL = "admin@shedshare.app"; // mock only: sign in with this email to preview the admin dashboard
const AGREEMENT_VERSION = "v1";

/* ---------- mobile PWA installation ---------- */
let deferredInstallPrompt = null;
const installAppButton = document.getElementById("installAppButton");
function isShedShareInstalled() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}
function syncInstallAppButton() {
  if (!installAppButton) return;
  installAppButton.hidden = isShedShareInstalled();
}
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  syncInstallAppButton();
});
window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  syncInstallAppButton();
  showToast("ShedShare has been installed.");
});
syncInstallAppButton();
window.addEventListener("resize", syncInstallAppButton);
installAppButton?.addEventListener("click", async () => {
  if (!deferredInstallPrompt) {
    const isIOS = /iphone|ipad|ipod/i.test(window.navigator.userAgent) || (window.navigator.platform === "MacIntel" && window.navigator.maxTouchPoints > 1);
    showToast(isIOS
      ? "To install ShedShare, tap Share in Safari, then Add to Home Screen."
      : "To install ShedShare, open your browser menu and choose Install app or Add to Home screen.");
    return;
  }
  deferredInstallPrompt.prompt();
  const choice = await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  if (choice?.outcome === "accepted") syncInstallAppButton();
});

/* ---------- appearance ---------- */
const themeNames = { navy: "Navy", light: "Bright", dark: "Black" };
const themeOrder = ["navy", "light", "dark"];
const savedTheme = localStorage.getItem("shedshare_theme");
document.documentElement.dataset.theme = themeNames[savedTheme] ? savedTheme : "navy";
const themeToggle = document.getElementById("themeToggle");
function syncThemeButton() {
  const theme = document.documentElement.dataset.theme;
  const compact = window.matchMedia("(max-width: 420px)").matches;
  themeToggle.textContent = compact ? themeNames[theme] : `Theme: ${themeNames[theme]}`;
  themeToggle.setAttribute("aria-label", `Current theme: ${themeNames[theme]}. Tap to change theme.`);
  themeToggle.title = `Change theme (current: ${themeNames[theme]})`;
}
syncThemeButton();
window.addEventListener("resize", syncThemeButton);
themeToggle.addEventListener("click", () => {
  const current = themeOrder.indexOf(document.documentElement.dataset.theme);
  const nextTheme = themeOrder[(current + 1) % themeOrder.length];
  document.documentElement.dataset.theme = nextTheme;
  localStorage.setItem("shedshare_theme", nextTheme);
  syncThemeButton();
});

// The no-backend demo must never present itself as a real payment flow.

// From Google Cloud Console → APIs & Services → Credentials → OAuth client ID
// (type "Web application"). Must be registered against your real hosting domain
// under "Authorized JavaScript origins" — it cannot be tested on this preview
// link, since that URL changes and was never registered with Google.
let GOOGLE_CLIENT_ID = "";

const CATEGORIES = ["Home & Furniture", "Kitchen", "Vehicles", "Tools & Equipment", "Electronics", "Events", "Fashion", "Music", "Outdoor", "Other"];

// Auth data stays in memory; the server stores the JWT in an HttpOnly cookie.
// Remove any legacy bearer token left by the previous localStorage session implementation.
localStorage.removeItem("shedshare_session");
let session = USER_PREVIEW || ADMIN_PREVIEW ? { user: { id: "preview-user", name: "Daniel Godwin", email: "preview@local.invalid", isAdmin: ADMIN_PREVIEW, isRider: false, subaccountCode: "preview" } } : null;
let csrfToken = "";
let itemsCache = [];     // browse list
let itemsCacheInitialized = false;
let messageListingCache = [];
const RENTAL_DRAFT_STORAGE_KEY = "shedshare_pending_rental_draft";
const RENTAL_DRAFT_TTL_MS = 48 * 60 * 60 * 1000;
function readPendingRentalDraft() {
  try {
    const stored=JSON.parse(localStorage.getItem(RENTAL_DRAFT_STORAGE_KEY)||"null");
    if(!stored||!stored.draft||Number(stored.expiresAt)<=Date.now()){localStorage.removeItem(RENTAL_DRAFT_STORAGE_KEY);return null;}
    return stored.draft;
  } catch(_e) { return null; }
}
function savePendingRentalDraft(draft) {
  const memoryDraft=pendingRentalDraft&&Number(pendingRentalDraft.expiresAt)>Date.now()?pendingRentalDraft:null;
  const previous=memoryDraft&&String(memoryDraft.itemId)===String(draft.itemId)?memoryDraft:readPendingRentalDraft();
  const createdAt=previous&&String(previous.itemId)===String(draft.itemId)?Number(previous.createdAt)||Date.now():Date.now();
  pendingRentalDraft={...draft,createdAt,expiresAt:createdAt+RENTAL_DRAFT_TTL_MS};
  try { localStorage.setItem(RENTAL_DRAFT_STORAGE_KEY,JSON.stringify({draft:pendingRentalDraft,expiresAt:pendingRentalDraft.expiresAt})); } catch(_e) {}
  schedulePendingRentalDraftExpiry();
}
function clearPendingRentalDraft() {
  if(rentalDraftExpiryTimer)clearTimeout(rentalDraftExpiryTimer);
  rentalDraftExpiryTimer=null;
  pendingRentalDraft=null;
  try { localStorage.removeItem(RENTAL_DRAFT_STORAGE_KEY); } catch(_e) {}
}
function schedulePendingRentalDraftExpiry() {
  if(rentalDraftExpiryTimer)clearTimeout(rentalDraftExpiryTimer);
  if(!pendingRentalDraft?.expiresAt)return;
  rentalDraftExpiryTimer=setTimeout(()=>{if(Number(pendingRentalDraft?.expiresAt)<=Date.now())clearPendingRentalDraft();else schedulePendingRentalDraftExpiry();},Math.max(1,Number(pendingRentalDraft.expiresAt)-Date.now()));
}
let pendingRentalDraft = readPendingRentalDraft();
let rentalDraftExpiryTimer = null;
schedulePendingRentalDraftExpiry();
let myItemsCache = [];   // the signed-in owner's items (dashboard)
let editingItemId = null;
let aiAvailable = false;
let cloudinaryPhotoAvailable = false;

function hasEnhanceablePhoto(){return sourceImageFile?Boolean(sourceImageDataUrl):Boolean(editingItemId&&existingImageUrl);}
function syncAiControls() {
  document.getElementById("aiDescriptionStatus").hidden = !aiAvailable || !document.getElementById("aiDescriptionStatus").textContent;
  const haveSource=hasEnhanceablePhoto();
  const photoButton=document.getElementById("enhancePhoto");
  photoButton.disabled=!cloudinaryPhotoAvailable||!haveSource;
}

async function refreshAiAvailability() {
  if (PREVIEW_MODE || !API_BASE) { aiAvailable = false; cloudinaryPhotoAvailable=false;syncAiControls();document.getElementById("cloudinaryPhotoStatus").textContent="Cloudinary photo cleaning requires the configured ShedShare backend.";return; }
  try {
    const response = await fetch(`${API_BASE}/api/config`, { credentials: "include", cache: "no-store" });
    const config = response.ok ? await response.json() : {};
    aiAvailable = config.aiAvailable === true;
    cloudinaryPhotoAvailable=config.cloudinaryPhotoEnhancementAvailable===true;
    const photoStatus=document.getElementById("cloudinaryPhotoStatus");
    photoStatus.textContent=cloudinaryPhotoAvailable?"Cloudinary photo cleaning is ready. Processing starts only when you click the button.":config.cloudinaryPhotoEnhancementConfigured?"Cloudinary credentials are present, but photo cleaning is disabled. Review account usage, then set CLOUDINARY_PHOTO_ENHANCEMENT_ENABLED=true on the server to enable it.":"Cloudinary photo cleaning is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET on the server; review your plan before enabling it.";
  } catch (_error) { aiAvailable = false;cloudinaryPhotoAvailable=false;document.getElementById("cloudinaryPhotoStatus").textContent="Could not check Cloudinary setup. Your original photo is still available."; }
  syncAiControls();
  if (aiAvailable && sourceImageFile && lastDescriptionDraftFile !== sourceImageFile) autoDraftDescription(sourceImageFile);
}

/* ---------- small helpers ---------- */
const isOpen = r => r.status === "confirmed" || r.status === "active";
function isAdmin() { return !!(session && session.user && session.user.isAdmin); }
function currentUserName() { return (session && session.user && session.user.name) || "You"; }
function money(n) { return "₦" + Number(n || 0).toLocaleString(); }
function split(amount) { const fee = 0; return { fee, owner: amount - fee }; }
function lowestPrice(item) { return Math.max(0, item.price - MAX_DISCOUNT_NAIRA); }
function asList(data) { return Array.isArray(data) ? data : []; }
function plural(n, unit) { return `${n} ${unit}${n > 1 ? "s" : ""}`; }

// User-typed text is escaped before it goes into innerHTML (prevents stored XSS once a real backend holds user input).
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function safeImg(src) { return /^(data:image\/|https?:\/\/)/i.test(src || "") ? esc(src) : ""; }
function safeVideo(src) { return /^(data:video\/|https?:\/\/)/i.test(src || "") ? esc(src) : ""; }
// Dynamic Google resources inherit the response nonce used by the HTML entry point.
function applyCspNonce(scriptElement) {
  const nonceSource = document.querySelector("script[nonce]");
  if (nonceSource?.nonce) scriptElement.nonce = nonceSource.nonce;
  return scriptElement;
}

const pad2 = n => String(n).padStart(2, "0");
function toDateInput(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function toDateTimeInput(d) { return `${toDateInput(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function parseStart(unit, value) {
  if (!value) return null;
  if(value.includes("T"))return new Date(value);
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addPeriod(start, unit, n) {
  const d = new Date(start);
  if (unit === "hour") d.setHours(d.getHours() + n);
  else if (unit === "week") d.setDate(d.getDate() + 7 * n);
  else if(unit==="day")d.setDate(d.getDate()+n);
  else {const day=d.getDate(),months=unit==="year"?n*12:n;d.setDate(1);d.setMonth(d.getMonth()+months);d.setDate(Math.min(day,new Date(d.getFullYear(),d.getMonth()+1,0).getDate()));}
  return d;
}
function overlaps(aS, aE, bS, bE) { return aS < bE && bS < aE; }
function fmtDT(iso, unit) {
  const d = new Date(iso);
  return unit === "hour" ? d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : d.toLocaleDateString(undefined, { dateStyle: "medium" });
}
function fmtRange(s, e, unit) { return fmtDT(s, unit) + " to " + fmtDT(e, unit); }

function agreementTermsText(itemName, units, unit) {
  return `By renting "${itemName}" you agree to the terms that both parties will review in the structured ShedShare rental summary, including return condition, deadline, and cancellation terms. Any informational deposit is arranged directly at handover and is not collected or held by ShedShare. ShedShare is not an insurer and does not guarantee against loss, theft, damage, or compensation.`;
}
function agreementHtml(r) {
  if (!r) return "";
  const t=r.agreementTerms;
  if(!t)return r.agreementAccepted?`<details class="agreement"><summary>View legacy rental terms</summary><div id="agreement-${esc(r.id)}" class="printable-agreement"><h3>ShedShare rental agreement</h3><p>${esc(r.itemName)} · ${esc(fmtRange(r.startAt,r.endAt,r.pricingUnit))}</p><p>${esc(agreementTermsText(r.itemName,r.units,r.pricingUnit))}</p><p class="fine">Detailed terms were not retained for this older booking.</p></div><button type="button" class="btn-outline" data-download-agreement="${esc(r.id)}">Download accepted agreement</button>${(r.paymentVerified||r.paymentComplete)?` <button type="button" class="btn-outline" data-download-receipt="${esc(r.id)}">Download transaction receipt</button>`:""}</details>`:"";
  const printId=`agreement-${String(r.id).replace(/[^a-z0-9_-]/gi,"")}`;
  return `<details class="agreement"><summary>View accepted agreement</summary><div id="${printId}" class="printable-agreement"><h3>ShedShare rental agreement</h3><p><strong>${esc(t.itemName)}</strong> · listing ${esc(t.listingId)}</p><p>Renter ${esc(r.renterName||t.renterId)} · Owner ${esc(r.ownerName||t.ownerId)}</p><p>${esc(fmtRange(t.startAt,t.endAt,t.pricingUnit))} · ${Number(t.units)} ${esc(t.pricingUnit)} unit(s) · Quantity ${Number(t.inventoryQuantity||t.inventory_quantity||1)}</p><p>Rental charge ${money(t.subtotal)}${paystackAvailable?` · Amount charged by Paystack ${money(t.platformCheckoutAmount??t.subtotal)}`:""}${Number(t.directDeliveryFee??t.deliveryFee??0)>0?` · Owner delivery fee arranged and paid directly ${money(t.directDeliveryFee??t.deliveryFee)}`:""} · Estimated total ${money(t.totalEstimatedCost??t.totalPayable)}</p>${paystackAvailable?`<p>Platform commission ${money(t.platformCommission)} (${Number(t.platformCommissionPercent)}%). Processing fee ${t.processingFee==null?"shown by Paystack at checkout":money(t.processingFee)}.</p>`:""}<p>Informational deposit ${money(t.informationalDeposit)}; if agreed, arranged directly between parties at handover and not collected by ShedShare.</p><p><strong>Delivery / collection:</strong> ${esc(t.deliveryMethod)}${t.deliveryLocation?` · ${esc(t.deliveryLocation)}`:""}</p><p><strong>Cancellation:</strong> ${esc(t.cancellationPolicy||"Not specified")}</p><p><strong>Rental conditions:</strong> ${esc(t.rentalConditions||"Follow the listing conditions")}</p><p><strong>Known defects:</strong> ${esc(t.knownDefects||"None listed")}</p><p>Both parties accepted the same recorded terms. Handover, return and condition are recorded separately; this record is not proof of physical condition.</p></div><button type="button" class="btn-outline" data-print-agreement="${printId}">Print / Save PDF</button><button type="button" class="btn-outline" data-download-agreement="${esc(r.id)}">Download accepted agreement</button>${(r.paymentVerified||r.paymentComplete)?` <button type="button" class="btn-outline" data-download-receipt="${esc(r.id)}">Download transaction receipt</button>`:""}<p class="fine">Accepted ${esc(new Date(r.acceptedAt||Date.now()).toLocaleString())} (${esc(r.agreementVersion||AGREEMENT_VERSION)})</p></details>`;
}
function downloadHtmlDocument(filename,title,content){const blob=new Blob([`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:850px;margin:40px auto;padding:0 24px;color:#1c2622}h1{color:#174c3a;border-bottom:2px solid #d5e3db;padding-bottom:12px}.receipt-row{display:flex;justify-content:space-between;gap:20px;border-bottom:1px solid #e3e8e4;padding:10px 0}.muted{color:#65746d;font-size:14px}.brand{font-weight:700;letter-spacing:.12em;color:#174c3a}@media print{body{margin:0;max-width:none}}</style></head><body><p class="brand">SHEDSHARE · RENT · SHARE · EARN</p><h1>${esc(title)}</h1>${content}<p class="muted">Generated from ShedShare's saved rental record.</p></body></html>`],{type:"text/html;charset=utf-8"});const url=URL.createObjectURL(blob),link=document.createElement("a");link.href=url;link.download=filename;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}

function statusLabel(status, role) {
  if (status === "pending_payment") return "Awaiting payment verification";
  const labels = {
    confirmed: { owner: "Payment confirmed, arrange handover", renter: "Confirmed, awaiting handover", admin: "Confirmed" },
    active: { owner: "Handed over, in progress", renter: "In progress", admin: "Active" },
    completed: { owner: "Completed", renter: "Completed", admin: "Completed" },
    cancelled: { owner: "Cancelled", renter: "Cancelled", admin: "Cancelled" }
  };
  return (labels[status] && labels[status][role]) || status;
}

function stepTrackerHtml(current) {
  const steps = ["Details", "Agreement", "Payment"];
  return `<div class="step-tracker">${steps.map((label, i) => {
    const n = i + 1;
    const cls = n < current ? "done" : n === current ? "active" : "";
    const sep = i < steps.length - 1 ? `<span class="line"></span>` : "";
    return `<span class="step-dot ${cls}"><span class="dot"></span>${label}</span>${sep}`;
  }).join("")}</div>`;
}

function animateValue(el, end, formatFn, duration = 600) {
  if (!el) return;
  const start = performance.now();
  function tick(now) {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = formatFn(Math.round(end * eased));
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

let offlineToastActive = false;
function setToastMessage(toast, message) {
  const text = toast.querySelector(".toast-message");
  if (text) text.textContent = message;
  else toast.textContent = message;
}
function showToast(msg) {
  if (offlineToastActive) return;
  const t = document.getElementById("toast");
  setToastMessage(t, msg);
  t.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove("show"), 3600);
}
document.querySelector(".toast-dismiss")?.addEventListener("click", () => {
  const toast = document.getElementById("toast");
  toast.classList.remove("show");
  clearTimeout(showToast._t);
});
function syncOfflineToast() {
  const toast = document.getElementById("toast");
  if (!navigator.onLine) {
    offlineToastActive = true;
    clearTimeout(showToast._t);
    setToastMessage(toast, "You're offline. Connect to the internet to use ShedShare.");
    const icon = toast.querySelector(".toast-icon");
    if (icon) icon.textContent = "!";
    toast.classList.add("show", "offline");
    return;
  }
  if (!offlineToastActive) return;
  offlineToastActive = false;
  const icon = toast.querySelector(".toast-icon");
  if (icon) icon.textContent = "✓";
  toast.classList.remove("offline", "show");
  showToast("You're back online.");
}
window.addEventListener("offline", syncOfflineToast);
window.addEventListener("online", syncOfflineToast);
syncOfflineToast();

/* ---------- lightbox: tap a photo or video to see it larger ---------- */
function openLightbox(kind, src) {
  if (!src) return;
  const inner = document.getElementById("lightboxInner");
  inner.innerHTML = "";
  const el = document.createElement(kind === "video" ? "video" : "img");
  if (kind === "video") { el.controls = true; el.playsInline = true; }
  else { el.alt = ""; }
  el.src = src;
  inner.appendChild(el);
  document.getElementById("lightbox").hidden = false;
}
function closeLightbox() {
  document.getElementById("lightbox").hidden = true;
  document.getElementById("lightboxInner").innerHTML = ""; // also stops any playing video
}
document.getElementById("lightboxClose").addEventListener("click", closeLightbox);
document.getElementById("lightbox").addEventListener("click", (e) => { if (e.target.id === "lightbox") closeLightbox(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeLightbox(); });

/* ---------- API layer ---------- */
async function loadCsrfToken(force = false) {
  if (csrfToken && !force) return csrfToken;
  const response = await fetch(`${API_BASE}/api/csrf`, { credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error("Unable to initialize request security.");
  const data = await response.json();
  if (!data.csrfToken) throw new Error("CSRF token was not returned.");
  csrfToken = data.csrfToken;
  return csrfToken;
}

async function restoreSession() {
  if (!API_BASE || PREVIEW_MODE) return;
  const result = await api("/api/auth/session");
  if (!result?.user) return;
  session = { user: result.user };
  renderSession();
  resumePendingMessage();
  if (isAdmin()) { activateSection("admin"); renderAdminDashboard(); }
  else { activateSection("dashboard"); renderDashboard(); }
}
function resumePendingMessage(){try{const target=JSON.parse(sessionStorage.getItem("shedshare_pending_message")||"null");if(!session||!target)return;sessionStorage.removeItem("shedshare_pending_message");window.setTimeout(()=>openConversation(target.itemId,target.withUserId,target.withUserName,target.itemName,target.rentalId),0);}catch(_error){sessionStorage.removeItem("shedshare_pending_message");}}

async function api(path, options = {}) {
  if (!API_BASE) {
    if (options.body instanceof FormData) return { error: "Media uploads require the real backend to be configured.", status: 503 };
    if (path === "/api/rentals" && options.method === "POST") return { error: "Online payments are not connected yet. Paystack checkout will be available after the backend is deployed and configured.", status: 503 };
    return mockRouter(path, options);
  }
  try {
    const method = String(options.method || "GET").toUpperCase();
    const changesState = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
    const send = async (retryCsrf = false) => {
      const headers = { ...(options.headers || {}) };
      if (!(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
      if (changesState) headers["X-CSRF-Token"] = await loadCsrfToken(retryCsrf);
      const res = await fetch(API_BASE + path, { ...options, credentials: "include", headers });
      let data = null;
      try { data = await res.json(); } catch (_error) { /* empty body */ }
      if (res.status === 403 && data?.code === "CSRF_TOKEN_INVALID" && !retryCsrf) return send(true);
      if (!res.ok) {
        if (res.status === 401 && session) {
          session = null; renderSession();
          showToast("Session expired. Please sign in again.");
        }
        return { error: (data && data.error) || `Request failed (${res.status})`, status: res.status };
      }
      return data;
    };
    return await send();
  } catch (e) {
    showToast("Can't reach the server");
    return { error: "network" };
  }
}

/* ---------- mock backend (only used when API_BASE is empty) ---------- */
const seedDefaults = { ownerSubaccountCode: "", image: "", video: "", paused: false, deliveryAvailable: false, riderDeliveryAvailable: false, deliveryFee: 0, deposit: 0, pricingUnit: "day", minPeriod: 1, condition: "Good", location: "Uyo, Akwa Ibom", ownerBrand: "" };
let mockItems = [
  { id: "i1", name: "Cordless drill", category: "Tools & Equipment", description: "Two batteries included.", ownerName: "Priya", ownerPhone: "0803 000 1111", price: 2000, maxPeriod: 14, image: "https://picsum.photos/seed/shedshare-drill/640/480" },
  { id: "i2", name: "Extension ladder (24ft)", category: "Tools & Equipment", condition: "Well used", description: "Heavy, bring a second person.", ownerName: "Marcus", ownerPhone: "0805 000 2222", ownerBrand: "Marcus Rentals", price: 2500, maxPeriod: 7, image: "https://picsum.photos/seed/shedshare-ladder/640/480" },
  { id: "i3", name: "Pressure washer", category: "Tools & Equipment", condition: "Like new", description: "Weekend pickup only.", ownerName: "Priya", ownerPhone: "0803 000 1111", price: 4000, maxPeriod: 5, deposit: 1000, image: "https://picsum.photos/seed/shedshare-washer/640/480" },
  { id: "i4", name: "Projector & screen", category: "Events", description: "Great for outdoor movie nights.", ownerName: "Jo", ownerPhone: "0807 000 3333", ownerBrand: "Jo's Event Hire", price: 5500, maxPeriod: 3, deposit: 2000, image: "https://picsum.photos/seed/shedshare-projector/640/480", video: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4" },
  { id: "i5", name: "Toyota Camry (2018)", category: "Vehicles", description: "Comes with a full tank, insured.", location: "Lagos, Lekki", ownerName: "Chidi", ownerPhone: "0812 000 4444", ownerBrand: "Chidi Auto Rentals", price: 15000, maxPeriod: 14, deposit: 20000, image: "https://picsum.photos/seed/shedshare-camry/640/480" },
  { id: "i6", name: "Stand mixer", category: "Kitchen", condition: "Like new", description: "Great for baking events.", ownerName: "Priya", ownerPhone: "0803 000 1111", price: 1500, maxPeriod: 5, image: "https://picsum.photos/seed/shedshare-mixer/640/480" }
].map(i => ({ ...seedDefaults, ...i }));
let mockRentals = [];

function buildRental(item, renterName, perUnit, units, startAt, deliveryMethod) {
  const subtotal = perUnit * units;
  const { fee, owner } = split(subtotal);
  const dm = deliveryMethod === "delivery" && item.deliveryAvailable ? "delivery" : "pickup";
  const deliveryFee = dm === "delivery" ? item.deliveryFee : 0;
  return {
    id: "r" + (mockRentals.length + 1), itemId: item.id, itemName: item.name,
    ownerName: item.ownerName, renterName,
    pricePerUnit: perUnit, units, pricingUnit: item.pricingUnit,
    startAt: new Date(startAt).toISOString(), endAt: addPeriod(startAt, item.pricingUnit, units).toISOString(),
    subtotal, deposit: item.deposit || 0, deliveryMethod: dm, deliveryFee,
    total: subtotal + deliveryFee,
    platformFeePercent: PLATFORM_FEE_PERCENT, platformFee: fee, ownerPayout: owner,
    agreementVersion: AGREEMENT_VERSION, agreementAccepted: true, acceptedAt: new Date().toISOString(),
    status: "confirmed"
  };
}
// One seeded booking so the "already booked" behaviour is visible in the demo.
(function seedBooking() {
  const camry = mockItems.find(i => i.id === "i5");
  const start = new Date(); start.setDate(start.getDate() + 3); start.setHours(0, 0, 0, 0);
  mockRentals.push(buildRental(camry, "Amaka", camry.price, 2, start, "pickup"));
  if (USER_PREVIEW) {
    const listing = { ...mockItems[0], id: "preview-listing", name: "Portable generator", category: "Tools & Equipment", ownerName: "Daniel Godwin", ownerPhone: "", price: 8000, image: "https://picsum.photos/seed/shedshare-preview-generator/640/480" };
    mockItems.unshift(listing);
    const bookingStart = new Date(); bookingStart.setDate(bookingStart.getDate() + 1); bookingStart.setHours(0, 0, 0, 0);
    mockRentals.push(buildRental(camry, "Daniel Godwin", camry.price, 2, bookingStart, "pickup"));
  }
  if (ADMIN_PREVIEW) {
    const samples = [
      { item: mockItems[4], renter: "Tunde A.", owner: "Chidi", daysAgo: 0, status: "active" },
      { item: mockItems[5], renter: "Blessing K.", owner: "Priya", daysAgo: 1, status: "confirmed" },
      { item: mockItems[0], renter: "Emeka J.", owner: "Priya", daysAgo: 2, status: "pending_payment" },
      { item: mockItems[3], renter: "Aisha M.", owner: "Jo", daysAgo: 3, status: "completed" },
      { item: mockItems[1], renter: "David O.", owner: "Marcus", daysAgo: 4, status: "completed" },
      { item: mockItems[2], renter: "Mary E.", owner: "Priya", daysAgo: 5, status: "active" }
    ];
    samples.forEach((sample,index) => {
      const start = new Date(); start.setDate(start.getDate() + sample.daysAgo + 1); start.setHours(0,0,0,0);
      const rental = buildRental(sample.item,sample.renter,sample.item.price,2,start,"pickup");
      Object.assign(rental,{id:`preview-rental-${index+1}`,ownerName:sample.owner,status:sample.status,createdAt:new Date(Date.now()-sample.daysAgo*86400000).toISOString(),paymentVerified:sample.status!=="pending_payment",paymentReference:sample.status!=="pending_payment"?`PREVIEW-${index+1}`:""});
      mockRentals.push(rental);
    });
  }
})();

function mockRouter(path, options) {
  const method = options.method || "GET";
  const body = options.body ? JSON.parse(options.body) : {};
  const [pathname, query = ""] = path.split("?");
  const me = currentUserName();
  const user = (session && session.user) || {};

  if (pathname === "/api/testimonials" && method === "GET") return [];
  if (pathname === "/api/testimonials" && method === "POST") return { id: String(Date.now()), status: "pending", message: "Thank you. Your testimonial will be reviewed before it appears publicly." };
  if (pathname === "/api/admin/testimonials" && method === "GET") return [];

  if (ADMIN_PREVIEW && pathname === "/api/admin/listers" && method === "GET") return [
    { id:"l1",name:"Chidi Okafor",email:"chidi@example.invalid",phone:"0803 *** 110",brand:"Chidi Auto Rentals",listingCount:5,activeListingCount:4 },
    { id:"l2",name:"Priya Nair",email:"priya@example.invalid",phone:"0805 *** 221",brand:"Independent lister",listingCount:4,activeListingCount:4 },
    { id:"l3",name:"Marcus James",email:"marcus@example.invalid",phone:"0807 *** 330",brand:"Marcus Rentals",listingCount:3,activeListingCount:2 },
    { id:"l4",name:"Jo Ekanem",email:"jo@example.invalid",phone:"0812 *** 441",brand:"Jo’s Event Hire",listingCount:2,activeListingCount:2 }
  ];
  if (ADMIN_PREVIEW && pathname === "/api/admin/controls" && method === "GET") return { paymentsPaused:false };
  if (ADMIN_PREVIEW && pathname === "/api/admin/contact-flags" && method === "GET") return [];
  if (ADMIN_PREVIEW && pathname === "/api/rider/applications" && method === "GET") return [];
  if (ADMIN_PREVIEW && pathname === "/api/deliveries" && method === "GET") return [];

  if (pathname === "/api/items" && method === "GET") {
    return query.includes("mine=1") ? mockItems.filter(i => i.ownerName === me) : mockItems.filter(i => !i.paused);
  }
  const currentListingMatch = pathname.match(/^\/api\/items\/([^/]+)$/);
  if (currentListingMatch && method === "GET") {
    const item = mockItems.find(i => String(i.id) === currentListingMatch[1]);
    return item && !item.paused ? item : { error: "This listing is no longer available. Browse current listings to find another option.", status: 404 };
  }
  if (pathname === "/api/items/search" && method === "GET") {
    const params=new URLSearchParams(query),rows=mockItems.filter(item=>{
      if(item.paused)return false;
      const q=(params.get("q")||"").toLowerCase(),location=(params.get("location")||"").toLowerCase(),category=params.get("category"),unit=params.get("pricingUnit"),min=params.has("minPrice")?Number(params.get("minPrice")):null,max=params.has("maxPrice")?Number(params.get("maxPrice")):null,duration=params.has("duration")?Number(params.get("duration")):null;
      if(q&&!`${item.name||""} ${item.description||""}`.toLowerCase().includes(q))return false;
      if(location&&!String(item.location||"").toLowerCase().includes(location))return false;
      if(category&&item.category!==category)return false;
      if(unit&&item.pricingUnit!==unit)return false;
      if(min!==null&&item.price<min||max!==null&&item.price>max)return false;
      if(duration!==null&&(duration<(item.minPeriod||1)||duration>(item.maxPeriod||14)))return false;
      if(params.has("availabilityStart")){const start=new Date(params.get("availabilityStart")),units=duration||1,end=addPeriod(start,unit,units);if(mockRentals.some(r=>r.itemId===String(item.id)&&isOpen(r)&&overlaps(start,end,new Date(r.startAt),new Date(r.endAt))))return false;}
      return true;
    });
    if(params.get("sort")==="price_asc")rows.sort((a,b)=>a.price-b.price);else if(params.get("sort")==="price_desc")rows.sort((a,b)=>b.price-a.price);
    const page=Number(params.get("page")||1),size=Number(params.get("pageSize")||24),start=(page-1)*size;
    return {items:rows.slice(start,start+size),page,pageSize:size,hasMore:rows.length>start+size,appliedBudget:params.has("minPrice")||params.has("maxPrice")?{min:params.has("minPrice")?Number(params.get("minPrice")):null,max:params.has("maxPrice")?Number(params.get("maxPrice")):null,pricingUnit:params.get("pricingUnit")}:null};
  }

  if (pathname === "/api/items" && method === "POST") {
    if (!body.name || !Number(body.price) || !body.location) return { error: "Name, price and location are required.", status: 400 };
    const item = {
      id: "i" + (Date.now()),
      ownerName: me, ownerPhone: user.phone || "", ownerBrand: user.brand || "",
      paused: false, image: body.image || "", video: body.video || "",
      name: body.name, category: body.category, condition: body.condition,
      location: body.location, description: body.description,
      price: Number(body.price), pricingUnit: body.pricingUnit || "day",
      minPeriod: Number(body.minPeriod) || 1, maxPeriod: Number(body.maxPeriod) || 30,
      deposit: Number(body.deposit) || 0,
      deliveryAvailable: !!body.deliveryAvailable, riderDeliveryAvailable: !!body.riderDeliveryAvailable, deliveryFee: Number(body.deliveryFee) || 0
    };
    mockItems.unshift(item);
    return item;
  }

  const bookingsMatch = pathname.match(/^\/api\/items\/([^/]+)\/bookings$/);
  if (bookingsMatch && method === "GET") {
    return mockRentals.filter(r => r.itemId === bookingsMatch[1] && isOpen(r)).map(r => ({ startAt: r.startAt, endAt: r.endAt }));
  }

  const itemMatch = pathname.match(/^\/api\/items\/([^/]+)$/);
  if (itemMatch && (method === "PATCH" || method === "DELETE")) {
    const item = mockItems.find(i => i.id === itemMatch[1]);
    if (!item) return { error: "Item not found.", status: 404 };
    if (item.ownerName !== me) return { error: "That isn't your listing.", status: 403 };
    if (method === "DELETE") {
      if (mockRentals.some(r => r.itemId === item.id && isOpen(r))) return { error: "This item has an open rental.", status: 409 };
      mockItems = mockItems.filter(i => i.id !== item.id);
      return { ok: true };
    }
    ["name", "category", "condition", "location", "description", "pricingUnit", "image", "video"].forEach(k => { if (body[k] !== undefined) item[k] = body[k]; });
    ["price", "minPeriod", "maxPeriod", "deposit", "deliveryFee"].forEach(k => { if (body[k] !== undefined) item[k] = Number(body[k]); });
    ["deliveryAvailable", "riderDeliveryAvailable", "paused"].forEach(k => { if (body[k] !== undefined) item[k] = !!body[k]; });
    return item;
  }

  if (pathname === "/api/auth/account" && method === "DELETE") return { ok: true };
  if (pathname === "/api/notification-preferences" && method === "GET") return {inApp:true,email:false,push:false,emailAvailable:false,pushAvailable:false};
  if (pathname === "/api/notification-preferences" && method === "PUT") return {inApp:!!body.inApp,email:false,push:false,emailAvailable:false,pushAvailable:false};
  if (pathname === "/api/messages/conversations" && method === "GET") return [];
  if (pathname === "/api/messages/unread-count" && method === "GET") return { unreadMessages: 0 };
  if (pathname === "/api/messages/conversations" && method === "POST") return { conversationId: "demo", itemId: body.itemId, itemName: "Demo listing", withUserId: body.otherUserId, withUserName: "ShedShare member" };
  if (pathname === "/api/messages" && method === "GET") return [];
  if (pathname === "/api/messages" && method === "POST") return { id: String(Date.now()), conversationId: body.conversationId, senderId: String(user.id || ""), text: body.text, createdAt: new Date().toISOString() };
  if (pathname === "/api/rider/profile" && method === "GET") return { error: "No rider application was found.", status: 404 };

  if (pathname === "/api/rentals" && method === "GET") {
    if (query.includes("role=admin")) return mockRentals; // backend MUST verify the admin role server-side
    if (query.includes("role=owner")) return mockRentals.filter(r => r.ownerName === me);
    return mockRentals.filter(r => r.renterName === me);
  }

  if (pathname === "/api/rentals" && method === "POST") {
    const item = mockItems.find(i => i.id === body.itemId);
    if (!item) return { error: "Item not found.", status: 404 };
    if (item.paused) return { error: "This listing is paused.", status: 409 };
    const perUnit = Math.min(item.price, Math.max(lowestPrice(item), Number(body.pricePerUnit)));
    const units = Math.max(item.minPeriod || 1, Math.min(item.maxPeriod || 999, Math.round(Number(body.units) || 1)));
    const startAt = new Date(body.startAt);
    if (isNaN(startAt)) return { error: "Choose a start date.", status: 400 };
    const endAt = addPeriod(startAt, item.pricingUnit, units);
    if (endAt <= new Date()) return { error: "That start time is in the past.", status: 400 };
    const clash = mockRentals.some(r => r.itemId === item.id && isOpen(r) && overlaps(startAt, endAt, new Date(r.startAt), new Date(r.endAt)));
    if (clash) return { error: "Those dates were just booked. Pick different dates.", status: 409 };
    const rental = buildRental(item, me, perUnit, units, startAt, body.deliveryMethod);
    mockRentals.unshift(rental);
    return rental;
  }

  if(pathname==="/api/rental-summaries"&&method==="POST"){const item=mockItems.find(i=>i.id===String(body.itemId));if(!item)return {error:"Listing not found.",status:404};return {rentalId:"preview-inquiry",agreementId:"preview-agreement",version:1,terms:{listingId:item.id,itemName:item.name,renterId:"preview-renter",ownerId:item.ownerId||"preview-owner",startAt:new Date(body.startAt).toISOString(),endAt:addPeriod(new Date(body.startAt),item.pricingUnit,body.units).toISOString(),units:body.units,pricingUnit:item.pricingUnit,pricePerUnit:body.pricePerUnit,subtotal:body.pricePerUnit*body.units,totalPayable:body.pricePerUnit*body.units,deliveryFee:0,informationalDeposit:item.deposit||0,platformCommission:Math.round(body.pricePerUnit*body.units*PLATFORM_FEE_PERCENT/100)}};}
  if(pathname.startsWith("/api/rental-summaries/")&&pathname.endsWith("/accept")&&method==="POST")return {accepted:true,ready:true,rentalId:"preview-inquiry"};
  if(pathname==="/api/inspections"&&method==="POST")return {id:"preview-inspection",status:"requested",proposedAt:body.proposedAt,meetingLocation:body.meetingLocation};
  if(pathname==="/api/inspections"&&method==="GET")return [];
  if(pathname.startsWith("/api/inspections/")&&method==="PATCH")return {id:pathname.split("/").pop(),status:body.action};

  const actionMatch = pathname.match(/^\/api\/rentals\/([^/]+)\/(activate|complete|cancel)$/);
  if (actionMatch && method === "POST") {
    const rental = mockRentals.find(r => r.id === actionMatch[1]);
    if (!rental) return { error: "Rental not found.", status: 404 };
    rental.status = { activate: "active", complete: "completed", cancel: "cancelled" }[actionMatch[2]];
    return rental;
  }

  if (pathname === "/api/auth/login" && method === "POST") {
    const email = (body.email || "you@example.com").toLowerCase();
    return { user: { name: email.split("@")[0], email, isAdmin: email === ADMIN_EMAIL } };
  }
  if (pathname === "/api/auth/signup" && method === "POST") {
    const email = (body.email || "you@example.com").toLowerCase();
    return { user: { name: body.name || "You", phone: body.phone || "", brand: body.brand || "", bankName: body.bankName || "", accountNumber: body.accountNumber || "", email, isAdmin: email === ADMIN_EMAIL } };
  }
  if (pathname === "/api/referrals/me" && method === "GET") return { code:"SHARE2026", enabled:false, promotionalCreditBalance:0, ownReferral:null, rules:[], referrals:[] };
  if (pathname === "/api/auth/google" && method === "POST") return { error: "Google sign-in requires the real backend.", status: 503 };
  return {};
}

/* ---------- session ---------- */
function renderSession() {
  syncAiControls();
  const externalButton=document.getElementById("externalSearchButton");if(externalButton)externalButton.hidden=!session||!externalSearchEnabled;
  const box = document.getElementById("sessionBox");
  const headerSignIn = document.getElementById("headerSignIn");
  if (headerSignIn) headerSignIn.hidden = Boolean(session);
  box.innerHTML = session
    ? `${esc(session.user.name)}${session.user.isAdmin ? ' <span class="admin-tag">admin</span>' : ""} <button id="signOut">Sign out</button>`
    : "";
  const signOut = document.getElementById("signOut");
  if (signOut) signOut.addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST", body: "{}" });
    clearPendingRentalDraft();
    session = null; activeConversation = null; renderSession();
    document.getElementById("listerList").replaceChildren();
    document.getElementById("adminDeliveryList").replaceChildren();
    document.getElementById("contactFlagList").replaceChildren();
    document.getElementById("allTxList").replaceChildren();
    activateSection("browse");
  });
  document.querySelectorAll(".signed-in-tab").forEach(button => {
    const tab = button.dataset.tab;
    button.hidden = !session || (tab === "dashboard" && isAdmin()) || (tab === "admin" && !isAdmin()) || (tab === "rider" && !session.user.isRider && !isAdmin());
  });
  const riderShortcut = document.getElementById("topNavRider");
  if (riderShortcut) riderShortcut.hidden = !session;
  const riderEntry = document.getElementById("riderEntryButton");
  if (riderEntry) riderEntry.textContent = session?.user?.isRider || isAdmin() ? "Rider dashboard" : "Become a rider";
  syncNotificationPolling();
  syncMessageUnreadPolling();
  if (session && !isAdmin() && document.getElementById("dashboard").getAttribute("aria-current") === "true") document.body.classList.add("user-mode");
  const postTab = document.querySelector('[data-tab="post"]');
  if (postTab) postTab.hidden = !session || isAdmin();
}
document.getElementById("headerSignIn")?.addEventListener("click", () => {
  const panel = document.getElementById("authPanel");
  panel.hidden = false;
  document.querySelector('[data-authtab="login"]')?.click();
  panel.scrollIntoView({ behavior: "smooth", block: "center" });
  document.getElementById("li-email")?.focus({ preventScroll: true });
});

/* ---------- categories ---------- */
function populateCategorySelects() {
  const opts = CATEGORIES.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  document.getElementById("i-cat").innerHTML = opts;
  document.getElementById("q-cat").innerHTML = `<option value="">All categories</option>` + opts;
  document.getElementById("catPills").innerHTML =
    `<button type="button" class="cat-pill-btn" data-cat="" aria-pressed="true">All</button>` +
    CATEGORIES.map(c => `<button type="button" class="cat-pill-btn" data-cat="${esc(c)}" aria-pressed="false">${esc(c)}</button>`).join("");
  document.querySelectorAll(".cat-pill-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".cat-pill-btn").forEach(b => b.setAttribute("aria-pressed", "false"));
      btn.setAttribute("aria-pressed", "true");
      document.getElementById("q-cat").value = btn.dataset.cat;
      filterItems();
    });
  });
}

/* ---------- browse: search, filter, scroll reveal ---------- */
async function loadItems() {
  return loadBudgetSearch(false);
}

let browseSearchRequestId = 0, browseSearchPage = 1, browseSearchHasMore = false, browseSearchTimer = null;
async function loadBudgetSearch(append = false) {
  const requestId=++browseSearchRequestId;
  const minRaw=document.getElementById("q-minprice").value.trim(),maxRaw=document.getElementById("q-maxprice").value.trim();
  const minPrice=minRaw===""?null:Number(minRaw),maxPrice=maxRaw===""?null:Number(maxRaw),pricingUnit=document.getElementById("q-pricing-unit").value;
  const note=document.getElementById("budgetSearchNote"),more=document.getElementById("loadMoreListings");
  if ((minPrice!==null&&(!Number.isFinite(minPrice)||minPrice<0||minPrice>9999999999.99))||(maxPrice!==null&&(!Number.isFinite(maxPrice)||maxPrice<0||maxPrice>9999999999.99))) { note.textContent="Enter a valid budget from ₦0 to ₦9,999,999,999.99.";more.hidden=true;document.getElementById("itemGrid").hidden=true;return; }
  if(minPrice!==null&&maxPrice!==null&&minPrice>maxPrice){note.textContent="Minimum budget cannot exceed maximum budget.";more.hidden=true;document.getElementById("itemGrid").hidden=true;return;}
  if((minPrice!==null||maxPrice!==null)&&!pricingUnit){note.textContent="Choose a rental period so your budget compares like with like.";more.hidden=true;document.getElementById("itemGrid").hidden=true;return;}
  const durationRaw=document.getElementById("q-duration").value.trim(),duration=durationRaw===""?null:Number(durationRaw);
  if(duration!==null&&(!Number.isInteger(duration)||duration<1||duration>744)){note.textContent="Rental duration must be a whole number from 1 to 744 units.";more.hidden=true;document.getElementById("itemGrid").hidden=true;return;}
  const availabilityRaw=document.getElementById("q-availability").value;
  if(availabilityRaw&&(!pricingUnit||!Number.isInteger(duration)||duration<1)){note.textContent="Choose a rental unit and duration to check availability for your dates.";more.hidden=true;document.getElementById("itemGrid").hidden=true;return;}
  let availabilityStart="";
  if(availabilityRaw){const date=new Date(availabilityRaw);if(Number.isNaN(date.getTime())||date<=new Date()){note.textContent="Choose a future availability date.";more.hidden=true;document.getElementById("itemGrid").hidden=true;return;}availabilityStart=date.toISOString();}
  syncBrowseQueryState();
  const page=append?browseSearchPage+1:1,params=new URLSearchParams({page:String(page),pageSize:"24",sort:document.getElementById("q-sort").value||"relevance"});
  const text=document.getElementById("q-search").value.trim(),location=document.getElementById("q-location").value.trim();
  if(text)params.set("q",text);if(location&&location.toLowerCase()!=="nearby")params.set("location",location);
  if(browseCoordinates){params.set("lat",String(browseCoordinates.lat));params.set("lng",String(browseCoordinates.lng));}
  const category=document.getElementById("q-cat").value;if(category)params.set("category",category);
  if(minPrice!==null)params.set("minPrice",String(minPrice));if(maxPrice!==null)params.set("maxPrice",String(maxPrice));if(pricingUnit)params.set("pricingUnit",pricingUnit);
  if(duration!==null)params.set("duration",String(duration));if(availabilityStart)params.set("availabilityStart",availabilityStart);
  note.textContent=append?"Loading more matching listings…":"Searching available listings…";
  if(!append)document.getElementById("itemGrid").hidden=true;
  const result=await api(`/api/items/search?${params.toString()}`);
  if(requestId!==browseSearchRequestId)return;
  if(result?.error){if(!append)itemsCache=[];itemsCacheInitialized=true;browseSearchHasMore=false;renderItemCards(itemsCache);document.getElementById("itemGrid").hidden=itemsCache.length===0;document.getElementById("browseResultCount").textContent="Search unavailable";note.textContent=result.error;more.hidden=true;return;}
  const rows=asList(result?.items);
  itemsCache=append?[...itemsCache,...rows]:rows;
  browseSearchPage=page;browseSearchHasMore=Boolean(result?.hasMore);itemsCacheInitialized=true;
  renderItemCards(itemsCache);
  document.getElementById("itemGrid").hidden=itemsCache.length===0;
  document.getElementById("browseResultCount").textContent=`${itemsCache.length}${browseSearchHasMore?"+":""} ${itemsCache.length===1?"listing":"listings"} found`;
  const hasBudget=minPrice!==null||maxPrice!==null;
  note.textContent=itemsCache.length===0?(hasBudget?`No available listings match this ${pricingUnit} budget and the selected filters. Results outside the budget are not included.`:"No available listings match these filters."):hasBudget?`Showing prices per ${pricingUnit}. Rental totals, deposits, delivery, platform, and payment charges are shown separately before booking or checkout.`:"Listing prices are per their stated rental unit. Known deposits and delivery charges are shown on each card; platform and payment charges are shown before checkout.";
  more.hidden=!browseSearchHasMore;
  const emptyActions=document.getElementById("noResultsActions");if(emptyActions)emptyActions.hidden=itemsCache.length>0;
  if(emptyActions&&itemsCache.length===0){const hasBudget=minPrice!==null||maxPrice!==null;emptyActions.querySelector("strong").textContent=hasBudget?"No listings found within this budget":"Nothing available near you yet";emptyActions.querySelector("p").textContent=hasBudget?"No out-of-budget listings are included. Try a wider budget, another rental unit, or a different location.":"Tell nearby owners what you need or get a message when a match is listed.";}
  const externalButton=document.getElementById("externalSearchButton");if(externalButton)externalButton.hidden=itemsCache.length>0||!text||!externalSearchEnabled||!session;
  if(!document.getElementById("listingMap").hidden&&mapsReady)renderBrowseMap();
}

function distanceKm(a, b) {
  const rad = value => value * Math.PI / 180, dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
let mapsReady = false, mapsFeatureEnabled=false, mapsUnavailableMessage="Add a restricted GEOAPIFY_MAPS_BROWSER_KEY and GEOAPIFY_API_KEY to the server .env, then restart ShedShare.", geoapifyMapsKey="", browseMap, browseLocationMarker=null, pickupLocationRequestId=0, browseMarkers = [], externalSearchMap=null, externalSearchEnabled=false, minListingsForExternal=100, profileBrowseLocation=null, usedMyLocation=false, addressSuggestTimer=null, addressSuggestRequest=0, paystackAvailable=false,manualPaymentAvailable=false,paymentMode="manual";
document.getElementById("i-address").addEventListener("input",()=>{pickupLocationRequestId++;document.getElementById("i-place-id").value="";document.getElementById("i-lat").value="";document.getElementById("i-lng").value="";scheduleAddressSuggestions();});
["i-city","i-state","i-area"].forEach(id=>document.getElementById(id).addEventListener("input",()=>{pickupLocationRequestId++;}));
function loadLeaflet(){
  if(window.L)return Promise.resolve(true);
  if(!document.querySelector('link[data-leaflet-css]')){const css=document.createElement("link");css.rel="stylesheet";css.href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";css.dataset.leafletCss="true";document.head.appendChild(css);}
  return new Promise(resolve=>{const script=applyCspNonce(document.createElement("script"));script.src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";script.onload=()=>resolve(Boolean(window.L));script.onerror=()=>resolve(false);document.head.appendChild(script);});
}
function createGeoapifyMap(element,center=[9.082,8.675],zoom=6){
  const map=L.map(element,{maxBounds:L.latLngBounds([4.2,2.6],[13.9,14.8]),maxBoundsViscosity:.8,scrollWheelZoom:false}).setView(center,zoom);
  L.tileLayer(`https://maps.geoapify.com/v1/tile/osm-carto/{z}/{x}/{y}.png?apiKey=${encodeURIComponent(geoapifyMapsKey)}`,{maxZoom:20,attribution:'<a href="https://www.geoapify.com/" target="_blank" rel="noopener">Powered by Geoapify</a> | <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>'}).addTo(map);
  return map;
}
function initializeOwnerAutocomplete(){
  const input=document.getElementById("i-address"),suggestions=document.getElementById("ownerAddressSuggestions");
  if(!input||input.dataset.autocompleteReady)return;
  input.dataset.autocompleteReady="true";
  input.addEventListener("keydown",event=>{if(event.key==="Escape")suggestions.hidden=true;});
  document.addEventListener("click",event=>{if(!event.target.closest(".location-autocomplete"))suggestions.hidden=true;});
}
function scheduleAddressSuggestions(){
  const input=document.getElementById("i-address"),host=document.getElementById("ownerAddressSuggestions");
  if(!input||!host)return;
  const query=input.value.trim(),request=++addressSuggestRequest;clearTimeout(addressSuggestTimer);
  if(query.length<3){host.hidden=true;host.replaceChildren();return;}
  addressSuggestTimer=setTimeout(async()=>{
    const result=await api("/api/locations/autocomplete",{method:"POST",body:JSON.stringify({query})});
    if(request!==addressSuggestRequest||input.value.trim()!==query)return;
    host.replaceChildren();
    (result?.suggestions||[]).forEach(suggestion=>{const button=document.createElement("button");button.type="button";button.className="location-suggestion";button.setAttribute("role","option");button.textContent=suggestion.address;button.addEventListener("click",()=>{host.hidden=true;host.replaceChildren();setOwnerLocation({address:suggestion.address,city:suggestion.city,state:suggestion.state,area:suggestion.area,lat:suggestion.latitude,lng:suggestion.longitude});});host.append(button);});
    host.hidden=!host.childElementCount;
  },280);
}
function setOwnerLocation(data) {
  pickupLocationRequestId++;
  document.getElementById("i-address").value = data.address || "";
  document.getElementById("i-city").value = data.city || document.getElementById("i-city").value;
  document.getElementById("i-state").value = data.state || document.getElementById("i-state").value;
  document.getElementById("i-area").value = data.area || document.getElementById("i-area").value;
  document.getElementById("i-lat").value = data.lat ?? "";
  document.getElementById("i-lng").value = data.lng ?? "";
  document.getElementById("i-place-id").value = data.placeId || "";
  document.getElementById("itemLocationStatus").textContent = data.lat != null && data.lng != null ? "Address selected. ShedShare will save its location coordinates with this address." : "Enter the pickup address, city, state, and area manually, or use your current location.";
}
async function applyDevicePickupLocation(position,requestId) {
  const status=document.getElementById("itemLocationStatus");
  const lat=position.coords.latitude,lng=position.coords.longitude,accuracyMeters=position.coords.accuracy;
  document.getElementById("i-lat").value=lat;document.getElementById("i-lng").value=lng;document.getElementById("i-place-id").value=`pin:${lat},${lng}`;
  const accuracyNote=Number.isFinite(accuracyMeters)?accuracyMeters>250?` The device's location estimate is only accurate to about ±${Math.round(accuracyMeters)} m.`:` Device reports about ±${Math.round(accuracyMeters)} m accuracy.`:"";
  status.textContent="Location found. Looking up the nearest pickup address…";
  const result=await api("/api/locations/reverse",{method:"POST",body:JSON.stringify({latitude:lat,longitude:lng})});
  if(requestId!==pickupLocationRequestId)return;
  if(result?.error){status.textContent=`Your device location was saved, but the address lookup failed. Enter the address, area, city, and state manually.${accuracyNote}`;return;}
  setOwnerLocation({address:result.pickupAddress,city:result.city,state:result.state,area:result.areaName,lat,lng,placeId:result.placeId||`pin:${lat},${lng}`});
  status.textContent=`Location found. Review the suggested pickup address before saving.${accuracyNote}`;
}
function useDevicePickupLocation() {
  if(!navigator.geolocation){showToast("This device does not support location access. Enter the pickup address manually.");return;}
  const requestId=++pickupLocationRequestId;
  const status=document.getElementById("itemLocationStatus"),options={enableHighAccuracy:true,timeout:20000,maximumAge:0};
  let bestPosition=null,watchId=null,finished=false;
  status.textContent="Finding your current location…";
  const finish=()=>{
    if(finished)return;finished=true;clearTimeout(timer);if(watchId!==null)navigator.geolocation.clearWatch(watchId);
    if(requestId!==pickupLocationRequestId)return;
    if(bestPosition){applyDevicePickupLocation(bestPosition,requestId);return;}
    status.textContent="Could not get your current location. Check this device’s location permission, then try again or enter the pickup address manually.";
  };
  const timer=setTimeout(finish,15000);
  watchId=navigator.geolocation.watchPosition(position=>{
    if(requestId!==pickupLocationRequestId||finished)return;
    if(!bestPosition||position.coords.accuracy<bestPosition.coords.accuracy){bestPosition=position;status.textContent=`Location accuracy: about ±${Math.round(position.coords.accuracy)} m. Getting the best available fix…`;}
    if(position.coords.accuracy<=50)finish();
  },error=>{
    if(requestId!==pickupLocationRequestId||finished)return;
    if(error.code===1){finished=true;clearTimeout(timer);navigator.geolocation.clearWatch(watchId);status.textContent="Location permission was denied. Allow location access for ShedShare, then try again.";return;}
    if(bestPosition)finish();
  },options);
}
document.getElementById("usePickupLocationButton").addEventListener("click",useDevicePickupLocation);

function renderBrowseMap() {
  if (!mapsFeatureEnabled || !mapsReady) return;
  const mapEl = document.getElementById("listingMap"); mapEl.hidden = false;
  if (!browseMap) browseMap = createGeoapifyMap(mapEl,browseCoordinates?[browseCoordinates.lat,browseCoordinates.lng]:[9.082,8.675],browseCoordinates?12:6);
  if(browseCoordinates){const position=[browseCoordinates.lat,browseCoordinates.lng];if(!browseLocationMarker)browseLocationMarker=L.circleMarker(position,{radius:8,color:"#fff",weight:3,fillColor:"#2878dc",fillOpacity:1}).bindTooltip("Your location").addTo(browseMap);else browseLocationMarker.setLatLng(position);}else if(browseLocationMarker){browseLocationMarker.remove();browseLocationMarker=null;}
  const itemBounds = browseMap.getBounds();
  let markers = itemsCache.filter(item => item.latitude != null && item.longitude != null && (!itemBounds || itemBounds.contains([item.latitude, item.longitude])));
  const center = browseMap.getCenter();
  if (center) markers = markers.map(item => ({ ...item, distance: distanceKm({ lat: center.lat, lng: center.lng }, { lat: item.latitude, lng: item.longitude }) }));
  const category = document.getElementById("q-cat").value, minPrice=Number(document.getElementById("q-minprice").value),maxPrice = Number(document.getElementById("q-maxprice").value), pricingUnit=document.getElementById("q-pricing-unit").value,query = document.getElementById("q-search").value.trim().toLowerCase();
  markers = markers.filter(item => (!category || item.category === category) && (!Number.isFinite(minPrice)||document.getElementById("q-minprice").value===""||item.price>=minPrice) && (!Number.isFinite(maxPrice)||document.getElementById("q-maxprice").value===""||item.price<=maxPrice) && (!pricingUnit||item.pricingUnit===pricingUnit) && (!query || item.name.toLowerCase().includes(query)));
  browseMarkers.forEach(marker => marker.remove()); browseMarkers = [];
  markers.forEach(item => {
    const marker = L.marker([item.latitude, item.longitude], { title: item.name }).addTo(browseMap);
    const photo=safeImg(item.image);
    marker.bindPopup(`<div class="map-mini-card">${photo?`<img src="${photo}" alt="" width="160" height="90">`:""}<strong>${esc(item.name)}</strong><p>${esc(item.location || "")}</p><small>₦${Number(item.price).toLocaleString()}/${esc(item.pricingUnit)} · ${item.distance?.toFixed(1) || "—"} km</small><br><button type="button" data-map-rent="${esc(item.id)}">View item</button></div>`);
    marker.on("popupopen",event=>event.popup.getElement()?.querySelector(`[data-map-rent="${CSS.escape(String(item.id))}"]`)?.addEventListener("click",()=>openRentFlow(item.id),{once:true}));
    browseMarkers.push(marker);
  });
}
function debounceBrowseMap() { clearTimeout(browseReloadTimer); browseReloadTimer = setTimeout(() => { if (browseCoordinates && browseMap) { const center = browseMap.getCenter(); browseCoordinates = { lat: center.lat, lng: center.lng }; loadItems(); } else renderBrowseMap(); }, 350); }
document.getElementById("listViewToggle").addEventListener("click", () => { document.getElementById("listingMap").hidden = true; document.getElementById("itemGrid").hidden = false; document.getElementById("listViewToggle").setAttribute("aria-pressed", "true"); document.getElementById("mapViewToggle").setAttribute("aria-pressed", "false"); if(itemsCacheInitialized&&!itemsCache.length)showToast("Listings could not be loaded. Try your city or area again shortly."); });
document.getElementById("mapViewToggle").addEventListener("click", () => {
  if (!mapsFeatureEnabled || !mapsReady) { const message = document.getElementById("mapConfigMessage"); message.hidden = false; message.textContent = mapsUnavailableMessage; return; }
  document.getElementById("noResultsActions").hidden = true; document.getElementById("itemGrid").hidden = true; document.getElementById("listingMap").hidden = false; document.getElementById("mapViewToggle").setAttribute("aria-pressed", "true"); document.getElementById("listViewToggle").setAttribute("aria-pressed", "false");
  if (browseMap) browseMap.invalidateSize(); renderBrowseMap(); if (browseMap&&!browseMap._shedIdleListener) { browseMap.on("moveend", debounceBrowseMap); browseMap._shedIdleListener = true; }
});
async function resolveRequestLocation(){
  let typed=document.getElementById("q-location").value.trim();if(typed.toLowerCase()==="nearby")typed="";
  if(typed){const parts=typed.split(",").map(part=>part.trim()).filter(Boolean);if(parts.length>1)return{city:parts[0],state:parts.slice(1).join(", ")};const state=window.prompt(`Which state is ${typed} in?`);return state?.trim()?{city:typed,state:state.trim()}:null;}
  if(profileBrowseLocation?.city&&profileBrowseLocation?.state)return{...profileBrowseLocation};
  if(usedMyLocation&&browseCoordinates){const result=await api("/api/locations/reverse",{method:"POST",body:JSON.stringify({latitude:browseCoordinates.lat,longitude:browseCoordinates.lng})});if(result?.city&&result?.state)return{city:result.city,state:result.state};}
  const city=window.prompt("Enter the city where you want to find this item:");if(!city?.trim())return null;const state=window.prompt("Enter the state:");return state?.trim()?{city:city.trim(),state:state.trim()}:null;
}
document.getElementById("requestItemButton").addEventListener("click", async () => {
  if (!session) { document.getElementById("authPanel").hidden = false; return showToast("Sign in to request an item."); }
  const itemName=document.getElementById("q-search").value.trim();if(!itemName)return showToast("Enter the item you need in the search box first.");const location=await resolveRequestLocation();if(!location)return showToast("Choose a city and state to send your request.");
  const result=await api("/api/requests/nearby",{method:"POST",body:JSON.stringify({itemName,category:document.getElementById("q-cat").value||null,city:location.city,state:location.state,radiusKm:Number(document.getElementById("q-radius").value),maxPrice:Number(document.getElementById("q-maxprice").value)||null,...(browseCoordinates?{latitude:browseCoordinates.lat,longitude:browseCoordinates.lng}:{})})});
  showToast(result?.error||`Request posted for ${location.city}, ${location.state}. Nearby owners have been notified.`);
});
document.getElementById("notifyItemButton").addEventListener("click", async () => {
  if (!session) { document.getElementById("authPanel").hidden = false; return showToast("Sign in to save an availability alert."); }
  const itemName = document.getElementById("q-search").value.trim();if(!itemName)return showToast("Enter the item you need in the search box first.");const location=await resolveRequestLocation();if(!location)return showToast("Choose a city and state to save an alert.");
  const result = await api("/api/location-alerts", { method: "POST", body: JSON.stringify({ itemName, category: document.getElementById("q-cat").value || "Other", city: location.city, state: location.state, radiusKm: Number(document.getElementById("q-radius").value), maxPrice: Number(document.getElementById("q-maxprice").value) || null, ...(browseCoordinates ? {latitude:browseCoordinates.lat,longitude:browseCoordinates.lng} : {}) }) });
  showToast(result?.error || `Alert saved for ${location.city}, ${location.state}. We’ll message you when a matching item is listed.`);
});
function parseExternalLocation(value){const parts=String(value||"").split(",").map(part=>part.trim()).filter(Boolean);return parts.length>=2?{city:parts[0],state:parts.slice(1).join(", ")}:null;}
async function externalSearchLocation(){let typed=document.getElementById("q-location").value.trim();if(typed.toLowerCase()==="nearby")typed="";const typedPair=parseExternalLocation(typed);if(typedPair)return typedPair;if(typed){const state=window.prompt(`Choose the state for ${typed}:`);if(state?.trim())return{city:typed,state:state.trim()};return null;}if(profileBrowseLocation?.city&&profileBrowseLocation?.state)return{...profileBrowseLocation};if(usedMyLocation&&browseCoordinates){const reverse=await api("/api/locations/reverse",{method:"POST",body:JSON.stringify({latitude:browseCoordinates.lat,longitude:browseCoordinates.lng})});if(!reverse?.error&&reverse?.city&&reverse?.state)return{city:reverse.city,state:reverse.state};showToast(reverse?.error||"Enter your city and state to continue.");}const city=window.prompt("Enter your city:");if(!city?.trim())return null;const state=window.prompt("Enter your state:");if(!state?.trim())return null;return{city:city.trim(),state:state.trim()};}
function renderExternalSearchResults(payload,city,state){const host=document.getElementById("externalSearchResults");if(!host)return;const results=asList(payload?.results);if(payload?.error||!results.length){host.innerHTML=`<p class="fine">${esc(payload?.error||"No businesses found nearby. Try widening the area.")}</p><button type="button" class="btn-outline" id="widenExternalArea">Widen area</button>`;host.querySelector("#widenExternalArea")?.addEventListener("click",()=>{const area=window.prompt("Enter a wider city and state (for example, Yaba, Lagos):",`${city}, ${state}`);if(area){document.getElementById("q-location").value=area;runExternalSearch();}});return;}host.innerHTML=`<p class="external-search-notice">These businesses may rent this item. Call to confirm availability and price.</p><div id="externalBusinessMap" class="listing-map"></div><div class="external-business-list">${results.map(place=>`<article class="history-card"><h3>${esc(place.name)}</h3><p>${esc(place.address)}</p><p class="fine">${place.rating==null?"":`Rating ${esc(place.rating)} · `}${place.openNow==null?"":place.openNow?"Open now":"Currently closed"}${place.distanceKm==null?"":` · ${Number(place.distanceKm).toFixed(1)} km`}</p><div class="row-actions">${place.callUrl?`<a class="btn-outline" href="${esc(API_BASE+place.callUrl)}">Call${place.phone?` ${esc(place.phone)}`:""}</a>`:""}${place.whatsappUrl?`<a class="btn-outline" href="${esc(API_BASE+place.whatsappUrl)}">WhatsApp</a>`:""}<a class="btn-outline" href="${esc(API_BASE+place.directionsUrl)}">Directions</a><button class="btn-outline" type="button" data-business-invite="true">Is this your business? List on ShedShare</button></div></article>`).join("")}</div><p class="fine google-attribution">${esc(payload.attribution||"Google Maps")}</p>`;host.querySelectorAll("[data-business-invite]").forEach(button=>button.addEventListener("click",()=>{document.getElementById("authPanel").hidden=false;document.querySelector('[data-authtab="signup"]')?.click();document.getElementById("authPanel").scrollIntoView({behavior:"smooth"});}));}
function renderExternalGeoapifyMap(results){const host=document.getElementById("externalBusinessMap");if(!host||!mapsReady||!Array.isArray(results))return;if(externalSearchMap){externalSearchMap.remove();externalSearchMap=null;}externalSearchMap=createGeoapifyMap(host,[9.082,8.675],11);const points=[];for(const place of results){if(place.lat==null||place.lng==null)continue;const point=[Number(place.lat),Number(place.lng)];points.push(point);const card=[...document.querySelectorAll("#externalSearchResults .history-card")].find(el=>el.querySelector("h3")?.textContent===place.name);L.marker(point,{title:place.name}).addTo(externalSearchMap).on("click",()=>card?.scrollIntoView({behavior:"smooth",block:"center"}));}if(points.length>1)externalSearchMap.fitBounds(L.latLngBounds(points),{padding:[24,24],maxZoom:14});else if(points.length)externalSearchMap.setView(points[0],14);setTimeout(()=>externalSearchMap.invalidateSize(),0);}
async function runExternalSearch(){const host=document.getElementById("externalSearchResults"),item=document.getElementById("q-search").value.trim();if(!mapsFeatureEnabled||!externalSearchEnabled)return;if(!session){document.getElementById("authPanel").hidden=false;return showToast("Sign in to search nearby businesses.");}if(!item){showToast("Enter the item name before searching nearby businesses.");return;}const location=await externalSearchLocation();if(!location?.city||!location?.state){showToast("Choose a city and state before searching nearby businesses.");return;}host.innerHTML="<p class=\"fine\">Searching nearby businesses…</p>";const result=await api("/api/external-search/search",{method:"POST",body:JSON.stringify({item,city:location.city,state:location.state})});renderExternalSearchResults(result,location.city,location.state);renderExternalGeoapifyMap(result?.results);}
document.getElementById("externalSearchButton").addEventListener("click",runExternalSearch);
async function loadMaps() {
  initializeOwnerAutocomplete();
  const config = await fetch(`${API_BASE}/api/config`, { credentials: "include" }).then(res => res.ok ? res.json() : {}).catch(() => ({}));
  mapsFeatureEnabled=Boolean(config.mapsEnabled);
  paystackAvailable=Boolean(config.paystackAvailable);
  paymentMode=config.paymentMode||"manual";manualPaymentAvailable=paymentMode==="manual";
  externalSearchEnabled=Boolean(config.externalSearchEnabled);minListingsForExternal=Number(config.minListingsForExternal)||100;
  const externalButton=document.getElementById("externalSearchButton");if(externalButton)externalButton.hidden=!externalSearchEnabled||!session;
  if (!mapsFeatureEnabled || !config.mapTilesKey) { mapsUnavailableMessage=config.mapsDiagnostic || "Geoapify maps are turned off by the ShedShare administrator."; const note = document.getElementById("mapConfigMessage"); note.hidden = false; note.textContent = mapsUnavailableMessage; document.getElementById("listingMap").hidden = true; return; }
  geoapifyMapsKey=config.mapTilesKey;
  const loaded=await loadLeaflet();
  if(!loaded){mapsUnavailableMessage="The map library could not load. Check your connection and try again.";const note=document.getElementById("mapConfigMessage");note.hidden=false;note.textContent=mapsUnavailableMessage;return;}
  mapsReady = true;
  if (!document.getElementById("listingMap").hidden) renderBrowseMap();
}
if (API_BASE && !PREVIEW_MODE) {
  loadMaps();
  if(session) api("/api/items/profile-location").then(profile=>{if(profile?.city&&profile?.state){profileBrowseLocation={city:profile.city,state:profile.state};if(!document.getElementById("q-location").value)document.getElementById("q-location").value=[profile.city,profile.state].join(", ");}});
}

function filterItems() { browseSearchRequestId+=1;clearTimeout(browseSearchTimer);document.getElementById("itemGrid").hidden=true;document.getElementById("budgetSearchNote").textContent="Updating matches…";browseSearchTimer=setTimeout(()=>loadBudgetSearch(false),220); }
let browseCoordinates = null;
let browseReloadTimer = null;
function syncBrowseQueryState(){
  try{const url=new URL(window.location.href),state={browseQ:document.getElementById("q-search").value.trim(),browseLocation:document.getElementById("q-location").value.trim(),browseCategory:document.getElementById("q-cat").value,budgetMin:document.getElementById("q-minprice").value.trim(),budgetMax:document.getElementById("q-maxprice").value.trim(),priceUnit:document.getElementById("q-pricing-unit").value,duration:document.getElementById("q-duration").value.trim(),availableFrom:document.getElementById("q-availability").value,sort:document.getElementById("q-sort").value};for(const [key,value] of Object.entries(state)){if(value)url.searchParams.set(key,value);else url.searchParams.delete(key);}window.history.replaceState({},"",url.pathname+url.search+url.hash);}catch(_error){}
}
function restoreBrowseQueryState(){
  try{const params=new URLSearchParams(window.location.search),state=[["browseQ","q-search"],["browseLocation","q-location"],["browseCategory","q-cat"],["budgetMin","q-minprice"],["budgetMax","q-maxprice"],["priceUnit","q-pricing-unit"],["duration","q-duration"],["availableFrom","q-availability"],["sort","q-sort"]];for(const [param,id] of state){if(params.has(param))document.getElementById(id).value=params.get(param);}const category=document.getElementById("q-cat").value;document.querySelectorAll(".cat-pill-btn").forEach(button=>button.setAttribute("aria-pressed",String(button.dataset.cat===category)));}catch(_error){}
}
["q-search", "q-location", "q-minprice", "q-maxprice", "q-pricing-unit", "q-duration", "q-availability", "q-sort"].forEach(id => document.getElementById(id).addEventListener("input", filterItems));
document.getElementById("loadMoreListings").addEventListener("click",()=>loadBudgetSearch(true));
document.getElementById("q-location").addEventListener("input", () => { browseCoordinates = null; });
document.getElementById("useMyLocation").addEventListener("click", () => {
  if (!navigator.geolocation) return showToast("Location isn't available on this device. Search by city or area instead.");
  const button = document.getElementById("useMyLocation");
  button.disabled = true;
  button.textContent = "Finding precise location…";
  let bestPosition = null, watchId = null, finished = false;
  const finish = (error) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    button.disabled = false;
    button.textContent = "Use my location";
    if (!bestPosition) return showToast(error || "Couldn't get your location. Check permission or search by city or area.");
    browseCoordinates = { lat: bestPosition.coords.latitude, lng: bestPosition.coords.longitude };
    usedMyLocation = true;
    document.getElementById("q-location").value = "Nearby";
    if (browseMap) { browseMap.setView([browseCoordinates.lat, browseCoordinates.lng], 16); renderBrowseMap(); }
    loadItems();
    const accuracy = Math.round(bestPosition.coords.accuracy);
    showToast(`Showing nearest listings from your location (device accuracy about ±${accuracy} m).`);
  };
  const timer = setTimeout(() => finish(), 15000);
  watchId = navigator.geolocation.watchPosition(position => {
    if (finished) return;
    if (!bestPosition || position.coords.accuracy < bestPosition.coords.accuracy) bestPosition = position;
    if (position.coords.accuracy <= 25) finish();
  }, error => {
    if (error.code === 1) finish("Location permission wasn't granted. Search by city or area instead.");
    else if (bestPosition) finish();
  }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
});
document.getElementById("exploreSearch")?.addEventListener("click", () => { browseCoordinates = null; loadItems(); });
document.getElementById("q-location").addEventListener("keydown", event => { if(event.key==="Enter"){event.preventDefault();browseCoordinates=null;loadItems();} });
document.getElementById("q-cat").addEventListener("change", filterItems);
document.getElementById("exploreBrowse")?.addEventListener("click", () => document.getElementById("q-search").focus({preventScroll:false}));

let eventInventory = [];
function eventDurationUnits(item) {
  const hours=Number(document.getElementById("eventDuration").value||0), divisor={hour:1,day:24,week:168}[item.pricingUnit]||24;
  return Math.ceil(hours/divisor);
}
function selectedEventItemIds(){return [...document.querySelectorAll("[data-event-item]:checked")].map(input=>input.value);}
function renderEventInventory(rows){
  const host=document.getElementById("eventInventoryList");eventInventory=asList(rows);
  host.innerHTML=eventInventory.length?eventInventory.map(item=>{const units=eventDurationUnits(item),durationOk=units>=item.minPeriod&&units<=item.maxPeriod,available=item.available&&durationOk&&!myItemsCache.some(owned=>String(owned.id)===item.id);return `<label class="event-inventory-card ${available?"":"unavailable"}">${item.image?`<img src="${esc(item.image)}" alt="">`:`<span class="event-inventory-placeholder">◇</span>`}<span class="event-inventory-copy"><strong>${esc(item.name)}</strong><small>${esc(item.category)} · ${money(item.price)}/${esc(item.pricingUnit)} · ${esc(item.ownerName)}</small><small>${esc(item.location||"Location not listed")}</small><small>${item.deliveryAvailable?`Owner delivery may be available (listed fee ${money(item.deliveryFee)}).`:"Pickup shown; ask the lister about arrangements."}${item.riderDeliveryAvailable?" Rider delivery may be available; separate rider quote/payment applies.":""}</small><small class="${available?"event-available":"event-unavailable"}">${available?`Available to request · estimate ${money(item.price*units)}`:!durationOk?"Duration outside this listing’s rental limits":item.available?"Your own listing":"Booked or unavailable for these dates"}</small></span><input type="checkbox" data-event-item value="${esc(item.id)}" ${available?"":"disabled"} aria-label="Add ${esc(item.name)}"></label>`;}).join(""):`<div class="empty">No event-related listings matched these dates. Try another date or broaden your search.</div>`;
  host.querySelectorAll("[data-event-item]").forEach(input=>input.addEventListener("change",updateEventSelection));updateEventSelection();
}
function updateEventSelection(){
  const ids=selectedEventItemIds(),selected=eventInventory.filter(item=>ids.includes(item.id)),sum=selected.reduce((total,item)=>total+item.price*eventDurationUnits(item),0),owners=new Set(selected.map(item=>item.ownerId));
  const summary=document.getElementById("eventSelectedSummary");summary.hidden=!selected.length;summary.innerHTML=selected.length?`<strong>${selected.length} listing${selected.length===1?"":"s"} · ${money(sum)} estimated rental subtotal</strong><p>${owners.size} separate lister${owners.size===1?"":"s"} · delivery, deposits, availability confirmation and payment are handled separately for each booking. This collection does not reserve inventory.</p>`:"";
  document.getElementById("submitEventPlan").disabled=!selected.length;
}
async function refreshEventPlans(){
  const host=document.getElementById("eventPlanList");if(!session){host.innerHTML=`<p class="fine">Sign in to see event plans.</p>`;return;}
  host.innerHTML=`<p class="fine">Loading your event plans…</p>`;const response=await api("/api/event-plans");
  if(response?.error){host.innerHTML=`<p class="fine">${esc(response.error)} <button type="button" class="btn-outline" id="retryEventPlans">Retry</button></p>`;document.getElementById("retryEventPlans")?.addEventListener("click",refreshEventPlans);return;}const plans=asList(response);
  host.innerHTML=plans.length?plans.map(plan=>`<article class="event-plan-row"><div class="section-heading"><div><strong>${esc(plan.eventType)} · ${esc(plan.location)}</strong><p>${esc(fmtRange(plan.startAt,plan.endAt,"hour"))} · Budget ${plan.budget?money(plan.budget):"Not provided"} · ${esc(plan.status)}</p></div>${String(plan.renterId)===String(session.user.id)&&plan.status!=="cancelled"?`<button class="btn-outline" data-cancel-event-plan="${esc(plan.id)}">Cancel requests</button>`:""}</div>${plan.items.map(line=>`<div class="event-plan-line"><span><strong>${esc(line.name)}</strong><small>${esc(line.category)} · ${money(line.estimatedSubtotal)} estimate · ${esc(line.ownerName)} · ${esc(line.status)}</small>${line.note?`<small>${esc(line.note)}</small>`:""}</span>${String(line.ownerId)===String(session.user.id)&&line.status==="requested"?`<span class="event-plan-actions"><button type="button" class="btn-outline" data-event-response="accept" data-plan="${esc(plan.id)}" data-line="${esc(line.id)}">Interested</button><button type="button" class="btn-outline" data-event-response="reject" data-plan="${esc(plan.id)}" data-line="${esc(line.id)}">Decline</button></span>`:String(plan.renterId)===String(session.user.id)?`<span class="event-plan-actions">${line.status==="accepted"?`<button type="button" class="primary" data-event-book-item="${esc(line.itemId)}">Continue to separate booking</button>`:""}<button type="button" class="btn-outline" data-event-message data-item="${esc(line.itemId)}" data-owner="${esc(line.ownerId)}" data-owner-name="${esc(line.ownerName)}" data-item-name="${esc(line.name)}">Message lister</button></span>`:""}</div>`).join("")}<p class="fine">${String(plan.renterId)===String(session.user.id)?"Each response is separate. Interested listings still need a separate rental agreement and checkout; availability is checked again then.":`Renter: ${esc(plan.renterName)} · Responding does not reserve the listing.`}</p></article>`).join(""):`<div class="empty">You have no event plans or listing requests.</div>`;
}
document.getElementById("toggleEventPlanner").addEventListener("click",async event=>{const body=document.getElementById("eventPlannerBody"),show=body.hidden;body.hidden=!show;event.currentTarget.setAttribute("aria-expanded",String(show));event.currentTarget.textContent=show?"Hide planner":"Start planning";if(show){await refreshEventPlans();document.getElementById("eventDate").min=new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16);}});
document.addEventListener("click",event=>{if(!event.target.closest("[data-event-planner-nav]"))return;activateSection("browse");const body=document.getElementById("eventPlannerBody");if(body.hidden)document.getElementById("toggleEventPlanner").click();});
document.getElementById("loadEventInventory").addEventListener("click",async event=>{const startValue=document.getElementById("eventDate").value,duration=Number(document.getElementById("eventDuration").value);if(!startValue||!Number.isInteger(duration)||duration<1)return showToast("Choose an event date and a valid duration first.");const start=new Date(startValue);if(start<=new Date())return showToast("Choose a future event date.");const end=new Date(start.getTime()+duration*3600000),button=event.currentTarget;button.disabled=true;document.getElementById("eventPlannerStatus").textContent="Checking item listings and current bookings…";document.getElementById("eventInventoryList").innerHTML=`<div class="empty">Searching event inventory…</div>`;const result=await api(`/api/event-inventory?startAt=${encodeURIComponent(start.toISOString())}&endAt=${encodeURIComponent(end.toISOString())}`);button.disabled=false;if(result?.error){document.getElementById("eventPlannerStatus").textContent=result.error;document.getElementById("eventInventoryList").innerHTML=`<button type="button" class="btn-outline" id="retryEventInventory">Try again</button>`;document.getElementById("retryEventInventory").addEventListener("click",()=>document.getElementById("loadEventInventory").click());return;}document.getElementById("eventPlannerStatus").textContent=`${result.length} event-related listings checked. Availability can change until each lister confirms and a separate rental is booked.`;renderEventInventory(result);});
document.getElementById("eventDuration").addEventListener("change",()=>{if(eventInventory.length)renderEventInventory(eventInventory);});
document.getElementById("eventPlannerForm").addEventListener("submit",async event=>{event.preventDefault();const itemIds=selectedEventItemIds(),startValue=document.getElementById("eventDate").value;if(!session)return showToast("Sign in to request event rentals.");if(!itemIds.length)return showToast("Select at least one available listing.");if(!startValue||!document.getElementById("eventType").value||!document.getElementById("eventLocation").value.trim())return showToast("Complete the event details first.");const submit=document.getElementById("submitEventPlan"),budget=document.getElementById("eventBudget").value;submit.disabled=true;submit.textContent="Sending separate requests…";const result=await api("/api/event-plans",{method:"POST",body:JSON.stringify({eventType:document.getElementById("eventType").value,location:document.getElementById("eventLocation").value.trim(),startAt:new Date(startValue).toISOString(),durationHours:Number(document.getElementById("eventDuration").value),budget:budget===""?0:Number(budget),itemIds})});submit.disabled=false;submit.textContent="Send separate owner requests";if(result?.error){document.getElementById("eventPlannerStatus").textContent=result.error;return;}document.getElementById("eventPlannerStatus").textContent=`Requests sent to ${result.itemCount} listers. No booking has been reserved; each accepted item needs a separate agreement and checkout.`;document.getElementById("eventPlannerForm").reset();document.getElementById("eventDuration").value="8";eventInventory=[];document.getElementById("eventInventoryList").innerHTML="";document.getElementById("eventSelectedSummary").hidden=true;await refreshEventPlans();});
document.addEventListener("click",async event=>{const book=event.target.closest("[data-event-book-item]");if(book){await openRentFlow(book.dataset.eventBookItem);return;}const message=event.target.closest("[data-event-message]");if(message){await openConversation(message.dataset.item,message.dataset.owner,message.dataset.ownerName,message.dataset.itemName);return;}const response=event.target.closest("[data-event-response]");if(response){response.disabled=true;const result=await api(`/api/event-plans/${response.dataset.plan}/items/${response.dataset.line}/respond`,{method:"POST",body:JSON.stringify({action:response.dataset.eventResponse})});if(result?.error){response.disabled=false;return showToast(result.error);}await refreshEventPlans();return;}const cancel=event.target.closest("[data-cancel-event-plan]");if(cancel){cancel.disabled=true;const result=await api(`/api/event-plans/${cancel.dataset.cancelEventPlan}/cancel`,{method:"POST",body:"{}"});if(result?.error){cancel.disabled=false;return showToast(result.error);}await refreshEventPlans();}});

// Cards start hidden and glide in as they enter the viewport while scrolling.
let cardObserver = null;
function observeCards() {
  if (cardObserver) cardObserver.disconnect();
  const cards = document.querySelectorAll("#itemGrid .item-card");
  if (!("IntersectionObserver" in window)) { cards.forEach(c => c.classList.add("in-view", "settled")); return; }
  cardObserver = new IntersectionObserver((entries) => {
    entries.filter(e => e.isIntersecting).forEach((entry, i) => {
      const el = entry.target;
      const delay = i * 90; // cards arriving together are staggered
      el.classList.add("in-view");
      cardObserver.unobserve(el);
      setTimeout(() => { el.classList.add("settled"); }, 750 + delay);
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
  cards.forEach(c => cardObserver.observe(c));
}

function trustRoleSummary(summary,label){
  if(!summary)return `<section class="trust-role-card"><h3>${esc(label)}</h3><p class="fine">Trust information unavailable.</p></section>`;
  const avg=summary.averageRating==null?"No published reviews yet":`${Number(summary.averageRating).toFixed(1)} / 5 from ${Number(summary.reviewCount)} verified rental review${Number(summary.reviewCount)===1?"":"s"}`;
  const categories=summary.categoryAverages||{};
  const categoryRows=[["Communication",categories.communication],["Item accuracy",categories.accuracy],["Reliability",categories.reliability],["Fulfillment",categories.fulfillment]].filter(([,value])=>value!=null).map(([name,value])=>`<span>${esc(name)}: ${Number(value).toFixed(1)} / 5</span>`).join("");
  const reviews=asList(summary.reviews).map(review=>`<article class="trust-review"><div class="trust-review-heading"><strong>${Number(review.rating).toFixed(1)} / 5</strong><span>Verified rental · ${esc(review.authorRole)} · ${esc(new Date(review.createdAt).toLocaleDateString())}</span></div><p>${esc(review.body)}</p><small>${esc(review.itemName||"Completed rental")}</small>${session?`<details class="trust-report"><summary>Report this review</summary><form data-report-trust-review="${esc(review.id)}"><label>Reason<select name="reason" required><option value="">Choose reason</option><option value="abusive">Abusive content</option><option value="fraudulent">Fraudulent or misleading</option><option value="irrelevant">Irrelevant to the rental</option><option value="private_information">Private information</option><option value="other">Other</option></select></label><label>Details<textarea name="details" minlength="10" maxlength="1000" required></textarea></label><button class="btn-outline" type="submit">Send report</button></form></details>`:""}</article>`).join("");
  return `<section class="trust-role-card"><h3>${esc(label)}</h3><p class="trust-rating-line">${esc(avg)}</p><p>${Number(summary.completedVerifiedRentals)} completed, payment-verified rental${Number(summary.completedVerifiedRentals)===1?"":"s"}</p><p class="trust-account-status ${summary.account?.emailVerified?"is-verified":""}">Account email status: ${summary.account?.emailVerified?"verified":"not verified"}. This confirms email only, not identity or item ownership.</p>${categoryRows?`<div class="trust-category-scores">${categoryRows}</div>`:""}<div class="trust-reviews-list">${reviews||`<p class="fine">No published reviews yet.</p>`}</div></section>`;
}
async function openTrustProfile(userId,role="lister",displayName="ShedShare member"){
  const dialog=document.getElementById("trustProfileDialog"),body=document.getElementById("trustProfileBody");
  if(role==="renter"&&!session)return showToast("Sign in to view a renter trust profile.");
  document.getElementById("trustProfileTitle").textContent=`${displayName} · ${role} trust`;
  body.innerHTML=`<p class="fine">Loading ${esc(role)} trust information…</p>`;dialog.showModal();
  const result=await api(`/api/trust/${role}s/${encodeURIComponent(userId)}`);
  if(result?.error){body.innerHTML=`<p class="fine">${esc(result.error)}</p>`;return;}
  const summary=result?.[role];if(!summary){body.innerHTML=`<p class="fine">No ${esc(role)} trust record was returned.</p>`;return;}
  body.innerHTML=`<p class="fine">Trust comes from verified completed rentals and published reviews. The account indicator reports email verification only.</p>${trustRoleSummary(summary,role==="lister"?"Lister record":"Renter record")}`;
  body.querySelectorAll("[data-report-trust-review]").forEach(form=>form.addEventListener("submit",async event=>{event.preventDefault();const submit=form.querySelector("button[type=submit]"),details=form.elements.details.value.trim(),reason=form.elements.reason.value;submit.disabled=true;const report=await api(`/api/trust/reviews/${form.dataset.reportTrustReview}/reports`,{method:"POST",body:JSON.stringify({reason,details})});if(report?.error){submit.disabled=false;return showToast(report.error);}form.innerHTML=`<p class="fine">Report sent to ShedShare trust and safety.</p>`;showToast("Review report submitted.");}));
}
document.getElementById("closeTrustProfile").addEventListener("click",()=>document.getElementById("trustProfileDialog").close());
function renderItemCards(list) {
  const grid = document.getElementById("itemGrid");
  if (!list.length) { grid.innerHTML = `<div class="empty-filtered">No items match your search.</div>`; return; }
  grid.innerHTML = list.map(i => {
    const img = safeImg(i.image);
    const requestedUnit=document.getElementById("q-pricing-unit").value,matchedRate=(i.rentalPrices||[]).find(rate=>rate.pricingUnit===requestedUnit),displayRate=matchedRate||{price:i.price,pricingUnit:i.pricingUnit,minPeriod:i.minPeriod,maxPeriod:i.maxPeriod};
    const bookmarked = getBookmarkedIds().includes(String(i.id));
    return `
    <div class="item-card">
      ${img ? `<img class="item-photo" src="${img}" alt="${esc(i.name)}" loading="lazy">` : `<div class="item-photo-placeholder">${esc(i.category)}</div>`}
      ${session && !isAdmin() ? `<button type="button" class="item-bookmark ${bookmarked ? "is-saved" : ""}" data-bookmark="${esc(i.id)}" aria-label="${bookmarked ? "Remove saved item" : "Save item"}" aria-pressed="${bookmarked}">${bookmarked ? "♥" : "♡"}</button>` : ""}
      <span class="cat-pill">${esc(i.category)}</span>${i.video ? `<span class="has-video-tag">Video available</span>` : ""}
      <h3>${esc(i.name)}</h3>
      <div class="owner">${esc(i.ownerName)}${i.ownerBrand ? " (" + esc(i.ownerBrand) + ")" : ""}</div>
      <div class="loc">${esc(i.location || "")}</div>
      <div class="price">${money(displayRate.price)}/${esc(displayRate.pricingUnit)}</div>
      <button data-rent="${esc(i.id)}">View &amp; rent</button>
    </div>`;
  }).join("");
  grid.querySelectorAll("[data-rent]").forEach(btn => btn.addEventListener("click", () => openRentFlow(btn.dataset.rent)));
  grid.querySelectorAll("[data-lister-trust]").forEach(btn=>btn.addEventListener("click",()=>openTrustProfile(btn.dataset.listerTrust,"lister",btn.dataset.trustName)));
  grid.querySelectorAll("[data-bookmark]").forEach(btn => btn.addEventListener("click", () => toggleBookmark(btn.dataset.bookmark)));
  grid.querySelectorAll(".item-photo").forEach(el => el.addEventListener("click", () => openLightbox("image", el.src)));
  observeCards();
}

document.getElementById("listCta").addEventListener("click", () => { exitEditMode(); activateSection("post"); });

/* ---------- post / edit an item ---------- */
function renderSplitPreview() {
  const price = Number(document.getElementById("i-price").value) || 0;
  const unit = document.getElementById("i-unit").value;
  if (!price) { document.getElementById("splitPreview").innerHTML = ""; return; }
  const low = Math.max(0, price - MAX_DISCOUNT_NAIRA);
  const full = split(price), worst = split(low);
  document.getElementById("splitPreview").innerHTML = `
    <div class="split-row"><span class="label">Full price ${money(price)}/${esc(unit)}</span><span class="value payout">${money(full.owner)} to you <span class="fee">(${money(full.fee)} fee)</span></span></div>
    <div class="split-row"><span class="label">Lowest a renter can offer ${money(low)}/${esc(unit)}</span><span class="value payout">${money(worst.owner)} to you <span class="fee">(${money(worst.fee)} fee)</span></span></div>`;
}
document.getElementById("i-price").addEventListener("input", renderSplitPreview);
document.getElementById("i-unit").addEventListener("change", renderSplitPreview);

// Not based on claims data — a starting anchor for the one field the system actually
// knows at listing time (per-unit price), since there's no "item value" field to go on.
function updateDepositHint() {
  const cat = document.getElementById("i-cat").value;
  const price = Number(document.getElementById("i-price").value) || 0;
  const hintEl = document.getElementById("depositHint");
  if (cat === "Vehicles" && price) {
    hintEl.textContent = `Vehicles commonly use a deposit of roughly 3–5× the per-unit price here — about ${money(price * 3)}–${money(price * 5)}. Just a starting point; you know this vehicle's real risk better than we do.`;
  } else {
    hintEl.textContent = "";
  }
}
document.getElementById("i-price").addEventListener("input", updateDepositHint);
document.getElementById("i-cat").addEventListener("change", updateDepositHint);

let pendingImageDataUrl = "";
let pendingImageFile = null;
let existingImageUrl = "";
let existingOriginalImageUrl = "";
let enhancedPhotoChosen = false;
let sourceImageFile = null;
let sourceImageDataUrl = "";
let photoEnhancementRequestId = 0;
let enhancedPhotoCandidate = null;
const enhancedPhotoCache = new WeakMap();
let lastDescriptionDraftFile = null;
let descriptionRequestId = 0;

let descriptionDraftEditVersion = 0;
function buildDescriptionDetails() {
  return [document.getElementById("i-desc").value, document.getElementById("i-defects").value && `Known defects: ${document.getElementById("i-defects").value}`].filter(Boolean).join("\n").slice(0, 2000);
}

async function autoDraftDescription(file) {
  if (!aiAvailable || !file) return;
  const description = document.getElementById("i-desc");
  const status = document.getElementById("aiDescriptionStatus");
  if(description.value.trim()){
    lastDescriptionDraftFile=file;
    status.hidden=false;status.textContent="Your existing description was kept. Clear it before selecting a photo if you want a draft.";
    return;
  }
  const requestId = ++descriptionRequestId;
  const snapshot = { version: descriptionDraftEditVersion, value: description.value };
  const form = new FormData();
  form.append("name", document.getElementById("i-name").value.trim());
  form.append("category", document.getElementById("i-cat").value);
  form.append("condition", document.getElementById("i-cond").value);
  form.append("details", buildDescriptionDetails());
  form.append("image", file, file.name || "listing-photo");
  status.hidden = false;
  status.textContent = "Drafting the description…";
  syncAiControls();
  let result;
  try { result = await api("/api/ai/description", { method: "POST", body: form }); }
  catch (_error) {
    if (requestId === descriptionRequestId) { status.textContent = "Could not create the description draft. Your text was kept."; status.hidden = false; }
    return;
  }
  if (requestId !== descriptionRequestId) return;
  if (file !== sourceImageFile && file !== pendingImageFile) return;
  if (result?.error) {
    status.textContent = result.error;
    status.hidden = false;
    return;
  }
  const canFill = descriptionDraftEditVersion === snapshot.version && !snapshot.value.trim();
  if(canFill&&typeof result?.draft==="string"&&result.draft.trim())description.value=result.draft.trim();
  lastDescriptionDraftFile = file;
  status.textContent = canFill&&result?.draft?.trim()
    ? "Description draft added. Review and edit it before saving."
    : "Your existing description was kept. Clear it before choosing a photo if you want a draft.";
  status.hidden = false;
}

document.getElementById("i-desc").addEventListener("input",()=>{descriptionDraftEditVersion+=1;});

async function blobFileFromDataUrl(dataUrl,name="cloudinary-cleaned.jpg") {
  const response=await fetch(dataUrl);const blob=await response.blob();
  if(blob.type!=="image/jpeg"||!blob.size)throw new Error("Cloudinary returned an invalid image preview.");
  return new File([blob],name,{type:blob.type});
}

document.getElementById("i-image").addEventListener("change", (e) => {
  photoEnhancementRequestId += 1;
  enhancedPhotoCandidate = null;
  enhancedPhotoChosen = false;
  document.getElementById("cancelPhotoEnhancement").hidden = true;
  document.getElementById("photoCompare").hidden = true;
  const file = e.target.files[0];
  const wrap = document.getElementById("imagePreviewWrap");
  if (!file) { pendingImageDataUrl = ""; pendingImageFile = null; sourceImageFile = null; sourceImageDataUrl = ""; wrap.hidden = true; syncAiControls(); return; }
  if(!["image/jpeg","image/png","image/webp"].includes(file.type)){e.target.value="";showToast("Choose a JPEG, PNG, or WebP photo. HEIC and other formats are not supported yet.");return;}
  if(file.size>8*1024*1024){e.target.value="";showToast("This photo is larger than the 8 MiB upload limit. Choose a smaller photo.");return;}
  sourceImageFile = file;
  document.getElementById("cloudinaryPhotoStatus").hidden = false;
  document.getElementById("cloudinaryPhotoStatus").textContent = "Original photo selected. You can preview a Cloudinary cleanup before saving.";
  document.getElementById("restoreOriginalPhoto").hidden = true;
  pendingImageFile = file;
  const reader = new FileReader();
  reader.onload = () => {
    sourceImageDataUrl = reader.result;
    pendingImageDataUrl = sourceImageDataUrl;
    document.getElementById("imagePreview").src = pendingImageDataUrl;
    wrap.hidden = false;
    syncAiControls();
    if (aiAvailable) autoDraftDescription(file);
  };
  reader.readAsDataURL(file);
  syncAiControls();
});

document.getElementById("enhancePhoto").addEventListener("click", async event => {
  if (!cloudinaryPhotoAvailable)return showToast("Cloudinary photo cleaning is not enabled. The original photo remains available.");
  if (!hasEnhanceablePhoto()) return showToast("Choose or open a listing photo first.");
  const button = event.currentTarget;
  const status = document.getElementById("cloudinaryPhotoStatus");
  const requestId = ++photoEnhancementRequestId;
  const sourceFile = sourceImageFile;
  const cancelButton = document.getElementById("cancelPhotoEnhancement");
  const itemId=editingItemId;
  const cached=sourceFile?enhancedPhotoCache.get(sourceFile):null;
  if(cached){enhancedPhotoCandidate=cached;document.getElementById("photoOriginalCompare").src=sourceImageDataUrl||existingImageUrl;document.getElementById("photoEnhancedCompare").src=cached.dataUrl;document.getElementById("photoCompare").hidden=false;status.textContent="Showing the saved preview for this photo. No new Cloudinary request was made.";return;}
  button.disabled = true;
  cancelButton.hidden = false;
  status.textContent = "Sending your photo securely to Cloudinary for a preview…";
  const form=new FormData();if(sourceFile)form.append("image",sourceFile,sourceFile.name||"listing-photo");if(itemId)form.append("itemId",String(itemId));
  try {
    const result=await api("/api/items/photo-enhancement",{method:"POST",body:form,headers:{}});
    if(requestId!==photoEnhancementRequestId)return;
    if(result?.error)throw new Error(result.error);
    if(!result?.imageDataUrl?.startsWith("data:image/jpeg;base64,"))throw new Error("Cloudinary did not return a usable photo preview.");
    const file=await blobFileFromDataUrl(result.imageDataUrl);
    if(requestId!==photoEnhancementRequestId)return;
    enhancedPhotoCandidate={file,dataUrl:result.imageDataUrl};
    if(sourceFile)enhancedPhotoCache.set(sourceFile,enhancedPhotoCandidate);
    document.getElementById("photoOriginalCompare").src=sourceImageDataUrl||existingImageUrl;
    document.getElementById("photoEnhancedCompare").src = result.imageDataUrl;
    document.getElementById("photoCompare").hidden = false;
    status.textContent = "Cloudinary preview ready. Your original is still selected; choose Use Enhanced Photo or Keep Original.";
  } catch (error) {
    if(requestId!==photoEnhancementRequestId)return;
    const reason = String(error?.message || error || "Unknown processing error").replace(/\s+/g, " ").slice(0, 180);
    status.textContent = `Cloudinary photo cleaning failed: ${reason}. Your original is unchanged. You can retry or keep the original.`;
    console.error("Image enhancement failed:", error);
  } finally { if(requestId===photoEnhancementRequestId){button.disabled = !cloudinaryPhotoAvailable||!hasEnhanceablePhoto();cancelButton.hidden=true;} }
});

document.getElementById("cancelPhotoEnhancement").addEventListener("click",()=>{
  photoEnhancementRequestId+=1;
  document.getElementById("enhancePhoto").disabled=!cloudinaryPhotoAvailable||!hasEnhanceablePhoto();
  document.getElementById("cancelPhotoEnhancement").hidden=true;
  document.getElementById("cloudinaryPhotoStatus").textContent="Stopped waiting for the Cloudinary result. The original remains selected.";
});
document.getElementById("acceptEnhancedPhoto").addEventListener("click",()=>{
  if(!enhancedPhotoCandidate)return;
  if(enhancedPhotoCandidate.file.size>8*1024*1024){document.getElementById("cloudinaryPhotoStatus").textContent="This enhanced preview is larger than ShedShare’s 8 MiB upload limit. Keep the original photo.";return;}
  const selection=window.ShedSharePhotoSelection.accept(enhancedPhotoCandidate);if(!selection)return;
  pendingImageFile=selection.file;pendingImageDataUrl=selection.dataUrl;
  document.getElementById("imagePreview").src=pendingImageDataUrl;
  document.getElementById("imagePreviewWrap").hidden=false;
  document.getElementById("photoCompare").hidden=true;
  document.getElementById("restoreOriginalPhoto").hidden=false;
  enhancedPhotoChosen=true;
  document.getElementById("cloudinaryPhotoStatus").textContent="Enhanced photo selected. It replaces the stored listing image only when you save the listing.";
  enhancedPhotoCandidate=null;
});
document.getElementById("discardEnhancedPhoto").addEventListener("click",()=>{
  enhancedPhotoCandidate=null;document.getElementById("photoCompare").hidden=true;
  document.getElementById("cloudinaryPhotoStatus").textContent="Enhancement discarded. Your original photo remains selected.";
});

document.getElementById("restoreOriginalPhoto").addEventListener("click", () => {
  if (editingItemId && existingOriginalImageUrl && !sourceImageFile) {
    pendingImageFile=null;pendingImageDataUrl=existingOriginalImageUrl;existingImageUrl=existingOriginalImageUrl;enhancedPhotoChosen=false;
    document.getElementById("imagePreview").src=existingOriginalImageUrl;document.getElementById("restoreOriginalPhoto").hidden=true;
    document.getElementById("cloudinaryPhotoStatus").textContent="Original photo restored. Save changes to use it.";showToast("Original photo restored.");return;
  }
  const original=window.ShedSharePhotoSelection.restore({sourceFile:sourceImageFile,sourceDataUrl:sourceImageDataUrl,editingItemId,existingImageUrl});if(!original)return;
  pendingImageFile=original.file;pendingImageDataUrl=original.dataUrl;document.getElementById("imagePreview").src=original.dataUrl;
  enhancedPhotoChosen=false;
  document.getElementById("restoreOriginalPhoto").hidden = true;
  enhancedPhotoCandidate=null;
  document.getElementById("cloudinaryPhotoStatus").textContent = "Original photo restored.";
  showToast("Original photo restored.");
});

document.getElementById("i-image").addEventListener("change", () => {
  syncAiControls();
});

async function loadTestimonials() {
  const host = document.getElementById("testimonialTrack");
  const rows = asList(await api("/api/testimonials"));
  if (!host) return;
  if (!rows.length) { host.innerHTML = `<p class="fine">Member stories will appear here after they are approved.</p>`; return; }
  const cards = rows.map(row => `<article class="testimonial-card"><span class="testimonial-mark" aria-hidden="true">“</span><blockquote>${esc(row.body)}</blockquote><p>— ${esc(row.displayName)}</p></article>`).join("");
  host.classList.toggle("is-moving", rows.length > 1);
  host.innerHTML = rows.length > 1 ? `<div class="testimonial-run"><div class="testimonial-group">${cards}</div><div class="testimonial-group" aria-hidden="true">${cards}</div></div>` : cards;
}

let adminAiSettings = null;
async function refreshAdminAiSettings() {
  const result = await api("/api/admin/ai-settings");
  const toggle = document.getElementById("adminAiToggle");
  const status = document.getElementById("adminAiKeyStatus");
  if (result?.error) {
    adminAiSettings = null; aiAvailable = false; syncAiControls();
    status.textContent = result.error; toggle.disabled = true;
    return;
  }
  adminAiSettings = result;
  const geminiReady = Boolean(result.providers?.gemini?.configured);
  status.textContent = result.setupRequired ? "Run the database migration to create AI control settings." : `AI API key: ${geminiReady ? "ready" : "missing"}.${result.masterEnabled ? "" : " Set AI_FEATURES_ENABLED=true on the server to allow activation."}`;
  toggle.disabled = !result.enabled && (!result.masterEnabled || !geminiReady);
  toggle.textContent = result.enabled ? "Turn AI off" : "Use AI";
  toggle.setAttribute("aria-pressed", String(result.enabled));
  toggle.title = geminiReady ? "Enable or disable Gemini listing description drafts" : "Configure the Gemini API key on the server first";
  aiAvailable = result.enabled;
  syncAiControls();
  if (aiAvailable && sourceImageFile && lastDescriptionDraftFile !== sourceImageFile) autoDraftDescription(sourceImageFile);
}

document.getElementById("adminAiToggle").addEventListener("click", async () => {
  if (!isAdmin() || !adminAiSettings) return;
  const enabling = !adminAiSettings.enabled;
  const result = await api("/api/admin/ai-settings", { method: "PUT", body: JSON.stringify({ enabled: enabling }) });
  if (result?.error) { showToast(result.error); return refreshAdminAiSettings(); }
  showToast(enabling ? "Gemini description drafts are enabled." : "Gemini listing helpers are now off for everyone.");
  await refreshAdminAiSettings();
});
let adminMapSettings = null;
async function refreshAdminMapSettings() {
  const result = await api("/api/admin/map-settings");
  const toggle = document.getElementById("adminMapToggle");
  const status = document.getElementById("adminMapKeyStatus");
  if (result?.error) {
    adminMapSettings = null;
    status.textContent = result.error;
    toggle.disabled = true;
    return;
  }
  adminMapSettings = result;
  const keysReady = Boolean(result.browserKeyConfigured && result.geocodingKeyConfigured);
  status.textContent = `Geoapify browser map key: ${result.browserKeyConfigured ? "ready" : "missing"}. Server geocoding key: ${result.geocodingKeyConfigured ? "ready" : "missing"}. ${result.enabled ? "Maps are available to users." : "Maps are currently off; no map tiles are loaded by ShedShare."}`;
  toggle.disabled = !result.enabled && !keysReady;
  toggle.textContent = result.enabled ? "Turn Map off" : "Use Map";
  toggle.setAttribute("aria-pressed", String(result.enabled));
  toggle.title = keysReady ? "Enable or disable Geoapify maps, location pinning, and nearby search for ShedShare" : "Add GEOAPIFY_MAPS_BROWSER_KEY and GEOAPIFY_API_KEY to the server environment first";
}
document.getElementById("adminMapToggle").addEventListener("click", async () => {
  if (!isAdmin() || !adminMapSettings) return;
  const enabling = !adminMapSettings.enabled;
  const result = await api("/api/admin/map-settings", { method: "PUT", body: JSON.stringify({ enabled: enabling }) });
  if (result?.error) { showToast(result.error); return refreshAdminMapSettings(); }
  showToast(enabling ? "Maps are enabled for ShedShare." : "Maps are turned off for everyone.");
  await Promise.all([refreshAdminMapSettings(), loadMaps()]);
});
async function loadPendingTestimonials() {
  const host = document.getElementById("testimonialModerationList");
  if (!host || !isAdmin()) return;
  const rows = asList(await api("/api/admin/testimonials"));
  host.innerHTML = rows.length ? rows.map(row => `<article class="testimonial-review-card"><div><strong>${esc(row.displayName)}</strong><small>${esc(new Date(row.createdAt).toLocaleString())}</small><p>${esc(row.body)}</p></div><div class="testimonial-review-actions"><button type="button" class="primary" data-testimonial-review="${esc(row.id)}" data-status="approved">Approve</button><button type="button" class="danger-button" data-testimonial-review="${esc(row.id)}" data-status="rejected">Reject</button></div></article>`).join("") : `<div class="empty">No testimonials are waiting for review.</div>`;
  host.querySelectorAll("[data-testimonial-review]").forEach(button => button.addEventListener("click", async () => {
    const result = await api(`/api/admin/testimonials/${button.dataset.testimonialReview}`, { method: "PATCH", body: JSON.stringify({ status: button.dataset.status }) });
    if (result?.error) return showToast(result.error);
    showToast(`Testimonial ${button.dataset.status}.`);
    await Promise.all([loadPendingTestimonials(), loadTestimonials()]);
  }));
}

document.getElementById("refreshTestimonials").addEventListener("click", loadPendingTestimonials);
async function loadListingModerationSettings(){if(!isAdmin())return;const result=await api("/api/admin/listing-moderation/settings");if(result?.error){document.getElementById("listingModerationConfigStatus").textContent=result.error;return;}document.getElementById("listingModerationEnabled").checked=result.enabled;document.getElementById("listingModerationPolicy").value=result.policyText;document.getElementById("listingProhibitedTerms").value=result.prohibitedTerms.join(", ");document.getElementById("listingReviewTerms").value=result.reviewTerms.join(", ");document.getElementById("listingModerationConfidence").value=result.autoApprovalConfidence;document.getElementById("listingModerationConfigStatus").textContent=`Gemini API key ${result.geminiConfigured?"configured on server":"missing"}. Shared AI provider ${result.aiPlatformEnabled?"enabled":"disabled"}; listing screening ${result.enabled?"enabled":"disabled"}. Failed or uncertain checks remain hidden for admin review.`;}
async function loadListingModerationQueue(){if(!isAdmin())return;const host=document.getElementById("listingModerationQueue");host.innerHTML='<p class="fine">Loading listing review queue…</p>';const response=await api("/api/admin/listings/moderation");if(response?.error){host.innerHTML=`<p class="fine">${esc(response.error)}</p>`;return;}const rows=asList(response);document.getElementById("listingModerationCount").textContent=rows.length;host.innerHTML=rows.length?rows.map(row=>`<article class="listing-moderation-card"><div class="listing-moderation-photo">${row.image?`<img src="${esc(row.image)}" alt="${esc(row.name)} listing photo">`:`<span>No listing photo</span>`}</div><div class="listing-moderation-details"><div class="section-heading"><div><h3>${esc(row.name)}</h3><p>${esc(row.category)} · ${esc(row.condition)} · ${money(row.price)}/${esc(row.pricingUnit)} · ${esc(row.status.replaceAll("_"," "))}</p></div><small>${new Date(row.submittedAt).toLocaleString()}</small></div><p><strong>Submitted details:</strong> ${esc(row.description||"No description provided")}</p><p><strong>AI item identification:</strong> ${esc(row.itemSummary)}</p><p><strong>AI factual description:</strong> ${esc(row.aiDescription||"Unavailable")}</p><p class="alert-banner"><strong>Review reason:</strong> ${esc(row.reason)} ${row.confidence==null?"· confidence unavailable":`· confidence ${Math.round(row.confidence*100)}%`}${row.providerError?" · automated check failed":""}</p><p><strong>Lister:</strong> ${esc(row.lister.name)} · ${esc(row.lister.email)} · ${esc(row.lister.phone)}</p><p><strong>Submitted listing:</strong> ${esc(row.location)}</p><div class="row-actions"><button class="primary" data-listing-moderation="approve" data-listing-id="${esc(row.id)}">Approve</button><button class="danger-button" data-listing-moderation="decline" data-listing-id="${esc(row.id)}">Decline</button><button class="btn-outline" data-listing-moderation="request_information" data-listing-id="${esc(row.id)}">Request more information</button></div></div></article>`).join(""):`<div class="empty">No listings need administrator review.</div>`;host.querySelectorAll("[data-listing-moderation]").forEach(button=>button.addEventListener("click",async()=>{const action=button.dataset.listingModeration,reason=window.prompt(action==="approve"?"Add an approval note for the audit record:":action==="decline"?"Explain why this listing is declined:":"What information should the lister provide?");if(!reason||reason.trim().length<4)return showToast("Enter a clear decision reason.");button.disabled=true;const result=await api(`/api/admin/listings/${button.dataset.listingId}/moderation`,{method:"PATCH",body:JSON.stringify({action,reason:reason.trim()})});if(result?.error){button.disabled=false;return showToast(result.error);}showToast(`Listing ${result.status.replaceAll("_"," ")}.`);await Promise.all([loadListingModerationQueue(),loadItems()]);}));}
document.getElementById("refreshListingModeration").addEventListener("click",loadListingModerationQueue);
document.getElementById("listingModerationSettingsForm").addEventListener("submit",async event=>{event.preventDefault();const result=await api("/api/admin/listing-moderation/settings",{method:"PUT",body:JSON.stringify({enabled:document.getElementById("listingModerationEnabled").checked,policyText:document.getElementById("listingModerationPolicy").value.trim(),prohibitedTerms:document.getElementById("listingProhibitedTerms").value.split(",").map(x=>x.trim()).filter(Boolean),reviewTerms:document.getElementById("listingReviewTerms").value.split(",").map(x=>x.trim()).filter(Boolean),autoApprovalConfidence:Number(document.getElementById("listingModerationConfidence").value)})});if(result?.error){document.getElementById("listingModerationConfigStatus").textContent=result.error;return;}document.getElementById("listingModerationConfigStatus").textContent="Policy saved. New submissions will use this configuration.";showToast("Listing moderation policy saved.");});

async function loadRentalTrustModeration(){
  if(!isAdmin())return;const reviewHost=document.getElementById("rentalReviewModerationList"),reportHost=document.getElementById("rentalReviewReportsList");if(!reviewHost||!reportHost)return;
  const [reviews,reports]=await Promise.all([api("/api/admin/rental-reviews"),api("/api/admin/rental-review-reports")]);
  reviewHost.innerHTML=reviews?.error?`<p class="fine">${esc(reviews.error)}</p>`:asList(reviews).length?asList(reviews).map(review=>`<article class="trust-moderation-card"><div class="section-heading"><div><strong>${esc(review.itemName)} · ${esc(review.targetRole)} review</strong><p class="fine">${esc(review.authorName)} · rental ${esc(review.rentalId)} · ${esc(review.status)}</p></div><span>${Number(review.overallRating)} / 5</span></div><p>${esc(review.body)}</p><p class="fine">Communication ${review.communicationRating}/5 · ${review.accuracyRating==null?"Accuracy n/a":`Accuracy ${review.accuracyRating}/5`} · Reliability ${review.reliabilityRating}/5 · Fulfillment ${review.fulfillmentRating}/5</p><div class="row-actions">${review.status!=="approved"?`<button type="button" class="primary" data-trust-review-action="approved" data-review-id="${esc(review.id)}">Approve</button>`:`<button type="button" class="danger-button" data-trust-review-action="hidden" data-review-id="${esc(review.id)}">Hide</button>`}${review.status!=="rejected"?`<button type="button" class="danger-button" data-trust-review-action="rejected" data-review-id="${esc(review.id)}">Reject</button>`:""}</div></article>`).join(""):`<div class="empty">No rental reviews require moderation.</div>`;
  reportHost.innerHTML=reports?.error?`<p class="fine">${esc(reports.error)}</p>`:asList(reports).length?asList(reports).map(report=>`<article class="trust-moderation-card"><div class="section-heading"><div><strong>${esc(report.reason.replaceAll("_"," "))} · ${esc(report.itemName)}</strong><p class="fine">Reported by ${esc(report.reporterName)} · review ${esc(report.reviewId)} · ${esc(report.status)}</p></div><span>${esc(report.reviewStatus)}</span></div><blockquote>${esc(report.reviewBody)}</blockquote><p>${esc(report.details)}</p><div class="row-actions"><button type="button" class="btn-outline" data-trust-report-action="reviewing" data-report-id="${esc(report.id)}">Mark reviewing</button><button type="button" class="primary" data-trust-report-action="resolved" data-report-id="${esc(report.id)}">Resolve report</button></div></article>`).join(""):`<div class="empty">No open rental review reports.</div>`;
  reviewHost.querySelectorAll("[data-trust-review-action]").forEach(button=>button.addEventListener("click",async()=>{const reason=window.prompt(`Required moderation reason for ${button.dataset.trustReviewAction}:`);if(!reason||reason.trim().length<5)return;button.disabled=true;const result=await api(`/api/admin/rental-reviews/${button.dataset.reviewId}`,{method:"PATCH",body:JSON.stringify({status:button.dataset.trustReviewAction,reason:reason.trim()})});if(result?.error){button.disabled=false;return showToast(result.error);}showToast(`Rental review ${result.status}.`);loadRentalTrustModeration();}));
  reportHost.querySelectorAll("[data-trust-report-action]").forEach(button=>button.addEventListener("click",async()=>{const resolution=window.prompt("Add the reason or resolution for this report:");if(!resolution||resolution.trim().length<5)return;button.disabled=true;const result=await api(`/api/admin/rental-review-reports/${button.dataset.reportId}`,{method:"PATCH",body:JSON.stringify({status:button.dataset.trustReportAction,resolution:resolution.trim()})});if(result?.error){button.disabled=false;return showToast(result.error);}showToast("Rental review report updated.");loadRentalTrustModeration();}));
}
document.getElementById("refreshRentalTrust")?.addEventListener("click",loadRentalTrustModeration);
document.getElementById("submitTestimonial").addEventListener("click", async event => {
  if (!session) return showToast("Sign in to share your experience.");
  const displayName = document.getElementById("testimonialDisplayName").value.trim();
  const body = document.getElementById("testimonialBody").value.trim();
  const consent = document.getElementById("testimonialConsent").checked;
  const status = document.getElementById("testimonialStatus");
  if (!displayName || !body || !consent) { status.textContent = "Add a display name and testimonial, then agree to public display."; return; }
  event.currentTarget.disabled = true;
  const result = await api("/api/testimonials", { method: "POST", body: JSON.stringify({ displayName, body, consentPublic: consent }) });
  event.currentTarget.disabled = false;
  status.textContent = result?.error || result?.message || "Your testimonial has been submitted for review.";
  if (!result?.error) { document.getElementById("testimonialBody").value = ""; document.getElementById("testimonialConsent").checked = false; }
});

let pendingVideoDataUrl = "";
let pendingVideoFile = null;
let existingVideoUrl = "";
document.getElementById("i-video").addEventListener("change", (e) => {
  const file = e.target.files[0];
  const wrap = document.getElementById("videoPreviewWrap");
  if (!file) { pendingVideoDataUrl = ""; pendingVideoFile = null; wrap.hidden = true; return; }
  if (file.size > MAX_VIDEO_MB * 1024 * 1024) {
    showToast(`Video must be under ${MAX_VIDEO_MB}MB — try a shorter clip`);
    e.target.value = "";
    pendingVideoDataUrl = ""; pendingVideoFile = null; wrap.hidden = true;
    return;
  }
  pendingVideoFile = file;
  const reader = new FileReader();
  reader.onload = () => {
    pendingVideoDataUrl = reader.result;
    document.getElementById("videoPreview").src = pendingVideoDataUrl;
    wrap.hidden = false;
  };
  reader.readAsDataURL(file);
});

function exitEditMode() {
  photoEnhancementRequestId += 1; enhancedPhotoCandidate = null;
  document.getElementById("photoCompare").hidden = true; document.getElementById("cancelPhotoEnhancement").hidden = true;
  document.getElementById("enhancePhoto").disabled = !sourceImageFile;
  pickupLocationRequestId += 1;
  descriptionRequestId += 1;
  lastDescriptionDraftFile = null;
  document.getElementById("aiDescriptionStatus").textContent = "";
  document.getElementById("aiDescriptionStatus").hidden = true;
  editingItemId = null;
  document.getElementById("availabilityManager").hidden=true;
  document.getElementById("postTitle").textContent = "Post an item for rent";
  document.getElementById("itemSubmit").textContent = "Post item";
  document.getElementById("cancelEdit").hidden = true;
  document.getElementById("itemForm").reset();
  document.getElementById("itemLocationStatus").textContent = "Enter the pickup address manually, or use your current location to fill it in.";
  pendingImageDataUrl = "";
  pendingImageFile = null;
  existingImageUrl = "";
  existingOriginalImageUrl = "";
  enhancedPhotoChosen = false;
  sourceImageFile = null;
  sourceImageDataUrl = "";
  document.getElementById("imagePreviewWrap").hidden = true;
  document.getElementById("cloudinaryPhotoStatus").textContent = "";
  document.getElementById("restoreOriginalPhoto").hidden = true;
  pendingVideoDataUrl = "";
  pendingVideoFile = null;
  existingVideoUrl = "";
  document.getElementById("videoPreviewWrap").hidden = true;
  document.getElementById("splitPreview").innerHTML = "";
  document.getElementById("depositHint").textContent = "";
  syncAiControls();
}

function startEditItem(id) {
  const item = myItemsCache.find(i => i.id === id);
  if (!item) return;
  pickupLocationRequestId += 1;
  descriptionRequestId += 1;
  lastDescriptionDraftFile = null;
  photoEnhancementRequestId += 1; enhancedPhotoCandidate = null;
  document.getElementById("photoCompare").hidden = true; document.getElementById("cancelPhotoEnhancement").hidden = true;
  document.getElementById("aiDescriptionStatus").textContent = "";
  document.getElementById("aiDescriptionStatus").hidden = true;
  editingItemId = id;
  document.getElementById("availabilityManager").hidden=false;renderAvailabilityBlocks(id);
  pendingImageFile = null;
  enhancedPhotoChosen = false;
  sourceImageFile = null;
  sourceImageDataUrl = "";
  document.getElementById("cloudinaryPhotoStatus").textContent = "";
  document.getElementById("restoreOriginalPhoto").hidden = true;
  const set = (k, v) => { document.getElementById(k).value = v; };
  set("i-name", item.name); set("i-cat", item.category); set("i-cond", item.condition);
  set("i-city", item.city || ""); set("i-state", item.state || ""); set("i-area", item.areaName || ""); set("i-address", item.pickupAddress || ""); set("i-desc", item.description || "");set("i-defects",item.knownDefects||"");set("i-conditions",item.rentalConditions||"");set("i-cancellation",item.cancellationPolicy||"");
  document.getElementById("i-lat").value = item.latitude ?? ""; document.getElementById("i-lng").value = item.longitude ?? ""; document.getElementById("i-place-id").value = item.placeId || "";
  set("i-price", item.price); set("i-unit", item.pricingUnit);document.getElementById("i-unit").dataset.previousUnit=item.pricingUnit;renderAdditionalRentalRates(item.rentalPrices||[]);set("i-quantity",item.availableQuantity||1);
  set("i-minp", item.minPeriod); set("i-maxp", item.maxPeriod); set("i-deposit", item.deposit || "");
  document.getElementById("i-installments").checked=Boolean(item.installmentAvailable);set("i-installment-deposit-percent",item.installmentDepositPercent||50);
  document.getElementById("i-rider-delivery-available").checked = Boolean(item.riderDeliveryAvailable);
  updateDepositHint();
  pendingImageDataUrl = item.image || "";
  existingImageUrl = item.image || "";
  existingOriginalImageUrl = item.originalImage || "";
  if(existingOriginalImageUrl)document.getElementById("restoreOriginalPhoto").hidden=false;
  const wrap = document.getElementById("imagePreviewWrap");
  const img = safeImg(item.image);
  if (img) { document.getElementById("imagePreview").src = item.image; wrap.hidden = false; } else { wrap.hidden = true; }
  pendingVideoDataUrl = item.video || "";
  existingVideoUrl = item.video || "";
  const vwrap = document.getElementById("videoPreviewWrap");
  const vid = safeVideo(item.video);
  if (vid) { document.getElementById("videoPreview").src = item.video; vwrap.hidden = false; } else { vwrap.hidden = true; }
  document.getElementById("postTitle").textContent = "Edit item";
  document.getElementById("itemSubmit").textContent = "Save changes";
  document.getElementById("itemLocationStatus").textContent = "Review the pickup address, or use your current location to replace it.";
  document.getElementById("cancelEdit").hidden = false;
  renderSplitPreview();
  syncAiControls();
  activateSection("post");
}

async function renderAvailabilityBlocks(itemId){const host=document.getElementById("availabilityBlockList");host.textContent="Loading availability…";const response=await api(`/api/items/${encodeURIComponent(itemId)}/availability-blocks`);if(response?.error){host.textContent=response.error;return;}const rows=asList(response);host.innerHTML=rows.length?rows.map(block=>`<div class="availability-block-row"><span><strong>${esc(block.status)}</strong> · ${new Date(block.startAt).toLocaleString()} – ${new Date(block.endAt).toLocaleString()} · ${block.quantity==null?"all units":`${block.quantity} units`}${block.note?` · ${esc(block.note)}`:""}</span><button type="button" class="btn-outline" data-remove-availability="${esc(block.id)}" data-item="${esc(itemId)}">Remove</button></div>`).join(""):`<p class="fine">No manual availability blocks.</p>`;}
document.getElementById("addAvailabilityBlock").addEventListener("click",async()=>{if(!editingItemId)return;const start=document.getElementById("availabilityStart").value,end=document.getElementById("availabilityEnd").value;if(!start||!end)return showToast("Choose a start and end for this availability block.");const result=await api(`/api/items/${encodeURIComponent(editingItemId)}/availability-blocks`,{method:"POST",body:JSON.stringify({startAt:new Date(start).toISOString(),endAt:new Date(end).toISOString(),status:document.getElementById("availabilityStatus").value,quantity:document.getElementById("availabilityQuantity").value?Number(document.getElementById("availabilityQuantity").value):null,note:document.getElementById("availabilityNote").value.trim()})});if(result?.error)return showToast(result.error);document.getElementById("availabilityStart").value="";document.getElementById("availabilityEnd").value="";document.getElementById("availabilityQuantity").value="";document.getElementById("availabilityNote").value="";await renderAvailabilityBlocks(editingItemId);showToast("Availability updated.");});
document.addEventListener("click",async event=>{const button=event.target.closest("[data-remove-availability]");if(!button)return;button.disabled=true;const result=await api(`/api/items/${encodeURIComponent(button.dataset.item)}/availability-blocks/${encodeURIComponent(button.dataset.removeAvailability)}`,{method:"DELETE"});if(result?.error){button.disabled=false;return showToast(result.error);}await renderAvailabilityBlocks(button.dataset.item);});
document.getElementById("cancelEdit").addEventListener("click", () => { exitEditMode(); activateSection("dashboard"); });

const allPricingUnits=["hour","day","week","month","year"];
const pricingUnitLabel={hour:"Hour",day:"Day",week:"Week",month:"Month",year:"Year"};
function renderAdditionalRentalRates(existing=[]){
  const host=document.getElementById("additionalRentalRates");if(!host)return;
  host.innerHTML=allPricingUnits.filter(unit=>unit!==document.getElementById("i-unit").value).map(unit=>{const option=existing.find(rate=>rate.pricingUnit===unit);return `<label class="rate-option"><input type="checkbox" data-rate-enabled="${unit}" ${option?"checked":""}> ${pricingUnitLabel[unit]} <input type="number" min="1" step="0.01" placeholder="Price per ${unit}" data-rate-price="${unit}" value="${option?.price??""}" ${option?"":"disabled"}></label>`;}).join("");
  host.querySelectorAll("[data-rate-enabled]").forEach(toggle=>toggle.addEventListener("change",()=>{const price=host.querySelector(`[data-rate-price="${toggle.dataset.rateEnabled}"]`);price.disabled=!toggle.checked;if(!toggle.checked)price.value="";}));
}
renderAdditionalRentalRates();
document.getElementById("i-unit").addEventListener("change",event=>{const previous=event.target.dataset.previousUnit||"day",options=[{pricingUnit:previous,price:Number(document.getElementById("i-price").value)||0},...Array.from(document.querySelectorAll("#additionalRentalRates [data-rate-enabled]:checked")).map(toggle=>({pricingUnit:toggle.dataset.rateEnabled,price:Number(document.querySelector(`#additionalRentalRates [data-rate-price=\"${toggle.dataset.rateEnabled}\"]`).value)||0}))];const selected=options.find(option=>option.pricingUnit===event.target.value);if(selected?.price)document.getElementById("i-price").value=selected.price;renderAdditionalRentalRates(options.filter(option=>option.price>0));event.target.dataset.previousUnit=event.target.value;});

document.getElementById("itemForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    name: document.getElementById("i-name").value.trim(),
    category: document.getElementById("i-cat").value,
    condition: document.getElementById("i-cond").value,
    location: [document.getElementById("i-area").value.trim(), document.getElementById("i-city").value.trim(), document.getElementById("i-state").value.trim()].filter(Boolean).join(", "),
    pickupAddress: document.getElementById("i-address").value.trim(),
    city: document.getElementById("i-city").value.trim(),
    state: document.getElementById("i-state").value.trim(),
    areaName: document.getElementById("i-area").value.trim(),
    latitude: document.getElementById("i-lat").value === "" ? null : Number(document.getElementById("i-lat").value),
    longitude: document.getElementById("i-lng").value === "" ? null : Number(document.getElementById("i-lng").value),
    placeId: document.getElementById("i-place-id").value,
    description: document.getElementById("i-desc").value.trim(),
    knownDefects:document.getElementById("i-defects").value.trim(),rentalConditions:document.getElementById("i-conditions").value.trim(),cancellationPolicy:document.getElementById("i-cancellation").value.trim(),
    price: Number(document.getElementById("i-price").value),
    pricingUnit: document.getElementById("i-unit").value,
    minPeriod: Math.max(1, Number(document.getElementById("i-minp").value) || 1),
    maxPeriod: Math.max(1, Number(document.getElementById("i-maxp").value) || 1),
    availableQuantity:Math.max(1,Number(document.getElementById("i-quantity").value)||1),
    rentalPrices:[{pricingUnit:document.getElementById("i-unit").value,price:Number(document.getElementById("i-price").value),minPeriod:Math.max(1,Number(document.getElementById("i-minp").value)||1),maxPeriod:Math.max(1,Number(document.getElementById("i-maxp").value)||1)},...Array.from(document.querySelectorAll("#additionalRentalRates [data-rate-enabled]:checked")).map(toggle=>({pricingUnit:toggle.dataset.rateEnabled,price:Number(document.querySelector(`#additionalRentalRates [data-rate-price="${toggle.dataset.rateEnabled}"]`).value),minPeriod:Math.max(1,Number(document.getElementById("i-minp").value)||1),maxPeriod:Math.max(1,Number(document.getElementById("i-maxp").value)||1)}))],
    deposit: Number(document.getElementById("i-deposit").value) || 0,
    allowInstallments:document.getElementById("i-installments").checked,
    installmentDepositPercent:Number(document.getElementById("i-installment-deposit-percent").value)||50,
    deliveryAvailable: Boolean(editingItemId && myItemsCache.find(item => item.id === editingItemId)?.deliveryAvailable),
    deliveryFee: Number(editingItemId && myItemsCache.find(item => item.id === editingItemId)?.deliveryFee) || 0,
    riderDeliveryAvailable: document.getElementById("i-rider-delivery-available").checked,
    // Keep an existing stored photo untouched until the authenticated upload
    // endpoint has accepted the replacement. JSON.stringify omits undefined.
    image: window.ShedSharePhotoSelection.imageField({pendingImageFile,editingItemId,existingImageUrl}),
    video: existingVideoUrl
  };
  if (!payload.name || !payload.price || !payload.city || !payload.state || !payload.areaName) return showToast("Item name, city, state, and area are required.");
  if(payload.rentalPrices.some(rate=>!Number.isFinite(rate.price)||rate.price<=0))return showToast("Enter a valid price for every supported rental period.");
  if(pendingImageFile&&pendingImageFile.size>8*1024*1024)return showToast("This photo is larger than the 8 MiB upload limit. Choose a smaller photo or restore the original.");
  if ((payload.latitude == null) !== (payload.longitude == null)) return showToast("The saved location is incomplete. Use current location again or enter the address manually.");
  const placeId=payload.placeId;
  if(placeId || payload.latitude != null){const verified=await api("/api/locations/verify",{method:"POST",body:JSON.stringify({placeId,city:payload.city,state:payload.state,areaName:payload.areaName,address:payload.pickupAddress,latitude:payload.latitude,longitude:payload.longitude})});if(verified?.error)return showToast(verified.error);Object.assign(payload,{pickupAddress:verified.pickupAddress,city:verified.city,state:verified.state,areaName:verified.areaName,latitude:verified.latitude,longitude:verified.longitude,placeId:verified.placeId,location:[verified.areaName,verified.city,verified.state].filter(Boolean).join(", ")});if(verified.verified===false)document.getElementById("itemLocationStatus").textContent="Location saved from the address and device coordinates. Please double-check the address before posting.";}
  if(/^pinned pickup location$/i.test(payload.pickupAddress)){showToast("Enter the full private pickup address to use this pin.");return;}
  if (payload.maxPeriod < payload.minPeriod) { showToast("Max rental period can't be shorter than the minimum."); return; }
  const editing = editingItemId;
  let r = editing
    ? await api(`/api/items/${editing}`, { method: "PATCH", body: JSON.stringify(payload) })
    : await api("/api/items", { method: "POST", body: JSON.stringify(payload) });
  if (r && r.error) { showToast(r.error); return; }
  const itemId = editing || r.id;
  const shouldModerateEdit = Boolean(editing && (r.moderationStatus === "pending_analysis" || pendingImageFile));
  if (pendingImageFile) {
    const form = new FormData(); form.append("image", pendingImageFile);
    if(enhancedPhotoChosen){form.append("enhanced","true");if(sourceImageFile)form.append("original",sourceImageFile,sourceImageFile.name||"original-listing-photo");}
    r = await api(`/api/items/${itemId}/image`, { method: "PUT", body: form, headers: {} });
    if (r && r.error) {
      if(!editing) await api(`/api/items/${itemId}`,{method:"DELETE"});
      showToast(`${r.error}${r.status===500?" Check that the Supabase Storage bucket exists and matches SUPABASE_STORAGE_BUCKET.":""}`);return;
    }
  }
  if (pendingVideoFile) {
    const form = new FormData(); form.append("video", pendingVideoFile);
    r = await api(`/api/items/${itemId}/video`, { method: "PUT", body: form, headers: {} });
    if (r && r.error) { showToast(r.error); return; }
  }
  if(!editing){
    const moderation=await api(`/api/items/${encodeURIComponent(itemId)}/moderate`,{method:"POST",body:"{}"});
    if(moderation?.error){exitEditMode();showToast("Listing saved privately. Automated moderation could not finish; it remains hidden until ShedShare reviews it.");activateSection("dashboard");await renderDashboard();return;}
    exitEditMode();
    if(moderation.status==="approved"){showToast("Listing approved and published.");activateSection("browse");}
    else{showToast("Listing received. It is hidden while ShedShare reviews it; approval has not been granted.");activateSection("dashboard");await renderDashboard();}
    await loadItems();if(!isAdmin())document.querySelector('[data-tab="post"]').hidden=false;return;
  }
  if(shouldModerateEdit){
    const moderation=await api(`/api/items/${encodeURIComponent(itemId)}/moderate`,{method:"POST",body:"{}"});
    exitEditMode();
    showToast(moderation?.error?"Changes saved privately. This listing remains hidden until its safety review can finish.":moderation.status==="approved"?"Changes saved and listing review passed.":"Changes saved. The listing is hidden while ShedShare reviews the update.");
    activateSection("dashboard");await Promise.all([renderDashboard(),loadItems()]);if(!isAdmin())document.querySelector('[data-tab="post"]').hidden=false;return;
  }
  exitEditMode();
  if (editing) { showToast("Changes saved"); activateSection("dashboard"); renderDashboard(); }
  else { showToast("Item posted"); activateSection("browse"); }
  loadItems();
  if (!isAdmin()) document.querySelector('[data-tab="post"]').hidden = false;
});

/* ---------- rent flow, step 1: price, duration, dates, delivery ---------- */
async function openRentFlow(id, { resumeDraft = false, autoContinue = false, rentAgain = null } = {}) {
  // Rent Again deliberately starts from the current public listing record. It
  // never restores a historical price, date, agreement, or payment state.
  const item = rentAgain ? await api(`/api/items/${encodeURIComponent(id)}`) : [...itemsCache, ...messageListingCache].find(i => String(i.id) === String(id));
  if (!item || item.error) {
    if (rentAgain) { showToast(item?.error || "This listing is unavailable. Browse current listings to find another option."); activateSection("browse"); }
    return;
  }
  const savedDraft=resumeDraft?(readPendingRentalDraft()||(Number(pendingRentalDraft?.expiresAt)>Date.now()?pendingRentalDraft:null)):null;
  if(resumeDraft)pendingRentalDraft=savedDraft;
  const draft = resumeDraft && pendingRentalDraft && String(pendingRentalDraft.itemId) === String(id) ? { ...pendingRentalDraft } : null;
  const booked = asList(await api(`/api/items/${id}/bookings`));
  const low = lowestPrice(item);
  const supportedRates=item.rentalPrices||[{pricingUnit:item.pricingUnit,price:item.price,minPeriod:item.minPeriod,maxPeriod:item.maxPeriod}];
  const hourly = supportedRates.some(rate=>rate.pricingUnit==="hour");
  const now = new Date();
  const nextHour = new Date(now); nextHour.setMinutes(0, 0, 0); nextHour.setHours(nextHour.getHours() + 1);
  const startInput = hourly
    ? `<input type="datetime-local" id="rentStart" min="${toDateTimeInput(now)}" value="${rentAgain ? "" : toDateTimeInput(nextHour)}">`
    : `<input type="date" id="rentStart" min="${toDateInput(now)}" value="${rentAgain ? "" : toDateInput(now)}">`;
  const img = safeImg(item.image);
  const vid = safeVideo(item.video);
  document.getElementById("rentDetail").innerHTML = `
    <div class="step">
    ${stepTrackerHtml(1)}
    ${rentAgain ? `<p class="fine rent-again-notice">Renting again from a previous rental. Choose a new period and review the current price, availability, and charges. Your previous agreement and payment are not reused.</p>` : ""}
    ${img ? `<img class="detail-photo" src="${img}" alt="${esc(item.name)}">` : `<div class="detail-photo-placeholder">No photo provided</div>`}
    ${vid ? `<div class="video-preview"><video class="detail-video" src="${vid}" muted playsinline preload="metadata"></video><span class="play-badge"></span></div>` : ""}
    <span class="cat-pill">${esc(item.category)}</span>
    <h2 class="detail-title">${esc(item.name)}</h2>
    <p class="detail-desc">${esc(item.description || "")}</p>
    <dl class="spec-block">
      <div><dt>Owner</dt><dd>${esc(item.ownerName)}${item.ownerBrand ? " (" + esc(item.ownerBrand) + ")" : ""}</dd></div>
      <div><dt>Lister trust</dt><dd>${PREVIEW_MODE?"Trust data unavailable in demo preview":`${item.ownerAverageRating==null?`${Number(item.ownerCompletedRentals||0)} completed verified rentals · no published reviews`: `${Number(item.ownerAverageRating).toFixed(1)} / 5 · ${Number(item.ownerReviewCount)} verified rental review${Number(item.ownerReviewCount)===1?"":"s"}`} · ${item.ownerEmailVerified?"email verified account":"email not verified"}<br><button type="button" class="text-link" data-detail-lister-trust="${esc(item.ownerId)}">View trust profile</button>`}</dd></div>
      <div><dt>Condition</dt><dd>${esc(item.condition)}</dd></div>
      <div><dt>Known defects</dt><dd>${esc(item.knownDefects||"None listed")}</dd></div>
      <div><dt>Rental conditions</dt><dd>${esc(item.rentalConditions||"See owner agreement")}</dd></div>
      <div><dt>Cancellation policy</dt><dd>${esc(item.cancellationPolicy||"Confirm cancellation terms in the accepted rental summary")}</dd></div>
      ${item.installmentAvailable?`<div><dt>Payment arrangement</dt><dd>Deposit and balance available · ${Number(item.installmentDepositPercent||50)}% due when agreed; the balance is due 24 hours before rental start</dd></div>`:""}
      <div><dt>Location</dt><dd>${esc(item.location || "Not provided")}</dd></div>
      <div><dt>Distance</dt><dd>${item.distanceKm == null ? "Distance unavailable" : `${Number(item.distanceKm).toFixed(1)} km away`}</dd></div>
      ${session && String(session.user.id) !== String(item.ownerId || "") ? "<div><dt>Phone</dt><dd>Shared after rental confirmation</dd></div>" : ""}
      ${item.deposit ? `<div><dt>Deposit</dt><dd>${money(item.deposit)}</dd></div>` : ""}
      <div><dt>Delivery options</dt><dd>${[item.deliveryAvailable&&"Owner delivery",item.riderDeliveryAvailable&&"ShedShare rider delivery"].filter(Boolean).join(", ")||"Pickup only"}</dd></div>
    </dl>
    <label for="rentPricingUnit">Rental price period</label><select id="rentPricingUnit">${(item.rentalPrices||[{pricingUnit:item.pricingUnit,price:item.price,minPeriod:item.minPeriod,maxPeriod:item.maxPeriod}]).map(rate=>`<option value="${esc(rate.pricingUnit)}" ${rate.pricingUnit===item.pricingUnit?"selected":""}>Per ${esc(rate.pricingUnit)} · ${money(rate.price)}</option>`).join("")}</select>
    <label for="rentPrice">Your proposed price per selected period</label>
    <div class="price-live" id="priceLive">${money(item.price)}/${esc(item.pricingUnit)}</div>
    <input type="number" id="rentPrice" min="1" step="0.01" value="${item.price}">
    <label for="rentUnits">Number of ${esc(item.pricingUnit)}s (${item.minPeriod} to ${item.maxPeriod})</label>
    <input type="number" id="rentUnits" min="${item.minPeriod}" max="${item.maxPeriod}" value="${item.minPeriod}">
    ${Number(item.availableQuantity||1)>1?`<label for="rentInventoryQuantity">Quantity (up to ${Number(item.availableQuantity)})</label><input type="number" id="rentInventoryQuantity" min="1" max="${Number(item.availableQuantity)}" value="1">`:""}
    ${item.deliveryAvailable||item.riderDeliveryAvailable ? `<fieldset class="delivery-choice"><legend>How will you get the item?</legend><label><input type="radio" name="rentDeliveryMethod" value="pickup" checked> Pickup</label>${item.deliveryAvailable?`<label><input type="radio" name="rentDeliveryMethod" value="owner_delivery"> Owner delivers (${money(item.deliveryFee || 0)})</label>`:""}${item.riderDeliveryAvailable?`<label><input type="radio" name="rentDeliveryMethod" value="rider_delivery"> ShedShare rider delivers <small>The rider quotes a fee. Pay it securely through ShedShare; ShedShare applies the current rider commission rate.</small></label>`:""}<label for="deliveryLocation">Delivery address</label><input id="deliveryLocation" type="text" maxlength="255" placeholder="Street, area, city" autocomplete="street-address"></fieldset>` : ""}
    <label for="rentStart">Start ${hourly ? "date and time" : "date"}</label>
    ${startInput}
    <div class="when" id="rentWhen"></div>
    ${booked.length ? `<p class="fine">Already booked: ${booked.map(b => esc(fmtRange(b.startAt, b.endAt, item.pricingUnit))).join("; ")}</p>` : ""}
    <div class="contact-privacy">Keep your conversation on ShedShare. Contact details are hidden until booking payment is confirmed.</div>
    ${(!session || String(session.user.id) !== String(item.ownerId || "")) ? `<button type="button" class="btn-outline message-owner" data-message-item="${esc(item.id)}" data-message-owner="${esc(item.ownerId || "")}" data-message-name="${esc(item.ownerName || "Lister")}">Message Lister</button>` : ""}
    ${session && String(session.user.id) !== String(item.ownerId || "") ? `<button type="button" class="btn-outline" id="requestInspection">Request to view</button>` : ""}
    <div class="split-preview" id="rentSplit"></div>
    <button class="primary" id="continueAgreement">Continue</button>
    </div>`;

  if (draft) {
    if(draft.pricingUnit&&supportedRates.some(rate=>rate.pricingUnit===draft.pricingUnit))document.getElementById("rentPricingUnit").value=draft.pricingUnit;
    const priceInput=document.getElementById("rentPrice"),unitsInput=document.getElementById("rentUnits"),startInputEl=document.getElementById("rentStart");
    if(priceInput)priceInput.value=String(Math.max(Number(priceInput.min),Math.min(Number(priceInput.max),Number(draft.price)||Number(priceInput.value))));
    if(unitsInput)unitsInput.value=String(Math.max(Number(unitsInput.min),Math.min(Number(unitsInput.max),Number(draft.units)||Number(unitsInput.value))));
    if(startInputEl&&draft.start)startInputEl.value=draft.start;
    if(draft.deliveryMethod)document.querySelector(`input[name="rentDeliveryMethod"][value="${CSS.escape(draft.deliveryMethod)}"]`)?.click();
    const deliveryLocation=document.getElementById("deliveryLocation");
    if(deliveryLocation)deliveryLocation.value=draft.deliveryLocation||"";
  }
  if (rentAgain) {
    const unitsInput = document.getElementById("rentUnits");
    if (unitsInput) unitsInput.value = String(Math.max(Number(unitsInput.min), Math.min(Number(unitsInput.max), Number(rentAgain.units) || Number(unitsInput.value))));
    if (rentAgain.deliveryMethod) document.querySelector(`input[name="rentDeliveryMethod"][value="${CSS.escape(rentAgain.deliveryMethod)}"]`)?.click();
  }

  const photoEl = document.querySelector("#rentDetail .detail-photo");
  document.querySelector("#rentDetail [data-detail-lister-trust]")?.addEventListener("click",event=>openTrustProfile(event.currentTarget.dataset.detailListerTrust,"lister",item.ownerName));
  if (photoEl) photoEl.addEventListener("click", () => openLightbox("image", photoEl.src));
  const videoPreview = document.querySelector("#rentDetail .video-preview");
  if (videoPreview) {
    const inlineVideo = videoPreview.querySelector("video");
    videoPreview.addEventListener("click", () => openLightbox("video", inlineVideo.currentSrc || inlineVideo.src));
  }
  const readDeliveryMethod = () => document.querySelector('input[name="rentDeliveryMethod"]:checked')?.value || "pickup";
  let activeUnit=document.getElementById("rentPricingUnit").value||item.pricingUnit,activeRate=(item.rentalPrices||[{pricingUnit:item.pricingUnit,price:item.price,minPeriod:item.minPeriod,maxPeriod:item.maxPeriod}]).find(rate=>rate.pricingUnit===activeUnit)||{price:item.price,minPeriod:item.minPeriod,maxPeriod:item.maxPeriod};
  if(draft&&draft.pricingUnit){const unitInput=document.getElementById("rentUnits");unitInput.min=activeRate.minPeriod;unitInput.max=activeRate.maxPeriod;document.querySelector('label[for="rentUnits"]').textContent=`Number of ${activeUnit}s (${activeRate.minPeriod} to ${activeRate.maxPeriod})`;}
  document.getElementById("rentPricingUnit").addEventListener("change",event=>{activeUnit=event.target.value;activeRate=(item.rentalPrices||[]).find(rate=>rate.pricingUnit===activeUnit);if(!activeRate)return;const input=document.getElementById("rentUnits");input.min=activeRate.minPeriod;input.max=activeRate.maxPeriod;input.value=activeRate.minPeriod;document.querySelector('label[for="rentUnits"]').textContent=`Number of ${activeUnit}s (${activeRate.minPeriod} to ${activeRate.maxPeriod})`;document.getElementById("rentPrice").value=activeRate.price;recalc();});
  const read = () => {
    const perUnit = Number(document.getElementById("rentPrice").value);
    const units = Math.max(activeRate.minPeriod, Math.min(activeRate.maxPeriod, Math.round(Number(document.getElementById("rentUnits").value) || activeRate.minPeriod)));
    const start = parseStart(activeUnit, document.getElementById("rentStart").value);
    const inventoryQuantity=Number(document.getElementById("rentInventoryQuantity")?.value||1);
    return { perUnit, units, inventoryQuantity, pricingUnit:activeUnit, deliveryMethod: readDeliveryMethod(), start };
  };
  const recalc = () => {
    const { perUnit, units, inventoryQuantity, deliveryMethod, start } = read();
    document.getElementById("priceLive").textContent = money(perUnit) + "/" + activeUnit;
    const subtotal = perUnit * units * inventoryQuantity;
    const { fee, owner } = split(subtotal);
    const deliveryFee = deliveryMethod === "owner_delivery" ? Number(item.deliveryFee || 0) : 0;
    const total = subtotal + deliveryFee;
    document.getElementById("rentSplit").innerHTML = `
      <div class="split-row"><span class="label">${plural(units, esc(activeUnit))} × ${money(perUnit)}${inventoryQuantity>1?` × ${inventoryQuantity} units`:""}</span><span class="value">${money(subtotal)}</span></div>
      ${item.deposit ? `<div class="split-row"><span class="label">Informational deposit (paid directly if agreed)</span><span class="value">${money(item.deposit)}</span></div>` : ""}
      ${deliveryFee ? `<div class="split-row"><span class="label">Owner delivery</span><span class="value">${money(deliveryFee)}</span></div>` : ""}
      ${deliveryMethod === "rider_delivery" ? `<div class="split-row"><span class="label">Rider delivery</span><span class="value">The rider will quote a fee; pay securely through ShedShare after they accept.</span></div>` : ""}
      <div class="split-row"><span class="label">Pay on ShedShare</span><span class="value">${money(total)}</span></div>
      ${paystackAvailable ? `<div class="split-row"><span class="label">Platform commission</span><span class="value fee">Shown in the prepared rental summary</span></div>` : ""}
      ${paystackAvailable ? `<div class="split-row"><span class="label">Owner allocation</span><span class="value payout">Shown in the prepared rental summary</span></div>` : ""}`;
    let problem = "";
    let end = null;
    if (!start || isNaN(start)) problem = "Choose a start date.";
    else {
      end = addPeriod(start, activeUnit, units);
      if (end <= new Date()) problem = "That start time is in the past.";
      else if (booked.filter(b => overlaps(start, end, new Date(b.startAt), new Date(b.endAt))).reduce((sum,b)=>sum+Number(b.quantity||item.availableQuantity||1),0)+inventoryQuantity>Number(item.availableQuantity||1)) problem = "There are not enough units available for those dates.";
    }
    document.getElementById("rentWhen").innerHTML = problem
      ? `<span class="warn-text">${esc(problem)}</span>`
      : `<span>Return by ${esc(fmtDT(end, item.pricingUnit))}</span>`;
    document.getElementById("continueAgreement").disabled = !!problem||!Number.isFinite(perUnit)||perUnit<=0||inventoryQuantity<1||inventoryQuantity>Number(item.availableQuantity||1);
  };
  recalc();
  ["rentPrice", "rentUnits", "rentStart","rentInventoryQuantity"].forEach(id => document.getElementById(id)?.addEventListener("input", recalc));
  document.querySelectorAll('input[name="rentDeliveryMethod"]').forEach(input => input.addEventListener("change", recalc));
  document.getElementById("continueAgreement").addEventListener("click", () => {
    const { perUnit, units, inventoryQuantity, pricingUnit, deliveryMethod, start } = read();
    showAgreementStep({...item,pricingUnit,inventoryQuantity}, perUnit, units, deliveryMethod, start.toISOString(),document.getElementById("deliveryLocation")?.value.trim()||"");
  });
  if(draft){recalc();if(autoContinue){const {perUnit,units,deliveryMethod,start}=read();const end=start&&!isNaN(start)?addPeriod(start,item.pricingUnit,units):null;const unavailable=!start||isNaN(start)||end<=new Date()||booked.some(b=>overlaps(start,end,new Date(b.startAt),new Date(b.endAt)));if(unavailable)showToast("Those saved dates are no longer available. Update the rental details to continue.");else showAgreementStep(item,perUnit,units,deliveryMethod,start.toISOString(),draft.deliveryLocation||"");}}
  document.getElementById("requestInspection")?.addEventListener("click",async()=>{const when=prompt("Inspection date and time (ISO format, e.g. 2026-10-25T14:00:00Z)");if(!when)return;const meeting=prompt("Agreed meeting location (do not share your private home address unless you choose)");if(!meeting)return;const result=await api("/api/inspections",{method:"POST",body:JSON.stringify({itemId:String(item.id),proposedAt:new Date(when).toISOString(),meetingLocation:meeting})});showToast(result?.error||"Inspection request sent. This is not a booking and requires no payment.");});
  activateSection("rentFlow");
}

/* ---------- rent flow, step 2: agreement ---------- */
function showAgreementStep(item, perUnit, units, deliveryMethod, startIso, deliveryLocation = "") {
  const endIso = addPeriod(startIso, item.pricingUnit, units).toISOString();
  document.getElementById("rentDetail").innerHTML = `
    <div class="step">
    ${stepTrackerHtml(2)}
    <h2 class="detail-title">Rental agreement</h2>
    <p class="fine">${esc(fmtRange(startIso, endIso, item.pricingUnit))}</p>
    <div class="terms-box">${esc(agreementTermsText(item.name, units, item.pricingUnit))}${Number(item.inventoryQuantity||1)>1?` · Quantity: ${Number(item.inventoryQuantity)} units/rooms`:""}</div>
    <label class="agree-row"><input type="checkbox" id="agreeCheck"> I have read and agree to the rental terms.</label>
    <button type="button" class="btn-outline" id="editRentalDetails">Edit rental details</button>
    <button class="primary" id="continuePay" ${paystackAvailable||manualPaymentAvailable?"":"disabled"}>${paystackAvailable||manualPaymentAvailable?"Continue to payment":"Payments are temporarily unavailable"}</button>
    </div>`;
    document.getElementById("agreeCheck").addEventListener("change", (e) => {
    document.getElementById("continuePay").disabled = !e.target.checked || !(paystackAvailable||manualPaymentAvailable);
  });
  document.getElementById("editRentalDetails").addEventListener("click",()=>{const startDate=new Date(startIso);savePendingRentalDraft({itemId:String(item.id),price:perUnit,units,pricingUnit:item.pricingUnit,inventoryQuantity:item.inventoryQuantity||1,deliveryMethod,start:item.pricingUnit==="hour"?toDateTimeInput(startDate):toDateInput(startDate),deliveryLocation});openRentFlow(item.id,{resumeDraft:true});});
  document.getElementById("continuePay").addEventListener("click", () => showPaymentStep(item, perUnit, units, deliveryMethod, startIso, deliveryLocation));
}

/* ---------- rent flow, step 3: payment ---------- */
function showPaymentStep(item, perUnit, units, deliveryMethod, startIso, deliveryLocation = "") {
  const inventoryQuantity=Number(item.inventoryQuantity||1),subtotal = perUnit * units * inventoryQuantity;
  const deliveryFee = deliveryMethod === "owner_delivery" ? item.deliveryFee : 0;
  const total = subtotal + deliveryFee;
  const endIso = addPeriod(startIso, item.pricingUnit, units).toISOString();

  async function finalizeRental() {
    const paymentReference = "shedshare-" + Date.now() + "-" + Math.random().toString(36).slice(2, 12);
    let deliveryLatitude, deliveryLongitude;
    if(deliveryMethod!=="pickup"&&navigator.geolocation){await new Promise(resolve=>navigator.geolocation.getCurrentPosition(position=>{deliveryLatitude=position.coords.latitude;deliveryLongitude=position.coords.longitude;resolve();},()=>resolve(),{enableHighAccuracy:false,timeout:5000,maximumAge:60000}));}
  const paymentPlan=document.getElementById("rentalPaymentPlan")?.value||"full";
  const summary=await api("/api/rental-summaries",{method:"POST",body:JSON.stringify({itemId:String(item.id),pricePerUnit:perUnit,units,pricingUnit:item.pricingUnit,inventoryQuantity,deliveryMethod,deliveryLocation,startAt:new Date(startIso).toISOString(),paymentPlan})});
    if(summary?.error){showToast(summary.error);return false;}
    clearPendingRentalDraft();
    const terms=summary.terms;
    const agreed=await confirmRentalSummary(summary,terms);
    if(!agreed)return false;
  const r = await api("/api/rentals", { method: "POST", body: JSON.stringify({ itemId: item.id, agreementId:summary.agreementId,pricePerUnit:terms.pricePerUnit, units:terms.units, pricingUnit:terms.pricingUnit, inventoryQuantity:terms.inventoryQuantity, deliveryMethod:terms.deliveryMethod, deliveryLocation, ...(deliveryLatitude==null?{}:{deliveryLatitude,deliveryLongitude}), startAt: terms.startAt, paymentReference }) });
    if (r && r.error) {
      showToast(r.error);
      if (r.status === 409) { await loadItems(); openRentFlow(item.id); }
      return false;
    }
    if (r.checkoutUrl) {
      showToast("Checkout opened. Your rental will be confirmed after Paystack verifies payment.");
      window.location.assign(r.checkoutUrl);
      return true;
    }
    if(r.paymentMode==="manual"){const p=r.paymentSchedule?.[0];const notice=r.manualPaymentNotice||"You are transferring directly to the lister. ShedShare does not hold these funds.";document.getElementById("rentDetail").innerHTML=`<div class="step"><h2 class="detail-title">Booking agreement accepted</h2><p class="fine">Booking SS-${esc(r.id)} · ${esc(r.itemName||item.name)}</p><p class="alert-banner">${esc(notice)}</p>${p?`<section class="manual-transfer-instructions"><h3>Installment ${p.number} · ${money(p.amount)}</h3><p>Due ${esc(new Date(p.dueAt).toLocaleString())}</p><dl><dt>Account name</dt><dd>${esc(p.paymentInstructions.accountName)}</dd><dt>Bank</dt><dd>${esc(p.paymentInstructions.bankName)}</dd><dt>Account number</dt><dd>${esc(p.paymentInstructions.accountNumber)}</dd><dt>Transfer reference</dt><dd>${esc(p.paymentInstructions.transferReference)}</dd></dl><button type="button" class="primary" id="reportFirstTransfer">I Have Made This Transfer</button></section>`:""}<button type="button" class="btn-outline" id="viewBookingDashboard">View booking and payment schedule</button></div>`;document.getElementById("reportFirstTransfer")?.addEventListener("click",async()=>{const ref=prompt("Enter the bank transfer reference if available (optional):")||"";const report=await api(`/api/manual-payments/installments/${p.id}/report`,{method:"POST",body:JSON.stringify({transferReference:ref})});if(report?.error)return showToast(report.error);showToast("Transfer reported. The lister must confirm receipt before it counts as paid.");activateSection("dashboard");await renderDashboard();});document.getElementById("viewBookingDashboard")?.addEventListener("click",async()=>{activateSection("dashboard");await renderDashboard();});return true;}
    activateSection("dashboard");
    renderDashboard();
    loadItems();
    return true;
  }

  const head = `${stepTrackerHtml(3)}<h2 class="detail-title">Send a rental summary</h2><p class="fine">${esc(item.name)}: ${esc(fmtRange(startIso, endIso, item.pricingUnit))}</p>`;

  if (API_BASE) {
    const ready = true;
    document.getElementById("rentDetail").innerHTML = `
      <div class="step">${head}
      <p class="detail-desc">${paymentMode==="manual"?`Rental charge: <strong>${money(subtotal)}</strong>. Payment transfers go directly to the lister. The agreed schedule and receiving details will appear after both parties accept the terms. ShedShare does not hold these funds.`:`Rental charge: <strong>${money(subtotal)}</strong>. Owner delivery, when selected: ${money(deliveryFee)}. ${paystackAvailable?"The configured payment breakdown is shown in the prepared rental summary.":""} An informational deposit, if agreed, is paid directly at handover. The owner must accept these exact terms before payment opens.`}</p>
      ${manualPaymentAvailable&&item.installmentAvailable?`<label for="rentalPaymentPlan">Payment schedule</label><select id="rentalPaymentPlan"><option value="full">Full rental payment upfront · ${money(subtotal)}</option><option value="deposit_balance">${Number(item.installmentDepositPercent||50)}% deposit now · balance due 24 hours before start</option></select>`:""}
      ${deliveryMethod === "rider_delivery" ? `<div class="fine">Rider delivery is subject to a nearby rider accepting and quoting a fee. The renter pays that fee through a separate Paystack checkout; ShedShare applies the current rider commission rate.</div>` : ""}
      <div class="fine">The security deposit and delivery fee are paid directly to the owner or rider separately and are not part of this platform checkout.</div>
      <button class="primary" id="payBtn" ${ready&&(paystackAvailable||manualPaymentAvailable) ? "" : "disabled"}>${paymentMode==="manual"?`Continue with bank transfer — ${money(subtotal)}`:paystackAvailable?`Continue to Paystack checkout — ${money(subtotal)}`:"Payments temporarily unavailable"}</button>
      </div>`;
    if (ready&&(paystackAvailable||manualPaymentAvailable)) document.getElementById("payBtn").addEventListener("click", finalizeRental);
    return;
  }

  document.getElementById("rentDetail").innerHTML = `<div class="step">${head}<p class="detail-desc">Paystack checkout is not connected in this preview. Payments cannot be accepted or marked paid here.</p><button class="btn-outline" id="paymentBack">Back to browse</button></div>`;
  document.getElementById("paymentBack").addEventListener("click", () => activateSection("browse"));
}

async function confirmRentalSummary(summary,terms){
  const accepted=await api(`/api/rental-summaries/${summary.agreementId}/accept`,{method:"POST",body:JSON.stringify({accepted:true})});
  if(accepted?.error){showToast(accepted.error);return false;}
  if(accepted.ready)return true;
  const schedule=terms.paymentSchedule?.type==="deposit_balance"?`Deposit ${terms.paymentSchedule.depositPercent}%: ${money(Number(terms.subtotal)*Number(terms.paymentSchedule.depositPercent)/100)} now; balance due ${new Date(terms.paymentSchedule.balanceDueAt).toLocaleString()}.`:"Full rental payment is due when the booking is created.";const message=`Rental summary for ${terms.itemName}\n${fmtRange(terms.startAt,terms.endAt,terms.pricingUnit)}\nRental: ${money(terms.subtotal)}\n${schedule}\nOwner delivery fee: ${money(terms.deliveryFee)}\n${paystackAvailable?`Platform commission (disclosed): ${money(terms.platformCommission)}\n`:""}Estimated total including direct delivery: ${money(terms.totalEstimatedCost??terms.totalPayable)}\nInformational deposit: ${money(terms.informationalDeposit)} paid directly at handover if the parties agree.\n\nThe owner must accept these exact terms before payment instructions are available. Continue to the conversation?`;
  window.alert(message);
  const c=await api("/api/messages/conversations",{method:"POST",body:JSON.stringify({itemId:terms.listingId})});
  if(c?.error){showToast(c.error);return false;}
  activeConversation={conversationId:c.conversationId,itemId:String(terms.listingId),withUserId:c.withUserId,withUserName:c.withUserName,itemName:terms.itemName};activateSection("messages");await renderMessagesPage();
  showToast("Rental summary sent. Checkout opens after the owner accepts the same terms.");return false;
}
async function checkoutAcceptedAgreement(agreementId){
  const itemId=activeConversation?.itemId;
  const summaries=asList(await api(`/api/messages/agreements?conversationId=${encodeURIComponent(activeConversation?.conversationId||"")}`));
  const agreement=summaries.find(row=>String(row.id)===String(agreementId));
  if(!agreement||!agreement.ready||agreement.status!=="inquiry")return showToast("This accepted summary is no longer available for checkout.");
  const terms=agreement.terms;
  const reference="shedshare-"+Date.now()+"-"+Math.random().toString(36).slice(2,12);
  const result=await api("/api/rentals",{method:"POST",body:JSON.stringify({itemId:String(terms.listingId||itemId),agreementId:String(agreement.id),pricePerUnit:Number(terms.pricePerUnit),units:Number(terms.units),deliveryMethod:terms.deliveryMethod,deliveryLocation:terms.deliveryLocation||"",...(terms.deliveryLatitude==null?{}:{deliveryLatitude:terms.deliveryLatitude,deliveryLongitude:terms.deliveryLongitude}),startAt:terms.startAt,paymentReference:reference})});
  if(result?.error)return showToast(result.error);
  if(result.checkoutUrl){showToast("Checkout opened. The booking confirms after Paystack verifies payment.");window.location.assign(result.checkoutUrl);return;}
  showToast("Checkout is available only when the real backend is configured.");
}
document.getElementById("rentBack").addEventListener("click", () => activateSection("browse"));

/* ---------- dashboard ---------- */
function actions(html) { return html ? `<div class="row-actions">${html}</div>` : ""; }
function rentalActionButtons(r, role) {
  if (r.onHold && (role === "owner" || role === "renter")) return `<span class="alert-banner">Safety hold: ${esc(r.holdReason || "Contact ShedShare support before continuing.")}</span>`;
  const safetyReport = !r.onHold && ["confirmed", "active"].includes(r.status) && (role === "owner" || role === "renter")
    ? `<button class="danger-button" data-report-safety="${esc(r.id)}">Report safety issue</button>` : "";
  const manualPaymentActions=r.manualPayment&&(role==="owner"||role==="renter")?`<button type="button" class="btn-outline" data-load-manual-payment="${esc(r.id)}">${role==="owner"?"Review transfers":"Pay Remaining Balance"}</button><div data-manual-payment-panel="${esc(r.id)}"></div>`:"";
  const riderDeliveryPayment = role === "renter" && r.deliveryId && r.riderPaymentStatus === "pending"
    ? `<p class="fine">Rider quote: ${money(r.deliveryFee)}${paystackAvailable?` · ShedShare ${Number(r.riderCommissionPercent??0)}%: ${money(Number(r.deliveryFee)*Number(r.riderCommissionPercent??0)/100)} · Rider receives ${100-Number(r.riderCommissionPercent??0)}%: ${money(Number(r.deliveryFee)*(100-Number(r.riderCommissionPercent??0))/100)}`:" · Rider receives the full quoted fee."}</p>${paystackAvailable?`<button type="button" class="primary" data-pay-rider-delivery="${esc(r.deliveryId)}">Pay rider through Paystack</button>`:`<p class="fine">Rider payments are temporarily unavailable.</p>`}<button type="button" class="btn-outline" data-decline-rider-quote="${esc(r.deliveryId)}">Decline quote</button>`
    : role === "renter" && r.riderPaymentStatus === "paid" ? `<p class="fine">Rider fee paid through ShedShare${paystackAvailable?` · ShedShare commission: ${Number(r.riderCommissionPercent??0)}%.`:"."}</p>` : "";
  if (role === "owner") {
    if (r.status === "pending_payment" && r.manualPayment) return `${manualPaymentActions}<button class="btn-outline" data-raction="cancel" data-rid="${esc(r.id)}">Cancel booking</button>`;
    if (r.status === "confirmed") return `${manualPaymentActions}<button class="primary" data-rental-confirm="${esc(r.id)}" data-record="handover">Confirm handover</button>${safetyReport}`;
    if (r.status === "active") return `${manualPaymentActions}<button class="primary" data-rental-confirm="${esc(r.id)}" data-record="return">Confirm return</button><button class="btn-outline" data-extension-response="${esc(r.id)}" data-extension-id="${esc(r.pendingExtensionId||"")}" ${r.pendingExtensionId?"":"hidden"}>Review extension request</button>${safetyReport}`;
  }
  if (role === "renter") {
    if (r.status === "pending_payment" && r.manualPayment) return `${manualPaymentActions}<button class="btn-outline" data-raction="cancel" data-rid="${esc(r.id)}">Cancel booking</button>`;
    if (r.status === "confirmed") return `${manualPaymentActions}${riderDeliveryPayment}<button class="primary" data-rental-confirm="${esc(r.id)}" data-record="handover">Confirm handover</button><button class="btn-outline" data-raction="cancel" data-rid="${esc(r.id)}">Cancel</button>${safetyReport}`;
    if (r.status === "active") return `${manualPaymentActions}${riderDeliveryPayment}<button class="primary" data-rental-confirm="${esc(r.id)}" data-record="return">Confirm return</button><button class="btn-outline" data-extension-request="${esc(r.id)}">Request extension</button>${safetyReport}`;
  }
  if (riderDeliveryPayment) return riderDeliveryPayment;
  if (role === "admin" && (r.status === "confirmed" || r.status === "active")) {
    return `<button class="btn-outline" data-raction="cancel" data-rid="${esc(r.id)}">Cancel</button>`;
  }
  return manualPaymentActions;
}
function wireActionButtons() {
  document.querySelectorAll("[data-load-manual-payment]").forEach(btn=>btn.addEventListener("click",()=>loadManualPaymentPanel(btn.dataset.loadManualPayment)));
  document.querySelectorAll("[data-pay-rider-delivery]").forEach(btn=>btn.addEventListener("click",async()=>{btn.disabled=true;const result=await api(`/api/deliveries/${btn.dataset.payRiderDelivery}/rider-payment`,{method:"POST",body:"{}"});if(result?.error){btn.disabled=false;return showToast(result.error);}window.location.assign(result.checkoutUrl);}));
  document.querySelectorAll("[data-decline-rider-quote]").forEach(btn=>btn.addEventListener("click",async()=>{if(!confirm("Decline this rider quote? You can then choose pickup or owner delivery if available."))return;btn.disabled=true;const result=await api(`/api/deliveries/${btn.dataset.declineRiderQuote}/decline-rider-quote`,{method:"POST",body:"{}"});if(result?.error){btn.disabled=false;return showToast(result.error);}showToast("Rider quote declined. Choose a different delivery option.");await renderDashboard();renderHistory();}));
  document.querySelectorAll("[data-extension-request]").forEach(btn=>btn.addEventListener("click",async()=>{const value=prompt("Proposed new return date and time (ISO format, e.g. 2026-11-01T14:00:00Z):");if(!value)return;const result=await api(`/api/rentals/${btn.dataset.extensionRequest}/extensions`,{method:"POST",body:JSON.stringify({proposedEndAt:new Date(value).toISOString()})});showToast(result?.error||"Extension request sent. Any extra charge requires revised terms and verified checkout.");}));
  document.querySelectorAll("[data-extension-response]").forEach(btn=>btn.addEventListener("click",async()=>{const rows=asList(await api(`/api/rentals/${btn.dataset.extensionResponse}/extensions`));const request=rows.find(row=>row.status==="requested");if(!request)return showToast("No pending extension request is available.");const accepted=confirm(`Renter proposes return by ${new Date(request.proposedEndAt).toLocaleString()}. Accepting cannot change booking dates until revised terms and any extra payment can be verified. Decline this request?`);const result=await api(`/api/rentals/${btn.dataset.extensionResponse}/extensions/${request.id}/respond`,{method:"POST",body:JSON.stringify({accepted:false})});showToast(result?.error||"Extension request declined; booking dates are unchanged.");}));
  document.querySelectorAll("[data-print-agreement]").forEach(btn=>btn.addEventListener("click",()=>{const content=document.getElementById(btn.dataset.printAgreement);if(!content)return;const page=window.open("","_blank","noopener,noreferrer");if(!page)return showToast("Allow pop-ups to print this agreement.");const stylesheet=new URL("/style.css",window.location.href).href;page.document.write(`<!doctype html><html><head><title>ShedShare rental agreement</title><meta charset="utf-8"><link rel="stylesheet" href="${stylesheet}"></head><body class="agreement-print-body">${content.innerHTML}</body></html>`);page.document.close();page.focus();page.print();}));
  document.querySelectorAll("[data-download-agreement]").forEach(button=>button.addEventListener("click",()=>{const id=String(button.dataset.downloadAgreement).replace(/[^a-z0-9_-]/gi,""),content=document.getElementById(`agreement-${id}`);if(!content)return showToast("Accepted agreement details are unavailable for this rental.");downloadHtmlDocument(`shedshare-agreement-${id}.html`,"Accepted rental agreement",content.innerHTML);}));
  document.querySelectorAll("[data-download-receipt]").forEach(button=>button.addEventListener("click",async()=>{button.disabled=true;const result=await api(`/api/rentals/${encodeURIComponent(button.dataset.downloadReceipt)}/receipt`);button.disabled=false;if(result?.error)return showToast(result.error);const rows=[["Receipt number",result.receiptNumber],["Payment status",result.status],["Payment reference",result.paymentReference],["Payment verified",new Date(result.paidAt).toLocaleString()],["Renter",result.renterName],["Lister",result.ownerName],["Listing",result.itemName],["Rental period",fmtRange(result.startAt,result.endAt,result.pricingUnit)],["Quantity",result.inventoryQuantity],["Rate",`${money(result.pricePerUnit)} per ${result.pricingUnit}`],["Rental subtotal",money(result.rentalSubtotal)],["Platform commission",`${money(result.platformFee)} (${result.platformFeePercent}%)`],["Lister payout allocation",money(result.ownerPayout)],["Processed through Paystack",money(result.platformAmount)],["Owner delivery (separately arranged)",money(result.deliveryFee)],["Informational deposit (direct, if agreed)",money(result.informationalDeposit)],["Currency",result.currency],["Agreement version",result.agreementVersion||"Legacy agreement"]];const content=rows.map(([label,value])=>`<div class="receipt-row"><strong>${esc(label)}</strong><span>${esc(String(value??"—"))}</span></div>`).join("")+`<p class="muted">The informational deposit is not collected by ShedShare. Owner delivery is shown separately and is not represented as part of the Paystack rental charge.</p>`;downloadHtmlDocument(`shedshare-receipt-${String(result.receiptNumber).replace(/[^a-z0-9-]/gi,"")}.html`,"Verified rental transaction receipt",content);}));
  document.querySelectorAll("[data-rental-confirm]").forEach(btn=>btn.addEventListener("click",async()=>{const record=btn.dataset.record,notes=prompt(record==="handover"?"Optional condition notes at handover:":"Optional condition notes at return:")||"";const result=await api(`/api/rentals/${btn.dataset.rentalConfirm}/${record}`,{method:"POST",body:JSON.stringify({conditionNotes:notes})});if(result?.error)return showToast(result.error);showToast(result.complete?`Both parties confirmed ${record}.`:`Your ${record} confirmation is recorded; waiting for the other party.`);renderDashboard();}));
  document.querySelectorAll("[data-raction]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const action = btn.dataset.raction;
      if (action === "cancel" && !window.confirm("Cancel this booking? Confirmed bank transfers are not refunded automatically. Contact the other party to agree on any refund.")) return;
      const r = await api(`/api/rentals/${btn.dataset.rid}/${action}`, { method: "POST" });
      if (r && r.error) { showToast(r.error); return; }
      showToast({ activate: "Marked as handed over", complete: "Rental marked completed", cancel: "Rental cancelled" }[action] || "Updated");
      renderDashboard();
      loadItems();
    });
  });
  document.querySelectorAll("[data-iaction]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.iid, action = btn.dataset.iaction;
      if (action === "edit") { startEditItem(id); return; }
      if (action === "delete") {
        if (!window.confirm("Delete this listing permanently? This cannot be undone.")) return;
        btn.disabled = true;btn.textContent = "Deleting…";
        const r = await api(`/api/items/${id}`, { method: "DELETE" });
        if (r && r.error) { showToast(r.error);btn.disabled=false;btn.textContent="Delete listing";return; }
        showToast("Listing deleted");
      } else {
        const pausing = btn.dataset.paused !== "true";
        btn.disabled=true;
        const r = await api(`/api/items/${id}`, { method: "PATCH", body: JSON.stringify({ paused: pausing }) });
        if (r && r.error) { showToast(r.error);btn.disabled=false;return; }
        showToast(pausing ? "Listing paused" : "Listing is live again");
      }
      renderDashboard();
      loadItems();
    });
  });
  document.querySelectorAll("[data-listing-resubmit]").forEach(button=>button.addEventListener("click",async()=>{button.disabled=true;const id=button.dataset.listingResubmit,resubmitted=await api(`/api/items/${encodeURIComponent(id)}/moderation/resubmit`,{method:"POST",body:"{}"});if(resubmitted?.error){button.disabled=false;return showToast(resubmitted.error);}const result=await api(`/api/items/${encodeURIComponent(id)}/moderate`,{method:"POST",body:"{}"});showToast(result?.error|| (result.status==="approved"?"Listing approved and published.":"Updated listing sent for review; it remains hidden."));await Promise.all([renderDashboard(),loadItems()]);}));
  document.querySelectorAll("[data-admin-lister-toggle]").forEach(btn => btn.addEventListener("click", async () => {
    const paused = btn.dataset.paused !== "true";
    const r = await api(`/api/admin/listers/${btn.dataset.adminListerToggle}/listings`, { method: "PATCH", body: JSON.stringify({ paused }) });
    if (r?.error) return showToast(r.error);
    showToast(paused ? `Paused ${r.updatedListings} lister item(s)` : `Resumed ${r.updatedListings} lister item(s)`);
    renderAdminDashboard(); loadItems();
  }));
  document.querySelectorAll("[data-admin-lister-delete]").forEach(btn => btn.addEventListener("click", async () => {
    const listerName = btn.dataset.listerName || "this lister";
    if (!window.confirm(`Permanently delete eligible listings from ${listerName}? Listings with rental history or inspection records will be kept. This cannot be undone.`)) return;
    btn.disabled = true;
    const r = await api(`/api/admin/listers/${btn.dataset.adminListerDelete}/listings`, { method: "DELETE" });
    if (r?.error) { btn.disabled = false; return showToast(r.error); }
    showToast(`Deleted ${r.deletedCount} listing(s); kept ${r.skippedCount} with linked records.`);
    renderAdminDashboard(); loadItems();
  }));
  document.querySelectorAll("[data-admin-hold]").forEach(btn => btn.addEventListener("click", async () => {
    const hold = btn.dataset.held !== "true";
    const reason = hold ? (window.prompt("Why are you placing this rental on a safety hold?", "Safety concern reported") || "").trim() : "";
    if (hold && !reason) return;
    const r = await api(`/api/admin/rentals/${btn.dataset.adminHold}/hold`, { method: "PATCH", body: JSON.stringify({ hold, reason }) });
    if (r?.error) return showToast(r.error);
    showToast(hold ? "Rental actions paused for review" : "Safety hold released");
    renderAdminDashboard();
  }));
  document.querySelectorAll("[data-report-safety]").forEach(btn => btn.addEventListener("click", async () => {
    const reason = (window.prompt("Describe the safety issue or theft concern. Rental handover/completion will pause.", "") || "").trim();
    if (!reason) return;
    const result = await api(`/api/rentals/${btn.dataset.reportSafety}/report-safety`, { method: "POST", body: JSON.stringify({ reason }) });
    if (result?.error) return showToast(result.error);
    showToast(result.message || "Safety report submitted."); renderDashboard();
  }));
  document.querySelectorAll("[data-track-delivery]").forEach(btn => btn.addEventListener("click", async () => {
    startDeliveryTracking(btn.dataset.trackDelivery);
    document.querySelector(`[data-track-panel="${CSS.escape(String(btn.dataset.trackDelivery))}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }));
  document.querySelectorAll("[data-share-owner-delivery]").forEach(btn=>btn.addEventListener("click",()=>shareDeliveryLocation(btn.dataset.shareOwnerDelivery)));
  document.querySelectorAll("[data-owner-start-delivery]").forEach(btn=>btn.addEventListener("click",async()=>{const result=await api(`/api/deliveries/${btn.dataset.ownerStartDelivery}/accept`,{method:"POST"});if(result?.error)return showToast(result.error);showToast("Owner delivery started");renderHistory();}));
}

let activeConversation = null, chatEventSource = null, chatLastId = "0", chatRefreshTimer = null;
const QUICK_MESSAGE_SUGGESTIONS=["Is this item available for my dates?","Can we discuss a deposit and balance schedule?","What deposit do you require?","Can I pay the balance before collection?","Can I pay the balance closer to the event date?","Can we agree on a different installment schedule?","Can we discuss the rental price?","Are delivery and collection available?","Can you confirm the rental duration?","What is your cancellation and refund policy?"];
let activeHistoryFilter = "rentals";
async function openConversation(itemId, withUserId, withUserName, itemName, rentalId = "") {
  if (!session) { sessionStorage.setItem("shedshare_pending_message",JSON.stringify({itemId:String(itemId||""),withUserId:String(withUserId||""),withUserName:String(withUserName||"Lister"),itemName:String(itemName||"Listing"),rentalId:String(rentalId||"")}));showToast("Sign in to message this lister. We’ll return you to the conversation afterward."); document.getElementById("authPanel").hidden = false; return; }
  if (!itemId) { showToast("This transaction is missing listing details."); return; }
  if(chatEventSource){chatEventSource.close();chatEventSource=null;} if(chatRefreshTimer){clearInterval(chatRefreshTimer);chatRefreshTimer=null;}
  const opened = await api("/api/messages/conversations", { method:"POST", body:JSON.stringify({itemId:String(itemId),...(withUserId?{otherUserId:String(withUserId)}:{}),...(rentalId?{rentalId:String(rentalId)}:{})}) });
  if(opened?.error){showToast(opened.error);return;}
  activeConversation = { conversationId:String(opened.conversationId), itemId:String(itemId), withUserId:String(withUserId||opened.withUserId||""), withUserName:withUserName||opened.withUserName||"ShedShare member", itemName:itemName||opened.itemName||"Listing" };
  chatLastId="0";
  const pane = document.getElementById("chatThread");
  document.getElementById("chatEmpty").hidden = true;
  document.getElementById("chatForm").hidden = false;
  pane.innerHTML = `<div class="chat-title"><strong>${esc(withUserName)}</strong><span>${esc(itemName)}</span></div><div class="empty">Loading messages…</div>`;
  activateSection("messages");
  renderMessagesPage();
}

async function loadConversation() {
  if (!activeConversation) return;
  const c = activeConversation;
  const response = await api(`/api/messages?conversationId=${encodeURIComponent(c.conversationId)}`);
  if (response?.error) {
    document.getElementById("chatThread").innerHTML = `<div class="chat-title"><strong>${esc(c.withUserName)}</strong><span>${esc(c.itemName)}</span></div><div class="empty">${esc(response.error)} <button type="button" class="btn-outline" id="retryConversation">Try again</button></div>`;
    document.getElementById("retryConversation")?.addEventListener("click", loadConversation);
    return;
  }
  const messages = asList(response); chatLastId=messages.length?messages[messages.length-1].id:"0";
  const summaries=asList(await api(`/api/messages/agreements?conversationId=${encodeURIComponent(c.conversationId)}`));
  const summaryHtml=summaries.map((a,index)=>{const latest=index===0,isOwner=String(session.user.id)===String(a.ownerId),isRenter=String(session.user.id)===String(a.renterId),alreadyAccepted=isOwner?a.ownerAccepted:a.renterAccepted,statusText=({pending:"Pending offer",accepted:"Accepted by both parties",rejected:"Rejected",expired:"Expired",superseded:"Replaced by a newer offer"})[a.status]||a.status;return `<section class="agreement-summary"><strong>Rental offer v${esc(a.version)} · ${esc(statusText)}${a.expiresAt&&["pending","accepted"].includes(a.status)?` · expires ${esc(new Date(a.expiresAt).toLocaleString())}`:""}</strong><p>${esc(a.terms.itemName)} · ${esc(fmtRange(a.terms.startAt,a.terms.endAt,a.terms.pricingUnit))} · Rental ${money(a.terms.subtotal)} · ${money(a.terms.totalEstimatedCost??a.terms.totalPayable)} estimated total</p>${a.status==="pending"&&!alreadyAccepted?`<button type="button" class="btn-outline" data-agreement-accept="${esc(a.id)}">Accept this offer</button>`:""}${a.status==="pending"&&String(a.createdBy)!==String(session.user.id)?`<button type="button" class="btn-outline" data-agreement-reject="${esc(a.id)}">Reject offer</button>`:""}${latest&&isOwner&&String(a.createdBy)!==String(session.user.id)&&["pending","accepted"].includes(a.status)?`<button type="button" class="btn-outline" data-agreement-counter="${esc(a.rentalId)}">Send counteroffer</button>`:""}${latest&&isRenter&&["rejected","expired"].includes(a.status)?`<button type="button" class="btn-outline" data-agreement-propose="${esc(a.rentalId)}">Propose another price</button>`:""}${a.ready&&a.status==="accepted"&&a.rentalStatus==="inquiry"&&(paystackAvailable||manualPaymentAvailable)?`<button type="button" class="primary" data-agreement-checkout="${esc(a.id)}" data-rental="${esc(a.terms.listingId)}">Continue to payment</button>`:""}${a.rentalStatus==="pending_payment"?`<p class="fine">Payment is pending verification or lister confirmation. Your booking is confirmed after the configured payment method verifies receipt.</p>`:""}</section>`;}).join("");
  const listing=messageListingCache.find(item=>String(item.id)===String(c.itemId))||itemsCache.find(item=>String(item.id)===String(c.itemId));
  const canStartRental=Boolean(listing&&!listing.paused&&String(listing.ownerId)!==String(session.user.id)&&!c.locked&&!summaries.length);
  const rentalCta=canStartRental?`<section class="chat-rental-cta"><div><strong>Ready to rent this item?</strong><p>Choose your dates and delivery option, review the agreement, then continue to secure payment.</p></div><button type="button" class="primary" data-chat-rent-item="${esc(c.itemId)}">Continue to agreement &amp; payment</button></section>`:"";
  document.getElementById("chatThread").innerHTML = `<div class="chat-title"><strong>${esc(c.withUserName)}</strong><span>${esc(c.itemName)}</span><div class="chat-safety-actions"><button type="button" class="btn-outline" id="reportConversation">Report</button><button type="button" class="btn-outline" id="blockConversation">Block</button></div></div><p class="fine">Messages may be reviewed by ShedShare for safety and dispute resolution.</p>${rentalCta}${summaryHtml}${messages.some(m=>m.contactDetailsMasked)?`<p class="fine">Contact details are shared after booking is confirmed.</p>`:""}<div class="chat-messages">${messages.length ? messages.map(m => `<article class="chat-bubble ${String(m.senderId) === String(session.user.id) ? "mine" : "theirs"}" data-message-id="${esc(m.id)}"><span>${esc(m.senderName)}</span><p>${esc(m.text)}</p>${m.attachment?`<img class="chat-photo" data-private-chat-photo="${esc(m.attachment.url)}" alt="Photo attachment">`:""}<time>${esc(new Date(m.createdAt).toLocaleString())} · <span data-message-receipt>${m.read?"Seen":"Sent"}</span></time></article>`).join("") : `<div class="empty">Start the conversation. Keep payments and arrangements on ShedShare.</div>`}</div><div class="quick-message-chips" aria-label="Suggested messages">${QUICK_MESSAGE_SUGGESTIONS.map((text,index)=>`<button type="button" class="btn-outline" data-quick-message="${index}">${esc(text)}</button>`).join("")}</div>`;
  document.querySelectorAll("[data-quick-message]").forEach(button=>button.addEventListener("click",()=>{const input=document.getElementById("chatText");if(input){input.value=QUICK_MESSAGE_SUGGESTIONS[Number(button.dataset.quickMessage)]||"";input.focus();}}));
  document.getElementById("reportConversation")?.addEventListener("click",async()=>{const reason=prompt("Why are you reporting this conversation?");if(reason){const r=await api(`/api/messages/conversations/${c.conversationId}/report`,{method:"POST",body:JSON.stringify({reason})});showToast(r?.error||"Report sent to ShedShare safety.");}});
  document.getElementById("blockConversation")?.addEventListener("click",async()=>{if(!confirm("Block messaging in this conversation?"))return;const r=await api(`/api/messages/conversations/${c.conversationId}/block`,{method:"POST",body:"{}"});showToast(r?.error||"Conversation blocked.");});
  const list = document.getElementById("conversationList");
  list.querySelectorAll("[data-conversation]").forEach(btn => btn.classList.toggle("selected", btn.dataset.conversationId === c.conversationId));
  const messagesEl = document.querySelector(".chat-messages");
  if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
  loadPrivateChatPhotos();
  refreshMessageUnreadBadge();
  startChatUpdates(c.conversationId);
}

async function loadPrivateChatPhotos(){for(const img of document.querySelectorAll("img[data-private-chat-photo]")){try{const response=await fetch(API_BASE+img.dataset.privateChatPhoto,{credentials:"include"});if(!response.ok)continue;img.src=URL.createObjectURL(await response.blob());}catch(_e){}}}
function updateChatReadReceipt(lastReadMessageId){const host=document.querySelector(".chat-messages");if(!host)return;for(const bubble of host.querySelectorAll('.chat-bubble.mine[data-message-id]')){if(Number(bubble.dataset.messageId)<=Number(lastReadMessageId)){const receipt=bubble.querySelector("[data-message-receipt]");if(receipt)receipt.textContent="Seen";}}}
function appendChatMessages(rows){if(!activeConversation||!rows.length)return;const host=document.querySelector(".chat-messages");if(!host)return;for(const m of rows){if(Number(m.id)<=Number(chatLastId))continue;chatLastId=m.id;host.insertAdjacentHTML("beforeend",`<article class="chat-bubble ${String(m.senderId)===String(session.user.id)?"mine":"theirs"}" data-message-id="${esc(m.id)}"><span>${esc(m.senderName)}</span><p>${esc(m.text)}</p>${m.attachment?`<img class="chat-photo" data-private-chat-photo="${esc(m.attachment.url)}" alt="Photo attachment">`:""}<time>${esc(new Date(m.createdAt).toLocaleString())} · <span data-message-receipt>${m.read?"Seen":"Sent"}</span></time></article>`);}host.scrollTop=host.scrollHeight;loadPrivateChatPhotos();loadConversations();}
function startChatUpdates(conversationId){if(chatEventSource){chatEventSource.close();chatEventSource=null;}if(chatRefreshTimer)clearInterval(chatRefreshTimer);if(!session)return;fetch(`${API_BASE}/api/messages/stream?conversationId=${encodeURIComponent(conversationId)}&afterId=${encodeURIComponent(chatLastId)}`,{credentials:"include"}).then(async response=>{if(!response.ok||!response.body)throw new Error("stream");const reader=response.body.getReader(),decoder=new TextDecoder();let pending="";while(true){const {value,done}=await reader.read();if(done)break;pending+=decoder.decode(value,{stream:true});const chunks=pending.split("\n\n");pending=chunks.pop()||"";for(const chunk of chunks){if(chunk.includes("event: closed")){showToast("This conversation is closed.");return;}const data=chunk.split("\n").find(line=>line.startsWith("data: "))?.slice(6);if(data&&chunk.includes("event: messages")){try{appendChatMessages(JSON.parse(data));}catch(_e){}}else if(data&&chunk.includes("event: read")){try{updateChatReadReceipt(JSON.parse(data).lastReadMessageId);}catch(_e){}}}}}).catch(()=>{}).finally(()=>{if(activeConversation?.conversationId===conversationId&&!chatRefreshTimer){chatRefreshTimer=setInterval(async()=>{const rows=await api(`/api/messages?conversationId=${encodeURIComponent(conversationId)}&afterId=${encodeURIComponent(chatLastId)}`);if(Array.isArray(rows))appendChatMessages(rows);},8000);}});}

async function loadConversations() {
  const list = document.getElementById("conversationList");
  if (!session) { list.innerHTML = `<div class="empty">Sign in to view messages.</div>`; return; }
  list.innerHTML = `<div class="empty">Loading conversations…</div>`;
  const response = await api("/api/messages/conversations");
  if (response?.error) {
    list.innerHTML = `<div class="empty">${esc(response.error)} <button type="button" class="btn-outline" id="retryConversations">Try again</button></div>`;
    document.getElementById("retryConversations")?.addEventListener("click", loadConversations);
    return;
  }
  const rows = asList(response);
  applyMessageUnreadBadge(rows.reduce((total,conversation)=>total+Number(conversation.unreadCount||0),0));
  list.innerHTML = rows.length ? rows.map(c => `<button type="button" class="conversation-button ${activeConversation && activeConversation.conversationId === c.conversationId ? "selected" : ""}" data-conversation data-conversation-id="${esc(c.conversationId)}" data-item-id="${esc(c.itemId||"")}" data-with-user-id="${esc(c.otherUserId)}" data-with-name="${esc(c.otherUserName)}" data-item-name="${esc(c.itemName)}" data-locked="${c.locked?"true":"false"}"><span class="conversation-thumb">${c.thumbnail?`<img src="${esc(c.thumbnail)}" alt="">`:"◉"}</span><span class="conversation-copy"><strong>${esc(c.otherUserName)}</strong><span>${esc(c.itemName)}</span><small>${esc(c.lastMessage||"Conversation started")}</small></span>${c.unreadCount?`<b class="unread-badge">${esc(c.unreadCount)}</b>`:""}</button>`).join("") : `<div class="empty">No conversations yet. Start one from an item page.</div>`;
  list.querySelectorAll("[data-conversation]").forEach(btn => btn.addEventListener("click", () => {activeConversation={conversationId:btn.dataset.conversationId,itemId:btn.dataset.itemId,withUserId:btn.dataset.withUserId,withUserName:btn.dataset.withName,itemName:btn.dataset.itemName,locked:btn.dataset.locked==="true"};chatLastId="0";document.getElementById("chatEmpty").hidden=true;document.getElementById("chatForm").hidden=false;document.querySelector("#chatForm button[type=submit]").disabled=activeConversation.locked;document.querySelector("#chatText").disabled=activeConversation.locked;loadConversation();}));
}

async function loadMessageDirectory() {
  const directory = document.getElementById("messageDirectory");
  if (!directory || !session) return;
  directory.innerHTML = `<div class="empty">Loading people on ShedShare…</div>`;
  const response = await api("/api/items");
  if (response?.error) { directory.innerHTML = `<div class="empty">${esc(response.error)} <button type="button" class="btn-outline" id="retryMessageDirectory">Try again</button></div>`; document.getElementById("retryMessageDirectory")?.addEventListener("click", loadMessageDirectory); return; }
  const listings = asList(response);
  messageListingCache = listings;
  const choices = listings.filter(item => !item.paused && String(item.ownerId) !== String(session.user.id));
  directory.innerHTML = choices.length ? choices.map(item => `<article class="message-contact-card"><div class="message-contact-copy"><strong>${esc(item.ownerName || "ShedShare lister")}</strong><span>${esc(item.name)} · ${esc(item.location || "Location not set")}</span></div><button type="button" data-message-item="${esc(item.id)}" data-message-owner="${esc(item.ownerId)}" data-message-name="${esc(item.ownerName || "ShedShare lister")}" data-message-item-name="${esc(item.name)}">Message</button></article>`).join("") : `<div class="empty">No other active listers yet. When someone posts an item, they’ll appear here. You can also browse listings to find people to contact.</div>`;
}

document.getElementById("chatForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeConversation) return;
  const input = document.getElementById("chatText"), photoInput=document.getElementById("chatImage"), file=photoInput?.files?.[0], text = input.value.trim();
  if (!text&&!file) return;
  const result = await api("/api/messages", { method: "POST", body: JSON.stringify({ conversationId: activeConversation.conversationId, text, attachmentMessage:Boolean(file) }) });
  if (result?.error) return showToast(result.error);
  if(file){const form=new FormData();form.append("image",file);const uploaded=await api(`/api/messages/${result.id}/attachment`,{method:"POST",body:form});if(uploaded?.error)showToast(uploaded.error);photoInput.value="";}
  input.value = "";
  await loadConversation(); loadConversations();
});

let deliveryTrackingTimer = null, deliveryTrackingMap = null, deliveryTrackingMarkers = [];
async function shareDeliveryLocation(deliveryId){if(!navigator.geolocation)return showToast("This device does not support location sharing.");navigator.geolocation.getCurrentPosition(async position=>{const result=await api(`/api/deliveries/${deliveryId}/location`,{method:"POST",body:JSON.stringify({lat:position.coords.latitude,lng:position.coords.longitude,timestamp:position.timestamp})});showToast(result?.error||"Delivery location shared with the renter.");},()=>showToast("Location permission was not granted."),{enableHighAccuracy:true,timeout:12000});}
async function startDeliveryTracking(deliveryId) {
  const host = document.querySelector(`[data-track-panel="${CSS.escape(String(deliveryId))}"]`); if (!host) return;
  if (deliveryTrackingTimer) clearInterval(deliveryTrackingTimer);
  const refresh = async () => {
    const track = await api(`/api/deliveries/${deliveryId}/track`);
    if (track?.error) { host.innerHTML = `<p class="fine">${esc(track.error)}</p>`; clearInterval(deliveryTrackingTimer); return; }
    if (track.fallbackAvailable) { host.innerHTML = `<p class="fine">No rider accepted within the offer period. Choose how to continue.</p><button type="button" class="btn-outline" data-delivery-fallback="pickup">Choose Pickup</button>${track.ownerDelivery!==false?`<button type="button" class="primary" data-delivery-fallback="owner_delivery">Choose Owner delivers</button>`:`<span class="fine">Owner delivery is not available for this listing.</span>`}`;host.querySelectorAll("[data-delivery-fallback]").forEach(button=>button.addEventListener("click",async()=>{const result=await api(`/api/deliveries/${deliveryId}/fallback`,{method:"POST",body:JSON.stringify({choice:button.dataset.deliveryFallback})});if(result?.error)return showToast(result.error);showToast("Delivery choice updated");clearInterval(deliveryTrackingTimer);renderHistory();}));clearInterval(deliveryTrackingTimer);return;}
    if (track.trackingState === "ended") { host.innerHTML = `<p class="fine">Delivery tracking has ended. Rental and delivery records remain available.</p>`; clearInterval(deliveryTrackingTimer); return; }
    if(track.trackingState==="stale"){host.innerHTML=`<p class="fine">Stale, last seen ${Math.floor(track.staleAgeSeconds/60)}m ago. The old position is hidden. Waiting for a fresh rider update.</p>`;return;}
    if (track.trackingState === "not_started") { host.innerHTML = `<p class="fine">Delivery is ${esc(track.status.replaceAll("_"," "))}. Rider location has not been received yet.</p>`; return; }
    if (!track.lastLocation) { host.innerHTML = `<p class="fine">Rider location not received yet. It will appear here when the delivery person shares GPS.</p>`; return; }
    const age = Math.max(0, Math.floor(track.lastLocation.ageSeconds || 0));
    if (age > 90) { host.innerHTML = `<p class="fine">Stale, last seen ${age} seconds ago. The old position is hidden.</p>`; return; }
    if (!mapsReady || !window.L) { host.innerHTML = `<p class="fine">Map failed to load. Delivery status is ${esc(track.status.replaceAll("_"," "))}; location last received ${age}s ago.</p>`; return; }
    const points = [track.lastLocation,track.pickupPoint,track.destinationPoint].filter(Boolean);
    const center=[Number(track.lastLocation.lat),Number(track.lastLocation.lng)];
    if (deliveryTrackingMap&&deliveryTrackingMap.getContainer()!==host){deliveryTrackingMap.remove();deliveryTrackingMap=null;deliveryTrackingMarkers=[];}
    if (!deliveryTrackingMap) deliveryTrackingMap = createGeoapifyMap(host,center,13);
    deliveryTrackingMarkers.forEach(marker=>deliveryTrackingMap.removeLayer(marker)); deliveryTrackingMarkers=[];
    const bounds=L.latLngBounds();const addPin=(point,title,color)=>{const position=[Number(point.lat),Number(point.lng)];bounds.extend(position);deliveryTrackingMarkers.push(L.circleMarker(position,{radius:8,color:"#fff",weight:2,fillColor:color,fillOpacity:1}).bindTooltip(title).addTo(deliveryTrackingMap));};
    addPin(track.lastLocation,track.rider?.name||"Delivery person","#0b7a53"); if(track.pickupPoint)addPin(track.pickupPoint,"Pickup","#3478d4");if(track.destinationPoint)addPin(track.destinationPoint,"Destination","#d45d44");
    if(points.length>1)deliveryTrackingMap.fitBounds(bounds,{padding:[24,24],maxZoom:15}); else deliveryTrackingMap.setView(center,13);
    setTimeout(()=>deliveryTrackingMap.invalidateSize(),0);
    const updated = new Date(track.lastLocation.recordedAt); const elapsed = Math.max(0,Math.floor((Date.now()-updated.getTime())/1000));
    let meta=host.querySelector("[data-track-meta]");if(!meta){meta=document.createElement("p");meta.className="fine";meta.dataset.trackMeta="true";host.append(meta);}meta.innerHTML=`<strong>${esc(track.rider?.name||"Delivery person")}</strong> · ${esc(track.status.replaceAll("_"," "))} · Updated ${elapsed<60?`${elapsed}s ago`:`${Math.floor(elapsed/60)}m ago`}.`;
  };
  await refresh(); deliveryTrackingTimer=setInterval(refresh,10000);
}

function deliveryMapHtml(point, status, riderName) {
  if (!Number.isFinite(Number(point?.lat)) || !Number.isFinite(Number(point?.lng))) return `<p class="fine">Rider location not received yet.</p>`;
  const age=Math.floor(Math.max(0,(Date.now()-new Date(point.recordedAt).getTime())/1000));
  return `<div class="map-meta"><span><strong>${esc(riderName)}</strong> · ${esc(status.replaceAll("_", " "))}</span><span>${age>90?`Stale, last seen ${age}s ago`:`Updated ${age}s ago`}</span></div>`;
}

async function renderAdminTools(allTx) {
  const [listers, registeredUsers, deliveries, controls, flags, riders, businessLeads,appConfig,chatReports,disputedConversations] = await Promise.all([
    api("/api/admin/listers"), api("/api/admin/users"), api("/api/deliveries?role=admin"), api("/api/admin/controls"), api("/api/admin/contact-flags"), api("/api/rider/applications"),api("/api/admin/external-business-leads"),fetch(`${API_BASE}/api/config`, { credentials: "include" }).then(response=>response.ok?response.json():{}).catch(()=>({})),api("/api/admin/chat-reports"),api("/api/admin/disputed-conversations")
  ]);
  const listerRows = asList(listers), userRows = asList(registeredUsers), deliveryRows = asList(deliveries), riderRows = asList(riders);
  document.querySelectorAll("#listerCount,#listerCountLabel").forEach(el => el.textContent = `${listerRows.length} lister${listerRows.length === 1 ? "" : "s"}`);
  document.getElementById("listerList").innerHTML = listerRows.length ? listerRows.map(l => `<article class="lister-card"><div class="lister-main"><div class="avatar-chip">${esc((l.name || "L").slice(0,1).toUpperCase())}</div><div><h3>${esc(l.name)}</h3><p>${esc(l.brand || "Independent lister")}</p></div></div><div class="lister-details"><a href="mailto:${esc(l.email)}">${esc(l.email)}</a><a href="tel:${esc(l.phone)}">${esc(l.phone || "No phone on file")}</a><span>${l.activeListingCount} active · ${l.listingCount} total listings</span></div><div class="lister-actions"><button type="button" class="${l.activeListingCount ? "danger-button" : "btn-outline"}" data-admin-lister-toggle="${esc(l.id)}" data-paused="${l.activeListingCount === 0 ? "true" : "false"}">${l.activeListingCount ? "Pause all listings" : "Resume all listings"}</button><button type="button" class="danger-button" data-admin-lister-delete="${esc(l.id)}" data-lister-name="${esc(l.name)}" ${l.listingCount === 0 ? "disabled" : ""}>Delete eligible listings</button></div></article>`).join("") : `<div class="empty">No listers have posted items yet.</div>`;
  document.querySelectorAll("#registeredUserCount,#registeredUserCountLabel").forEach(el => el.textContent = `${userRows.length} account${userRows.length === 1 ? "" : "s"}`);
  document.getElementById("registeredUserList").innerHTML = registeredUsers?.error
    ? `<div class="empty">${esc(registeredUsers.error)}</div>`
    : userRows.length ? userRows.map(user => `<article class="registered-user-card"><div class="registered-user-avatar">${esc((user.name || "U").trim().slice(0,1).toUpperCase())}</div><div class="registered-user-main"><div class="registered-user-heading"><h3>${esc(user.name || "Unnamed user")}</h3><span class="registered-user-role">${user.isAdmin ? "Administrator" : user.isRider ? "Rider" : "User"}</span></div><div class="registered-user-details"><a href="mailto:${esc(user.email)}">${esc(user.email)}</a><a href="tel:${esc(user.phone)}">${esc(user.phone || "No phone on file")}</a><span>${user.emailVerified ? "Email verified" : "Email not verified"}</span><span>Joined ${esc(new Date(user.joinedAt).toLocaleDateString())}</span></div></div></article>`).join("")
    : `<div class="empty">No registered accounts yet.</div>`;
  const pauseButton = document.getElementById("paymentPauseButton");
  if (controls?.error) { pauseButton.disabled = true; pauseButton.textContent = "Control unavailable"; }
  else { pauseButton.disabled = false; pauseButton.dataset.paused = String(Boolean(controls?.paymentsPaused)); pauseButton.textContent = controls?.paymentsPaused ? "Resume new checkouts" : "Pause new checkouts"; pauseButton.classList.toggle("is-paused", Boolean(controls?.paymentsPaused)); }
  const commissionSettings = await api("/api/admin/commission-settings");
  const commissionForm = document.getElementById("commissionSettingsForm");
  const commissionStatus = document.getElementById("commissionSettingsStatus");
  commissionForm.closest(".admin-controls")?.toggleAttribute("hidden", !paystackAvailable);
  if (commissionSettings?.error) { commissionForm.querySelectorAll("input,button").forEach(control => control.disabled = true); commissionStatus.textContent = commissionSettings.error; }
  else { document.getElementById("rentalCommissionPercent").value = commissionSettings.rentalPercent; document.getElementById("riderCommissionPercent").value = commissionSettings.riderPercent; }
  document.getElementById("adminDeliveryList").innerHTML = deliveryRows.length ? deliveryRows.map(d => { const eligible = riderRows.filter(r => r.isApproved && r.availability === "active" && !r.currentDeliveryId); const assign = !d.riderId && ["requested","awaiting_rider"].includes(d.status) && eligible.length ? `<div class="assignment-row"><select aria-label="Choose a rider" data-rider-choice="${esc(d.id)}">${eligible.map(r => `<option value="${esc(r.userId)}">${esc(r.name)} · ${esc(r.vehicleType)}</option>`).join("")}</select><button class="btn-outline" type="button" data-assign-rider="${esc(d.id)}">Assign</button></div>` : ""; return `<article class="delivery-card"><div class="section-heading"><div><h3>${esc(d.itemName || "Delivery")}</h3><p>${esc(d.referenceNumber)} · ${esc(d.status.replaceAll("_", " "))}</p></div><span class="status ${d.exception ? "cancelled" : "active"}">${d.exception ? "Needs review" : "Tracking"}</span></div><div class="split-row"><span class="label">Renter</span><span class="value">${esc(d.renter?.name || "—")}</span></div><div class="split-row"><span class="label">Contact</span><span class="value">${d.renter?.email ? `<a href="mailto:${esc(d.renter.email)}">${esc(d.renter.email)}</a> · <a href="tel:${esc(d.renter.phone)}">${esc(d.renter.phone)}</a>` : "—"}</span></div><div class="split-row"><span class="label">Rider</span><span class="value">${esc(d.riderName || "Unassigned")}</span></div>${assign}${d.lastLocation ? deliveryMapHtml(d.lastLocation,d.status,d.riderName || "Rider") : `<div class="map-placeholder">Waiting for rider GPS. Location sharing is available during active deliveries.</div>`}${d.exception ? `<p class="alert-banner">${esc(d.exception.type)} · ${esc(d.exception.status)}</p>` : ""}</article>`; }).join("") : `<div class="empty">No delivery jobs yet. Delivery map pins appear when an approved rider shares GPS.</div>`;
  document.getElementById("riderApplicationList").innerHTML = riderRows.length ? riderRows.map(r=>`<article class="delivery-card"><div class="section-heading"><div><h3>${esc(r.name||"Rider applicant")} · ${esc(r.status)}</h3><p>${esc(r.city)}, ${esc(r.state)} · ${esc(r.vehicleType)} · ${esc(r.plateNumber)}</p></div>${r.flaggedLowRating?`<span class="status cancelled">Low rating review</span>`:""}</div><p class="fine">${esc(r.email)} · ${esc(r.phone)} · Paystack account ${r.payoutConnected?"connected":"not connected"}</p><p class="fine">Cancellations: ${r.cancellationCount} · Rating: ${r.averageRating==null?"No ratings":`${r.averageRating.toFixed(1)} / 5 (${r.ratingCount})`}</p><div class="row-actions">${r.profilePhotoAvailable?`<button class="btn-outline" data-rider-document="${esc(r.id)}" data-kind="profile">View profile photo</button>`:""}${r.idDocumentAvailable?`<button class="btn-outline" data-rider-document="${esc(r.id)}" data-kind="id">View ID</button>`:""}${r.status==="pending"?`<button class="primary" data-rider-review="${esc(r.id)}" data-status="approved">Approve once</button><button class="danger-button" data-rider-review="${esc(r.id)}" data-status="rejected">Reject</button>`:""}${r.status==="approved"?`<button class="danger-button" data-rider-review="${esc(r.id)}" data-status="suspended">Suspend and set offline</button>`:""}${r.rejectionReason?`<p class="fine">Reason: ${esc(r.rejectionReason)}</p>`:""}</div></article>`).join(""):`<div class="empty">No rider applications yet.</div>`;
  document.querySelectorAll("[data-rider-review]").forEach(btn=>btn.addEventListener("click",async()=>{const reason=btn.dataset.status==="rejected"?prompt("Reason for rejecting this application?"):"";if(btn.dataset.status==="rejected"&&!reason)return;const result=await api(`/api/rider/applications/${btn.dataset.riderReview}/review`,{method:"PATCH",body:JSON.stringify({status:btn.dataset.status,...(reason?{reason}:{})})});if(result?.error)return showToast(result.error);showToast(`Rider ${btn.dataset.status}.`);renderAdminDashboard();}));
  document.querySelectorAll("[data-rider-document]").forEach(btn=>btn.addEventListener("click",async()=>{const preview=window.open("about:blank","_blank");try{const response=await fetch(`${API_BASE}/api/rider/applications/${btn.dataset.riderDocument}/document/${btn.dataset.kind}`,{credentials:"include"});if(!response.ok){preview?.close();return showToast("Unable to access this private document.");}const url=URL.createObjectURL(await response.blob());if(preview)preview.location.href=url;else showToast("Allow pop-ups to view the private rider document.");setTimeout(()=>URL.revokeObjectURL(url),60_000);}catch(_error){preview?.close();showToast("Unable to access this private document.");}}));
  document.querySelectorAll("[data-assign-rider]").forEach(btn => btn.addEventListener("click", async () => { const select = document.querySelector(`[data-rider-choice="${btn.dataset.assignRider}"]`); const result = await api(`/api/deliveries/${btn.dataset.assignRider}/assign`, { method: "POST", body: JSON.stringify({ riderId: select.value }) }); if (result?.error) return showToast(result.error); showToast("Rider assigned"); renderAdminDashboard(); }));
  const contactFlags = asList(flags);
  const reports=asList(chatReports),disputes=asList(disputedConversations);
  document.getElementById("contactFlagList").innerHTML = `<section class="chat-report-list"><h3>Chat reports and rental disputes</h3>${reports.map(r=>`<article class="flag-card"><div class="section-heading"><div><strong>Reported chat · ${esc(r.reporterName)} · ${esc(r.status)}</strong><p>${esc(new Date(r.createdAt).toLocaleString())} · ${esc(r.reason)}</p></div><button type="button" class="btn-outline" data-admin-review-chat="${esc(r.conversationId)}">Review conversation</button></div></article>`).join("")}${disputes.map(r=>`<article class="flag-card"><div class="section-heading"><div><strong>Rental dispute · ${esc(r.itemName)} · ${esc(r.status)}</strong><p>${esc(new Date(r.createdAt).toLocaleString())} · ${esc(r.reason)}</p></div><button type="button" class="btn-outline" data-admin-review-chat="${esc(r.conversationId)}" data-review-mode="dispute">Review conversation</button></div></article>`).join("")}${!reports.length&&!disputes.length?`<div class="empty">No reported chats or open rental disputes.</div>`:""}</section>${contactFlags.length ? contactFlags.map(f => `<article class="flag-card"><div class="section-heading"><div><strong>${esc(f.senderName)} → ${esc(f.recipientName)}</strong><p>${esc(f.itemName)} · ${esc(new Date(f.createdAt).toLocaleString())}</p></div><span class="count-pill">Contact filtered</span></div><p>${esc(f.text)}</p></article>`).join("") : `<div class="empty">No contact sharing attempts have been flagged.</div>`}`;
  document.getElementById("externalSearchStatus").textContent=appConfig?.externalSearchDiagnostic||"External search configuration is unavailable.";
  const leadRows=asList(businessLeads);document.getElementById("externalBusinessLeadList").innerHTML=businessLeads?.error?`<div class="empty">${esc(businessLeads.error)}</div>`:leadRows.length?leadRows.map(lead=>`<article class="flag-card"><strong>${esc(lead.item)}</strong><p>${esc(lead.city)}, ${esc(lead.state)} · ${esc(lead.action)}</p><p><a href="https://www.google.com/maps/search/?api=1&query_place_id=${encodeURIComponent(lead.placeId)}" target="_blank" rel="noopener">Open Google Maps place</a> · ${lead.count} lead${lead.count===1?"":"s"} · Last ${esc(new Date(lead.lastLeadAt).toLocaleString())}</p></article>`).join(""):`<div class="empty">No external business leads yet.</div>`;
  return { listerRows, userRows, deliveryRows, riderRows, controls, contactFlags,leadRows,commissionSettings };
}

async function renderReferralDashboard() {
  const host = document.getElementById("referralDashboardContent");
  if (!host || !session) return;
  host.innerHTML = `<div class="empty">Loading your referral details…</div>`;
  const data = await api("/api/referrals/me");
  if (data?.error) { host.innerHTML = `<div class="empty">${esc(data.error)} <button type="button" class="btn-outline" id="retryReferralDashboard">Try again</button></div>`; host.querySelector("#retryReferralDashboard")?.addEventListener("click", renderReferralDashboard); return; }
  const inviteUrl = `${window.location.origin}${window.location.pathname}?ref=${encodeURIComponent(data.code || "")}`;
  const referrals = asList(data.referrals);
  const referredMemberCount = new Set(referrals.map(row => row.id)).size;
  const rules = asList(data.rules).filter(rule => rule.enabled);
  host.innerHTML = `<div class="referral-share-card"><div><small>Your referral code</small><strong>${esc(data.code || "Unavailable")}</strong></div><label class="referral-link-field">Share link<input type="url" readonly value="${esc(inviteUrl)}" aria-label="Your referral link"></label><button type="button" class="primary" id="copyReferralLink">Copy link</button></div>
    <p class="fine">${data.enabled ? (rules.length ? `Qualifying actions: ${rules.map(rule => `${esc(rule.label)} (${money(rule.referrerReward)} referrer · ${money(rule.referredReward)} new member)`).join("; ")}. Rewards are promotional credit, not withdrawable cash, and are reviewed before issuance.` : "The programme is on, but no qualifying events are enabled yet.") : "The referral programme is currently inactive. Your code is ready, but no rewards accrue until ShedShare enables qualifying rules."}</p>
    ${data.ownReferral ? `<div class="referral-own-status"><strong>Your sign-up referral</strong><span>${esc(data.ownReferral.status.replaceAll("_", " "))}</span></div>` : ""}
    <div class="referral-summary"><div><small>Promotional credit balance</small><strong>${money(data.promotionalCreditBalance || 0)}</strong><small>Non-withdrawable · promotional ledger</small></div><div><small>People referred</small><strong>${referredMemberCount}</strong></div></div>
    <div class="referral-list">${referrals.length ? referrals.map(row => `<article class="referral-row"><div><strong>Referred member</strong><small>${esc(row.createdAt ? new Date(row.createdAt).toLocaleDateString() : "")}${row.qualifyingEvent ? ` · ${esc(String(row.qualifyingEvent).replaceAll("_", " "))}` : " · No qualifying action yet"}</small></div><span class="status ${esc(row.status)}">${esc(row.statusLabel || row.status)}</span><span class="value">${money(row.promotionalCredit || 0)}</span></article>`).join("") : `<div class="empty">No referrals yet. Share your link to invite someone to ShedShare.</div>`}</div>`;
  host.querySelector("#copyReferralLink")?.addEventListener("click", async event => {
    try { await navigator.clipboard.writeText(inviteUrl); showToast("Referral link copied."); }
    catch { const input = host.querySelector(".referral-link-field input"); input?.select(); showToast("Select and copy your referral link."); }
  });
}

async function renderDashboard() {
  syncAiControls();
  if (!itemsCacheInitialized) await loadItems();
  const user = session?.user || {};
  await renderReferralDashboard();
  const name = user.name || "there";
  const firstName = name.trim().split(/\s+/)[0];
  const initials = name.trim().split(/\s+/).map(part => part[0]).join("").slice(0,2).toUpperCase() || "SS";
  const hour = new Date().getHours();
  document.getElementById("dashboardTitle").textContent = `Good ${hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening"}, ${firstName}!`;
  document.getElementById("dashboardSubtitle").textContent = "Find and rent what you need, when you need it.";
  document.getElementById("userHeaderName").textContent = name;
  document.getElementById("userAccountName").textContent = name;
  document.getElementById("userAccountEmail").textContent = user.email || "Your ShedShare account";
  document.getElementById("userAvatar").textContent = initials;
  document.getElementById("userAccountAvatar").textContent = initials;
  const prefs=await api("/api/notification-preferences");if(prefs&&!prefs.error){const inApp=document.getElementById("pref-inapp"),email=document.getElementById("pref-email"),push=document.getElementById("pref-push");if(inApp)inApp.checked=Boolean(prefs.inApp);if(email){email.checked=Boolean(prefs.email&&prefs.emailAvailable);email.disabled=!prefs.emailAvailable;email.parentElement.lastChild.textContent=prefs.emailAvailable?" Email alerts":" Email alerts (provider unavailable)";}if(push){push.checked=Boolean(prefs.push&&prefs.pushAvailable);push.disabled=!prefs.pushAvailable;push.parentElement.lastChild.textContent=prefs.pushAvailable?" Phone notifications":" Phone notifications (server setup needed)";}}
  const bankDetails=await api("/api/manual-payments/bank-details");if(bankDetails&&!bankDetails.error){const bank=document.getElementById("manualBankName"),nameField=document.getElementById("manualAccountName"),acct=document.getElementById("manualAccountNumber");if(bank)bank.value=bankDetails.bankName||"";if(nameField)nameField.value=bankDetails.accountName||"";if(acct)acct.value=bankDetails.accountNumber||"";}
  myItemsCache = asList(await api("/api/items?mine=1"));
  const rentalsAsOwner = asList(await api("/api/rentals?role=owner"));
  const rentalsAsRenter = asList(await api("/api/rentals?role=renter"));
  const inspections=asList(await api("/api/inspections"));
  const inspectionHost=document.getElementById("inspectionList");if(inspectionHost)inspectionHost.innerHTML=inspections.length?inspections.map(i=>`<article class="history-card"><strong>${esc(i.itemName)} · ${esc(i.status)}</strong><p>${esc(new Date(i.proposedAt).toLocaleString())} · ${esc(i.meetingLocation)}</p>${i.status==="requested"&&String(i.ownerId)===String(user.id)?`<button type="button" class="btn-outline" data-inspection-action="accept" data-inspection="${esc(i.id)}">Accept</button><button type="button" class="btn-outline" data-inspection-action="decline" data-inspection="${esc(i.id)}">Decline</button>`:""}${["requested","accepted"].includes(i.status)?`<button type="button" class="btn-outline" data-inspection-action="cancel" data-inspection="${esc(i.id)}">Cancel</button>`:""}</article>`).join(""):`<div class="empty">No inspection appointments.</div>`;
  const conversations = session ? asList(await api("/api/messages/conversations")) : [];
  const saved = getBookmarkedIds();
  const catalog = [...itemsCache, ...myItemsCache];
  const savedItems = saved.map(id => catalog.find(item => String(item.id) === id)).filter(Boolean);
  document.getElementById("userBookmarkNavCount").textContent = String(saved.length);
  document.getElementById("userHeaderRole").textContent = user.isAdmin ? "Administrator" : "ShedShare member";
  document.getElementById("userBookmarksList").innerHTML = savedItems.length ? savedItems.map(item => `<article class="bookmark-row"><span class="bookmark-thumb">${item.image ? `<img src="${esc(item.image)}" alt="">` : "▣"}</span><div><strong>${esc(item.name)}</strong><small>${money(item.price)}/${esc(item.pricingUnit || "day")} · ${esc(item.location || item.category || "ShedShare listing")}</small></div><button type="button" data-user-tab="browse">View</button><button type="button" class="bookmark-remove" data-remove-bookmark="${esc(item.id)}" aria-label="Remove ${esc(item.name)} from bookmarks">×</button></article>`).join("") : `<div class="empty">Your saved items will appear here. Use the bookmark icon on a listing to save it.</div>`;
  const listingMore = document.getElementById("userListingsMore");
  listingMore.hidden = myItemsCache.length <= 1;
  listingMore.textContent = "Show more listings";
  document.getElementById("listingsList").classList.remove("is-expanded");
  const bookmarksMore = document.getElementById("userBookmarksMore");
  bookmarksMore.hidden = savedItems.length <= 1;
  bookmarksMore.textContent = "Show more bookmarks";
  document.getElementById("userBookmarksList").classList.remove("is-expanded");
  const spent = rentalsAsRenter.filter(r => r.paymentVerified || ["confirmed","active","completed"].includes(r.status)).reduce((sum,r) => sum + Number(r.total || r.subtotal || 0), 0);
  document.getElementById("userSummary").innerHTML = `
    <article class="user-stat"><span class="user-stat-icon blue">▦</span><small>My Rentals</small><strong>${rentalsAsRenter.filter(r => ["confirmed","active"].includes(r.status)).length}</strong><span>Ongoing</span></article>
    <article class="user-stat"><span class="user-stat-icon green">♧</span><small>Saved Items</small><strong>${saved.length}</strong><span>Bookmarks</span></article>
    <article class="user-stat"><span class="user-stat-icon purple">◉</span><small>Messages</small><strong>${conversations.length}</strong><span>Conversations</span></article>
    <article class="user-stat"><span class="user-stat-icon amber">▤</span><small>Total Spent</small><strong>${money(spent)}</strong><span>On rentals</span></article>`;
  const activity = [
    ...rentalsAsRenter.map(r => ({ kind:"Rental", title:r.itemName || "Rental", detail:`${r.category || "Item"} · Rental`, date:r.createdAt || r.startAt, period:fmtRange(r.startAt,r.endAt,r.pricingUnit), state:statusLabel(r.status,"renter"), cls:r.status, image:r.image })),
    ...myItemsCache.map(item => ({ kind:"Listing", title:item.name, detail:`${item.category || "Item"} · Your listing`, date:item.createdAt, period:item.location || "Listed on ShedShare", state:item.paused ? "Paused" : "Listed", cls:item.paused ? "paused" : "confirmed", image:item.image }))
  ].sort((a,b) => new Date(b.date || 0)-new Date(a.date || 0));
  document.getElementById("userRecentActivity").innerHTML = activity.length ? activity.map(row => `<article class="user-activity-row"><span class="activity-thumb">${row.image ? `<img src="${esc(row.image)}" alt="">` : "▣"}</span><div class="activity-item-copy"><strong>${esc(row.title)}</strong><small>${esc(row.detail)}</small></div><span class="activity-period">${esc(row.period)}</span><span class="activity-status ${esc(row.cls)}">${esc(row.state)}</span><button type="button" class="activity-chevron" data-user-tab="${row.kind === "Rental" ? "history" : "dashboard"}" aria-label="View ${esc(row.title)}">›</button></article>`).join("") : `<div class="user-empty-state"><span>⌂</span><strong>Your activity will show here</strong><p>Browse listings to find something useful, or list an item to start earning.</p><button type="button" data-user-tab="browse">Browse listings</button></div>`;
  const activityMore = document.getElementById("userActivityMore");
  activityMore.hidden = activity.length <= 1;
  activityMore.textContent = "Show more activity";
  document.getElementById("userRecentActivity").classList.remove("is-expanded");
  const payoutSetup = document.getElementById("payoutSetup");
  if (payoutSetup) payoutSetup.hidden = !session || isAdmin() || myItemsCache.length === 0 || Boolean(session.user.subaccountCode) || !API_BASE;

  document.getElementById("listingsEmpty").hidden = myItemsCache.length > 0;
  document.getElementById("listingsList").innerHTML = myItemsCache.map(item => {
    const forItem = rentalsAsOwner.filter(r => r.itemId === item.id);
    const openRental = forItem.find(isOpen);
    const rental = openRental || forItem[0];
    const moderationLabels={pending_analysis:"Safety checks pending",pending_review:"Pending admin review",needs_information:"More information requested",declined:"Listing declined",approved:"Approved"};
    const state = item.moderationStatus&&item.moderationStatus!=="approved" ? `<span class="status ${esc(item.moderationStatus)}">${esc(moderationLabels[item.moderationStatus]||item.moderationStatus)}</span>` : openRental ? `<span class="status ${openRental.status}">${statusLabel(openRental.status, "owner")}</span>`
      : item.paused ? `<span class="status paused">Paused</span>`
      : rental ? `<span class="status ${rental.status}">${statusLabel(rental.status, "owner")}</span>`
      : `<span class="status unrented">Not yet rented</span>`;
    return `<div class="row-card">
      <div class="top"><strong>${esc(item.name)}</strong>${state}</div>
      <div class="split-row"><span class="label">Listed at</span><span class="value">${money(item.price)}/${esc(item.pricingUnit)} (as low as ${money(lowestPrice(item))})</span></div>
      ${item.paused ? `<div class="split-row"><span class="label">Visibility</span><span class="value">Hidden from browse</span></div>` : ""}
      ${item.moderationStatus&&item.moderationStatus!=="approved"?`<p class="fine">This listing is hidden from public search until ShedShare approves it.</p>`:""}
      ${rental ? `
        <div class="split-row"><span class="label">Rental period</span><span class="value">${esc(fmtRange(rental.startAt, rental.endAt, rental.pricingUnit))}</span></div>
        <div class="split-row"><span class="label">${rental.status === "pending_payment" ? "Rental amount due" : "Verified rental payment"}</span><span class="value">${money(rental.subtotal)} (${plural(rental.units, esc(rental.pricingUnit))} × ${money(rental.pricePerUnit)})</span></div>
        ${paystackAvailable ? `<div class="split-row"><span class="label">Platform fee (${rental.platformFeePercent}%)</span><span class="value fee">${money(rental.platformFee)}</span></div>` : ""}
        <div class="split-row"><span class="label">You receive</span><span class="value payout">${money(rental.ownerPayout)}</span></div>` : ""}
      ${agreementHtml(rental)}
      ${actions((rental ? rentalActionButtons(rental, "owner") : "") + `
        <button class="btn-outline neutral" data-iaction="edit" data-iid="${esc(item.id)}">Edit</button>
        ${item.moderationStatus==="needs_information"?`<button type="button" class="primary" data-listing-resubmit="${esc(item.id)}">Resubmit updated details</button>`:""}
        <button type="button" class="btn-outline neutral" data-iaction="pause" data-iid="${esc(item.id)}" data-paused="${item.paused ? "true" : "false"}">${item.paused ? "Resume listing" : "Pause listing"}</button>
        <button type="button" class="danger-button" data-iaction="delete" data-iid="${esc(item.id)}" ${forItem.length ? `disabled title="Listings with rental history can’t be deleted. Pause the listing instead."` : ""}>Delete listing</button>`)}
    </div>`;
  }).join("");

  document.getElementById("rentalsEmpty").hidden = rentalsAsRenter.length > 0;
  document.getElementById("rentalsList").innerHTML = rentalsAsRenter.map(r => `
    <div class="row-card">
      <div class="top"><strong>${esc(r.itemName)}</strong><span class="status ${esc(r.status)}">${statusLabel(r.status, "renter")}</span></div>
      <div class="split-row"><span class="label">Rental period</span><span class="value">${esc(fmtRange(r.startAt, r.endAt, r.pricingUnit))}</span></div>
      <div class="split-row"><span class="label">${r.status === "pending_payment" ? "Payment pending" : "Verified rental payment"}</span><span class="value">${money(r.subtotal)}</span></div>
      ${r.pickupAddress ? `<div class="split-row"><span class="label">Pickup address</span><span class="value">${esc(r.pickupAddress)}</span></div>` : ""}
      <div class="split-row"><span class="label">Rental (${plural(r.units, esc(r.pricingUnit))})</span><span class="value">${money(r.subtotal)}</span></div>
      ${r.deposit ? `<div class="split-row"><span class="label">Deposit</span><span class="value">${money(r.deposit)}</span></div>` : ""}
      ${r.deliveryFee ? `<div class="split-row"><span class="label">Delivery fee</span><span class="value">${money(r.deliveryFee)}</span></div>` : ""}
      ${agreementHtml(r)}
      ${actions(rentalActionButtons(r, "renter") + (r.status === "completed" && (r.paymentVerified||r.paymentComplete) && !r.onHold && r.itemId ? `<button type="button" class="btn-outline" data-rent-again-item="${esc(r.itemId)}" data-rent-again-units="${esc(r.units || 1)}" data-rent-again-delivery="${esc(r.deliveryMethod || "pickup")}">Rent Again</button>` : ""))}
    </div>`).join("");

  wireActionButtons();
}
let notificationPollTimer=null;
let lastNotificationCounts={badgeCount:0,unreadCount:0,pendingApprovals:0};
let messageUnreadPollTimer=null;
function setBadgeElement(element,count){if(!element)return;element.textContent=count>99?"99+":String(count);element.hidden=count<=0;}
function applyNotificationBadge(count){
  const value=Math.max(0,Number(count)||0);
  setBadgeElement(document.getElementById("userNotificationCount"),value);
  const adminBadge=document.getElementById("adminNotificationCount");
  if(adminBadge){adminBadge.textContent=value>99?"99+":value?String(value):"";adminBadge.hidden=value<=0;}
  if(value&&navigator.setAppBadge)navigator.setAppBadge(value).catch(()=>{});
  else if(!value&&navigator.clearAppBadge)navigator.clearAppBadge().catch(()=>{});
}
function syncNotificationPolling(){
  if(notificationPollTimer){clearInterval(notificationPollTimer);notificationPollTimer=null;}
  if(!session){lastNotificationCounts={badgeCount:0,unreadCount:0,pendingApprovals:0};applyNotificationBadge(0);return;}
  refreshNotifications();
  notificationPollTimer=setInterval(()=>{if(document.visibilityState==="visible")refreshNotifications();},30_000);
}
function applyMessageUnreadBadge(count){
  const unread=Math.max(0,Number(count)||0);
  setBadgeElement(document.getElementById("messagesTabUnread"),unread);
  setBadgeElement(document.getElementById("userMessagesUnread"),unread);
  document.querySelectorAll('[data-tab="messages"],[data-user-tab="messages"]').forEach(button=>button.setAttribute("aria-label",unread?`Messages, ${unread} unread`:"Messages"));
}
async function refreshMessageUnreadBadge(){
  if(!session)return;
  const result=await api("/api/messages/unread-count");
  if(result&&!result.error)applyMessageUnreadBadge(result.unreadMessages);
}
function syncMessageUnreadPolling(){
  if(messageUnreadPollTimer){clearInterval(messageUnreadPollTimer);messageUnreadPollTimer=null;}
  if(!session){applyMessageUnreadBadge(0);return;}
  refreshMessageUnreadBadge();
  messageUnreadPollTimer=setInterval(()=>{if(document.visibilityState==="visible")refreshMessageUnreadBadge();},5000);
}
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")refreshMessageUnreadBadge();});
async function refreshNotifications(renderList=false){
  if(!session)return;
  const result=await api("/api/notifications");
  if(!result||result.error)return;
  lastNotificationCounts={badgeCount:Number(result.badgeCount)||0,unreadCount:Number(result.unreadCount)||0,pendingApprovals:Number(result.pendingApprovals)||0};
  applyNotificationBadge(lastNotificationCounts.badgeCount);
  if(renderList)renderNotificationList(result);
}
function renderNotificationList(data){
  const host=document.getElementById("notificationList");if(!host)return;
  const rows=Array.isArray(data.items)?data.items:[];
  const approvals=Number(data.pendingApprovals)||0;
  const summary=approvals?`<p class="notification-approval-summary">${approvals} rider application${approvals===1?"":"s"} ${approvals===1?"is":"are"} awaiting your review. This stays on your badge until you approve or reject ${approvals===1?"it":"them"}.</p>`:"";
  host.innerHTML=summary+(rows.length?rows.map(item=>`<article class="notification-row ${item.isRead?"is-read":"is-unread"}"><div><strong>${esc(item.type==="rider_application_review"?"Rider application to review":item.type.replaceAll("_"," "))}</strong><p>${esc(item.message)}</p><small>${esc(new Date(item.createdAt).toLocaleString())}</small></div><div class="notification-row-actions">${item.type==="rider_application_review"?`<button type="button" class="btn-outline" data-review-riders>Review riders</button>`:""}${!item.isRead?`<button type="button" class="btn-outline" data-mark-notification-read="${esc(item.id)}">Mark read</button>`:""}</div></article>`).join(""):`<p class="fine">No notifications yet.</p>`);
}
async function openNotificationCenter(){
  if(!session){document.getElementById("authPanel").hidden=false;return showToast("Sign in to view notifications.");}
  const dialog=document.getElementById("notificationDialog");if(!dialog.open)dialog.showModal();
  const host=document.getElementById("notificationList");host.innerHTML="<p class=\"fine\">Loading notifications…</p>";
  await refreshNotifications(true);
}
 navigator.serviceWorker?.addEventListener("message",event=>{if(event.data?.type==="open-notifications")openNotificationCenter();});
document.getElementById("userNotificationsButton")?.addEventListener("click",openNotificationCenter);
document.getElementById("adminNotificationsButton")?.addEventListener("click",openNotificationCenter);
document.getElementById("closeNotificationDialog")?.addEventListener("click",()=>document.getElementById("notificationDialog").close());
document.getElementById("notificationList")?.addEventListener("click",async event=>{
  const review=event.target.closest("[data-review-riders]");
  if(review){document.getElementById("notificationDialog").close();document.querySelector('[data-admin-jump="adminDeliveries"]')?.click();return;}
  const markRead=event.target.closest("[data-mark-notification-read]");
  if(markRead){const result=await api(`/api/notifications/${encodeURIComponent(markRead.dataset.markNotificationRead)}/read`,{method:"PATCH",body:"{}"});if(result?.error)showToast(result.error);await refreshNotifications(true);}
});
async function enablePhonePush(){
  if(!window.isSecureContext||!navigator.serviceWorker||!window.PushManager||!window.Notification)return {error:"Phone push requires an installed app opened from its HTTPS website."};
  const config=await api("/api/config");if(!config?.pushNotificationsConfigured||!config.pushPublicKey)return {error:"Phone push is not configured on the ShedShare server yet."};
  let permission=Notification.permission;if(permission==="default")permission=await Notification.requestPermission();
  if(permission!=="granted")return {error:"Allow notifications in your phone settings to enable phone alerts."};
  try{
    const registration=await navigator.serviceWorker.ready;
    let encodedKey=config.pushPublicKey.replace(/-/g,"+").replace(/_/g,"/");encodedKey+="=".repeat((4-encodedKey.length%4)%4);
    const subscription=await registration.pushManager.getSubscription()||await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:Uint8Array.from(atob(encodedKey),char=>char.charCodeAt(0))});
    const saved=await api("/api/push-subscriptions",{method:"POST",body:JSON.stringify(subscription.toJSON())});
    return saved?.error?saved:{subscribed:true};
  }catch(error){console.warn("Enabling phone notifications failed:",error);return {error:"Could not enable phone notifications on this device. Check its notification permission and try again."};}
}
async function disablePhonePush(){
  try{const registration=await navigator.serviceWorker?.ready;const subscription=await registration?.pushManager?.getSubscription();if(subscription){await api("/api/push-subscriptions",{method:"DELETE",body:JSON.stringify({endpoint:subscription.endpoint})});await subscription.unsubscribe();}}catch(error){console.warn("Disabling phone notifications failed:",error);}
}
document.getElementById("saveNotificationPreferences")?.addEventListener("click",async()=>{
  const pushEnabled=document.getElementById("pref-push").checked;
  if(pushEnabled){const enabled=await enablePhonePush();if(enabled.error){document.getElementById("pref-push").checked=false;return showToast(enabled.error);}}
  else await disablePhonePush();
  const result=await api("/api/notification-preferences",{method:"PUT",body:JSON.stringify({inApp:document.getElementById("pref-inapp").checked,email:document.getElementById("pref-email").checked,push:pushEnabled})});
  showToast(result?.error||"Notification preferences saved.");
  await refreshNotifications();
});
document.getElementById("saveManualBankDetails")?.addEventListener("click",async()=>{
  const status=document.getElementById("manualBankDetailsStatus");
  const result=await api("/api/manual-payments/bank-details",{method:"PATCH",body:JSON.stringify({bankName:document.getElementById("manualBankName").value.trim(),accountName:document.getElementById("manualAccountName").value.trim(),accountNumber:document.getElementById("manualAccountNumber").value.trim()})});
  status.textContent=result?.error||`Transfer details saved. Account ending ${result.accountNumberLast4}.`;
  if(result?.error)showToast(result.error);
});

const BOOKMARKS_KEY = "shedshare_bookmarks";
function getBookmarkedIds() {
  if (!session?.user) return [];
  try { return JSON.parse(localStorage.getItem(`${BOOKMARKS_KEY}:${session.user.id || session.user.email}`) || "[]").map(String); }
  catch { return []; }
}
function setBookmarkedIds(ids) {
  if (!session?.user) return;
  localStorage.setItem(`${BOOKMARKS_KEY}:${session.user.id || session.user.email}`, JSON.stringify([...new Set(ids.map(String))]));
}
function toggleBookmark(itemId) {
  const ids = getBookmarkedIds();
  setBookmarkedIds(ids.includes(String(itemId)) ? ids.filter(id => id !== String(itemId)) : [...ids, String(itemId)]);
  loadItems();
  if (document.getElementById("dashboard").getAttribute("aria-current") === "true") renderDashboard();
}
document.addEventListener("click", event => {
  if (event.target.closest("#userSignOut,[data-user-signout]")) document.getElementById("signOut")?.click();
});
document.getElementById("userDashboardSearch")?.addEventListener("keydown", event => {
  if (event.key !== "Enter") return;
  const target = document.getElementById("q-search");
  target.value = event.currentTarget.value;
  filterItems();
  activateSection("browse");
});
document.addEventListener("click", event => {
  const remove = event.target.closest("[data-remove-bookmark]");
  if (remove) { setBookmarkedIds(getBookmarkedIds().filter(id => id !== String(remove.dataset.removeBookmark))); renderDashboard(); }
});
[["userActivityMore","userRecentActivity","activity"],["userListingsMore","listingsList","listings"],["userBookmarksMore","userBookmarksList","bookmarks"]].forEach(([buttonId,listId,label]) => {
  document.getElementById(buttonId)?.addEventListener("click", event => {
    const list = document.getElementById(listId);
    const expanded = list.classList.toggle("is-expanded");
    event.currentTarget.textContent = expanded ? "Show less" : `Show more ${label}`;
  });
});

function renderRentalReviewForm(review){
  const field=(label,name)=>`<label>${esc(label)}<select name="${name}" required><option value="">Choose 1–5</option>${[1,2,3,4,5].map(value=>`<option value="${value}">${value} / 5</option>`).join("")}</select></label>`;
  return `<details class="rental-review-compose"><summary>Review this ${review.targetRole}</summary><form data-rental-review-form="true" data-rental-review="${esc(review.rentalId)}" data-target-role="${esc(review.targetRole)}"><p class="fine">Verified review for a completed, payment-verified rental. Reviews are immutable after submission and appear publicly only if approved.</p><div class="rental-review-fields">${field("Overall","overallRating")}${field("Communication","communicationRating")}${review.targetRole==="lister"?field("Item accuracy","accuracyRating"):""}${field("Reliability","reliabilityRating")}${field("Fulfillment","fulfillmentRating")}</div><label>Written feedback<textarea name="body" minlength="20" maxlength="2000" required placeholder="Describe your experience with this rental (20–2,000 characters)."></textarea></label><button type="submit" class="primary">Submit review</button></form></details>`;
}
async function loadManualPaymentPanel(rentalId){
  const host=document.querySelector(`[data-manual-payment-panel="${CSS.escape(String(rentalId))}"]`);if(!host)return;
  host.innerHTML="<p class=\"fine\">Loading payment schedule…</p>";
  const summary=await api(`/api/manual-payments/rentals/${encodeURIComponent(rentalId)}`);if(summary?.error){host.innerHTML=`<p class="fine">${esc(summary.error)}</p>`;return;}
  const isOwner=Boolean(summary.isLister),renterView=Boolean(summary.isRenter);
  host.innerHTML=`<p class="fine">${esc(summary.manualPaymentNotice||"Manual bank transfer goes directly to the lister. ShedShare does not hold these funds or automatically collect commission.")}</p><p><strong>Confirmed:</strong> ${money(summary.confirmedAmount)} · <strong>Awaiting verification:</strong> ${money(summary.reportedAmount)} · <strong>Outstanding:</strong> ${money(summary.outstandingBalance)}</p>${summary.installments.map(x=>`<article class="manual-installment"><strong>Installment ${x.number} · ${money(x.amount)} · ${esc(x.status.replaceAll("_"," "))}</strong><p class="fine">Due ${esc(new Date(x.dueAt).toLocaleString())}</p>${x.rejectionReason?`<p class="alert-banner">Transfer not confirmed: ${esc(x.rejectionReason)}</p>`:""}${x.paymentInstructions?`<div class="manual-transfer-instructions"><p>Transfer directly to the lister. ShedShare does not receive or hold this money.</p><dl><dt>Booking reference</dt><dd>SS-${esc(summary.bookingId)}</dd><dt>Account name</dt><dd>${esc(x.paymentInstructions.accountName)}</dd><dt>Bank</dt><dd>${esc(x.paymentInstructions.bankName)}</dd><dt>Account number</dt><dd>${esc(x.paymentInstructions.accountNumber)}</dd><dt>Exact amount</dt><dd>${money(x.amount)}</dd><dt>Transfer reference</dt><dd>${esc(x.paymentInstructions.transferReference)}</dd></dl>${["scheduled","awaiting_payment","overdue","rejected"].includes(x.status)?`<button type="button" class="primary" data-report-manual-payment="${esc(x.id)}">I Have Made This Transfer</button>`:""}</div>`:""}${x.status==="payment_reported"&&!renterView?`<p class="fine">Renter reported ${money(x.amount)}${x.transferReference?` · reference ${esc(x.transferReference)}`:""}. Verify receipt in your bank before confirming.</p><button type="button" class="primary" data-confirm-manual-payment="${esc(x.id)}">Confirm receipt</button><button type="button" class="btn-outline" data-reject-manual-payment="${esc(x.id)}">Reject report</button>`:""}</article>`).join("")}`;
  host.querySelectorAll("[data-report-manual-payment]").forEach(button=>button.addEventListener("click",async()=>{const transferReference=prompt("Enter the bank transfer reference if available (optional):")||"";const result=await api(`/api/manual-payments/installments/${button.dataset.reportManualPayment}/report`,{method:"POST",body:JSON.stringify({transferReference,note:"Reported by renter"})});if(result?.error)return showToast(result.error);showToast("Transfer reported. It counts as paid only after the lister confirms receipt.");await loadManualPaymentPanel(summary.bookingId);}));
  host.querySelectorAll("[data-confirm-manual-payment]").forEach(button=>button.addEventListener("click",async()=>{if(!confirm("Confirm that this exact amount has arrived in your bank account?"))return;const result=await api(`/api/manual-payments/installments/${button.dataset.confirmManualPayment}/decision`,{method:"POST",body:JSON.stringify({action:"confirm"})});if(result?.error)return showToast(result.error);showToast("Receipt confirmed. ShedShare did not receive or hold the transfer.");await loadManualPaymentPanel(summary.bookingId);}));
  host.querySelectorAll("[data-reject-manual-payment]").forEach(button=>button.addEventListener("click",async()=>{const reason=prompt("Why could you not verify this transfer?");if(!reason||reason.trim().length<4)return showToast("Enter a clear reason so the renter can correct the report.");const result=await api(`/api/manual-payments/installments/${button.dataset.rejectManualPayment}/decision`,{method:"POST",body:JSON.stringify({action:"reject",reason:reason.trim()})});if(result?.error)return showToast(result.error);showToast("Transfer report rejected with a reason.");await loadManualPaymentPanel(summary.bookingId);}));
}

async function renderHistory() {
  if (!session) return;
  const target = document.getElementById("historyList");
  target.innerHTML = `<div class="empty">Loading your transactions…</div>`;
  const [asOwner, asRenter, items, trustRentals] = await Promise.all([
    api("/api/rentals?role=owner"), api("/api/rentals?role=renter"), api("/api/items?mine=1"),api("/api/trust/rentals")
  ]);
  const rentals = [...asList(asOwner).map(r => ({ ...r, _historyRole: "owner" })), ...asList(asRenter).map(r => ({ ...r, _historyRole: "renter" }))]
    .filter((rental, index, all) => all.findIndex(other => String(other.id) === String(rental.id)) === index)
    .sort((a,b) => new Date(b.createdAt || b.startAt || 0) - new Date(a.createdAt || a.startAt || 0));
  document.querySelectorAll("[data-history-filter]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.historyFilter === activeHistoryFilter)));
  if (asOwner?.error || asRenter?.error) { target.innerHTML = `<div class="empty">${esc(asOwner?.error || asRenter?.error)} <button type="button" class="btn-outline" id="retryHistory">Try again</button></div>`; document.getElementById("retryHistory")?.addEventListener("click", renderHistory); return; }
  if (activeHistoryFilter === "listings") {
    const rows = asList(items);
    target.innerHTML = rows.length ? rows.map(item => `<article class="history-card"><div class="top"><strong>${esc(item.name)}</strong><span class="status ${item.paused ? "paused" : "active"}">${item.paused ? "Paused" : "Listed"}</span></div><p class="fine">${esc(item.category || "Item")} · ${money(item.price)}/${esc(item.pricingUnit || "day")}</p><p class="fine">${item.createdAt ? `Added ${esc(new Date(item.createdAt).toLocaleDateString())}` : "Listing activity"}</p></article>`).join("") : `<div class="empty">No listing activity yet.</div>`;
    return;
  }
  const trustByRental=new Map(asList(trustRentals).map(review=>[String(review.rentalId),review]));
  target.innerHTML = rentals.length ? rentals.map(r => {
    const isOwner = r._historyRole === "owner";
    const otherName = isOwner ? r.renterName : r.ownerName;
    const trustInfo=trustByRental.get(String(r.id));
    const targetRole=trustInfo?.targetRole||(isOwner?"renter":"lister");
    const targetTrust=trustInfo?.targetTrust;
    const targetTrustLabel=targetTrust?(targetTrust.averageRating==null?`${targetTrust.completedVerifiedRentals} completed verified rentals · no published reviews`:`${Number(targetTrust.averageRating).toFixed(1)} / 5 · ${targetTrust.reviewCount} verified rental reviews`):"Trust details not available";
    const targetAccountStatus=targetTrust?(targetTrust.emailVerified?"email verified account":"email not verified"):"account verification status unavailable";
    const targetTrustHtml=`<div class="history-trust-line"><span>${esc(targetTrustLabel)} · ${esc(targetAccountStatus)}</span><button type="button" class="text-link" data-counterparty-trust="${esc(trustInfo?.targetUserId|| (isOwner?r.renterId:r.ownerId))}" data-trust-role="${esc(targetRole)}" data-trust-name="${esc(otherName||"ShedShare member")}">View ${esc(targetRole)} trust profile</button></div>`;
    const reviewSummary=trustInfo?.reviewStatus?`<div class="review-submit-status"><strong>${trustInfo.reviewStatus==="approved"?"Review published":trustInfo.reviewStatus==="pending"?"Review awaiting moderation":trustInfo.reviewStatus==="hidden"?"Review hidden by moderation":"Review not approved"}</strong><p class="fine">Rental reviews cannot be edited or resubmitted. Only approved reviews appear on trust profiles.</p></div>`:trustInfo?.eligible?renderRentalReviewForm(trustInfo):"";
    const action = otherName && r.itemId ? `<button type="button" class="btn-outline" data-message-item="${esc(r.itemId)}" data-message-owner="${esc(isOwner ? r.renterId || "" : r.ownerId || "")}" data-message-name="${esc(otherName)}" data-message-item-name="${esc(r.itemName || "Rental")}" data-message-rental="${esc(r.id)}">Message ${isOwner ? "renter" : "lister"}</button>` : "";
    const rentAgainAction = !isOwner && r.status === "completed" && (r.paymentVerified||r.paymentComplete) && !r.onHold && r.itemId ? `<button type="button" class="btn-outline" data-rent-again-item="${esc(r.itemId)}" data-rent-again-units="${esc(r.units || 1)}" data-rent-again-delivery="${esc(r.deliveryMethod || "pickup")}">Rent Again</button>` : "";
    const trackButton=r.deliveryMethod&&r.deliveryMethod!=="pickup"?`<div class="row-actions">${isOwner&&r.deliveryMethod==="owner_delivery"&&r.status==="confirmed"?`<button type="button" class="btn-outline" data-owner-start-delivery="${esc(r.id)}">Start owner delivery</button>`:""}${!isOwner&&r.deliveryMethod==="owner_delivery"?`<button type="button" class="btn-outline" data-share-owner-delivery="${esc(r.id)}">Share delivery GPS</button>`:""}<button type="button" class="btn-outline" data-track-delivery="${esc(r.id)}">Track delivery</button></div><div class="delivery-track-panel" data-track-panel="${esc(r.id)}" aria-live="polite"></div>`:"";
    const riderPercent=Number(r.riderCommissionPercent??0); const riderQuoteControl=!isOwner&&r.riderPaymentStatus==="pending"?`<p class="fine">Rider quote: ${money(r.deliveryFee)}${paystackAvailable?` · ShedShare ${riderPercent}%: ${money(Number(r.deliveryFee)*riderPercent/100)} · Rider receives ${100-riderPercent}%: ${money(Number(r.deliveryFee)*(100-riderPercent)/100)}`:` · Rider receives the full quoted fee.`}</p>${paystackAvailable?`<button type="button" class="primary" data-pay-rider-delivery="${esc(r.deliveryId)}">Pay rider through Paystack</button>`:`<p class="fine">Rider payments are temporarily unavailable.</p>`}<button type="button" class="btn-outline" data-decline-rider-quote="${esc(r.deliveryId)}">Decline quote</button>`:!isOwner&&r.riderPaymentStatus==="paid"?`<p class="fine">Rider fee paid through ShedShare${paystackAvailable?` · ShedShare commission: ${riderPercent}%.`:"."}</p>`:"";
    const renterDeliveryControls=!isOwner&&r.deliveryId?`${riderQuoteControl}${r.deliveryMethod==="rider_delivery"&&!r.riderRated&&r.deliveryStatus==="completed"?`<label for="rider-rating-${esc(r.deliveryId)}">Rate your rider</label><select id="rider-rating-${esc(r.deliveryId)}" data-rider-rating><option value="">Choose 1–5</option>${[1,2,3,4,5].map(n=>`<option value="${n}">${n} star${n===1?"":"s"}</option>`).join("")}</select><button type="button" class="btn-outline" data-submit-rider-rating="${esc(r.deliveryId)}">Submit rating</button>`:""}${r.deliveryMethod==="rider_delivery"&&["awaiting_rider","rider_assigned","awaiting_collection","collected","arrived","delivered_awaiting_confirmation"].includes(r.deliveryStatus)?`<p class="fine" data-handover-display="${esc(r.deliveryId)}">Your 4-digit hand-over code is loading…</p>`:""}${r.deliveryStatus==="delivered_awaiting_confirmation"?`<button type="button" class="primary" data-confirm-delivery="${esc(r.deliveryId)}">Confirm delivery received</button>`:""}`:"";
    const manualPaymentCard=r.manualPayment?`<section class="manual-payment-card"><strong>Payment: ${esc((r.manualPaymentStatus||"awaiting_payment").replaceAll("_"," "))}</strong><p class="fine">Confirmed ${money(r.manualAmountConfirmed||0)} · awaiting verification ${money(r.manualAmountReported||0)} · total ${money(r.subtotal)}</p><button type="button" class="btn-outline" data-load-manual-payment="${esc(r.id)}">${isOwner?"Review payment schedule":"Pay Remaining Balance / View schedule"}</button><div data-manual-payment-panel="${esc(r.id)}"></div></section>`:"";
    return `<article class="history-card"><div class="top"><strong>${esc(r.itemName || "Rental")}</strong><span class="status ${r.onHold ? "cancelled" : esc(r.status)}">${r.onHold ? "Safety hold" : statusLabel(r.status, isOwner ? "owner" : "renter")}</span></div><p class="fine">${isOwner ? "You listed" : "You rented"} · ${esc(fmtRange(r.startAt, r.endAt, r.pricingUnit))}</p><p class="fine">${isOwner ? "Renter" : "Lister"}: <strong>${esc(otherName || "ShedShare member")}</strong></p>${targetTrustHtml}<div class="split-row"><span class="label">Amount</span><span class="value">${money(r.subtotal || r.total)}</span></div>${r.paymentReference ? `<p class="fine">Payment reference: ${esc(r.paymentReference)}</p>` : ""}${r.onHold ? `<p class="alert-banner">${esc(r.holdReason || "Safety review in progress")}</p>` : ""}${manualPaymentCard}${renterDeliveryControls}${trackButton}${action}${rentAgainAction}${reviewSummary}</article>`;
  }).join("") : `<div class="empty">Your rental history will appear here.</div>`;
  target.querySelectorAll("[data-counterparty-trust]").forEach(button=>button.addEventListener("click",()=>openTrustProfile(button.dataset.counterpartyTrust,button.dataset.trustRole,button.dataset.trustName)));
  target.querySelectorAll("[data-load-manual-payment]").forEach(button=>button.addEventListener("click",()=>loadManualPaymentPanel(button.dataset.loadManualPayment)));
  target.querySelectorAll("[data-rental-review-form]").forEach(form=>form.addEventListener("submit",async event=>{event.preventDefault();const data=new FormData(form),body={overallRating:Number(data.get("overallRating")),communicationRating:Number(data.get("communicationRating")),reliabilityRating:Number(data.get("reliabilityRating")),fulfillmentRating:Number(data.get("fulfillmentRating")),body:String(data.get("body")||"").trim()};if(form.dataset.targetRole==="lister")body.accuracyRating=Number(data.get("accuracyRating"));if(!body.overallRating||!body.communicationRating||!body.reliabilityRating||!body.fulfillmentRating||(form.dataset.targetRole==="lister"&&!body.accuracyRating))return showToast("Complete each rating from 1 to 5.");const button=form.querySelector("button[type=submit]");button.disabled=true;const result=await api(`/api/trust/rentals/${form.dataset.rentalReview}/reviews`,{method:"POST",body:JSON.stringify(body)});if(result?.error){button.disabled=false;return showToast(result.error);}showToast(result.message||"Review submitted for moderation.");renderHistory();}));
  target.querySelectorAll("[data-pay-rider-delivery]").forEach(btn=>btn.addEventListener("click",async()=>{btn.disabled=true;const result=await api(`/api/deliveries/${btn.dataset.payRiderDelivery}/rider-payment`,{method:"POST",body:"{}"});if(result?.error){btn.disabled=false;return showToast(result.error);}window.location.assign(result.checkoutUrl);}));
  target.querySelectorAll("[data-decline-rider-quote]").forEach(btn=>btn.addEventListener("click",async()=>{if(!confirm("Decline this rider quote? You can then choose pickup or owner delivery if available."))return;btn.disabled=true;const result=await api(`/api/deliveries/${btn.dataset.declineRiderQuote}/decline-rider-quote`,{method:"POST",body:"{}"});if(result?.error){btn.disabled=false;return showToast(result.error);}showToast("Rider quote declined. Choose a different delivery option.");renderHistory();}));
  target.querySelectorAll("[data-handover-display]").forEach(async el=>{const info=await api(`/api/deliveries/${el.dataset.handoverDisplay}/handover-code`);el.textContent=info?.code?`Your 4-digit hand-over code: ${info.code} · Share it with the rider when the item arrives.`:info?.error||"Hand-over code is not available.";});
  target.querySelectorAll("[data-confirm-delivery]").forEach(button=>button.addEventListener("click",async()=>{const answer=await api(`/api/deliveries/${button.dataset.confirmDelivery}/confirm-receipt`,{method:"POST",body:"{}"});if(answer?.error)return showToast(answer.error);showToast("Delivery confirmation recorded.");renderHistory();}));
  target.querySelectorAll("[data-submit-rider-rating]").forEach(button=>button.addEventListener("click",async()=>{const rating=Number(target.querySelector(`[data-rider-rating]`)?.value);if(!rating)return showToast("Choose a rating from 1 to 5.");const answer=await api(`/api/deliveries/${button.dataset.submitRiderRating}/rating`,{method:"POST",body:JSON.stringify({rating})});if(answer?.error)return showToast(answer.error);showToast("Thanks for rating your rider.");renderHistory();}));
}

async function renderAdminReferrals() {
  const [program, response] = await Promise.all([api("/api/admin/referrals/program"), api("/api/admin/referrals")]);
  const status = document.getElementById("referralProgramStatus"), host = document.getElementById("referralAdminList"), fields = document.getElementById("referralRuleFields");
  if (program?.error) { if (status) status.textContent = program.error; }
  else if (fields && program) {
    document.getElementById("referralProgramEnabled").checked = Boolean(program.enabled);
    fields.innerHTML = asList(program.rules).map(rule => `<fieldset class="referral-rule"><legend>${esc(rule.label)}</legend><label><input type="checkbox" data-referral-rule-enabled="${esc(rule.eventType)}" ${rule.enabled ? "checked" : ""}> Qualify on this action</label><label>Referrer reward (₦)<input type="number" min="0" max="1000000" step="0.01" data-referral-referrer-reward="${esc(rule.eventType)}" value="${Number(rule.referrerReward || 0)}"></label><label>New member reward (₦)<input type="number" min="0" max="1000000" step="0.01" data-referral-referred-reward="${esc(rule.eventType)}" value="${Number(rule.referredReward || 0)}"></label></fieldset>`).join("");
    const referralForm = document.getElementById("referralProgramForm");
    if (referralForm) referralForm.onsubmit = async event => {
      event.preventDefault(); const button = event.currentTarget.querySelector("button[type=submit]"); button.disabled = true;
      const rules = asList(program.rules).map(rule => ({ eventType: rule.eventType, enabled: Boolean(fields.querySelector(`[data-referral-rule-enabled="${CSS.escape(rule.eventType)}"]`)?.checked), referrerReward: Number(fields.querySelector(`[data-referral-referrer-reward="${CSS.escape(rule.eventType)}"]`)?.value), referredReward: Number(fields.querySelector(`[data-referral-referred-reward="${CSS.escape(rule.eventType)}"]`)?.value) }));
      const saved = await api("/api/admin/referrals/program", { method: "PUT", body: JSON.stringify({ enabled: document.getElementById("referralProgramEnabled").checked, rules }) });
      button.disabled = false; if (saved?.error) { status.textContent = saved.error; return; }
      status.textContent = "Referral settings saved. Future verified events use these rules; prior non-qualifying events are not applied retroactively."; showToast("Referral settings saved."); renderAdminReferrals();
    };
  }
  if (!host) return;
  if (response?.error) { host.innerHTML = `<div class="empty">${esc(response.error)}</div>`; return; }
  const rows = asList(response);
  host.innerHTML = rows.length ? rows.map(row => {
    const actions = row.eventId ? (({ eligible: ["approve", "reject"], approved: ["reward", "reject"], rewarded: ["reverse"] })[row.status] || []) : [];
    return `<article class="referral-admin-row"><div><strong>${esc(row.referrerName)} invited ${esc(row.referredName)}</strong><small>${esc(row.qualifyingEvent ? String(row.qualifyingEvent).replaceAll("_", " ") : "No qualifying action recorded")} · ${esc(new Date(row.eventAt || row.createdAt).toLocaleString())}</small>${row.riskFlag ? `<p class="alert-banner">Flagged for review: ${esc(row.riskReason)}</p>` : ""}${row.decisionReason ? `<small>Decision: ${esc(row.decisionReason)}</small>` : ""}</div><span class="status ${esc(row.status)}">${esc(row.status.replaceAll("_", " "))}</span><span>${money(row.promotionalCreditNet)} promotional credit net</span><div class="row-actions">${actions.map(action => `<button type="button" class="${action === "reject" || action === "reverse" ? "btn-outline" : "primary"}" data-referral-admin-action="${action}" data-referral-admin-id="${esc(row.id)}" data-referral-admin-event-id="${esc(row.eventId)}">${action[0].toUpperCase()}${action.slice(1)}</button>`).join("")}</div></article>`;
  }).join("") : `<div class="empty">No referrals have been recorded.</div>`;
  host.querySelectorAll("[data-referral-admin-action]").forEach(button => button.addEventListener("click", async () => {
    const action = button.dataset.referralAdminAction, reason = window.prompt(`${action[0].toUpperCase()}${action.slice(1)} this referral. Add the review reason:`);
    if (!reason || reason.trim().length < 5) return showToast("Enter a review reason of at least 5 characters.");
    button.disabled = true; const result = await api(`/api/admin/referrals/${button.dataset.referralAdminId}/events/${button.dataset.referralAdminEventId}/status`, { method: "PATCH", body: JSON.stringify({ action, reason: reason.trim() }) });
    if (result?.error) { button.disabled = false; return showToast(result.error); }
    showToast(`Referral ${result.status}.`); renderAdminReferrals();
  }));
}

async function renderAdminDashboard() {
  const adminSection = document.getElementById("adminSection");
  adminSection.hidden = !isAdmin();
  if (!isAdmin()) return;
  await refreshAdminAiSettings();
  await refreshAdminMapSettings();
  await Promise.all([loadListingModerationSettings(),loadListingModerationQueue()]);
  await loadPendingTestimonials();
  await loadRentalTrustModeration();
  const allTx = asList(await api("/api/rentals?role=admin"));
  const [toolData, catalog] = await Promise.all([renderAdminTools(allTx), api("/api/items")]);
  await renderAdminReferrals();
  const listers = toolData?.listerRows || [];
  const registeredUsers = toolData?.userRows || [];
  const listingsCount = listers.reduce((sum,lister) => sum + Number(lister.listingCount || 0),0);
  const activeRentals = allTx.filter(r => ["confirmed","active"].includes(r.status) && !r.onHold).length;
  const verified = allTx.filter(r => r.paymentVerified);
  const totalVolume = verified.reduce((sum,r) => sum + Number(r.subtotal || 0),0);
  const totalFees = verified.reduce((sum,r) => sum + Number(r.platformFee || 0) + Number(r.riderPlatformFee || 0),0);
  const totalPayouts = verified.reduce((sum,r) => sum + Number(r.ownerPayout || 0),0);
  const firstName = (session.user.name || "Administrator").trim().split(/\s+/)[0];
  document.getElementById("adminGreetingName").textContent = firstName;
  document.getElementById("adminUserName").textContent = session.user.name || "Administrator";
  document.getElementById("adminAvatar").textContent = (session.user.name || "AD").trim().split(/\s+/).map(word => word[0]).join("").slice(0,2).toUpperCase();
  document.getElementById("adminDateRange").textContent = new Date().toLocaleDateString(undefined,{month:"long",year:"numeric"}).toUpperCase();
  document.getElementById("adminSummary").innerHTML = `
    <article class="admin-stat"><span class="stat-icon blue">▤</span><span>Total listings</span><strong>${listingsCount}</strong><small>Across ${listers.length} listers</small></article>
    <article class="admin-stat"><span class="stat-icon green">▦</span><span>Active rentals</span><strong>${activeRentals}</strong><small>${allTx.length} total rental records</small></article>
    <article class="admin-stat"><span class="stat-icon purple">♙</span><span>Registered users</span><strong>${registeredUsers.length}</strong><small>All marketplace accounts</small></article>
    <article class="admin-stat"><span class="stat-icon amber">₦</span><span>Platform earnings</span><strong>${money(totalFees)}</strong><small>Current rates: ${Number(toolData?.commissionSettings?.rentalPercent??15)}% rentals · ${Number(toolData?.commissionSettings?.riderPercent??5)}% riders</small></article>`;
  document.getElementById("financialSummary").innerHTML = `<article><span class="finance-icon blue">◈</span><div><small>Gross rental value</small><strong>${money(totalVolume)}</strong></div></article>${paystackAvailable?`<article><span class="finance-icon purple">%</span><div><small>Platform earnings</small><strong>${money(totalFees)}</strong></div></article>`:""}<article><span class="finance-icon green">↗</span><div><small>Owner payouts</small><strong>${money(totalPayouts)}</strong></div></article><article><span class="finance-icon amber">▤</span><div><small>Verified payments</small><strong>${verified.length}</strong></div></article>`;
  renderAdminCharts(allTx, catalog);
  renderAdminRecentRentals(allTx);
  document.getElementById("allTxList").innerHTML = allTx.length ? allTx.map(r => `<div class="row-card"><div class="top"><strong>${esc(r.itemName)}</strong><span class="status ${r.onHold ? "cancelled" : esc(r.status)}">${r.onHold ? "Safety hold" : statusLabel(r.status,"admin")}</span></div><div class="split-row"><span class="label">${esc(r.renterName)} renting from ${esc(r.ownerName)}</span><span class="value">${money(r.subtotal)}</span></div><div class="split-row"><span class="label">Rental period</span><span class="value">${esc(fmtRange(r.startAt,r.endAt,r.pricingUnit))}</span></div><div class="split-row"><span class="label">Rental platform fee (${Number(r.platformFeePercent)}%)</span><span class="value fee">${money(r.platformFee)}</span></div>${r.riderPlatformFee?`<div class="split-row"><span class="label">Rider platform fee (${Number(r.riderCommissionPercent??5)}%)</span><span class="value fee">${money(r.riderPlatformFee)}</span></div>`:""}<div class="split-row"><span class="label">Owner payout</span><span class="value payout">${money(r.ownerPayout)}</span></div>${r.onHold ? `<p class="alert-banner">${esc(r.holdReason || "Safety review in progress")}</p>` : ""}${actions(rentalActionButtons(r,"admin") + (r.paymentReference && ["confirmed","active"].includes(r.status) ? `<button type="button" class="${r.onHold ? "primary" : "danger-button"}" data-admin-hold="${esc(r.id)}" data-held="${r.onHold ? "true" : "false"}">${r.onHold ? "Release safety hold" : "Place safety hold"}</button>` : ""))}</div>`).join("") : `<div class="empty">No transactions yet.</div>`;
  await renderCommissionObligations();
  await renderManualPaymentReports();
}

async function renderManualPaymentReports(){const host=document.getElementById("manualPaymentReports");if(!host)return;const rows=asList(await api("/api/manual-payments/reports"));host.innerHTML=rows.length?rows.map(x=>`<article class="history-card"><strong>SS-${esc(x.bookingId)} · ${esc(x.itemName)} · installment ${x.installmentNumber}</strong><p class="fine">${esc(x.renterName)} reported ${money(x.amount)} to ${esc(x.listerName)} · ${x.transferReference?`reference ${esc(x.transferReference)} · `:""}${x.reportedAt?new Date(x.reportedAt).toLocaleString():""}</p><button type="button" class="primary" data-admin-confirm-manual="${esc(x.installmentId)}">Confirm receipt</button><button type="button" class="btn-outline" data-admin-reject-manual="${esc(x.installmentId)}">Reject report</button></article>`).join(""):`<div class="empty">No reported bank transfers are waiting for review.</div>`;host.querySelectorAll("[data-admin-confirm-manual]").forEach(button=>button.addEventListener("click",async()=>{if(!confirm("Confirm that this transfer arrived in the lister's bank account?"))return;const result=await api(`/api/manual-payments/installments/${button.dataset.adminConfirmManual}/decision`,{method:"POST",body:JSON.stringify({action:"confirm"})});if(result?.error)return showToast(result.error);showToast("Lister receipt confirmation recorded.");renderManualPaymentReports();}));host.querySelectorAll("[data-admin-reject-manual]").forEach(button=>button.addEventListener("click",async()=>{const reason=prompt("Why could this transfer not be verified?");if(!reason||reason.trim().length<4)return showToast("Enter a clear rejection reason.");const result=await api(`/api/manual-payments/installments/${button.dataset.adminRejectManual}/decision`,{method:"POST",body:JSON.stringify({action:"reject",reason:reason.trim()})});if(result?.error)return showToast(result.error);showToast("Transfer report rejected with a reason.");renderManualPaymentReports();}));}
document.getElementById("refreshManualPaymentReports")?.addEventListener("click",renderManualPaymentReports);

async function renderCommissionObligations(){const host=document.getElementById("commissionObligations");if(!host)return;const rows=asList(await api("/api/admin/commission-obligations"));host.innerHTML=rows.length?rows.map(x=>`<article class="history-card"><strong>SS-${esc(x.rentalId)} · ${esc(x.itemName)}</strong><p class="fine">${esc(x.ownerName)} · ${Number(x.ratePercent)}% of ${money(x.basisAmount)} · due ${money(x.amountDue)} · received ${money(x.amountReceived)} · outstanding ${money(x.outstanding)} · ${esc(x.status)}</p>${x.outstanding>0?`<button type="button" class="btn-outline" data-record-commission="${esc(x.id)}" data-outstanding="${Number(x.outstanding)}">Record actual commission receipt</button>`:""}</article>`).join(""):`<div class="empty">No commission obligations are recorded.</div>`;host.querySelectorAll("[data-record-commission]").forEach(button=>button.addEventListener("click",async()=>{const amount=Number(prompt(`Enter the commission amount actually received (outstanding ${money(button.dataset.outstanding)}):`));if(!Number.isFinite(amount)||amount<=0)return;const reference=prompt("Enter the bank or reconciliation reference:");if(!reference?.trim())return showToast("A reconciliation reference is required.");const result=await api(`/api/admin/commission-obligations/${button.dataset.recordCommission}/receipts`,{method:"POST",body:JSON.stringify({amount,reference:reference.trim()})});if(result?.error)return showToast(result.error);showToast(`Commission receipt recorded: ${result.status}.`);renderCommissionObligations();}));}

document.getElementById("refreshCommissionObligations")?.addEventListener("click",renderCommissionObligations);

function renderAdminCharts(allTx, items) {
  const today = new Date(); today.setHours(0,0,0,0);
  const days = Array.from({length:7},(_,index)=>{const date=new Date(today);date.setDate(today.getDate()-(6-index));return date;});
  const byDay = days.map(day=>allTx.filter(r=>new Date(r.createdAt || r.startAt).toDateString()===day.toDateString()));
  const maxCount=Math.max(1,...byDay.map(rows=>rows.length));
  document.getElementById("rentalChart").innerHTML=`<div class="bar-chart">${byDay.map((rows,index)=>{const level=Math.min(100,Math.max(5,Math.ceil(rows.length/maxCount*20)*5));return `<div class="bar-column"><strong>${rows.length||""}</strong><span class="bar-fill bar-level-${level}"></span><small>${days[index].toLocaleDateString(undefined,{month:"short",day:"numeric"})}</small></div>`;}).join("")}</div>`;
  const earnings=byDay.map(rows=>rows.filter(r=>r.paymentVerified).reduce((sum,r)=>sum+Number(r.platformFee||0),0));
  const maxEarning=Math.max(1,...earnings),points=earnings.map((amount,index)=>`${24+index*92},${145-amount/maxEarning*112}`).join(" ");
  document.getElementById("earningsChart").innerHTML=`<div class="line-chart"><div class="line-y-labels"><span>${money(maxEarning)}</span><span>${money(maxEarning/2)}</span><span>₦0</span></div><svg viewBox="0 0 600 170" preserveAspectRatio="none" role="img" aria-label="Verified commission for the last seven days"><line x1="20" y1="34" x2="580" y2="34"/><line x1="20" y1="88" x2="580" y2="88"/><line x1="20" y1="145" x2="580" y2="145"/><polyline points="${points}"/>${earnings.map((amount,index)=>{const x=24+index*92,y=145-amount/maxEarning*112;return `<circle cx="${x}" cy="${y}" r="4"/><text x="${x}" y="${Math.max(18,y-10)}">${amount?money(amount):""}</text>`;}).join("")}</svg></div><div class="chart-x-labels">${days.map(day=>`<span>${day.toLocaleDateString(undefined,{month:"short",day:"numeric"})}</span>`).join("")}</div>`;
  const categories=new Map();asList(items).forEach(item=>categories.set(item.category||"Other",(categories.get(item.category||"Other")||0)+1));
  const top=[...categories.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5),maxCategory=Math.max(1,...top.map(([,count])=>count));
  document.getElementById("categorySummary").innerHTML=top.length?top.map(([name,count],index)=>{const width=Math.min(100,Math.max(5,Math.ceil(count/maxCategory*20)*5));return `<div class="category-row"><span class="category-dot dot-${index}">◇</span><span>${esc(name)}</span><div><i class="category-width-${width}"></i></div><small>${count}</small></div>`;}).join(""):`<div class="empty">No active listings yet.</div>`;
}

function renderAdminRecentRentals(allTx) {
  const recent=allTx.slice().sort((a,b)=>new Date(b.createdAt||b.startAt)-new Date(a.createdAt||a.startAt)).slice(0,6);
  document.getElementById("recentRentals").innerHTML=recent.length?`<div class="recent-table"><div class="recent-table-head"><span>Item</span><span>Renter</span><span>Period</span><span>Status</span><span>Amount</span></div>${recent.map(r=>`<div class="recent-table-row"><span class="recent-item"><i>▣</i><strong>${esc(r.itemName)}</strong></span><span>${esc(r.renterName)}</span><span>${esc(fmtRange(r.startAt,r.endAt,r.pricingUnit))}</span><span class="status ${r.onHold?"cancelled":esc(r.status)}">${r.onHold?"Safety hold":statusLabel(r.status,"admin")}</span><strong>${money(r.subtotal)}</strong></div>`).join("")}</div>`:`<div class="empty">New rentals will appear here.</div>`;
}

async function renderMessagesPage() {
  if (!session) return;
  await Promise.all([loadConversations(), loadMessageDirectory()]);
  if (activeConversation) await loadConversation();
}

async function renderRiderPage() {
  const fallback = document.getElementById("riderPageFallback");
  const dashboard = document.getElementById("riderDashboard");
  const applyCard = document.getElementById("riderApplyCard");
  const statusCard = document.getElementById("riderApplicationStatus");
  fallback.hidden = false;
  document.getElementById("riderPageFallbackTitle").textContent = "Loading rider options…";
  document.getElementById("riderPageFallbackText").textContent = "Your application form or delivery console will appear here.";
  dashboard.hidden = true;
  applyCard.hidden = true;
  statusCard.hidden = true;
  if (!session) {
    document.getElementById("riderPageFallbackTitle").textContent = "Sign in to apply";
    document.getElementById("riderPageFallbackText").textContent = "Sign in to submit a rider application or view delivery work.";
    return;
  }
  const profile = await api("/api/rider/profile");
  if (profile?.error) {
    if (profile.status === 404) {
      fallback.hidden = true;
      applyCard.hidden = false;
      applyCard.querySelector(".section-heading h2").textContent = "Apply to become a rider";
      document.getElementById("riderFullName").value=session.user.name||"";
      return;
    }
    document.getElementById("riderPageFallbackTitle").textContent = "Could not load rider options";
    document.getElementById("riderPageFallbackText").textContent = profile.error;
    return;
  }
  fallback.hidden = true;
  if (profile.status!=="approved"||!profile.isApproved) {
    statusCard.hidden = false;
    const labels={pending:["Application pending","We’ll notify you after admin review."],rejected:["Application not approved","You can contact ShedShare support if you need clarification."],suspended:["Rider account suspended","Your account is offline and cannot accept deliveries."]};
    const [title,message]=labels[profile.status]||["Application status","Check back later for updates."];
    document.getElementById("riderStatusTitle").textContent=title;
    document.getElementById("riderStatusMessage").textContent=profile.rejectionReason?`${message} Reason: ${profile.rejectionReason}`:message;
    document.getElementById("riderApplicationDetails").textContent = `${profile.vehicleType || "Rider application"}${profile.city?` · ${profile.city}, ${profile.state}`:""}`;
    return;
  }
  dashboard.hidden = false;
  await renderRiderDeliveries(profile);
}
document.getElementById("riderPageRetry").addEventListener("click", renderRiderPage);

async function renderRiderDeliveries(profile) {
  const target = document.getElementById("riderDeliveryList");
  const availabilityButton = document.getElementById("riderAvailabilityButton");
  availabilityButton.dataset.availability = profile.availability;
  availabilityButton.disabled = !profile.isApproved;
  availabilityButton.textContent = `Availability: ${profile.availability} · change`;
  const result = await api("/api/rider/deliveries");
  const deliveries = asList(result?.deliveries), offers = asList(result?.offers);
  document.getElementById("riderRatingSummary").textContent=profile.averageRating==null?"No rider ratings yet.":`Average rating: ${profile.averageRating.toFixed(1)} / 5 · ${profile.ratingCount} rating${profile.ratingCount===1?"":"s"}${profile.flaggedLowRating?" · Flagged for admin review":""}`;
  const offerHtml = offers.map(d=>`<article class="delivery-card rider-offer-card">${d.itemImage?`<img class="rider-offer-image" src="${esc(d.itemImage)}" alt="${esc(d.itemName)}">`:""}<div class="section-heading"><div><h3>${esc(d.itemName||"Nearby delivery")}</h3><p>${esc(d.referenceNumber)} · <span data-offer-countdown data-expires="${esc(d.offerExpiresAt)}">2:00</span> to accept</p></div></div><p class="fine">Approx. pickup: ${esc(d.pickupArea)}</p><p class="fine">Approx. drop-off: ${esc(d.dropoffArea)}</p><p class="fine">${d.distanceKm==null?"Distance unavailable":`${Number(d.distanceKm).toFixed(1)} km away`}</p><label for="rider-quote-${esc(d.id)}">Your delivery fee (₦)</label><input id="rider-quote-${esc(d.id)}" type="number" min="0.01" max="10000000" step="0.01" inputmode="decimal" data-rider-quote="${esc(d.id)}" placeholder="Enter your quote"><small>${paystackAvailable?"Your payout uses the current payment split and goes to your connected Paystack account.":"You receive your full quoted fee."}</small><button class="primary" data-accept-offer="${esc(d.id)}">Send quote and accept</button><button class="btn-outline" data-decline-offer="${esc(d.id)}">Decline</button></article>`).join("");
  target.innerHTML = offerHtml + (deliveries.length ? deliveries.map(d => {
    const stage=d.status==="rider_assigned"?"Heading to pickup":d.status==="awaiting_collection"?"Heading to pickup":d.status==="collected"?"Picked up":d.status==="delivered_awaiting_confirmation"?"Delivered · waiting for renter":d.status.replaceAll("_"," ");
    const next = d.riderPaymentStatus === "pending" ? `<p class="fine">Waiting for renter to pay your quoted fee through Paystack.</p>`
      : d.status === "rider_assigned" ? `<button class="primary" data-rider-action="accept" data-delivery-id="${esc(d.id)}">Start delivery</button><button class="btn-outline" data-rider-action="cancel" data-delivery-id="${esc(d.id)}">Cancel job</button>`
      : d.status === "awaiting_collection" ? `<button class="primary" data-rider-action="collect" data-delivery-id="${esc(d.id)}">Picked up</button><button class="btn-outline" data-rider-action="cancel" data-delivery-id="${esc(d.id)}">Cancel job</button>`
      : ["collected","en_route","arrived"].includes(d.status) ? `<label class="sr-only" for="handover-${esc(d.id)}">4-digit renter hand-over code</label><input id="handover-${esc(d.id)}" data-handover-code="${esc(d.id)}" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="Renter’s 4-digit code"><button class="primary" data-rider-action="mark-delivered" data-delivery-id="${esc(d.id)}">Delivered</button><button class="btn-outline" data-rider-action="cancel" data-delivery-id="${esc(d.id)}">Cancel job</button>` : "";
    return `<article class="delivery-card"><div class="section-heading"><div><h3>${esc(d.itemName || "Delivery")}</h3><p>${esc(d.referenceNumber)} · ${esc(stage)}</p></div></div><p class="fine">Pickup: ${esc(d.pickupLocation || "See delivery details")}</p><p class="fine">Drop-off: ${esc(d.dropoffLocation || "See delivery details")}</p>${d.deliveryFee?`<p class="fine">${d.riderPaymentStatus==="paid"?`Paid · `:"Your quote: "}${paystackAvailable?`Your payout (${100-Number(d.riderCommissionPercent??0)}%): ${money(d.deliveryFee*(100-Number(d.riderCommissionPercent??0))/100)}`:`You receive the full fee: ${money(d.deliveryFee)}`}</p>`:""}<div class="row-actions">${next}</div></article>`;
  }).join("") : offers.length ? "" : `<div class="empty">No deliveries assigned to you.</div>`);
  updateRiderOfferCountdowns();if(window.riderOfferCountdownTimer)clearInterval(window.riderOfferCountdownTimer);window.riderOfferCountdownTimer=setInterval(updateRiderOfferCountdowns,1000);
  const earnings=await api("/api/rider/earnings");document.getElementById("riderEarningsList").innerHTML=earnings?.error?`<div class="empty">${esc(earnings.error)}</div>`:asList(earnings.deliveries).length?`<p class="fine">Completed delivery earnings: <strong>${money(earnings.total)}</strong></p>${earnings.deliveries.map(e=>`<article class="history-card"><strong>${esc(e.itemName)}</strong><p class="fine">${esc(e.referenceNumber)} · ${esc(new Date(e.completedAt).toLocaleDateString())}</p><strong>${money(e.amount)}</strong></article>`).join("")}`:`<div class="empty">No completed deliveries yet.</div>`;
  if(navigator.wakeLock && deliveries.some(d=>["rider_assigned","awaiting_collection","collected","en_route","arrived"].includes(d.status))){try{window.shedshareWakeLock ||= await navigator.wakeLock.request("screen");}catch(_e){}}
  if(riderGpsTimer)clearInterval(riderGpsTimer);
  const active=deliveries.filter(d=>["awaiting_collection","collected","en_route","arrived"].includes(d.status));
  if(active.length&&navigator.geolocation){riderGpsTimer=setInterval(()=>navigator.geolocation.getCurrentPosition(position=>{for(const delivery of active)api(`/api/deliveries/${delivery.id}/location`,{method:"POST",body:JSON.stringify({lat:position.coords.latitude,lng:position.coords.longitude,timestamp:position.timestamp})});},()=>{}, {enableHighAccuracy:true,maximumAge:5000,timeout:10000}),15000);}
  target.querySelectorAll("[data-accept-offer]").forEach(btn=>btn.addEventListener("click",async()=>{const fee=Number(target.querySelector(`[data-rider-quote="${CSS.escape(btn.dataset.acceptOffer)}"]`)?.value);if(!Number.isFinite(fee)||fee<=0)return showToast("Enter the delivery fee you are quoting.");btn.disabled=true;const answer=await api(`/api/deliveries/${btn.dataset.acceptOffer}/accept-offer`,{method:"POST",body:JSON.stringify({deliveryFee:fee})});if(answer?.error){btn.disabled=false;return showToast(answer.error);}showToast(`Quote sent. If the renter accepts and pays, you receive ${money(answer.riderPayout)} (${100-answer.commissionPercent}%).`);await renderRiderPage();await openAcceptedDeliveryChat(btn.dataset.acceptOffer);}));
  target.querySelectorAll("[data-decline-offer]").forEach(btn=>btn.addEventListener("click",async()=>{const answer=await api(`/api/deliveries/${btn.dataset.declineOffer}/decline-offer`,{method:"POST"});if(answer?.error)return showToast(answer.error);renderRiderPage();}));
  target.querySelectorAll("[data-rider-action]").forEach(btn => btn.addEventListener("click", async () => {
    const id = btn.dataset.deliveryId;
    if (btn.dataset.riderAction === "share-location") {
      if (!navigator.geolocation) return showToast("This device does not support location sharing.");
      navigator.geolocation.getCurrentPosition(async position => {
        const result = await api(`/api/deliveries/${id}/location`, { method: "POST", body: JSON.stringify({ lat: position.coords.latitude, lng: position.coords.longitude, timestamp: position.timestamp }) });
        showToast(result?.error || "Delivery location shared with the recipient.");
      }, () => showToast("Location permission was not granted."), { enableHighAccuracy: true, timeout: 12000 });
      return;
    }
    let body={};if(btn.dataset.riderAction==="mark-delivered"){body.code=target.querySelector(`[data-handover-code="${CSS.escape(id)}"]`)?.value?.trim()||"";if(!/^\d{4}$/.test(body.code))return showToast("Enter the renter’s 4-digit hand-over code.");}if(btn.dataset.riderAction==="cancel"){body.reason=prompt("Why are you cancelling this accepted delivery?")||"Cancelled by rider";}
    const result = await api(`/api/deliveries/${id}/${btn.dataset.riderAction}`, { method: "POST",body:JSON.stringify(body) });
    if (result?.error) return showToast(result.error);
    showToast("Delivery status updated."); renderRiderPage();
  }));
}

function updateRiderOfferCountdowns(){document.querySelectorAll("[data-offer-countdown]").forEach(el=>{const seconds=Math.max(0,Math.ceil((new Date(el.dataset.expires).getTime()-Date.now())/1000));el.textContent=`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,"0")}`;const card=el.closest(".rider-offer-card");if(seconds===0)card?.querySelectorAll("button").forEach(button=>button.disabled=true);});}
async function openAcceptedDeliveryChat(deliveryId){const rows=asList(await api("/api/messages/conversations")),conversation=rows.find(row=>String(row.deliveryId)===String(deliveryId)&&row.kind==="delivery_renter");if(!conversation)return;activeConversation={conversationId:conversation.conversationId,itemId:conversation.itemId||"",withUserId:conversation.otherUserId,withUserName:conversation.otherUserName,itemName:conversation.itemName};chatLastId="0";activateSection("messages");await renderMessagesPage();}

document.getElementById("riderApplyForm").addEventListener("submit", async event => {
  event.preventDefault();
  const submit=event.currentTarget.querySelector("button[type=submit]"),profilePhoto=document.getElementById("riderPhoto").files[0],idPhoto=document.getElementById("riderIdPhoto").files[0];if(!profilePhoto||!idPhoto)return showToast("Choose both your profile photo and ID document.");submit.disabled=true;
  const upload=async(kind,file)=>{const form=new FormData();form.append("image",file);return api(`/api/rider/application-documents/${kind}`,{method:"POST",body:form});};
  const photo=await upload("profile",profilePhoto);if(photo?.error){submit.disabled=false;return showToast(photo.error);}const identity=await upload("id",idPhoto);if(identity?.error){submit.disabled=false;return showToast(identity.error);}
  const result = await api("/api/rider/apply", { method: "POST", body: JSON.stringify({ fullName:document.getElementById("riderFullName").value.trim(),phone: document.getElementById("riderPhone").value.trim(),city:document.getElementById("riderCity").value.trim(),state:document.getElementById("riderState").value.trim(),vehicleType: document.getElementById("riderVehicle").value,plateNumber:document.getElementById("riderPlate").value.trim(),profilePhotoPath:photo.path,idDocumentPath:identity.path }) });
  submit.disabled=false;
  if (result?.error) return showToast(result.error);
  session.user.isRider = true; // The server is the source of truth; no session token is persisted in browser storage.
  showToast("Rider application submitted for admin review."); renderRiderPage(); activateSection("rider");
});

document.getElementById("riderPayoutSetup")?.addEventListener("click",async()=>{const result=await api("/api/auth/paystack/subaccount",{method:"POST",body:"{}"});if(result?.error)return showToast(result.error);if(session?.user)session.user.subaccountCode=result.subaccountCode;document.getElementById("riderPayoutStatus").textContent=`Paystack payout account connected · ending ${result.accountLast4}.`;showToast("Existing Paystack payout account connected.");});

let riderGpsTimer=null;
document.getElementById("riderAvailabilityButton").addEventListener("click", async () => {
  const current = document.getElementById("riderAvailabilityButton").dataset.availability || "inactive";
  const availability = current === "active" ? "inactive" : "active";
  if(availability==="active"){
    if(!navigator.geolocation)return showToast("This device does not support location sharing.");
    navigator.geolocation.getCurrentPosition(async position=>{const result=await api("/api/rider/availability",{method:"PATCH",body:JSON.stringify({availability,lat:position.coords.latitude,lng:position.coords.longitude})});if(result?.error)return showToast(result.error);document.getElementById("riderAvailabilityButton").dataset.availability=availability;if(navigator.geolocation){if(riderGpsTimer)clearInterval(riderGpsTimer);riderGpsTimer=setInterval(()=>navigator.geolocation.getCurrentPosition(p=>api("/api/rider/availability",{method:"PATCH",body:JSON.stringify({availability:"active",lat:p.coords.latitude,lng:p.coords.longitude})}),()=>{}, {enableHighAccuracy:true,maximumAge:5000,timeout:10000}),15000);}showToast("You are online. Keep this screen open; background GPS may pause.");renderRiderPage();},()=>showToast("Location permission is needed to go online for nearby delivery offers."),{enableHighAccuracy:true,timeout:12000});return;
  }
  const result = await api("/api/rider/availability", { method: "PATCH", body: JSON.stringify({ availability }) });
  if (result?.error) return showToast(result.error);
  if(riderGpsTimer){clearInterval(riderGpsTimer);riderGpsTimer=null;}
  document.getElementById("riderAvailabilityButton").dataset.availability = availability;
  document.getElementById("riderAvailabilityButton").textContent = `Availability: ${availability} · change`;
  showToast(`You are now ${availability} for deliveries.`);
  renderRiderPage();
});

document.getElementById("paymentPauseButton").addEventListener("click", async () => {
  const paused = document.getElementById("paymentPauseButton").dataset.paused !== "true";
  if (paused && !window.confirm("Pause all new ShedShare checkouts? Existing provider payments may still finish.")) return;
  const result = await api("/api/admin/controls", { method: "PATCH", body: JSON.stringify({ paymentsPaused: paused }) });
  if (result?.error) return showToast(result.error);
  showToast(paused ? "New checkouts are paused" : "New checkouts resumed"); renderAdminDashboard();
});

document.getElementById("commissionSettingsForm")?.addEventListener("submit", async event => {
  event.preventDefault();
  const rentalPercent = Number(document.getElementById("rentalCommissionPercent").value);
  const riderPercent = Number(document.getElementById("riderCommissionPercent").value);
  if (![rentalPercent, riderPercent].every(value => Number.isFinite(value) && value >= 0 && value <= 100)) return showToast("Commission rates must be between 0% and 100%.");
  const reason = prompt("Why are you changing the commission rates? This is saved in the admin audit log.");
  if (!reason || reason.trim().length < 5) return showToast("Enter a reason of at least 5 characters to save these rates.");
  const status = document.getElementById("commissionSettingsStatus");
  status.textContent = "Saving…";
  const result = await api("/api/admin/commission-settings", { method: "PUT", body: JSON.stringify({ rentalPercent, riderPercent, reason: reason.trim() }) });
  if (result?.error) { status.textContent = result.error; return showToast(result.error); }
  status.textContent = `Saved. New rental payments use ${result.rentalPercent}% and new rider payments use ${result.riderPercent}%. Existing accepted or started payments keep their recorded rates.`;
  showToast("Commission rates saved.");
  renderAdminDashboard();
});

document.getElementById("dashboardRefresh").addEventListener("click", () => renderDashboard());
document.getElementById("deleteAccount")?.addEventListener("click", async () => {
  if (!window.confirm("Delete your ShedShare account? You will lose access immediately. Anonymized rental, payment, and safety records may be retained. This cannot be undone.")) return;
  const button = document.getElementById("deleteAccount");
  button.disabled = true;
  const result = await api("/api/auth/account", { method: "DELETE" });
  if (result?.error) { button.disabled = false; return showToast(result.error); }
  clearPendingRentalDraft();
  session = null;
  activeConversation = null;
  renderSession();
  activateSection("browse");
  showToast("Your account has been deleted.");
});
document.getElementById("historyRefresh")?.addEventListener("click", renderHistory);
document.getElementById("refreshReferrals")?.addEventListener("click", renderReferralDashboard);
if (document.getElementById("su-referral-code") && REFERRAL_CODE_FROM_LINK) document.getElementById("su-referral-code").value = REFERRAL_CODE_FROM_LINK.slice(0, 20);
document.querySelectorAll("[data-history-filter]").forEach(button => button.addEventListener("click", () => { activeHistoryFilter = button.dataset.historyFilter; renderHistory(); }));
document.addEventListener("click", async event => {
  const button = event.target.closest("[data-rent-again-item]");
  if (!button) return;
  if (!session) return showToast("Sign in to start a new rental.");
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Loading current listing…";
  await openRentFlow(button.dataset.rentAgainItem, {
    rentAgain: {
      units: Number(button.dataset.rentAgainUnits) || 1,
      deliveryMethod: button.dataset.rentAgainDelivery || "pickup"
    }
  });
  button.textContent = label;
  button.disabled = false;
});
document.querySelectorAll("[data-admin-jump]").forEach(button => button.addEventListener("click", () => document.getElementById(button.dataset.adminJump)?.scrollIntoView({ behavior: "smooth", block: "start" })));
document.getElementById("adminRefresh")?.addEventListener("click", renderAdminDashboard);
document.getElementById("refreshReferralAdmin")?.addEventListener("click", renderAdminReferrals);
document.getElementById("adminSignOut")?.addEventListener("click", () => document.getElementById("signOut")?.click());
document.getElementById("adminSearch")?.addEventListener("input", event => {
  const term = event.target.value.trim().toLowerCase();
  document.querySelectorAll("#adminSection .lister-card,#adminSection .registered-user-card,#adminSection .row-card,#adminSection .delivery-card,#adminSection .flag-card").forEach(card => { card.hidden = Boolean(term) && !card.textContent.toLowerCase().includes(term); });
});
document.querySelectorAll("[data-admin-jump]").forEach(button => button.addEventListener("click", () => {
  const jump = button.dataset.adminJump;
  document.querySelectorAll(".admin-side-link").forEach(link => link.classList.toggle("is-current", link.dataset.adminJump === jump));
}));
document.querySelectorAll("[data-goto]").forEach(button => button.addEventListener("click", () => { const id=button.dataset.goto; activateSection(id); if(id === "dashboard") renderDashboard(); document.getElementById(id)?.scrollIntoView({behavior:"smooth",block:"start"}); }));
document.addEventListener("click", event => {
  const button = event.target.closest("[data-user-tab]");
  if (!button) return;
  const tab = button.dataset.userTab;
  if (tab === "post") exitEditMode();
  activateSection(tab);
  if (tab === "dashboard") renderDashboard();
  if (tab === "history") renderHistory();
  if (tab === "messages") renderMessagesPage();
  if (tab === "browse") loadItems();
  if (tab === "browse") {
    const search = document.getElementById("userDashboardSearch").value.trim();
    if (search) { document.getElementById("q-search").value = search; filterItems(); }
    document.getElementById("browse").scrollIntoView({behavior:"smooth",block:"start"});
  }
});
document.addEventListener("click", async event => {
  const button = event.target.closest("[data-user-jump]");
  if (!button) return;
  const target = document.getElementById(button.dataset.userJump);
  if (!target) return;
  if (target.closest("#dashboard")) {
    if (document.getElementById("dashboard").getAttribute("aria-current") !== "true") activateSection("dashboard");
    await renderDashboard();
  }
  target?.scrollIntoView({behavior:"smooth",block:"start"});
  target.setAttribute("tabindex","-1");
  target.focus({preventScroll:true});
  document.querySelectorAll(".user-side-link").forEach(link => link.classList.toggle("is-current", link === button));
  const moreMenu = document.getElementById("userMoreMenu");
  const moreToggle = document.getElementById("userMoreToggle");
  if (window.matchMedia("(max-width: 760px)").matches) {
    if (moreMenu) moreMenu.hidden = true;
    moreToggle?.setAttribute("aria-expanded", "false");
  }
});
document.addEventListener("click", event => {
  const remove = event.target.closest("[data-remove-bookmark]");
  if (remove) { setBookmarkedIds(getBookmarkedIds().filter(id => id !== String(remove.dataset.removeBookmark))); renderDashboard(); }
});
document.addEventListener("click", event => {
  const button = event.target.closest("[data-message-item]");
  if(button?.closest("#rentDetail")){savePendingRentalDraft({itemId:String(button.dataset.messageItem),price:Number(document.getElementById("rentPrice")?.value),units:Number(document.getElementById("rentUnits")?.value),deliveryMethod:document.querySelector('input[name="rentDeliveryMethod"]:checked')?.value||"pickup",start:document.getElementById("rentStart")?.value||"",deliveryLocation:document.getElementById("deliveryLocation")?.value.trim()||""});}
  if (button) openConversation(button.dataset.messageItem, button.dataset.messageOwner, button.dataset.messageName, button.dataset.messageItemName || document.querySelector(".detail-title")?.textContent || "Listing",button.dataset.messageRental||"");
});
document.addEventListener("click", event => {
  const button=event.target.closest("[data-chat-rent-item]");
  if(!button)return;
  if(![...itemsCache,...messageListingCache].some(item=>String(item.id)===String(button.dataset.chatRentItem))){showToast("This listing is no longer available to rent.");return;}
  openRentFlow(button.dataset.chatRentItem,{resumeDraft:true,autoContinue:true});
});
document.addEventListener("click",async event=>{const accept=event.target.closest("[data-agreement-accept]");if(accept){accept.disabled=true;const result=await api(`/api/rental-summaries/${accept.dataset.agreementAccept}/accept`,{method:"POST",body:JSON.stringify({accepted:true})});if(result?.error){accept.disabled=false;return showToast(result.error);}showToast(result.ready?"Both parties accepted. The renter can continue to checkout.":"Acceptance recorded.");return loadConversation();}const reject=event.target.closest("[data-agreement-reject]");if(reject){reject.disabled=true;const reason=prompt("Optional reason for rejecting this offer:")||"";const result=await api(`/api/rental-summaries/${reject.dataset.agreementReject}/reject`,{method:"POST",body:JSON.stringify({reason})});if(result?.error){reject.disabled=false;return showToast(result.error);}showToast("Offer rejected. No payment was started.");return loadConversation();}const counter=event.target.closest("[data-agreement-counter]");if(counter){const input=prompt("Enter your counteroffer per rental period (₦):");if(input===null)return;const pricePerUnit=Number(input.trim());if(!Number.isFinite(pricePerUnit)||pricePerUnit<=0)return showToast("Enter a valid positive rental price.");counter.disabled=true;const result=await api(`/api/rentals/${encodeURIComponent(counter.dataset.agreementCounter)}/counteroffer`,{method:"POST",body:JSON.stringify({pricePerUnit})});if(result?.error){counter.disabled=false;return showToast(result.error);}showToast("Counteroffer sent. The renter has 48 hours to review it.");return loadConversation();}const propose=event.target.closest("[data-agreement-propose]");if(propose){const input=prompt("Enter your next proposed price per rental period (₦):");if(input===null)return;const pricePerUnit=Number(input.trim());if(!Number.isFinite(pricePerUnit)||pricePerUnit<=0)return showToast("Enter a valid positive rental price.");propose.disabled=true;const result=await api(`/api/rentals/${encodeURIComponent(propose.dataset.agreementPropose)}/propose`,{method:"POST",body:JSON.stringify({pricePerUnit})});if(result?.error){propose.disabled=false;return showToast(result.error);}showToast("Your new proposal has been sent to the lister.");return loadConversation();}const checkout=event.target.closest("[data-agreement-checkout]");if(checkout)return checkoutAcceptedAgreement(checkout.dataset.agreementCheckout);});
document.addEventListener("click",async event=>{const button=event.target.closest("[data-inspection-action]");if(!button)return;const result=await api(`/api/inspections/${button.dataset.inspection}`,{method:"PATCH",body:JSON.stringify({action:button.dataset.inspectionAction})});if(result?.error)return showToast(result.error);showToast(`Inspection ${result.status}.`);renderDashboard();});
document.addEventListener("click",async event=>{const button=event.target.closest("[data-admin-review-chat]");if(!button)return;const reason=prompt("Required reason for viewing this chat (reported conversation, dispute, fraud check, or safety review):");if(!reason)return;const mode=button.dataset.reviewMode||"reported";const rows=await api(`/api/admin/conversations/${button.dataset.adminReviewChat}?reason=${encodeURIComponent(reason)}&mode=${mode}`);if(rows?.error)return showToast(rows.error);let host=document.getElementById("adminChatReview");if(!host){host=document.createElement("div");host.id="adminChatReview";document.getElementById("contactFlagList").prepend(host);}host.innerHTML=`<section class="flag-card"><div class="section-heading"><strong>Read-only chat review · ${esc(reason)}</strong><button type="button" class="btn-outline" id="closeAdminChatReview">Close</button></div>${asList(rows).map(m=>`<article class="chat-bubble ${String(m.senderId)===String(session?.user?.id)?"mine":"theirs"}"><strong>${esc(m.senderName)}</strong><p>${esc(m.text)}</p><time>${esc(new Date(m.createdAt).toLocaleString())}</time></article>`).join("")||`<p class="fine">No retained messages in this conversation.</p>`}</section>`;document.getElementById("closeAdminChatReview")?.addEventListener("click",()=>host.remove());});
document.getElementById("setupPayout")?.addEventListener("click", async () => {
  const result = await api("/api/auth/paystack/subaccount", { method: "POST", body: "{}" });
  if (result?.error) return showToast(result.error);
  if (session?.user) session.user.subaccountCode = result.subaccountCode;
  showToast("Payout account verified and connected.");
  renderDashboard();
});

/* ---------- navigation ---------- */
function activateSection(id) {
  document.querySelectorAll(".wrap > section").forEach(s => s.setAttribute("aria-current", "false"));
  const target = document.getElementById(id);
  if (!target) return;
  target.setAttribute("aria-current", "true");
  document.querySelectorAll("nav button").forEach(b => b.setAttribute("aria-current", b.dataset.tab === id ? "true" : "false"));
  document.body.classList.toggle("admin-mode", id === "admin");
  document.body.classList.toggle("user-mode", id === "dashboard" && !!session && !isAdmin());
  window.shedShareMotion?.enterSection(target);
  if (id !== "dashboard" && window.matchMedia("(max-width: 760px)").matches) {
    const moreMenu = document.getElementById("userMoreMenu");
    const moreToggle = document.getElementById("userMoreToggle");
    if (moreMenu) moreMenu.hidden = true;
    moreToggle?.setAttribute("aria-expanded", "false");
  }
}
function syncUserMoreMenuForViewport() {
  const menu = document.getElementById("userMoreMenu");
  const toggle = document.getElementById("userMoreToggle");
  if (!menu || !toggle) return;
  const mobile = window.matchMedia("(max-width: 760px)").matches;
  toggle.hidden = !mobile;
  if (mobile) {
    menu.hidden = toggle.getAttribute("aria-expanded") !== "true";
  } else {
    menu.hidden = false;
    toggle.setAttribute("aria-expanded", "false");
  }
}
syncUserMoreMenuForViewport();
window.addEventListener("resize", syncUserMoreMenuForViewport);
document.getElementById("userMoreToggle")?.addEventListener("click", event => {
  if (!window.matchMedia("(max-width: 760px)").matches) return;
  event.stopPropagation();
  const menu = document.getElementById("userMoreMenu");
  const opening = menu.hidden;
  menu.hidden = !opening;
  event.currentTarget.setAttribute("aria-expanded", String(opening));
  if (opening) positionMorePopup(menu, event.currentTarget, "above");
});
document.getElementById("topNavMoreToggle")?.addEventListener("click", event => {
  event.stopPropagation();
  const menu = document.getElementById("topNavMoreMenu"), opening = menu.hidden;
  menu.hidden = !opening;
  event.currentTarget.setAttribute("aria-expanded", String(opening));
  if (opening) positionMorePopup(menu, event.currentTarget, "below");
});
function positionMorePopup(menu, toggle, placement) {
  const trigger = toggle.getBoundingClientRect();
  const bounds = menu.getBoundingClientRect();
  const width = bounds.width || Math.min(210, window.innerWidth - 24);
  const height = bounds.height;
  const left = Math.max(12, Math.min(trigger.right - width, window.innerWidth - width - 12));
  const top = placement === "above"
    ? Math.max(12, trigger.top - height - 10)
    : Math.min(trigger.bottom + 8, window.innerHeight - height - 12);
  menu.style.left = `${left}px`;
  menu.style.right = "auto";
  menu.style.top = `${top}px`;
  menu.style.bottom = "auto";
}
document.getElementById("topNavMoreMenu")?.addEventListener("click", event => {
  const button = event.target.closest("[data-tab]");
  if (!button || button.hidden) return;
  if (button.dataset.tab === "account") {
    activateSection("dashboard");
    renderDashboard().then(() => document.getElementById("userAccount").scrollIntoView({behavior:"smooth",block:"start"}));
  } else {
    activateSection(button.dataset.tab);
    if (button.dataset.tab === "rider") renderRiderPage();
  }
  document.getElementById("topNavMoreMenu").hidden = true;
  document.getElementById("topNavMoreToggle").setAttribute("aria-expanded", "false");
});
document.getElementById("userMoreMenu")?.addEventListener("click", event => {
  if (!window.matchMedia("(max-width: 760px)").matches) return;
  if (!event.target.closest("button")) return;
  document.getElementById("userMoreMenu").hidden = true;
  document.getElementById("userMoreToggle")?.setAttribute("aria-expanded", "false");
});
document.addEventListener("click", event => {
  const topMenu = document.getElementById("topNavMoreMenu"), topToggle = document.getElementById("topNavMoreToggle");
  if (topMenu && !event.target.closest(".top-nav-more-wrap")) { topMenu.hidden = true; topToggle?.setAttribute("aria-expanded", "false"); }
  if (!window.matchMedia("(max-width: 760px)").matches) return;
  if (event.target.closest(".user-more-wrap")) return;
  const menu = document.getElementById("userMoreMenu"), toggle = document.getElementById("userMoreToggle");
  if (menu) menu.hidden = true;
  toggle?.setAttribute("aria-expanded", "false");
});
// Only section tabs belong in the section-switch handler. Dashboard controls such
// as More have no data-tab and must not clear the current section when clicked.
document.querySelectorAll("nav button[data-tab]").forEach(btn => {
  btn.addEventListener("click", () => {
    if(btn.dataset.tab==="rider"&&!session){document.getElementById("authPanel").hidden=false;document.getElementById("authPanel").scrollIntoView({behavior:"smooth",block:"center"});showToast("Sign in or create an account to apply as a rider.");return;}
    if (btn.dataset.tab === "post") exitEditMode();
    activateSection(btn.dataset.tab);
    if (btn.dataset.tab === "dashboard") renderDashboard();
    if (btn.dataset.tab === "admin") renderAdminDashboard();
    if (btn.dataset.tab === "history") renderHistory();
    if (btn.dataset.tab === "browse") loadItems();
    if (btn.dataset.tab === "messages") renderMessagesPage();
    if (btn.dataset.tab === "rider") renderRiderPage();
  });
});
document.querySelectorAll("#userMoreMenu [data-user-tab],#userMoreMenu [data-user-jump]").forEach(button => {
  button.addEventListener("click", () => {
    const menu = document.getElementById("userMoreMenu"), toggle = document.getElementById("userMoreToggle");
    menu.hidden = true; toggle?.setAttribute("aria-expanded", "false");
  });
});

/* ---------- auth ---------- */
let authFlow = "login";
let passwordRecoveryProof = null;
function showAuthFlow(flow) {
  authFlow = flow;
  const views = ["loginForm", "signupForm", "forgotPasswordForm", "resetPasswordForm"];
  for (const id of views) document.getElementById(id).hidden = true;
  for (const id of ["passwordRecoverySent", "passwordRecoveryDone", "passwordRecoveryError"]) document.getElementById(id).hidden = true;
  if (flow === "login") document.getElementById("loginForm").hidden = false;
  if (flow === "signup") document.getElementById("signupForm").hidden = false;
  if (flow === "forgot") document.getElementById("forgotPasswordForm").hidden = false;
  if (flow === "reset") document.getElementById("resetPasswordForm").hidden = false;
  if (flow === "recovery-sent") document.getElementById("passwordRecoverySent").hidden = false;
  if (flow === "reset-done") document.getElementById("passwordRecoveryDone").hidden = false;
  if (flow === "reset-error") document.getElementById("passwordRecoveryError").hidden = false;
  const normalAuth = flow === "login" || flow === "signup";
  document.querySelector(".social-divider").hidden = !normalAuth;
  document.getElementById("googleSignInBtn").hidden = !normalAuth;
  document.getElementById("authHeaderTitle").textContent = ({ login: "Hello, welcome", signup: "Join ShedShare", forgot: "Forgot password?", "recovery-sent": "Check your email", reset: "Choose a new password", "reset-done": "Password updated", "reset-error": "Recovery link issue" })[flow] || "Hello, welcome";
  document.getElementById("authHeaderSub").textContent = flow === "signup" ? "Already have an account?" : flow === "login" ? "Don't have an account?" : "";
  document.getElementById("authToggleBtn").hidden = !normalAuth;
  if (normalAuth) document.getElementById("authToggleBtn").textContent = flow === "login" ? "Register" : "Sign in";
  document.querySelectorAll(".authTabs button").forEach(button => button.setAttribute("aria-current", button.dataset.authtab === flow ? "true" : "false"));
}
document.querySelectorAll(".authTabs button").forEach(btn => {
  btn.addEventListener("click", () => {
    const authPanel = document.getElementById("authPanel");
    showAuthFlow(btn.dataset.authtab);
    if (!authPanel.hidden) window.shedShareMotion?.enterAuth(authPanel);
  });
});
if (REFERRAL_CODE_FROM_LINK) document.querySelector('[data-authtab="signup"]')?.click();
document.getElementById("authToggleBtn").addEventListener("click", () => {
  const nextTab = document.querySelector('[data-authtab="login"]').getAttribute("aria-current") === "true" ? "signup" : "login";
  document.querySelector(`[data-authtab="${nextTab}"]`).click();
});
const ONBOARDING_PENDING_EMAIL_KEY = "shedshare_onboarding_pending_email";
function onboardingCompletedKey(user) {
  return `shedshare_onboarding_completed_${String(user?.id || user?.email || "new-user").toLowerCase()}`;
}
function showWelcomeTour(user) {
  const doneKey = user ? onboardingCompletedKey(user) : "shedshare_onboarding_guest_completed_v1";
  if (localStorage.getItem(doneKey) === "1" || document.getElementById("shedshareWelcomeTour")) return;
  const overlay = document.createElement("div");
  overlay.id = "shedshareWelcomeTour";
  overlay.className = "ss-welcome-layer";
  overlay.innerHTML = `<div class="ss-confetti" aria-hidden="true">${Array.from({length:48},(_,i)=>`<i style="--i:${i};--x:${Math.round(Math.random()*100)}%;--drift:${Math.round(Math.random()*160-80)}px;--delay:${(Math.random()*.55).toFixed(2)}s;--duration:${(2+Math.random()*1.6).toFixed(2)}s"></i>`).join("")}</div><div class="ss-balloon-burst" aria-hidden="true">${Array.from({length:8},(_,i)=>`<span style="--i:${i};--x:${6+i*12}%;--delay:${(i*.08).toFixed(2)}s"></span>`).join("")}</div><i class="ss-ribbon ss-ribbon-left" aria-hidden="true"></i><i class="ss-ribbon ss-ribbon-right" aria-hidden="true"></i><button type="button" class="ss-tour-close" aria-label="Close welcome tour">×</button><section class="ss-welcome-card" role="dialog" aria-modal="true" aria-labelledby="ssWelcomeTitle" aria-describedby="ssWelcomeCopy"><span class="eyebrow">A LITTLE SHEDSHARE SURPRISE</span><h2 id="ssWelcomeTitle"></h2><p id="ssWelcomeCopy">Find useful things to rent nearby, or share something you own. Here’s a quick look around.</p><div class="ss-welcome-actions"><button type="button" class="primary" id="ssTourBegin">Show me around</button><button type="button" class="btn-outline" id="ssTourSkipWelcome">Skip tour</button></div></section><div class="ss-tour-spotlight" hidden></div><section class="ss-tour-card" role="dialog" aria-modal="true" aria-labelledby="ssTourStepTitle" aria-describedby="ssTourStepCopy" hidden><div class="ss-tour-card-head"><span class="eyebrow" id="ssTourProgress"></span><button type="button" class="ss-tour-close-inline" aria-label="Close tour">×</button></div><h2 id="ssTourStepTitle"></h2><p id="ssTourStepCopy"></p><div class="ss-tour-actions"><button type="button" class="btn-outline" id="ssTourSkip">Skip tour</button><div><button type="button" class="btn-outline" id="ssTourBack">Back</button><button type="button" class="primary" id="ssTourNext">Next</button></div></div></section></div>`;
  document.body.append(overlay);
  const name = String(user?.name || "").trim().split(/\s+/)[0];
  overlay.querySelector("#ssWelcomeTitle").textContent = user ? `🎉 ShedShare welcomes you, ${name}!` : "🎉 Welcome to ShedShare!";
  const steps = user ? [
    { selector: '[data-tab="browse"]', title: "Explore and search", copy: "Browse nearby rentals, search by name or location, and open a listing to check its photos, price, availability, and rental details." },
    { selector: '[data-event-planner-nav]', title: "Plan an event", copy: "Build a collection from multiple listings and send a request to each lister. An interested response is not a reservation; each item still needs its own agreement." },
    { selector: '[data-tab="post"]', title: "Share an item with photos", copy: "Choose List an item to create a listing. Add clear photos so renters can see what you are offering, then set its price, availability, pickup area, and rules." },
    { selector: '[data-tab="messages"]', title: "Message and agree", copy: "Message a lister to ask questions, discuss price, and arrange terms. Quick-message suggestions are editable; agreed booking terms must be accepted by both sides." },
    { selector: 'button[data-tab="history"]', title: "Bookings and payments", copy: "My Rentals keeps your booking and payment schedule here. In manual-transfer mode, a report is not counted as paid until the lister confirms receipt." }
  ] : [
    { selector: '#exploreSearch', title: "Find a rental", copy: "Search by item or location, compare prices, and open a listing to view its photos, availability, and details." },
    { selector: '#toggleEventPlanner', title: "Plan an event", copy: "Use Event Planner to collect several listings and send requests to their listers. Each accepted request still needs its own booking agreement." },
    { selector: '#listCta', title: "Share what you own", copy: "Create an account to list an item. You can upload clear photos, add rental details, and set availability so renters know what to expect." },
    { selector: '#itemGrid', title: "Contact a lister", copy: "Open any listing and use Message Lister to ask about dates, delivery, price, or payment arrangements before you book." }
  ];
  const welcomeCard = overlay.querySelector(".ss-welcome-card");
  const tourCard = overlay.querySelector(".ss-tour-card");
  const spotlight = overlay.querySelector(".ss-tour-spotlight");
  let stepIndex = 0;
  const previousFocus = document.activeElement;
  const finish = () => {
    localStorage.setItem(doneKey, "1");
    document.removeEventListener("keydown", onKeyDown);
    overlay.remove();
    if (previousFocus?.isConnected) previousFocus.focus({preventScroll:true});
  };
  const targetFor = (selector) => {
    const matches = [...document.querySelectorAll(selector)];
    const isVisible = el => el && el.getClientRects().length && !el.closest("[hidden]") && getComputedStyle(el).visibility !== "hidden";
    return matches.find(isVisible) || [document.querySelector("#topNavMoreToggle"),document.querySelector("nav")].find(isVisible) || null;
  };
  const renderStep = () => {
    const step = steps[stepIndex];
    const target = targetFor(step.selector);
    welcomeCard.hidden = true;
    tourCard.hidden = false;
    overlay.classList.add("is-touring");
    overlay.querySelector("#ssTourProgress").textContent = `SHEDSHARE QUICK TOUR · ${stepIndex+1} OF ${steps.length}`;
    overlay.querySelector("#ssTourStepTitle").textContent = step.title;
    overlay.querySelector("#ssTourStepCopy").textContent = step.copy;
    overlay.querySelector("#ssTourBack").disabled = stepIndex === 0;
    overlay.querySelector("#ssTourNext").textContent = stepIndex === steps.length-1 ? "Finish" : "Next";
    if (target) {
      target.scrollIntoView({behavior:"smooth",block:"nearest",inline:"nearest"});
      requestAnimationFrame(() => {
        const rect = target.getBoundingClientRect();
        const pad = 5;
        spotlight.hidden = false;
        spotlight.style.left = `${Math.max(8,rect.left-pad)}px`;
        spotlight.style.top = `${Math.max(8,rect.top-pad)}px`;
        spotlight.style.width = `${Math.min(window.innerWidth-16,rect.width+pad*2)}px`;
        spotlight.style.height = `${Math.min(window.innerHeight-16,rect.height+pad*2)}px`;
        const cardRect = tourCard.getBoundingClientRect();
        const preferredTop = rect.bottom + cardRect.height + 22 < window.innerHeight ? rect.bottom+14 : rect.top-cardRect.height-14;
        tourCard.style.top = `${Math.max(12,Math.min(window.innerHeight-cardRect.height-12,preferredTop))}px`;
      });
    } else spotlight.hidden = true;
    overlay.querySelector("#ssTourNext").focus({preventScroll:true});
  };
  const onKeyDown = event => { if (event.key === "Escape") finish(); };
  overlay.querySelector("#ssTourBegin").addEventListener("click", renderStep);
  overlay.querySelector("#ssTourSkipWelcome").addEventListener("click", finish);
  overlay.querySelector("#ssTourSkip").addEventListener("click", finish);
  overlay.querySelector(".ss-tour-close").addEventListener("click", finish);
  overlay.querySelector(".ss-tour-close-inline").addEventListener("click", finish);
  overlay.querySelector("#ssTourBack").addEventListener("click",()=>{if(stepIndex>0){stepIndex--;renderStep();}});
  overlay.querySelector("#ssTourNext").addEventListener("click",()=>{if(stepIndex<steps.length-1){stepIndex++;renderStep();}else finish();});
  document.addEventListener("keydown", onKeyDown);
  overlay.querySelector("#ssTourBegin").focus({preventScroll:true});
}
function startSession(result, message, options = {}) {
  if (!result || result.error) { showToast((result && result.error) || "Something went wrong"); return; }
  session = result.user ? { user: result.user } : null;
  if (!session) return showToast("The server did not return a signed-in profile.");
  const pendingEmail = sessionStorage.getItem(ONBOARDING_PENDING_EMAIL_KEY);
  const isNewRegistration = options.newRegistration === true || (pendingEmail && pendingEmail.toLowerCase() === String(session.user.email || "").toLowerCase());
  if (pendingEmail) sessionStorage.removeItem(ONBOARDING_PENDING_EMAIL_KEY);
  renderSession();
  resumePendingMessage();
  document.getElementById("authPanel").hidden = true;
  if (isAdmin()) {
    activateSection("admin");
    renderAdminDashboard();
  } else {
    activateSection("dashboard");
    renderDashboard();
  }
  showToast(message);
  loadItems();
  if (isNewRegistration) window.setTimeout(() => showWelcomeTour(session?.user), 450);
}
document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("li-email").value.trim();
  const password = document.getElementById("li-pass").value;
  startSession(await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }), "Signed in");
});
document.getElementById("forgotPassword").addEventListener("click", () => {
  document.getElementById("emailVerificationStatus").hidden = true;
  document.getElementById("recoveryEmail").value = document.getElementById("li-email").value.trim();
  showAuthFlow("forgot");
});
document.getElementById("forgotPasswordForm").addEventListener("submit", async event => {
  event.preventDefault();
  const email = document.getElementById("recoveryEmail").value.trim();
  const result = await api("/api/auth/forgot-password", { method: "POST", body: JSON.stringify({ email }) });
  if (result?.error) return showToast(result.error);
  document.getElementById("li-email").value = email;
  document.getElementById("passwordRecoveryMessage").textContent = result?.message || "If an email-and-password account matches, recovery instructions have been sent. Check your inbox and spam folder.";
  showAuthFlow("recovery-sent");
});
function returnToSignIn() {
  passwordRecoveryProof = null;
  document.getElementById("li-pass").value = "";
  document.getElementById("emailVerificationStatus").hidden = true;
  showAuthFlow("login");
}
for (const id of ["forgotPasswordBack", "passwordRecoverySentBack", "passwordRecoveryDoneBack", "passwordRecoveryErrorBack"]) {
  document.getElementById(id).addEventListener("click", returnToSignIn);
}
document.getElementById("resetPasswordForm").addEventListener("submit", async event => {
  event.preventDefault();
  const password = document.getElementById("newPassword").value;
  const confirmPassword = document.getElementById("confirmNewPassword").value;
  if (password !== confirmPassword) return showToast("The passwords do not match.");
  if (!passwordRecoveryProof) return showToast("Open the recovery link from your email again.");
  const result = await api("/api/auth/reset-password", { method: "POST", body: JSON.stringify({ ...passwordRecoveryProof, password }) });
  if (result?.error) {
    if (result.status === 400) {
      passwordRecoveryProof = null;
      document.getElementById("passwordRecoveryErrorMessage").textContent = result.error;
      showAuthFlow("reset-error");
      return;
    }
    return showToast(result.error);
  }
  passwordRecoveryProof = null;
  document.getElementById("newPassword").value = "";
  document.getElementById("confirmNewPassword").value = "";
  document.getElementById("passwordRecoveryDoneMessage").textContent = result?.message || "Your password has been updated. Sign in with your email and new password.";
  showAuthFlow("reset-done");
});
async function resendVerificationEmail(email) {
  const address = String(email || document.getElementById("li-email").value || sessionStorage.getItem(ONBOARDING_PENDING_EMAIL_KEY) || "").trim();
  if (!address) return showToast("Enter your email address first.");
  const result = await api("/api/auth/refresh-verification", { method: "POST", body: JSON.stringify({ email: address }) });
  showToast(result?.error || result?.message || "If verification is pending, a new link has been sent.");
  return result;
}
document.getElementById("resendVerification").addEventListener("click", () => resendVerificationEmail());
document.getElementById("signupForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const referralInput = document.getElementById("su-referral-code");
  const body = {
    name: document.getElementById("su-name").value.trim(),
    phone: document.getElementById("su-phone").value.trim(),
    brand: document.getElementById("su-brand").value.trim(),
    bankName: document.getElementById("su-bank").value.trim(),
    accountNumber: document.getElementById("su-bankacct").value.trim(),
    email: document.getElementById("su-email").value.trim(),
    password: document.getElementById("su-pass").value,
    referralCode: referralInput?.value.trim() || REFERRAL_CODE_FROM_LINK
  };
  const result = await api("/api/auth/signup", { method: "POST", body: JSON.stringify(body) });
  if (result?.error) return showToast(result.error);
  if (result?.requiresEmailVerification) {
    sessionStorage.setItem(ONBOARDING_PENDING_EMAIL_KEY, body.email.toLowerCase());
    showToast(result.message || "Check your inbox to verify your email before signing in.");
    document.getElementById("li-email").value = body.email;
    document.querySelector('[data-authtab="login"]').click();
    return;
  }
  startSession(result, "Account created", {newRegistration:true});
});

/* ---------- Google sign-in ---------- */
function handleGoogleCredential(response) {
  api("/api/auth/google", { method: "POST", body: JSON.stringify({ credential: response.credential, referralCode: document.getElementById("su-referral-code")?.value.trim() || REFERRAL_CODE_FROM_LINK }) })
    .then(result => startSession(result, "Signed in with Google"));
}
async function finishEmailVerification() {
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const queryParams = new URLSearchParams(window.location.search);
  const linkType = hashParams.get("type") || queryParams.get("type") || "";
  const linkError = hashParams.get("error") || queryParams.get("error") || hashParams.get("error_code") || queryParams.get("error_code");
  if (linkType === "recovery" || (linkError && (hashParams.get("type") === "recovery" || queryParams.get("type") === "recovery"))) {
    passwordRecoveryProof = {
      ...(hashParams.get("token_hash") || queryParams.get("token_hash") ? { token_hash: hashParams.get("token_hash") || queryParams.get("token_hash") } : {}),
      ...(hashParams.get("access_token") || queryParams.get("access_token") ? { access_token: hashParams.get("access_token") || queryParams.get("access_token") } : {})
    };
    const cleanUrl = new URL(window.location.href);
    for (const key of ["error", "error_code", "error_description", "type", "token_hash", "access_token", "refresh_token", "expires_in", "expires_at", "token_type"]) cleanUrl.searchParams.delete(key);
    cleanUrl.hash = "";
    history.replaceState(null, "", cleanUrl.pathname + cleanUrl.search);
    document.getElementById("authPanel").hidden = false;
    document.getElementById("emailVerificationStatus").hidden = true;
    if (!passwordRecoveryProof.token_hash && !passwordRecoveryProof.access_token) {
      document.getElementById("passwordRecoveryErrorMessage").textContent = "This recovery link is invalid or expired. Request a new password reset email.";
      showAuthFlow("reset-error");
    } else showAuthFlow("reset");
    document.getElementById("authPanel").scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  const tokenHash = hashParams.get("token_hash");
  const queryTokenHash = queryParams.get("token_hash");
  const providerError = linkError;
  const singleUseTokenHash=tokenHash||queryTokenHash;
  if (!singleUseTokenHash && !providerError) return;
  const panel = document.getElementById("emailVerificationStatus");
  const message = document.getElementById("emailVerificationMessage");
  const resend = document.getElementById("emailVerificationResend");
  panel.hidden = false;
  document.querySelector('[data-authtab="login"]').click();
  const pendingEmail = sessionStorage.getItem(ONBOARDING_PENDING_EMAIL_KEY) || "";
  if (pendingEmail) document.getElementById("li-email").value = pendingEmail;
  let result = null;
  if (singleUseTokenHash) result = await api("/api/auth/confirm-email", { method: "POST", body: JSON.stringify({ token_hash: singleUseTokenHash }) });
  const cleanUrl = new URL(window.location.href);
  for (const key of ["error", "error_code", "error_description", "type", "token_hash", "access_token", "refresh_token"]) cleanUrl.searchParams.delete(key);
  history.replaceState(null, "", cleanUrl.pathname + cleanUrl.search);
  if (result && !result.error) {
    sessionStorage.removeItem(ONBOARDING_PENDING_EMAIL_KEY);
    message.textContent = "Email verified. You can sign in now. Email verification is separate from phone, identity, and lister checks.";
    resend.hidden = true;
    showToast(result.message || "Email verified. You can now sign in.");
  } else {
    message.textContent = "This link is invalid, expired, or already used. If you already verified, sign in; otherwise request a fresh verification email.";
    resend.hidden = false;
    showToast("Verification did not complete. Request a fresh link or sign in if the email is already verified.");
  }
}
document.getElementById("emailVerificationResend").addEventListener("click", () => resendVerificationEmail());
document.getElementById("emailVerificationSignIn").addEventListener("click", () => document.querySelector('[data-authtab="login"]').click());
function initGoogleSignIn() {
  const config = PREVIEW_MODE ? { googleClientId: "" } : null;
  const loadConfig = config ? Promise.resolve(config) : fetch(`${API_BASE}/api/config`, { credentials: "include" }).then(response => response.ok ? response.json() : {}).catch(() => ({}));
  loadConfig.then(settings => {
  GOOGLE_CLIENT_ID = settings.googleClientId || "";
  const container = document.getElementById("googleSignInBtn");
  const socialDivider = document.querySelector(".social-divider");
  const authModeNotice = document.getElementById("authModeNotice");
  if (settings.authMode === "local") {
    if (authModeNotice) authModeNotice.hidden = false;
    if (socialDivider) socialDivider.hidden = true;
    container.hidden = true;
    document.getElementById("resendVerification").hidden = true;
    document.getElementById("forgotPassword").hidden = true;
    return;
  }
  if (authModeNotice) authModeNotice.hidden = true;
  const normalAuthView = authFlow === "login" || authFlow === "signup";
  if (socialDivider) socialDivider.hidden = !normalAuthView;
  container.hidden = !normalAuthView;
  document.getElementById("resendVerification").hidden = false;
  if (!GOOGLE_CLIENT_ID) {
    container.innerHTML = `<p class="google-unavailable">Google sign-in isn't configured yet. You can sign in with your email and password.</p>`;
    return;
  }
  if (typeof google === "undefined" || !google.accounts || !google.accounts.id) {
    container.innerHTML = `<p class="google-unavailable">Google sign-in couldn't load. Check your internet connection and try again.</p>`;
    return;
  }
  google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: handleGoogleCredential });
    google.accounts.id.renderButton(container, { theme: "outline", size: "large", width: 320, text: "continue_with", shape: "pill" });
  });
}
window.addEventListener("load", initGoogleSignIn);
window.addEventListener("load", finishEmailVerification);

populateCategorySelects();
restoreBrowseQueryState();
renderSession();
loadItems();
loadTestimonials();
refreshAiAvailability();
if (USER_PREVIEW) { activateSection("dashboard"); renderDashboard(); }
if (ADMIN_PREVIEW) { activateSection("admin"); renderAdminDashboard(); }
if (!PREVIEW_MODE) restoreSession().finally(() => {
  if (!session) window.setTimeout(() => showWelcomeTour(null), 650);
});
/* ---- Messages: closable "Start a new chat" box. Paste at the VERY BOTTOM of script.js ---- */
(function () {
  const groups = document.querySelectorAll("#messages .message-sidebar > .message-group");
  if (groups.length < 2) return;
  const chatsGroup = groups[0], newChatGroup = groups[1], KEY = "shedshare_hide_new_chat";
  const close = document.createElement("button");
  close.type = "button"; close.className = "new-chat-close"; close.setAttribute("aria-label", "Hide start a new chat");
  const open = document.createElement("button");
  open.type = "button"; open.className = "new-chat-open"; open.textContent = "+ New chat";
  newChatGroup.prepend(close); chatsGroup.append(open);
  function apply(hidden) {
    newChatGroup.hidden = hidden; open.hidden = !hidden;
    try { sessionStorage.setItem(KEY, hidden ? "1" : "0"); } catch (_e) {}
  }
  close.addEventListener("click", () => apply(true));
  open.addEventListener("click", () => apply(false));
  let saved = false; try { saved = sessionStorage.getItem(KEY) === "1"; } catch (_e) {}
  apply(saved);
})();

/* ===== ShedShare 3D motion layer =====
   Cosmetic only: it animates elements that already exist. It never changes data,
   listings, prices, payments or any function above.
   - Page load: hero, buttons, search and filters start scattered in 3D, then glide together.
   - Item cards: drift in and settle, ease toward the pointer, and turn around by themselves.
     A turning card is two-faced: the back shows the same listing as the front.
     A newly posted item always turns once and glows.
   Optional hook: document.dispatchEvent(new CustomEvent("shedshare:item-posted",{detail:{id:"ITEM_ID"}})) */
(function () {
  "use strict";
  var root = document.documentElement;
  if (location.pathname === "/" && !location.hash) {
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";
    window.scrollTo(0, 0);
  }
  var LOW = (navigator.hardwareConcurrency || 4) <= 4;
  var AUTO_SPIN = true;               // set false to stop cards turning by themselves
  var SMOOTH = "cubic-bezier(.22,1,.36,1)";
  function ready() { root.classList.remove("m3d-intro"); }
  if (!Element.prototype.animate) { ready(); return; }

  var rnd = function (a, b) { return a + Math.random() * (b - a); };
  function shown(el) {
    var r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden";
  }

  /* scattered -> assembled: long, soft, no overshoot */
  function assemble(el, o) {
    o = o || {};
    var k = o.rot == null ? 1 : o.rot, ang = rnd(0, Math.PI * 2), rad = rnd(.5, 1) * (o.spread || 480);
    var x = Math.cos(ang) * rad, y = Math.sin(ang) * rad * .75, z = -rnd(.4, 1) * (o.depth || 420);
    var rx = rnd(-42, 42) * k, ry = rnd(-52, 52) * k, rz = rnd(-22, 22) * k, s = rnd(.72, .9);
    var cs = getComputedStyle(el), base = cs.transform === "none" ? "" : cs.transform;
    var an = cs.animationName, own = an && an !== "none";
    var blur = LOW ? 0 : (o.blur == null ? 6 : o.blur), kf;
    if (own) {   // element has its own CSS animation: use individual properties so it keeps running
      kf = [{ translate: (x * .5) + "px " + (y * .5) + "px", rotate: rz + "deg", scale: s, opacity: 0, filter: "blur(" + blur + "px)" },
            { opacity: 1, filter: "blur(0px)", offset: .35 },
            { translate: "0px 0px", rotate: "0deg", scale: 1, opacity: 1, filter: "blur(0px)" }];
    } else {
      var start = "perspective(1200px) translate3d(" + x + "px," + y + "px," + z + "px) rotateX(" + rx + "deg) rotateY(" + ry + "deg) rotateZ(" + rz + "deg) scale(" + s + ") " + base;
      kf = [{ transform: start, opacity: 0, filter: "blur(" + blur + "px)" },
            { opacity: 1, filter: "blur(0px)", offset: .35 },
            { transform: base || "none", opacity: 1, filter: "blur(0px)" }];
    }
    el.style.willChange = "transform, opacity";
    var a = el.animate(kf, { duration: o.dur || 3600, delay: o.delay || 0, easing: SMOOTH, fill: "backwards" });
    a.finished.then(function () { el.style.willChange = ""; if (o.done) o.done(el); }, function () { el.style.willChange = ""; });
    return a;
  }

  function animateEntries(entries, options) {
    var n = 0;
    entries.forEach(function (entry) {
      var el = entry && entry.el ? entry.el : entry;
      if (!el || !shown(el) || el.matches("#itemGrid, .item-card")) return;
      var rect = el.getBoundingClientRect();
      if (rect.top < innerHeight && rect.bottom > 0) {
        assemble(el, Object.assign({ spread: 300, depth: 280, dur: 2400, rot: .8, delay: Math.min(n * 70, 700) }, entry && entry.o || {}, options || {}));
        n++;
      } else lazy(el);
    });
  }

  function enterSection(section) {
    if (!section || section.getAttribute("aria-current") !== "true") return;
    if (section.id === "browse") {
      animateEntries(targets());
      return;
    }
    var entries = [].slice.call(section.children).filter(function (el) { return !el.matches(".public-info-grid, .faq-list"); });
    section.querySelectorAll(":scope > .public-info-grid > *, :scope > .faq-list > *").forEach(function (el) { entries.push(el); });
    animateEntries(entries);
  }

  function clearLoginDiamonds(panel) {
    if (panel._m3dDiamondTimer) clearTimeout(panel._m3dDiamondTimer);
    if (panel._m3dDiamondRaf) cancelAnimationFrame(panel._m3dDiamondRaf);
    panel._m3dDiamondTimer = null;
    panel._m3dDiamondRaf = null;
    panel._m3dDiamondActive = false;
    (panel._m3dDiamondRevealAnimations || []).forEach(function (animation) { animation.cancel(); });
    panel._m3dDiamondRevealAnimations = null;
    panel.classList.remove("m3d-diamond-source-hidden");
    panel.querySelector(":scope > .m3d-diamond-surface")?.remove();
    panel.querySelectorAll(":scope > .m3d-diamond-overlay").forEach(function (layer) { layer.remove(); });
  }

  function playLoginDiamonds(panel) {
    if (!panel || panel.hidden || panel._m3dDiamondActive || !Element.prototype.animate) return;
    clearLoginDiamonds(panel);
    panel._m3dDiamondActive = true;
    panel.classList.add("m3d-diamond-stage");
    var content = panel.querySelector(":scope > .m3d-diamond-content");
    if (!content) {
      content = document.createElement("div"); content.className = "m3d-diamond-content";
      while (panel.firstChild) content.appendChild(panel.firstChild);
      panel.insertBefore(content, panel.firstChild);
    }
    var surface = document.createElement("div");
    surface.className = "m3d-diamond-surface";
    surface.setAttribute("aria-hidden", "true");
    panel.appendChild(surface);
    var layer = document.createElement("div");
    layer.className = "m3d-diamond-overlay";
    layer.setAttribute("aria-hidden", "true");
    layer.setAttribute("inert", "");
    var canvas = document.createElement("canvas");
    canvas.className = "m3d-diamond-canvas";
    layer.appendChild(canvas);
    var width = panel.clientWidth, height = panel.clientHeight, dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    canvas.style.width = width + "px"; canvas.style.height = height + "px";
    panel.appendChild(layer);
    panel.classList.add("m3d-diamond-source-hidden");
    var revealFrames = [{ clipPath: "circle(0% at 100% 0%)" }, { clipPath: "circle(160% at 100% 0%)" }];
    panel._m3dDiamondRevealAnimations = [content, surface].map(function (element) {
      return element.animate(revealFrames, { duration: 3000, easing: "linear", fill: "both" });
    });
    var ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) { clearLoginDiamonds(panel); return; }
    ctx.scale(dpr, dpr);
    var originX = width * .97, originY = height * .045, maxDistance = Math.hypot(width, height);
    var count = Math.min(5600, Math.max(2200, Math.round(width * height / 42)));
    var colors = ["#ffffff", "#dce8ff", "#7fa6ff", "#2a5fd0", "#0b1220"];
    var particles = Array.from({ length: count }, function () {
      var x = Math.random() * width, y = Math.random() * height;
      var distance = Math.hypot(x - originX, y - originY) / maxDistance;
      return { x: x, y: y, size: .55 + Math.random() * .95, angle: Math.random() * Math.PI / 2,
        delay: distance * 260 + Math.random() * 220, duration: 1000 + distance * 1250 + Math.random() * 300,
        arc: (Math.random() - .5) * Math.min(width, height) * .13, phase: Math.random() * Math.PI * 2,
        color: colors[Math.floor(Math.random() * colors.length)] };
    });
    var start = performance.now();
    function draw(now) {
      if (!panel._m3dDiamondActive || !canvas.isConnected) return;
      var elapsed = now - start;
      ctx.clearRect(0, 0, width, height);
      particles.forEach(function (p) {
        var progress = Math.max(0, Math.min(1, (elapsed - p.delay) / p.duration));
        if (progress <= 0) return;
        var ease = 1 - Math.pow(1 - progress, 2.6);
        var arc = Math.sin(progress * Math.PI) * p.arc;
        var x = originX + (p.x - originX) * ease - arc * .55;
        var y = originY + (p.y - originY) * ease + arc;
        var twinkle = .68 + Math.sin(elapsed * .009 + p.phase) * .28;
        ctx.globalAlpha = (progress < 1 ? .48 + progress * .5 : twinkle);
        if (progress < 1) {
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - (p.x - originX) * .035, y - (p.y - originY) * .035);
          ctx.strokeStyle = p.color; ctx.lineWidth = .65; ctx.stroke();
        }
        ctx.save(); ctx.translate(x, y); ctx.rotate(p.angle + progress * Math.PI * .5);
        ctx.fillStyle = p.color; ctx.fillRect(-p.size, -p.size, p.size * 2, p.size * 2); ctx.restore();
      });
      ctx.globalAlpha = 1;
      var glow = ctx.createRadialGradient(originX, originY, 0, originX, originY, 34 + Math.sin(elapsed * .014) * 10);
      glow.addColorStop(0, "rgba(255,255,255,.98)"); glow.addColorStop(.18, "rgba(80,126,255,.68)");
      glow.addColorStop(.5, "rgba(11,18,32,.24)"); glow.addColorStop(1, "rgba(42,95,208,0)");
      ctx.fillStyle = glow; ctx.fillRect(originX - 48, originY - 48, 96, 96);
      if (elapsed < 3000) panel._m3dDiamondRaf = requestAnimationFrame(draw);
      else {
        layer.classList.add("m3d-diamond-fade");
        panel._m3dDiamondTimer = setTimeout(function () { clearLoginDiamonds(panel); }, 240);
      }
    }
    panel._m3dDiamondRaf = requestAnimationFrame(draw);
  }

  function enterAuth(panel) {
    if (!panel || panel.hidden) return;
    var loginActive = document.querySelector('[data-authtab="login"]')?.getAttribute("aria-current") === "true";
    if (loginActive) { playLoginDiamonds(panel); return; }
    clearLoginDiamonds(panel);
    animateEntries([].slice.call(panel.children));
  }

  window.shedShareMotion = { enterSection: enterSection, enterAuth: enterAuth };
  var authPanel = document.getElementById("authPanel");
  if (authPanel && "MutationObserver" in window) {
    new MutationObserver(function () { if (!authPanel.hidden) enterAuth(authPanel); }).observe(authPanel, { attributes: true, attributeFilter: ["hidden"] });
  }

  /* split the hero title into words (the gradient part stays one unit so its colour keeps working) */
  function splitTitle(h) {
    if (h._m3dw) return h._m3dw;
    var out = [];
    [].slice.call(h.childNodes).forEach(function (n) {
      if (n.nodeType === 3) {
        var frag = document.createDocumentFragment();
        n.textContent.split(/(\s+)/).forEach(function (w) {
          if (!w) return;
          if (/^\s+$/.test(w)) { frag.appendChild(document.createTextNode(w)); return; }
          var s = document.createElement("m3d-w"); s.textContent = w; frag.appendChild(s); out.push(s);
        });
        n.replaceWith(frag);
      } else if (n.nodeType === 1 && n.tagName !== "BR") { n.classList.add("m3d-unit"); out.push(n); }
    });
    h._m3dw = out; return out;
  }

  function targets() {
    var L = [];
    function add(sel, o) { document.querySelectorAll(sel).forEach(function (e) { if (shown(e)) L.push({ el: e, o: o || {} }); }); }
    add(".brand"); add("nav > *"); add(".explore-hero .explore-eyebrow");
    var h = document.querySelector(".explore-hero h1");
    if (h && shown(h)) splitTitle(h).forEach(function (w) { L.push({ el: w, o: { spread: 420 } }); });
    add(".explore-hero .tagline"); add(".explore-hero-actions > *"); add(".explore-trust");
    add(".explore-hero-art > *", { spread: 560, blur: 4 });
    add(".explore-listing-heading > *"); add(".explore-search-panel > *"); add("#catPills > *"); add(".filters > *");
    return L;
  }

  /* below-the-fold pieces glide together when they scroll into view */
  var lazyIO = null;
  function lazy(el) {
    if (!("IntersectionObserver" in window)) return;
    if (!lazyIO) lazyIO = new IntersectionObserver(function (entries) {
      var i = 0;
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        var t = e.target; lazyIO.unobserve(t); t.style.opacity = "";
        assemble(t, { spread: 260, depth: 260, dur: 1700, rot: .7, delay: i++ * 80 });
      });
    }, { threshold: .12 });
    el.style.opacity = "0"; lazyIO.observe(el);
  }

  function intro() {
    var L = targets(), vh = innerHeight, n = 0;
    L.forEach(function (t) {
      var r = t.el.getBoundingClientRect();
      if (r.top < vh * .98 && r.bottom > 0) { assemble(t.el, Object.assign({ delay: Math.min(n * 60, 900) }, t.o)); n++; }
      else lazy(t.el);
    });
    ready();
  }
  var started = false;
  function go() {
    if (started) return;
    started = true;
    try { intro(); }
    catch (error) { ready(); console.warn("3D motion intro failed; showing the page without animation.", error); }
  }
  var fontWait = document.fonts && document.fonts.ready ? Promise.race([document.fonts.ready, new Promise(function (r) { setTimeout(r, 180); })]) : Promise.resolve();
  fontWait.then(function () { requestAnimationFrame(go); });
  setTimeout(go, 350);

  /* ---------- item cards ---------- */
  var grid = document.getElementById("itemGrid");
  var seen = new Set(), settledFirst = false, postUntil = 0, pendingId = null, firstCardSpinPending = true, lastActive = Date.now();
  ["pointermove", "scroll", "keydown", "touchstart"].forEach(function (ev) { addEventListener(ev, function () { lastActive = Date.now(); }, { passive: true }); });
  document.addEventListener("submit", function (e) { if (e.target && e.target.id === "itemForm") postUntil = Date.now() + 30000; }, true);
  document.addEventListener("shedshare:item-posted", function (e) { postUntil = Date.now() + 30000; pendingId = (e.detail && e.detail.id != null) ? String(e.detail.id) : "__first"; });

  /* two-faced turn: the back is a copy of the same listing, readable and not mirrored */
  function spin(c, isNew) {
    if (!c || c.classList.contains("m3d-flip")) return;
    dropTilt(c);
    var back = document.createElement("div");
    back.className = "m3d-backface"; back.setAttribute("aria-hidden", "true"); back.setAttribute("inert", "");
    [].slice.call(c.childNodes).forEach(function (n) { back.appendChild(n.cloneNode(true)); });
    [].slice.call(back.querySelectorAll("[id]")).forEach(function (e) { e.removeAttribute("id"); });
    [].slice.call(back.querySelectorAll("img")).forEach(function (i) { i.removeAttribute("loading"); });
    [].slice.call(back.querySelectorAll("button,a,input,select,textarea")).forEach(function (e) { e.tabIndex = -1; });
    c.appendChild(back); c.classList.add("m3d-flip"); c.style.transform = "";
    if (isNew) c.classList.add("m3d-new");
    var P = "perspective(1300px) ", ease = "cubic-bezier(.65,0,.35,1)";
    var a = c.animate([
      { transform: P + "rotateY(0deg) scale(1)", easing: ease },
      { transform: P + "rotateY(180deg) scale(1.06)", offset: .5, easing: ease },
      { transform: P + "rotateY(360deg) scale(1)" }
    ], { duration: 2600 });
    var end = function () {
      if (back.parentNode) back.parentNode.removeChild(back);
      c.classList.remove("m3d-flip");
      if (isNew) setTimeout(function () { c.classList.remove("m3d-new"); }, 2800);
    };
    a.finished.then(end, end);
  }

  var cardIO = null;
  function enter(c, posted) {
    c.classList.add("in-view");
    assemble(c, { spread: 200, depth: 300, dur: 1600, blur: 3, rot: .7, done: function () {
      c.classList.add("settled");
      if (posted || firstCardSpinPending) {
        firstCardSpinPending = false;
        setTimeout(function () { spin(c, posted); }, 250);
      }
    } });
  }
  function processCards() {
    if (!grid) return;
    var cards = grid.querySelectorAll(".item-card:not([data-m3d])");
    if (!cards.length) return;
    if (!cardIO && "IntersectionObserver" in window) {
      cardIO = new IntersectionObserver(function (entries) {
        var i = 0;
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          var c = e.target; cardIO.unobserve(c);
          setTimeout(function () { enter(c, c._m3dPosted); }, i++ * 110);
        });
      }, { threshold: .12, rootMargin: "0px 0px -6% 0px" });
    }
    var idx = 0;
    cards.forEach(function (c) {
      c.setAttribute("data-m3d", "1");
      var btn = c.querySelector("[data-rent]"), id = btn ? btn.getAttribute("data-rent") : null;
      var isNew = settledFirst && id != null && !seen.has(id), posted = false;
      if (pendingId) posted = (pendingId === "__first" ? idx === 0 : id === pendingId);
      else if (isNew && Date.now() < postUntil && idx < 2) posted = true;
      if (posted) pendingId = null;
      if (id != null) seen.add(id);
      c._m3dPosted = posted; idx++;
      if (cardIO) cardIO.observe(c);
    });
    if (!settledFirst) setTimeout(function () { settledFirst = true; }, 2500);
  }
  if (grid) { new MutationObserver(processCards).observe(grid, { childList: true }); processCards(); }

  /* pointer tilt, eased every frame so it never snaps (mouse only) */
  var tilts = new Map(), raf = 0;
  function dropTilt(c) { if (tilts.has(c)) { tilts.delete(c); c.style.transform = ""; c.classList.remove("m3d-tilt"); } }
  function tick() {
    var alive = false;
    tilts.forEach(function (s, c) {
      s.rx += (s.tx - s.rx) * .12; s.ry += (s.ty - s.ry) * .12; s.l += (s.tl - s.l) * .12;
      if (s.tx === 0 && s.ty === 0 && s.tl === 0 && Math.abs(s.rx) < .02 && Math.abs(s.ry) < .02 && s.l < .1) { dropTilt(c); return; }
      c.style.transform = "perspective(900px) rotateX(" + s.rx + "deg) rotateY(" + s.ry + "deg) translateY(" + (-s.l) + "px) scale(" + (1 + s.l * .0025) + ")";
      alive = true;
    });
    raf = alive ? requestAnimationFrame(tick) : 0;
  }
  if (grid && matchMedia("(hover:hover) and (pointer:fine)").matches) {
    grid.addEventListener("pointermove", function (e) {
      var c = e.target.closest && e.target.closest(".item-card");
      if (!c || c.classList.contains("m3d-flip") || !c.classList.contains("settled")) return;
      var r = c.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      var s = tilts.get(c); if (!s) { s = { rx: 0, ry: 0, l: 0, tx: 0, ty: 0, tl: 0 }; tilts.set(c, s); c.classList.add("m3d-tilt"); }
      s.tx = (.5 - y) * 9; s.ty = (x - .5) * 11; s.tl = 6;
      c.style.setProperty("--gx", (x * 100) + "%"); c.style.setProperty("--gy", (y * 100) + "%");
      if (!raf) raf = requestAnimationFrame(tick);
    });
    grid.addEventListener("pointerout", function (e) {
      var c = e.target.closest && e.target.closest(".item-card");
      if (c && !c.contains(e.relatedTarget)) { var s = tilts.get(c); if (s) { s.tx = 0; s.ty = 0; s.tl = 0; if (!raf) raf = requestAnimationFrame(tick); } }
    });
  }

  /* cards turn around by themselves, one at a time, only while the visitor is idle */
  function autoTurn() {
    if (!AUTO_SPIN || document.hidden || !grid || grid.hidden || !shown(grid)) return;
    if (Date.now() - lastActive < 1200 || document.querySelector("dialog[open]")) return;
    var vh = innerHeight, best = null, bd = 1e9;
    grid.querySelectorAll(".item-card.settled:not(.m3d-flip)").forEach(function (c) {
      var r = c.getBoundingClientRect();
      var top = Math.max(r.top, 48), bottom = Math.min(r.bottom, vh - 82), visible = Math.max(0, bottom - top);
      if (visible / Math.max(1, r.height) < .38 || c.matches(":hover")) return;
      var d = Math.abs((top + bottom) / 2 - (vh - 82) / 2);
      if (d < bd) { bd = d; best = c; }
    });
    if (best) spin(best, false);
  }
  setInterval(autoTurn, 4000);

  window.ShedMotion = { replay: intro, spin: spin };
})();
