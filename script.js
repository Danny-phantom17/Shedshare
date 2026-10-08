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
const API_BASE = "http://localhost:3000"; // local API during development; replace with the deployed API origin at launch
const PLATFORM_FEE_PERCENT = 15; // platform cut of the rental fee (server is the source of truth)
const MAX_DISCOUNT_NAIRA = 500; // renter may go at most this far below the listed per-unit price
const MAX_VIDEO_MB = 20; // demo-only cap — see the Video note in BACKEND_PROMPT.md before shipping real uploads
const ADMIN_EMAIL = "admin@shedshare.app"; // mock only: sign in with this email to preview the admin dashboard
const AGREEMENT_VERSION = "v1";

/* ---------- appearance ---------- */
const themeNames = { warm: "Warm", light: "Bright", dark: "Black" };
const themeOrder = ["warm", "light", "dark"];
const savedTheme = localStorage.getItem("shedshare_theme");
document.documentElement.dataset.theme = themeNames[savedTheme] ? savedTheme : "warm";
const themeToggle = document.getElementById("themeToggle");
function syncThemeButton() {
  const theme = document.documentElement.dataset.theme;
  themeToggle.textContent = `Theme: ${themeNames[theme]}`;
  themeToggle.setAttribute("aria-label", `Current theme: ${themeNames[theme]}. Tap to change theme.`);
}
syncThemeButton();
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
const GOOGLE_CLIENT_ID = "";

const CATEGORIES = ["Home & Furniture", "Kitchen", "Vehicles", "Tools & Equipment", "Electronics", "Events", "Fashion", "Music", "Outdoor", "Other"];

let session = JSON.parse(localStorage.getItem("shedshare_session") || "null");
let itemsCache = [];     // browse list
let myItemsCache = [];   // the signed-in owner's items (dashboard)
let editingItemId = null;

/* ---------- small helpers ---------- */
const isOpen = r => r.status === "confirmed" || r.status === "active";
function isAdmin() { return !!(session && session.user && session.user.isAdmin); }
function currentUserName() { return (session && session.user && session.user.name) || "You"; }
function money(n) { return "₦" + Number(n || 0).toLocaleString(); }
function split(amount) { const fee = Math.round((amount * PLATFORM_FEE_PERCENT) / 100); return { fee, owner: amount - fee }; }
function lowestPrice(item) { return Math.max(0, item.price - MAX_DISCOUNT_NAIRA); }
function asList(data) { return Array.isArray(data) ? data : []; }
function plural(n, unit) { return `${n} ${unit}${n > 1 ? "s" : ""}`; }

// User-typed text is escaped before it goes into innerHTML (prevents stored XSS once a real backend holds user input).
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function safeImg(src) { return /^(data:image\/|https?:\/\/)/i.test(src || "") ? esc(src) : ""; }
function safeVideo(src) { return /^(data:video\/|https?:\/\/)/i.test(src || "") ? esc(src) : ""; }

const pad2 = n => String(n).padStart(2, "0");
function toDateInput(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function toDateTimeInput(d) { return `${toDateInput(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function parseStart(unit, value) {
  if (!value) return null;
  if (unit === "hour") return new Date(value);
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addPeriod(start, unit, n) {
  const d = new Date(start);
  if (unit === "hour") d.setHours(d.getHours() + n);
  else if (unit === "week") d.setDate(d.getDate() + 7 * n);
  else d.setDate(d.getDate() + n);
  return d;
}
function overlaps(aS, aE, bS, bE) { return aS < bE && bS < aE; }
function fmtDT(iso, unit) {
  const d = new Date(iso);
  return unit === "hour" ? d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : d.toLocaleDateString(undefined, { dateStyle: "medium" });
}
function fmtRange(s, e, unit) { return fmtDT(s, unit) + " to " + fmtDT(e, unit); }

function agreementTermsText(itemName, units, unit) {
  return `By renting "${itemName}" you agree to: return it in the condition you received it, cover repair costs for damage beyond normal wear, return it by the end of your ${units}-${unit} period, and forfeit your deposit (if any) for late or damaged returns. You can cancel free of charge before the owner hands the item over; after that, contact the owner directly. ShedShare facilitates this rental and the payment between you and the item's owner. ShedShare is not an insurer and does not guarantee against loss, theft, or damage — the deposit above, where applicable, is the owner's primary protection, agreed directly between the two of you.`;
}
function agreementHtml(r) {
  if (!r) return "";
  return `<details class="agreement"><summary>View agreement</summary><p>${esc(agreementTermsText(r.itemName, r.units, r.pricingUnit))}</p><p class="fine">Accepted ${esc(new Date(r.acceptedAt).toLocaleString())} (${esc(r.agreementVersion || AGREEMENT_VERSION)})</p></details>`;
}

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

function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove("show"), 2200);
}

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
async function api(path, options = {}) {
  if (!API_BASE) {
    if (options.body instanceof FormData) return { error: "Media uploads require the real backend to be configured.", status: 503 };
    if (path === "/api/rentals" && options.method === "POST") return { error: "Online payments are not connected yet. Paystack checkout will be available after the backend is deployed and configured.", status: 503 };
    return mockRouter(path, options);
  }
  try {
    const headers = { ...(session ? { Authorization: "Bearer " + session.token } : {}), ...(options.headers || {}) };
    if (!(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
    const res = await fetch(API_BASE + path, {
      ...options,
      headers
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* empty body */ }
    if (!res.ok) {
      if (res.status === 401 && session) {
        session = null; localStorage.removeItem("shedshare_session"); renderSession();
        showToast("Session expired. Please sign in again.");
      }
      return { error: (data && data.error) || `Request failed (${res.status})`, status: res.status };
    }
    return data;
  } catch (e) {
    showToast("Can't reach the server");
    return { error: "network" };
  }
}

/* ---------- mock backend (only used when API_BASE is empty) ---------- */
const seedDefaults = { ownerSubaccountCode: "", image: "", video: "", paused: false, deliveryAvailable: false, deliveryFee: 0, deposit: 0, pricingUnit: "day", minPeriod: 1, condition: "Good", location: "Uyo, Akwa Ibom", ownerBrand: "" };
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
    total: subtotal + (item.deposit || 0) + deliveryFee,
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
})();

function mockRouter(path, options) {
  const method = options.method || "GET";
  const body = options.body ? JSON.parse(options.body) : {};
  const [pathname, query = ""] = path.split("?");
  const me = currentUserName();
  const user = (session && session.user) || {};

  if (pathname === "/api/items" && method === "GET") {
    return query.includes("mine=1") ? mockItems.filter(i => i.ownerName === me) : mockItems.filter(i => !i.paused);
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
      deliveryAvailable: !!body.deliveryAvailable, deliveryFee: Number(body.deliveryFee) || 0
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
    ["deliveryAvailable", "paused"].forEach(k => { if (body[k] !== undefined) item[k] = !!body[k]; });
    return item;
  }

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

  const actionMatch = pathname.match(/^\/api\/rentals\/([^/]+)\/(activate|complete|cancel)$/);
  if (actionMatch && method === "POST") {
    const rental = mockRentals.find(r => r.id === actionMatch[1]);
    if (!rental) return { error: "Rental not found.", status: 404 };
    rental.status = { activate: "active", complete: "completed", cancel: "cancelled" }[actionMatch[2]];
    return rental;
  }

  if (pathname === "/api/auth/login" && method === "POST") {
    const email = (body.email || "you@example.com").toLowerCase();
    return { token: "mock-token", user: { name: email.split("@")[0], email, isAdmin: email === ADMIN_EMAIL } };
  }
  if (pathname === "/api/auth/signup" && method === "POST") {
    const email = (body.email || "you@example.com").toLowerCase();
    return { token: "mock-token", user: { name: body.name || "You", phone: body.phone || "", brand: body.brand || "", bankName: body.bankName || "", accountNumber: body.accountNumber || "", email, isAdmin: email === ADMIN_EMAIL } };
  }
  if (pathname === "/api/auth/google" && method === "POST") return { error: "Google sign-in requires the real backend.", status: 503 };
  return {};
}

/* ---------- session ---------- */
function renderSession() {
  const box = document.getElementById("sessionBox");
  box.innerHTML = session
    ? `${esc(session.user.name)}${session.user.isAdmin ? ' <span class="admin-tag">admin</span>' : ""} <button id="signOut">Sign out</button>`
    : `<button id="openAuth">Sign in</button>`;
  const signOut = document.getElementById("signOut");
  if (signOut) signOut.addEventListener("click", () => {
    session = null; localStorage.removeItem("shedshare_session"); renderSession();
  });
  const openAuth = document.getElementById("openAuth");
  if (openAuth) openAuth.addEventListener("click", () => { document.getElementById("authPanel").hidden = false; });
}

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
  itemsCache = asList(await api("/api/items"));
  filterItems();
}

function filterItems() {
  const q = document.getElementById("q-search").value.trim().toLowerCase();
  const loc = document.getElementById("q-location").value.trim().toLowerCase();
  const cat = document.getElementById("q-cat").value;
  const maxPrice = Number(document.getElementById("q-maxprice").value) || 0;
  renderItemCards(itemsCache.filter(i => {
    if (i.paused) return false;
    if (q && !((i.name || "").toLowerCase().includes(q) || (i.description || "").toLowerCase().includes(q))) return false;
    if (loc && !(i.location || "").toLowerCase().includes(loc)) return false;
    if (cat && i.category !== cat) return false;
    if (maxPrice && i.price > maxPrice) return false;
    return true;
  }));
}
["q-search", "q-location", "q-maxprice"].forEach(id => document.getElementById(id).addEventListener("input", filterItems));
document.getElementById("q-cat").addEventListener("change", filterItems);

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
      el.style.transitionDelay = delay + "ms";
      el.classList.add("in-view");
      cardObserver.unobserve(el);
      setTimeout(() => { el.style.transitionDelay = ""; el.classList.add("settled"); }, 750 + delay);
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
  cards.forEach(c => cardObserver.observe(c));
}

function renderItemCards(list) {
  const grid = document.getElementById("itemGrid");
  if (!list.length) { grid.innerHTML = `<div class="empty-filtered">No items match your search.</div>`; return; }
  grid.innerHTML = list.map(i => {
    const img = safeImg(i.image);
    return `
    <div class="item-card">
      ${img ? `<img class="item-photo" src="${img}" alt="${esc(i.name)}" loading="lazy">` : `<div class="item-photo-placeholder">${esc(i.category)}</div>`}
      <span class="cat-pill">${esc(i.category)}</span>${i.video ? `<span class="has-video-tag">Video available</span>` : ""}
      <h3>${esc(i.name)}</h3>
      <div class="owner">${esc(i.ownerName)}${i.ownerBrand ? " (" + esc(i.ownerBrand) + ")" : ""}</div>
      <div class="loc">${esc(i.location || "")}</div>
      <div class="price">${money(i.price)}/${esc(i.pricingUnit)}</div>
      <button data-rent="${esc(i.id)}">View &amp; rent</button>
    </div>`;
  }).join("");
  grid.querySelectorAll("[data-rent]").forEach(btn => btn.addEventListener("click", () => openRentFlow(btn.dataset.rent)));
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
document.getElementById("i-image").addEventListener("change", (e) => {
  const file = e.target.files[0];
  const wrap = document.getElementById("imagePreviewWrap");
  if (!file) { pendingImageDataUrl = ""; pendingImageFile = null; wrap.style.display = "none"; return; }
  pendingImageFile = file;
  const reader = new FileReader();
  reader.onload = () => {
    pendingImageDataUrl = reader.result;
    document.getElementById("imagePreview").src = pendingImageDataUrl;
    wrap.style.display = "block";
  };
  reader.readAsDataURL(file);
});

let pendingVideoDataUrl = "";
let pendingVideoFile = null;
let existingVideoUrl = "";
document.getElementById("i-video").addEventListener("change", (e) => {
  const file = e.target.files[0];
  const wrap = document.getElementById("videoPreviewWrap");
  if (!file) { pendingVideoDataUrl = ""; pendingVideoFile = null; wrap.style.display = "none"; return; }
  if (file.size > MAX_VIDEO_MB * 1024 * 1024) {
    showToast(`Video must be under ${MAX_VIDEO_MB}MB — try a shorter clip`);
    e.target.value = "";
    pendingVideoDataUrl = ""; pendingVideoFile = null; wrap.style.display = "none";
    return;
  }
  pendingVideoFile = file;
  const reader = new FileReader();
  reader.onload = () => {
    pendingVideoDataUrl = reader.result;
    document.getElementById("videoPreview").src = pendingVideoDataUrl;
    wrap.style.display = "block";
  };
  reader.readAsDataURL(file);
});

function exitEditMode() {
  editingItemId = null;
  document.getElementById("postTitle").textContent = "Post an item for rent";
  document.getElementById("itemSubmit").textContent = "Post item";
  document.getElementById("cancelEdit").hidden = true;
  document.getElementById("itemForm").reset();
  pendingImageDataUrl = "";
  pendingImageFile = null;
  existingImageUrl = "";
  document.getElementById("imagePreviewWrap").style.display = "none";
  pendingVideoDataUrl = "";
  pendingVideoFile = null;
  existingVideoUrl = "";
  document.getElementById("videoPreviewWrap").style.display = "none";
  document.getElementById("splitPreview").innerHTML = "";
  document.getElementById("depositHint").textContent = "";
}

function startEditItem(id) {
  const item = myItemsCache.find(i => i.id === id);
  if (!item) return;
  editingItemId = id;
  const set = (k, v) => { document.getElementById(k).value = v; };
  set("i-name", item.name); set("i-cat", item.category); set("i-cond", item.condition);
  set("i-loc", item.location || ""); set("i-desc", item.description || "");
  set("i-price", item.price); set("i-unit", item.pricingUnit);
  set("i-minp", item.minPeriod); set("i-maxp", item.maxPeriod); set("i-deposit", item.deposit || "");
  updateDepositHint();
  pendingImageDataUrl = item.image || "";
  existingImageUrl = item.image || "";
  const wrap = document.getElementById("imagePreviewWrap");
  const img = safeImg(item.image);
  if (img) { document.getElementById("imagePreview").src = item.image; wrap.style.display = "block"; } else { wrap.style.display = "none"; }
  pendingVideoDataUrl = item.video || "";
  existingVideoUrl = item.video || "";
  const vwrap = document.getElementById("videoPreviewWrap");
  const vid = safeVideo(item.video);
  if (vid) { document.getElementById("videoPreview").src = item.video; vwrap.style.display = "block"; } else { vwrap.style.display = "none"; }
  document.getElementById("postTitle").textContent = "Edit item";
  document.getElementById("itemSubmit").textContent = "Save changes";
  document.getElementById("cancelEdit").hidden = false;
  renderSplitPreview();
  activateSection("post");
}
document.getElementById("cancelEdit").addEventListener("click", () => { exitEditMode(); activateSection("dashboard"); });

document.getElementById("itemForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    name: document.getElementById("i-name").value.trim(),
    category: document.getElementById("i-cat").value,
    condition: document.getElementById("i-cond").value,
    location: document.getElementById("i-loc").value.trim(),
    description: document.getElementById("i-desc").value.trim(),
    price: Number(document.getElementById("i-price").value),
    pricingUnit: document.getElementById("i-unit").value,
    minPeriod: Math.max(1, Number(document.getElementById("i-minp").value) || 1),
    maxPeriod: Math.max(1, Number(document.getElementById("i-maxp").value) || 1),
    deposit: Number(document.getElementById("i-deposit").value) || 0,
    deliveryAvailable: false, // delivery is "coming soon" — see the note in BACKEND_PROMPT.md
    deliveryFee: 0,
    image: pendingImageFile ? "" : existingImageUrl,
    video: existingVideoUrl
  };
  if (!payload.name || !payload.price || !payload.location) return;
  if (payload.maxPeriod < payload.minPeriod) { showToast("Max rental period can't be shorter than the minimum."); return; }
  const editing = editingItemId;
  let r = editing
    ? await api(`/api/items/${editing}`, { method: "PATCH", body: JSON.stringify(payload) })
    : await api("/api/items", { method: "POST", body: JSON.stringify(payload) });
  if (r && r.error) { showToast(r.error); return; }
  const itemId = editing || r.id;
  if (pendingImageFile) {
    const form = new FormData(); form.append("image", pendingImageFile);
    r = await api(`/api/items/${itemId}/image`, { method: "PUT", body: form, headers: {} });
    if (r && r.error) { showToast(r.error); return; }
  }
  if (pendingVideoFile) {
    const form = new FormData(); form.append("video", pendingVideoFile);
    r = await api(`/api/items/${itemId}/video`, { method: "PUT", body: form, headers: {} });
    if (r && r.error) { showToast(r.error); return; }
  }
  exitEditMode();
  if (editing) { showToast("Changes saved"); activateSection("dashboard"); renderDashboard(); }
  else { showToast("Item posted"); activateSection("browse"); }
  loadItems();
});

/* ---------- rent flow, step 1: price, duration, dates, delivery ---------- */
async function openRentFlow(id) {
  const item = itemsCache.find(i => i.id === id);
  if (!item) return;
  const booked = asList(await api(`/api/items/${id}/bookings`));
  const low = lowestPrice(item);
  const hourly = item.pricingUnit === "hour";
  const now = new Date();
  const nextHour = new Date(now); nextHour.setMinutes(0, 0, 0); nextHour.setHours(nextHour.getHours() + 1);
  const startInput = hourly
    ? `<input type="datetime-local" id="rentStart" min="${toDateTimeInput(now)}" value="${toDateTimeInput(nextHour)}">`
    : `<input type="date" id="rentStart" min="${toDateInput(now)}" value="${toDateInput(now)}">`;
  const img = safeImg(item.image);
  const vid = safeVideo(item.video);
  document.getElementById("rentDetail").innerHTML = `
    <div class="step">
    ${stepTrackerHtml(1)}
    ${img ? `<img class="detail-photo" src="${img}" alt="${esc(item.name)}">` : `<div class="detail-photo-placeholder">No photo provided</div>`}
    ${vid ? `<div class="video-preview"><video class="detail-video" src="${vid}" muted playsinline preload="metadata"></video><span class="play-badge"></span></div>` : ""}
    <span class="cat-pill">${esc(item.category)}</span>
    <h2 class="detail-title">${esc(item.name)}</h2>
    <p class="detail-desc">${esc(item.description || "")}</p>
    <dl class="spec-block">
      <div><dt>Owner</dt><dd>${esc(item.ownerName)}${item.ownerBrand ? " (" + esc(item.ownerBrand) + ")" : ""}</dd></div>
      <div><dt>Condition</dt><dd>${esc(item.condition)}</dd></div>
      <div><dt>Location</dt><dd>${esc(item.location || "Not provided")}</dd></div>
      <div><dt>Phone</dt><dd>${esc(item.ownerPhone || "Not provided")}</dd></div>
      ${item.deposit ? `<div><dt>Deposit</dt><dd>${money(item.deposit)}</dd></div>` : ""}
      <div><dt>Delivery</dt><dd>Coming soon — pickup only for now</dd></div>
    </dl>
    <label for="rentPrice">Price per ${esc(item.pricingUnit)} (at most ₦${MAX_DISCOUNT_NAIRA} off the listed price)</label>
    <div class="price-live" id="priceLive">${money(item.price)}/${esc(item.pricingUnit)}</div>
    <input type="range" id="rentPrice" min="${low}" max="${item.price}" step="50" value="${item.price}">
    <label for="rentUnits">Number of ${esc(item.pricingUnit)}s (${item.minPeriod} to ${item.maxPeriod})</label>
    <input type="number" id="rentUnits" min="${item.minPeriod}" max="${item.maxPeriod}" value="${item.minPeriod}">
    <label for="rentStart">Start ${hourly ? "date and time" : "date"}</label>
    ${startInput}
    <div class="when" id="rentWhen"></div>
    ${booked.length ? `<p class="fine">Already booked: ${booked.map(b => esc(fmtRange(b.startAt, b.endAt, item.pricingUnit))).join("; ")}</p>` : ""}
    <div class="split-preview" id="rentSplit"></div>
    <button class="primary" id="continueAgreement">Continue</button>
    </div>`;

  const photoEl = document.querySelector("#rentDetail .detail-photo");
  if (photoEl) photoEl.addEventListener("click", () => openLightbox("image", photoEl.src));
  const videoPreview = document.querySelector("#rentDetail .video-preview");
  if (videoPreview) {
    const inlineVideo = videoPreview.querySelector("video");
    videoPreview.addEventListener("click", () => openLightbox("video", inlineVideo.currentSrc || inlineVideo.src));
  }
  const deliveryMethod = "pickup"; // delivery is coming soon — see BACKEND_PROMPT.md
  const read = () => {
    const perUnit = Number(document.getElementById("rentPrice").value);
    const units = Math.max(item.minPeriod, Math.min(item.maxPeriod, Math.round(Number(document.getElementById("rentUnits").value) || item.minPeriod)));
    const start = parseStart(item.pricingUnit, document.getElementById("rentStart").value);
    return { perUnit, units, deliveryMethod, start };
  };
  const recalc = () => {
    const { perUnit, units, start } = read();
    document.getElementById("priceLive").textContent = money(perUnit) + "/" + item.pricingUnit;
    const subtotal = perUnit * units;
    const { fee, owner } = split(subtotal);
    const total = subtotal + item.deposit;
    document.getElementById("rentSplit").innerHTML = `
      <div class="split-row"><span class="label">${plural(units, esc(item.pricingUnit))} × ${money(perUnit)}</span><span class="value">${money(subtotal)}</span></div>
      ${item.deposit ? `<div class="split-row"><span class="label">Deposit (refundable)</span><span class="value">${money(item.deposit)}</span></div>` : ""}
      <div class="split-row"><span class="label">Total to pay</span><span class="value">${money(total)}</span></div>
      <div class="split-row"><span class="label">Platform fee (${PLATFORM_FEE_PERCENT}%, on rental only)</span><span class="value fee">${money(fee)}</span></div>
      <div class="split-row"><span class="label">Owner receives</span><span class="value payout">${money(owner)}</span></div>`;
    let problem = "";
    let end = null;
    if (!start || isNaN(start)) problem = "Choose a start date.";
    else {
      end = addPeriod(start, item.pricingUnit, units);
      if (end <= new Date()) problem = "That start time is in the past.";
      else if (booked.some(b => overlaps(start, end, new Date(b.startAt), new Date(b.endAt)))) problem = "Those dates overlap an existing booking.";
    }
    document.getElementById("rentWhen").innerHTML = problem
      ? `<span class="warn-text">${esc(problem)}</span>`
      : `<span>Return by ${esc(fmtDT(end, item.pricingUnit))}</span>`;
    document.getElementById("continueAgreement").disabled = !!problem;
  };
  recalc();
  ["rentPrice", "rentUnits", "rentStart"].forEach(id => document.getElementById(id).addEventListener("input", recalc));
  document.getElementById("continueAgreement").addEventListener("click", () => {
    const { perUnit, units, deliveryMethod, start } = read();
    showAgreementStep(item, perUnit, units, deliveryMethod, start.toISOString());
  });
  activateSection("rentFlow");
}

/* ---------- rent flow, step 2: agreement ---------- */
function showAgreementStep(item, perUnit, units, deliveryMethod, startIso) {
  const endIso = addPeriod(startIso, item.pricingUnit, units).toISOString();
  document.getElementById("rentDetail").innerHTML = `
    <div class="step">
    ${stepTrackerHtml(2)}
    <h2 class="detail-title">Rental agreement</h2>
    <p class="fine">${esc(fmtRange(startIso, endIso, item.pricingUnit))}</p>
    <div class="terms-box">${esc(agreementTermsText(item.name, units, item.pricingUnit))}</div>
    <label class="agree-row"><input type="checkbox" id="agreeCheck"> I have read and agree to the rental terms.</label>
    <button class="primary" id="continuePay" disabled>Continue to payment</button>
    </div>`;
  document.getElementById("agreeCheck").addEventListener("change", (e) => {
    document.getElementById("continuePay").disabled = !e.target.checked;
  });
  document.getElementById("continuePay").addEventListener("click", () => showPaymentStep(item, perUnit, units, deliveryMethod, startIso));
}

/* ---------- rent flow, step 3: payment ---------- */
function showPaymentStep(item, perUnit, units, deliveryMethod, startIso) {
  const subtotal = perUnit * units;
  const deliveryFee = deliveryMethod === "delivery" ? item.deliveryFee : 0;
  const total = subtotal + item.deposit + deliveryFee;
  const endIso = addPeriod(startIso, item.pricingUnit, units).toISOString();

  async function finalizeRental() {
    const paymentReference = "shedshare-" + Date.now() + "-" + Math.random().toString(36).slice(2, 12);
    const r = await api("/api/rentals", { method: "POST", body: JSON.stringify({ itemId: item.id, pricePerUnit: perUnit, units, deliveryMethod, startAt: startIso, paymentReference }) });
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
    activateSection("dashboard");
    renderDashboard();
    loadItems();
    return true;
  }

  const head = `${stepTrackerHtml(3)}<h2 class="detail-title">Complete your payment</h2><p class="fine">${esc(item.name)}: ${esc(fmtRange(startIso, endIso, item.pricingUnit))}</p>`;

  if (API_BASE) {
    const ready = true;
    document.getElementById("rentDetail").innerHTML = `
      <div class="step">${head}
      <p class="detail-desc">You'll pay <strong>${money(subtotal)}</strong> through Paystack. ShedShare keeps ${money(Math.round(subtotal * PLATFORM_FEE_PERCENT / 100))}; the owner receives ${money(subtotal - Math.round(subtotal * PLATFORM_FEE_PERCENT / 100))}. Paystack sends you to its secure checkout to select a payment method. Any security deposit is arranged and paid directly to the owner separately.</p>
      <div class="fine">The security deposit is paid directly to the owner separately and is not part of this platform checkout.</div>
      <button class="primary" id="payBtn" ${ready ? "" : "disabled"}>Continue to Paystack checkout — ${money(subtotal)}</button>
      </div>`;
    if (ready) document.getElementById("payBtn").addEventListener("click", finalizeRental);
    return;
  }

  document.getElementById("rentDetail").innerHTML = `<div class="step">${head}<p class="detail-desc">Paystack checkout is not connected in this preview. Payments cannot be accepted or marked paid here.</p><button class="btn-outline" id="paymentBack">Back to browse</button></div>`;
  document.getElementById("paymentBack").addEventListener("click", () => activateSection("browse"));
}
document.getElementById("rentBack").addEventListener("click", () => activateSection("browse"));

/* ---------- dashboard ---------- */
function actions(html) { return html ? `<div class="row-actions">${html}</div>` : ""; }
function rentalActionButtons(r, role) {
  if (role === "owner") {
    if (r.status === "confirmed") return `<button class="primary" data-raction="activate" data-rid="${esc(r.id)}">Mark as handed over</button>`;
    if (r.status === "active") return `<button class="primary" data-raction="complete" data-rid="${esc(r.id)}">Mark completed</button>`;
  }
  if (role === "renter") {
    if (r.status === "confirmed") return `<button class="btn-outline" data-raction="cancel" data-rid="${esc(r.id)}">Cancel</button>`;
    if (r.status === "active") return `<button class="primary" data-raction="complete" data-rid="${esc(r.id)}">Mark completed</button>`;
  }
  if (role === "admin" && (r.status === "confirmed" || r.status === "active")) {
    return `<button class="btn-outline" data-raction="cancel" data-rid="${esc(r.id)}">Cancel</button>`;
  }
  return "";
}
function wireActionButtons() {
  document.querySelectorAll("[data-raction]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const action = btn.dataset.raction;
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
        if (!btn.dataset.armed) { // two taps to delete, no modal needed
          btn.dataset.armed = "1"; btn.textContent = "Tap again to delete";
          setTimeout(() => { btn.dataset.armed = ""; btn.textContent = "Delete"; }, 3000);
          return;
        }
        const r = await api(`/api/items/${id}`, { method: "DELETE" });
        if (r && r.error) { showToast(r.error); return; }
        showToast("Listing deleted");
      } else {
        const pausing = btn.dataset.paused !== "true";
        const r = await api(`/api/items/${id}`, { method: "PATCH", body: JSON.stringify({ paused: pausing }) });
        if (r && r.error) { showToast(r.error); return; }
        showToast(pausing ? "Listing paused" : "Listing is live again");
      }
      renderDashboard();
      loadItems();
    });
  });
}

async function renderDashboard() {
  myItemsCache = asList(await api("/api/items?mine=1"));
  const rentalsAsOwner = asList(await api("/api/rentals?role=owner"));
  const rentalsAsRenter = asList(await api("/api/rentals?role=renter"));
  const payoutSetup = document.getElementById("payoutSetup");
  if (payoutSetup) payoutSetup.hidden = !session || Boolean(session.user.subaccountCode) || !API_BASE;

  document.getElementById("listingsEmpty").hidden = myItemsCache.length > 0;
  document.getElementById("listingsList").innerHTML = myItemsCache.map(item => {
    const forItem = rentalsAsOwner.filter(r => r.itemId === item.id);
    const openRental = forItem.find(isOpen);
    const rental = openRental || forItem[0];
    const state = openRental ? `<span class="status ${openRental.status}">${statusLabel(openRental.status, "owner")}</span>`
      : item.paused ? `<span class="status paused">Paused</span>`
      : rental ? `<span class="status ${rental.status}">${statusLabel(rental.status, "owner")}</span>`
      : `<span class="status unrented">Not yet rented</span>`;
    return `<div class="row-card">
      <div class="top"><strong>${esc(item.name)}</strong>${state}</div>
      <div class="split-row"><span class="label">Listed at</span><span class="value">${money(item.price)}/${esc(item.pricingUnit)} (as low as ${money(lowestPrice(item))})</span></div>
      ${item.paused ? `<div class="split-row"><span class="label">Visibility</span><span class="value">Hidden from browse</span></div>` : ""}
      ${rental ? `
        <div class="split-row"><span class="label">Rental period</span><span class="value">${esc(fmtRange(rental.startAt, rental.endAt, rental.pricingUnit))}</span></div>
        <div class="split-row"><span class="label">${rental.status === "pending_payment" ? "Rental amount due" : "Verified rental payment"}</span><span class="value">${money(rental.subtotal)} (${plural(rental.units, esc(rental.pricingUnit))} × ${money(rental.pricePerUnit)})</span></div>
        <div class="split-row"><span class="label">Platform fee (${rental.platformFeePercent}%)</span><span class="value fee">${money(rental.platformFee)}</span></div>
        <div class="split-row"><span class="label">You receive</span><span class="value payout">${money(rental.ownerPayout)}</span></div>` : ""}
      ${agreementHtml(rental)}
      ${actions((rental ? rentalActionButtons(rental, "owner") : "") + `
        <button class="btn-outline neutral" data-iaction="edit" data-iid="${esc(item.id)}">Edit</button>
        <button class="btn-outline neutral" data-iaction="pause" data-iid="${esc(item.id)}" data-paused="${item.paused ? "true" : "false"}">${item.paused ? "Resume listing" : "Pause listing"}</button>
        <button class="btn-outline" data-iaction="delete" data-iid="${esc(item.id)}" ${openRental ? "disabled" : ""}>Delete</button>`)}
    </div>`;
  }).join("");

  document.getElementById("rentalsEmpty").hidden = rentalsAsRenter.length > 0;
  document.getElementById("rentalsList").innerHTML = rentalsAsRenter.map(r => `
    <div class="row-card">
      <div class="top"><strong>${esc(r.itemName)}</strong><span class="status ${esc(r.status)}">${statusLabel(r.status, "renter")}</span></div>
      <div class="split-row"><span class="label">Rental period</span><span class="value">${esc(fmtRange(r.startAt, r.endAt, r.pricingUnit))}</span></div>
      <div class="split-row"><span class="label">${r.status === "pending_payment" ? "Payment pending" : "Verified rental payment"}</span><span class="value">${money(r.subtotal)}</span></div>
      <div class="split-row"><span class="label">Rental (${plural(r.units, esc(r.pricingUnit))})</span><span class="value">${money(r.subtotal)}</span></div>
      ${r.deposit ? `<div class="split-row"><span class="label">Deposit</span><span class="value">${money(r.deposit)}</span></div>` : ""}
      ${r.deliveryFee ? `<div class="split-row"><span class="label">Delivery fee</span><span class="value">${money(r.deliveryFee)}</span></div>` : ""}
      ${agreementHtml(r)}
      ${actions(rentalActionButtons(r, "renter"))}
    </div>`).join("");

  const adminSection = document.getElementById("adminSection");
  if (isAdmin()) {
    adminSection.hidden = false;
    const allTx = asList(await api("/api/rentals?role=admin"));
    const totalVolume = allTx.reduce((s, r) => s + r.subtotal, 0);
    const totalFees = allTx.reduce((s, r) => s + r.platformFee, 0);
    const totalPayouts = allTx.reduce((s, r) => s + r.ownerPayout, 0);
    document.getElementById("adminSummary").innerHTML = `
      <div class="split-row"><span class="label">Total transactions</span><span class="value" id="statTx">0</span></div>
      <div class="split-row"><span class="label">Total rental volume</span><span class="value" id="statVol">₦0</span></div>
      <div class="split-row"><span class="label">Platform fees collected</span><span class="value fee" id="statFee">₦0</span></div>
      <div class="split-row"><span class="label">Owed to owners</span><span class="value payout" id="statPay">₦0</span></div>`;
    animateValue(document.getElementById("statTx"), allTx.length, n => n);
    animateValue(document.getElementById("statVol"), totalVolume, n => money(n));
    animateValue(document.getElementById("statFee"), totalFees, n => money(n));
    animateValue(document.getElementById("statPay"), totalPayouts, n => money(n));
    document.getElementById("allTxList").innerHTML = allTx.length ? allTx.map(r => `
      <div class="row-card">
        <div class="top"><strong>${esc(r.itemName)}</strong><span class="status ${esc(r.status)}">${statusLabel(r.status, "admin")}</span></div>
        <div class="split-row"><span class="label">${esc(r.renterName)} renting from ${esc(r.ownerName)}</span><span class="value">${money(r.subtotal)}</span></div>
        <div class="split-row"><span class="label">Rental period</span><span class="value">${esc(fmtRange(r.startAt, r.endAt, r.pricingUnit))}</span></div>
        <div class="split-row"><span class="label">Platform fee</span><span class="value fee">${money(r.platformFee)}</span></div>
        <div class="split-row"><span class="label">Owner payout</span><span class="value payout">${money(r.ownerPayout)}</span></div>
        ${actions(rentalActionButtons(r, "admin"))}
      </div>`).join("") : `<div class="empty">No transactions yet.</div>`;
  } else {
    adminSection.hidden = true;
  }
  wireActionButtons();
}
document.getElementById("setupPayout")?.addEventListener("click", async () => {
  const result = await api("/api/auth/paystack/subaccount", { method: "POST", body: "{}" });
  if (result?.error) return showToast(result.error);
  if (session?.user) session.user.subaccountCode = result.subaccountCode;
  localStorage.setItem("shedshare_session", JSON.stringify(session));
  showToast("Payout account verified and connected.");
  renderDashboard();
});

/* ---------- navigation ---------- */
function activateSection(id) {
  document.querySelectorAll("section").forEach(s => s.setAttribute("aria-current", "false"));
  document.getElementById(id).setAttribute("aria-current", "true");
  document.querySelectorAll("nav button").forEach(b => b.setAttribute("aria-current", b.dataset.tab === id ? "true" : "false"));
}
document.querySelectorAll("nav button").forEach(btn => {
  btn.addEventListener("click", () => {
    if (btn.dataset.tab === "post") exitEditMode();
    activateSection(btn.dataset.tab);
    if (btn.dataset.tab === "dashboard") renderDashboard();
  });
});

/* ---------- auth ---------- */
document.querySelectorAll(".authTabs button").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".authTabs button").forEach(b => b.setAttribute("aria-current", "false"));
    btn.setAttribute("aria-current", "true");
    document.getElementById("loginForm").hidden = btn.dataset.authtab !== "login";
    document.getElementById("signupForm").hidden = btn.dataset.authtab !== "signup";
  });
});
function startSession(result, message) {
  if (!result || result.error) { showToast((result && result.error) || "Something went wrong"); return; }
  session = result;
  localStorage.setItem("shedshare_session", JSON.stringify(session));
  renderSession();
  document.getElementById("authPanel").hidden = true;
  showToast(message);
  loadItems();
}
document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("li-email").value.trim();
  const password = document.getElementById("li-pass").value;
  startSession(await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }), "Signed in");
});
document.getElementById("resendVerification").addEventListener("click", async () => {
  const email = document.getElementById("li-email").value.trim();
  if (!email) return showToast("Enter your email address first.");
  const result = await api("/api/auth/refresh-verification", { method: "POST", body: JSON.stringify({ email }) });
  showToast(result?.error || result?.message || "If verification is pending, a new link has been sent.");
});
document.getElementById("signupForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    name: document.getElementById("su-name").value.trim(),
    phone: document.getElementById("su-phone").value.trim(),
    brand: document.getElementById("su-brand").value.trim(),
    bankName: document.getElementById("su-bank").value.trim(),
    accountNumber: document.getElementById("su-bankacct").value.trim(),
    email: document.getElementById("su-email").value.trim(),
    password: document.getElementById("su-pass").value
  };
  const result = await api("/api/auth/signup", { method: "POST", body: JSON.stringify(body) });
  if (result?.error) return showToast(result.error);
  if (result?.requiresEmailVerification) {
    showToast(result.message || "Check your inbox to verify your email before signing in.");
    document.getElementById("li-email").value = body.email;
    document.querySelector('[data-authtab="login"]').click();
    return;
  }
  startSession(result, "Account created");
});

/* ---------- Google sign-in ---------- */
function handleGoogleCredential(response) {
  api("/api/auth/google", { method: "POST", body: JSON.stringify({ credential: response.credential }) })
    .then(result => startSession(result, "Signed in with Google"));
}
async function finishEmailVerification() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const tokenHash = params.get("token_hash");
  const accessToken = params.get("access_token");
  if (!tokenHash && !accessToken) return;
  const result = await api("/api/auth/confirm-email", { method: "POST", body: JSON.stringify(tokenHash ? { token_hash: tokenHash } : { access_token: accessToken }) });
  history.replaceState(null, "", window.location.pathname + window.location.search);
  showToast(result?.error || result?.message || "Email verification complete.");
  if (!result?.error) document.querySelector('[data-authtab="login"]').click();
}
function initGoogleSignIn() {
  const container = document.getElementById("googleSignInBtn");
  if (!GOOGLE_CLIENT_ID || typeof google === "undefined" || !google.accounts || !google.accounts.id) {
    container.innerHTML = `<button type="button" class="btn-outline neutral" id="googleNotReady">Continue with Google</button>`;
    document.getElementById("googleNotReady").addEventListener("click", () => showToast("Google sign-in isn't connected yet"));
    return;
  }
  google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: handleGoogleCredential });
  google.accounts.id.renderButton(container, { theme: "outline", size: "large", width: 320 });
}
window.addEventListener("load", initGoogleSignIn);
window.addEventListener("load", finishEmailVerification);

populateCategorySelects();
renderSession();
loadItems();
