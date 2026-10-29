"use strict";

const crypto = require("node:crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const { z } = require("zod");

const NIGERIA = Object.freeze({ south: 4.2, north: 13.9, west: 2.6, east: 14.8 });

function addressPart(result, type) {
  const component = (result.addressComponents || []).find((entry) => entry.types?.includes(type));
  return component?.longText || component?.shortText || "";
}

function isNigeriaCoordinate(latitude, longitude) {
  return latitude >= NIGERIA.south && latitude <= NIGERIA.north && longitude >= NIGERIA.west && longitude <= NIGERIA.east;
}

async function geocodeV4(path, serverKey) {
  const url = new URL(`https://geocode.googleapis.com/v4/geocode/${path}`);
  url.searchParams.set("regionCode", "NG");
  const response = await fetch(url, {
    headers: { "X-Goog-Api-Key": serverKey },
    signal: AbortSignal.timeout(8000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = body.error?.status || `HTTP ${response.status}`;
    console.error("Google Geocoding v4 request failed:", reason);
    return [];
  }
  return Array.isArray(body.results) ? body.results : [];
}

async function geocodeGeoapify(mode, params, apiKey) {
  const url = new URL(`https://api.geoapify.com/v1/geocode/${mode}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  url.searchParams.set("format", "json");
  url.searchParams.set("apiKey", apiKey);
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = body.message || `HTTP ${response.status}`;
    console.error("Geoapify geocoding request failed:", reason);
    return [];
  }
  return Array.isArray(body.results) ? body.results : [];
}

function normalizeGeoapify(result) {
  const country = result.country || result.country_code || "";
  const city = result.city || result.town || result.village || result.municipality || result.county || "";
  const state = result.state || result.state_code || "";
  return {
    country,
    city,
    state,
    area: result.suburb || result.neighbourhood || result.neighborhood || result.district || city,
    address: result.formatted || result.address_line1 || "",
    latitude: Number(result.lat),
    longitude: Number(result.lon)
  };
}

function createLocationsRouter({ pool, authenticate, geocodingProvider = "google", serverKey }) {
  const router = express.Router();
  const limiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false });

  router.post("/autocomplete", authenticate, limiter, async (req, res) => {
    const parsed = z.object({ query: z.string().trim().min(3).max(255) }).strict().safeParse(req.body);
    if (!parsed.success) return res.json({ suggestions: [] });
    if (!serverKey || geocodingProvider !== "geoapify") return res.json({ suggestions: [] });
    try {
      const results = await geocodeGeoapify("autocomplete", { text: parsed.data.query, filter: "countrycode:ng", limit: 5 }, serverKey);
      return res.json({ suggestions: results.map(normalizeGeoapify).filter((entry) => entry.address && Number.isFinite(entry.latitude) && Number.isFinite(entry.longitude) && isNigeriaCoordinate(entry.latitude, entry.longitude)) });
    } catch (error) {
      console.error("Address suggestions failed:", error.message);
      return res.json({ suggestions: [] });
    }
  });

  router.post("/search", authenticate, limiter, async (req, res) => {
    const parsed = z.object({ query: z.string().trim().min(2).max(255) }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Enter a Nigerian city, town, or address to search." });
    if (!serverKey) return res.status(503).json({ error: "Address search is unavailable. You can still click the map to place a pin." });
    try {
      let result;
      if (geocodingProvider === "geoapify") {
        const results = await geocodeGeoapify("search", { text: parsed.data.query, filter: "countrycode:ng", limit: 1 }, serverKey);
        result = results[0] ? normalizeGeoapify(results[0]) : null;
      } else {
        const results = await geocodeV4(`address/${encodeURIComponent(parsed.data.query)}`, serverKey);
        const entry = results[0];
        if (entry) {
          const location = entry.location || {};
          result = {
            country: addressPart(entry, "country"),
            city: addressPart(entry, "locality") || addressPart(entry, "postal_town") || addressPart(entry, "administrative_area_level_2"),
            state: addressPart(entry, "administrative_area_level_1"),
            area: addressPart(entry, "sublocality_level_1") || addressPart(entry, "sublocality") || addressPart(entry, "neighborhood"),
            address: entry.formattedAddress,
            latitude: Number(location.latitude),
            longitude: Number(location.longitude)
          };
        }
      }
      if (!result || !/^(nigeria|ng)$/i.test(result.country) || !Number.isFinite(result.latitude) || !Number.isFinite(result.longitude) || !isNigeriaCoordinate(result.latitude, result.longitude)) {
        return res.status(404).json({ error: "No Nigerian place found. Try a nearby city or town, or click the map to place the pin." });
      }
      return res.json({ latitude: result.latitude, longitude: result.longitude, pickupAddress: result.address || parsed.data.query, city: result.city || "", state: result.state || "", areaName: result.area || result.city || "" });
    } catch (error) {
      console.error("Map address search failed:", error.message);
      return res.status(502).json({ error: "Address search could not complete. Try another place or click the map to place the pin." });
    }
  });

  router.post("/verify", authenticate, limiter, async (req, res) => {
    const parsed = z.object({
      placeId: z.string().trim().max(255).optional().default(""),
      city: z.string().trim().min(1).max(100),
      state: z.string().trim().min(1).max(100),
      areaName: z.string().trim().max(120).optional().default(""),
      address: z.string().trim().min(5).max(255),
      latitude: z.number().finite().min(NIGERIA.south).max(NIGERIA.north).optional(),
      longitude: z.number().finite().min(NIGERIA.west).max(NIGERIA.east).optional()
    }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Enter a Nigerian pickup address, city, state, and area." });
    if ((parsed.data.latitude == null) !== (parsed.data.longitude == null)) return res.status(400).json({ error: "Choose a complete pickup pin on the map." });

    try {
      const selectedPlaceId = parsed.data.placeId && !/^(pin|manual):/.test(parsed.data.placeId);
      const manuallyPinned = /^pin:/.test(parsed.data.placeId);
      const addressHash = crypto.createHash("sha256").update(parsed.data.address.toLowerCase()).digest("hex");
      const addressCacheKey = manuallyPinned ? "" : parsed.data.placeId || `address:${addressHash}`;
      const [cached] = addressCacheKey ? await pool.execute(
        "SELECT formatted_address,city,state,area_name,latitude,longitude FROM geocode_cache WHERE place_id=? LIMIT 1",
        [addressCacheKey]
      ) : [[]];
      let place = cached[0];
      let externallyVerified = Boolean(place) && !addressCacheKey.startsWith("manual:");

      if (!place && serverKey && !manuallyPinned) {
        let results = [];
        let found;
        if (geocodingProvider === "geoapify") {
          results = await geocodeGeoapify("search", { text: parsed.data.address, filter: "countrycode:ng", limit: 1 }, serverKey);
          found = results[0] ? normalizeGeoapify(results[0]) : null;
        } else {
          if (selectedPlaceId) results = await geocodeV4(`places/${encodeURIComponent(parsed.data.placeId)}`, serverKey);
          if (!results.length) results = await geocodeV4(`address/${encodeURIComponent(parsed.data.address)}`, serverKey);
          const result = results[0];
          if (result) {
            const location = result.location || {};
            found = {
              country: addressPart(result, "country"),
              city: addressPart(result, "locality") || addressPart(result, "postal_town") || addressPart(result, "administrative_area_level_2"),
              state: addressPart(result, "administrative_area_level_1"),
              area: addressPart(result, "sublocality_level_1") || addressPart(result, "sublocality") || addressPart(result, "neighborhood"),
              address: result.formattedAddress,
              latitude: Number(location.latitude),
              longitude: Number(location.longitude)
            };
          }
        }
        if (found) {
          const { country, city, state, latitude, longitude } = found;
          const areaName = found.area || city;
          if (!/^(nigeria|ng)$/i.test(country)) return res.status(400).json({ error: "Pickup location must be in Nigeria." });
          if (!city || !state || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            return res.status(422).json({ error: "We could not determine the city, state, and pin. Enter those details and select a pin manually." });
          }
          if (!isNigeriaCoordinate(latitude, longitude)) return res.status(400).json({ error: "Pickup location must be in Nigeria." });
          place = {
            formatted_address: String(found.address || parsed.data.address).slice(0, 255),
            city,
            state,
            area_name: areaName,
            latitude,
            longitude
          };
          externallyVerified = true;
        }
      }

      // If external geocoding is unavailable, a member can still post by entering
      // their address and area and choosing a point on the Nigeria-restricted map.
      // This fallback is clearly reported as user-supplied, not externally verified.
      if (!place && parsed.data.latitude != null && parsed.data.longitude != null) {
        const manualKey = `manual:${req.user.id}:${crypto.randomUUID()}`;
        place = {
          formatted_address: parsed.data.address,
          city: parsed.data.city,
          state: parsed.data.state,
          area_name: parsed.data.areaName || parsed.data.city,
          latitude: parsed.data.latitude,
          longitude: parsed.data.longitude
        };
        const [saved] = await pool.execute(
          "INSERT INTO geocode_cache (place_id,formatted_address,city,state,area_name,latitude,longitude) VALUES (?,?,?,?,?,?,?)",
          [manualKey, place.formatted_address, place.city, place.state, place.area_name, place.latitude, place.longitude]
        );
        void saved;
        if (place.city.toLowerCase() !== parsed.data.city.toLowerCase() || place.state.toLowerCase() !== parsed.data.state.toLowerCase()) {
          return res.status(400).json({ error: "Check that your city and state match the pickup address." });
        }
        return res.json({
          pickupAddress: place.formatted_address,
          city: place.city,
          state: place.state,
          areaName: place.area_name,
          latitude: place.latitude,
          longitude: place.longitude,
          placeId: manualKey,
          verified: false
        });
      }

      if (!place) {
        return res.status(serverKey ? 422 : 503).json({ error: serverKey
          ? "We could not verify that address. Enter the full address and select a map pin, then try again."
          : "Map geocoding is unavailable. Select a map pin and enter the address details manually to continue." });
      }
      if (place.city.toLowerCase() !== parsed.data.city.toLowerCase() || place.state.toLowerCase() !== parsed.data.state.toLowerCase()) {
        if (parsed.data.latitude == null || parsed.data.longitude == null) {
          return res.status(400).json({ error: "City and state must match the pickup address. Check the location details and try again." });
        }
        place = null;
      }

      if (!place) {
        const manualKey = `manual:${req.user.id}:${crypto.randomUUID()}`;
        const manualPlace = {
          formatted_address: parsed.data.address,
          city: parsed.data.city,
          state: parsed.data.state,
          area_name: parsed.data.areaName || parsed.data.city,
          latitude: parsed.data.latitude,
          longitude: parsed.data.longitude
        };
        await pool.execute(
          "INSERT INTO geocode_cache (place_id,formatted_address,city,state,area_name,latitude,longitude) VALUES (?,?,?,?,?,?,?)",
          [manualKey, manualPlace.formatted_address, manualPlace.city, manualPlace.state, manualPlace.area_name, manualPlace.latitude, manualPlace.longitude]
        );
        return res.json({
          pickupAddress: manualPlace.formatted_address,
          city: manualPlace.city,
          state: manualPlace.state,
          areaName: manualPlace.area_name,
          latitude: manualPlace.latitude,
          longitude: manualPlace.longitude,
          placeId: manualKey,
          verified: false
        });
      }

      if (!cached[0]) {
        await pool.execute(
          "INSERT INTO geocode_cache (place_id,formatted_address,city,state,area_name,latitude,longitude) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE formatted_address=VALUES(formatted_address),city=VALUES(city),state=VALUES(state),area_name=VALUES(area_name),latitude=VALUES(latitude),longitude=VALUES(longitude)",
          [addressCacheKey, place.formatted_address, place.city, place.state, place.area_name, place.latitude, place.longitude]
        );
      }
      return res.json({
        pickupAddress: place.formatted_address,
        city: place.city,
        state: place.state,
        areaName: place.area_name,
        latitude: Number(place.latitude),
        longitude: Number(place.longitude),
        placeId: addressCacheKey,
        verified: externallyVerified
      });
    } catch (error) {
      console.error("Location verification failed:", error.message);
      return res.status(502).json({ error: "Pickup address verification is temporarily unavailable. Select a map pin and enter the address details manually to continue." });
    }
  });

  router.post("/reverse", authenticate, limiter, async (req, res) => {
    const parsed = z.object({
      latitude: z.number().finite().min(NIGERIA.south).max(NIGERIA.north),
      longitude: z.number().finite().min(NIGERIA.west).max(NIGERIA.east)
    }).strict().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Choose a location in Nigeria." });
    if (!serverKey) return res.status(503).json({ error: "Location lookup is unavailable. Enter your pickup details manually." });

    try {
      let result;
      if (geocodingProvider === "geoapify") {
        const results = await geocodeGeoapify("reverse", { lat: parsed.data.latitude, lon: parsed.data.longitude, lang: "en" }, serverKey);
        result = results[0] ? normalizeGeoapify(results[0]) : null;
      } else {
        const results = await geocodeV4(`location/${parsed.data.latitude},${parsed.data.longitude}`, serverKey);
        const entry = results.find((candidate) => {
          const country = addressPart(candidate, "country");
          return /^(nigeria|ng)$/i.test(country)
            && (addressPart(candidate, "locality") || addressPart(candidate, "postal_town") || addressPart(candidate, "administrative_area_level_2"))
            && addressPart(candidate, "administrative_area_level_1");
        });
        result = entry ? {
          country: addressPart(entry, "country"),
          city: addressPart(entry, "locality") || addressPart(entry, "postal_town") || addressPart(entry, "administrative_area_level_2"),
          state: addressPart(entry, "administrative_area_level_1"),
          area: addressPart(entry, "sublocality_level_1") || addressPart(entry, "sublocality") || addressPart(entry, "neighborhood"),
          address: entry.formattedAddress
        } : null;
      }
      if (!result || !/^(nigeria|ng)$/i.test(result.country) || !result.city || !result.state) return res.status(422).json({ error: "We couldn't suggest an address for that pin. Enter the private address, area, city, and state manually; the pin will still be saved." });

      const { city, state } = result;
      const area = result.area || city;
      const pickupAddress = String(result.address || "").slice(0, 255);
      if (!pickupAddress || !city || !state) return res.status(422).json({ error: "We couldn't suggest an address for that pin. Enter the private address, area, city, and state manually; the pin will still be saved." });

      const pinId = `pin:${parsed.data.latitude.toFixed(7)},${parsed.data.longitude.toFixed(7)}`;
      await pool.execute(
        "INSERT INTO geocode_cache (place_id,formatted_address,city,state,area_name,latitude,longitude) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE formatted_address=VALUES(formatted_address),city=VALUES(city),state=VALUES(state),area_name=VALUES(area_name),latitude=VALUES(latitude),longitude=VALUES(longitude)",
        [pinId, pickupAddress, city, state, area, parsed.data.latitude, parsed.data.longitude]
      );
      return res.json({ pickupAddress, city, state, areaName: area, latitude: parsed.data.latitude, longitude: parsed.data.longitude, placeId: pinId, verified: true });
    } catch (error) {
      console.error("Reverse location lookup failed:", error.message);
      return res.status(502).json({ error: "Location lookup is temporarily unavailable. Enter the private address, area, city, and state manually; the pin will still be saved." });
    }
  });

  return router;
}

module.exports = { createLocationsRouter };
