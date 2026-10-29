"use strict";

function getGeocodingConfig(env = process.env) {
  if (env.GOOGLE_MAPS_SERVER_KEY) return { provider: "google", key: env.GOOGLE_MAPS_SERVER_KEY };
  if (env.GEOAPIFY_API_KEY) return { provider: "geoapify", key: env.GEOAPIFY_API_KEY };
  return { provider: "none", key: "" };
}

function getGoogleMapsPlacesServerKey(env = process.env) {
  if (env.GOOGLE_MAPS_PLACES_SERVER_KEY) return env.GOOGLE_MAPS_PLACES_SERVER_KEY;
  return "";
}

module.exports = { getGoogleMapsPlacesServerKey, getGeocodingConfig };
