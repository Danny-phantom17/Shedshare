# Listing exposure and trust signals

Browse search removes paused listings and applies the renter's category, location, unit-price, duration, and optional date-availability filters before ranking or pagination.

The default relevance order is:

1. Exact item-name matches, then item-name prefixes, then other text matches when a text query is present.
2. Shorter distance when the renter has chosen device location. Listings without coordinates follow listings with known distance.
3. Listing completeness (a photo and a description of at least 80 characters), followed by newest listing first.
4. Listing ID is a stable final tie-breaker.

Price sorting uses price within the selected rental unit, followed by listing recency. Booking volume, accumulated reviews, account age, and paid placement are not ranking inputs. Approved ratings and verified completed-rental counts are displayed as trust information; they do not lock smaller or newer listers out of results. Search filters and availability always take precedence over trust or completeness.

ShedShare does not currently persist per-listing impression counts, so this ranking cannot guarantee equal exposure or measure exposure fairness. It uses the existing listing detail, location, and rental records rather than inventing performance metrics. The completeness score is intentionally small and transparent, and renters can explicitly sort by price.
