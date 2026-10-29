"use strict";

function boundedInteger(name, fallback, min, max) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

module.exports = Object.freeze({
  riderSearchRadiusKm: boundedInteger("RIDER_SEARCH_RADIUS_KM", 10, 1, 50),
  offerTimeoutMinutes: boundedInteger("RIDER_OFFER_TIMEOUT_MINUTES", 10, 1, 60),
  riderJobOfferMinutes: boundedInteger("RIDER_JOB_OFFER_MINUTES", 2, 1, 10),
  cancellationWarningThreshold: boundedInteger("RIDER_CANCEL_WARNING_THRESHOLD", 3, 1, 20),
  cancellationReviewThreshold: boundedInteger("RIDER_CANCEL_REVIEW_THRESHOLD", 5, 2, 50),
  lowRatingThreshold: Number.isFinite(Number(process.env.RIDER_LOW_RATING_THRESHOLD)) && Number(process.env.RIDER_LOW_RATING_THRESHOLD) >= 1 && Number(process.env.RIDER_LOW_RATING_THRESHOLD) <= 5 ? Number(process.env.RIDER_LOW_RATING_THRESHOLD) : 3.5,
  lowRatingMinimumCount: boundedInteger("RIDER_LOW_RATING_MINIMUM_COUNT", 3, 1, 20),
  locationUpdateIntervalSeconds: boundedInteger("DELIVERY_LOCATION_INTERVAL_SECONDS", 15, 5, 120),
  locationMinMovementMeters: boundedInteger("DELIVERY_LOCATION_MIN_MOVEMENT_METERS", 20, 5, 500),
  locationStaleAfterSeconds: boundedInteger("DELIVERY_LOCATION_STALE_SECONDS", 90, 30, 600),
  maxTrackingHours: boundedInteger("DELIVERY_MAX_TRACKING_HOURS", 6, 1, 24),
  plausibleMaxSpeedMps: boundedInteger("DELIVERY_MAX_SPEED_MPS", 55, 10, 100),
  locationRateLimitPerMinute: boundedInteger("DELIVERY_LOCATION_RATE_LIMIT_PER_MINUTE", 6, 2, 30)
});
