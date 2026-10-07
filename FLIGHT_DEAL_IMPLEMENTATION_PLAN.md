# Flexible Flight Deal Implementation Plan

## Goal

Replace the fixed next-Monday flight search with a flexible Google Flights search that publishes one best verified round-trip deal from Toronto for every city.

The traveller can change both dates and length of stay. For mainland China, Hong Kong, and Macau, the published result may represent a stay of roughly two weeks through 180 days. Other destinations remain limited to stays of roughly two weeks through two months. The interface shows only one best deal per city; alternative itineraries remain internal search candidates.

## Source and operating constraints

- Keep Google Flights as the only flight-data source.
- Continue using Playwright because Google Flights does not provide a public consumer search API for this use.
- Search one adult in economy class and CAD.
- Use Toronto Pearson (`YYZ`) as the initial origin.
- Search future dates available through Google Flights, without tying all cities to one date range.
- Refresh once per day while `server.py` is running.
- Preserve local history, cached results, and application logging.

## Published result

The main page and corresponding city page must show the same single result:

- Total round-trip price in CAD
- Origin and destination
- Departure and return dates
- Number of nights
- Airline, when available
- Number of stops
- Total journey duration, when available
- Cabin or fare type, when available
- Baggage information, when available; otherwise omit it or show `Unknown`
- Last successfully verified time
- Exact Google Flights link for the itinerary
- Deal label only when there is enough comparable history

Do not add a list of trip-length choices or multiple public deals.

## Search workflow

### 1. Flexible candidate discovery

For each city, use Google Flights flexible-date surfaces such as the date grid, price graph, Explore, or Flight Deals to find promising departure and return combinations. Consider varied stays from approximately 14 to 60 nights for most destinations. For mainland China, Hong Kong, and Macau, also consider long stays up to 180 days.

Collect a small internal candidate set. Avoid exhaustive searches across every date pair because that would be slow and would increase blocking risk.

### 2. Exact itinerary verification

Open an exact round-trip search for each promising candidate and accept it only after confirming:

- Origin is Toronto/YYZ.
- Destination and airports are correct.
- Departure and return dates match the candidate.
- Both outbound and return journeys exist.
- Currency is CAD.
- Price is the total round-trip price for one adult.
- Price belongs to a specific itinerary, not a generic `from` message.
- Airline, stops, and duration correspond to that itinerary.
- The result is still available when verified.

### 3. Candidate ranking

Publish only the highest-ranked verified candidate. Ranking should consider:

1. Discount relative to comparable historical prices or Google's price insight.
2. Total round-trip price.
3. Number of stops.
4. Total journey duration.
5. Itinerary practicality.

A slightly more expensive itinerary can outrank a much longer or multi-stop itinerary. Keep weights and rejection limits as named constants so they can be tuned without rewriting the scraper.

## Deal calculation

- Prefer Google's `low`, `typical`, or `high` insight when it can be reliably attached to the exact search.
- Compare local history only with observations for the same route and broadly comparable season, stay length, and itinerary conditions.
- Use the median rather than the arithmetic mean.
- Exclude the current observation from its own baseline.
- Require sufficient history before showing a deal label.
- Suggested labels:
  - Exceptional deal: at least 25% below comparable median
  - Good deal: 15% to 24% below comparable median
  - Fair price: within 15% of comparable median
  - Above normal: more than 15% above comparable median
  - Insufficient history: do not claim a deal

## Data model

Every verified observation should store:

- City slug and destination airport(s)
- Origin airport
- Departure and return dates
- Number of nights
- Price and currency
- Airline(s)
- Stops per direction
- Journey duration per direction
- Cabin/fare type
- Baggage details, if known
- Exact Google Flights URL
- Discovery time and verification time
- Google price insight, if available
- Verification status and rejection reason

Keep an old verified result attached to its original dates. Never copy an old price into a record containing newly generated dates.

## Reliability rules

- Retain the previous verified deal until a replacement has passed verification.
- A failed refresh must not erase a valid result.
- Recheck unexpectedly cheap candidates in a fresh page/context before publishing.
- Reject an extreme high-price outlier when it exceeds twice the median of at least three comparable verified observations; do not retain a previously published extreme outlier through later refresh failures.
- Reject implausible prices and mismatched routes, dates, currencies, or trip types.
- Save diagnostic details when extraction fails; save screenshots only for failures or suspicious results to control storage.
- Update the cache atomically so the frontend never reads a partially written JSON file.
- Log refresh start and finish, each city result, rejected candidates, verification failures, retained stale results, and unexpected exceptions.

## Frontend behavior

Use clear states instead of leaving `Checking price` indefinitely:

- Verified result with `Checked <date/time>`
- Updating, while continuing to show the previous verified result
- No verified fare found
- Search temporarily unavailable
- Price expired; open Google Flights to search again

Both English and Chinese interfaces must receive equivalent text and behavior.

## Implementation sequence

1. Refactor the Google Flights scraper to return structured itinerary data rather than the minimum number found in page text.
2. Fix stale-price/date mixing and write cache files atomically.
3. Correct historical comparison so the current observation is excluded and only comparable observations are used.
4. Implement flexible candidate discovery with a small bounded candidate set.
5. Implement exact candidate verification and suspicious-price rechecks.
6. Implement ranking and publish one best deal per city.
7. Extend the cache/history schema while remaining tolerant of existing records.
8. Update the main page and city page to display the same result and explicit status.
9. Keep the daily scheduler and improve logs around each stage.
10. Validate a representative set of short-haul, transatlantic, and long-haul cities, then run a complete 36-city refresh.

## Acceptance criteria

- No search is hard-coded to next Monday or one common travel week.
- Every published price is tied to verified departure and return dates.
- Every published link opens the matching Google Flights route and dates.
- One and only one best deal is displayed per city.
- The main page and city page agree on price, dates, and itinerary.
- A failed scrape preserves the previous verified result and exposes its age.
- A suspiciously low result requires a second successful verification.
- Deal labels use comparable historical data and exclude the current observation.
- The scraper does not accept generic `from` text as proof of an itinerary price.
- English and Chinese displays are complete.
- Daily refresh activity and failures are visible in `logs/app.log`.
- Existing city, attraction, food, image, and language functionality continues to work.

## Efficient handoff prompt

Use this prompt in a fresh Codex task:

> Implement `FLIGHT_DEAL_IMPLEMENTATION_PLAN.md` in this project. First inspect the existing flight backend, scraper, frontend, cache, history, and logs. Work through the implementation sequence, preserving unrelated functionality and existing user data. Test structured extraction against representative short-haul, transatlantic, and long-haul cities before running all cities. Do not publish a price unless its exact itinerary is verified. Keep changes focused, report material limitations, and stop only when the acceptance criteria pass or a concrete external blocker is demonstrated.
