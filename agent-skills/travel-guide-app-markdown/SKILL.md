---
name: travel-guide-app
description: Use when working on or explaining the bilingual travel guide website in this workspace, including its JSON city data, local image assets, Google Flights price scraping, daily backend refresh, flight history, and deal-highlighting behavior.
---

# Travel Guide App

## App Summary

This workspace contains a bilingual travel guide website built from two JSON data files:

- `travel_cities_en.json`
- `travel_cities_zh.json`

The app shows a main city list grouped by travel tier. Each city has a detail page with city overview, climate, best travel time, attractions, food recommendations, local images, Toronto round-trip flight price, Google Flights link, and language switching between English and Chinese.

## Main Features

- Bilingual UI using matching English and Chinese JSON files.
- Main city cards grouped by travel tier.
- City detail pages with hero image, highlights, five attractions, and foods.
- Local images for cities, attractions, and foods under `assets/images`.
- Daily Google Flights price refresh from Toronto to each city.
- Flight price cache in `assets/flights.json`.
- Flight price history in `assets/flight-history.json`.
- Deal highlighting when the latest price is at least 10% below history average.
- Google Flights links and displayed departure/return dates.

## Technologies

- Frontend: HTML, CSS, plain JavaScript.
- Backend: Python `http.server` with custom `/api/flights`.
- Browser automation: Playwright using Microsoft Edge.
- Image search/download: Playwright plus Bing Images.
- Flight scraping: Playwright plus rendered Google Flights pages.
- Data storage: JSON files and local asset folders.

## Important Files

- `index.html`: Main city-list page.
- `city.html`: City detail page shell.
- `app.js`: Main page rendering, language switcher, flight display, deal badge.
- `city.js`: City detail rendering from JSON and image map.
- `style.css`: Layout, cards, hero images, deal highlight styles.
- `server.py`: Local web server, `/api/flights`, daily flight refresh, flight history logic.
- `scrape_flight_price.js`: Playwright Google Flights scraper.
- `download_city_images_playwright.js`: City image downloader.
- `download_detail_images_playwright.js`: Attraction and food image downloader.
- `fill_missing_attraction_thumbnails.js`: Fallback thumbnail screenshot downloader.
- `refresh_all_flight_prices.js`: Manual all-city flight refresh and validation.
- `assets/image-map.json`: Maps city, attraction, and food names to local images.
- `assets/flights.json`: Latest flight prices and deal metadata.
- `assets/flight-history.json`: Historical flight-price records.

## Build And Improvement Process

The app began with two JSON files and grew into a bilingual travel guide:

1. Created the first website structure with `index.html`, `city.html`, `app.js`, `city.js`, and `style.css`.
2. Rendered city cards by tier and city detail pages from JSON.
3. Added English/Chinese language switching.
4. Downloaded city images and updated both main cards and city pages to use local images.
5. Downloaded hotspot and food images.
6. Added screenshot fallback for image hosts that blocked direct downloads.
7. Expanded attractions from two to five per city in both JSON files.
8. Downloaded images for newly added attractions.
9. Added a Python backend server with `/api/flights`.
10. Added Playwright Google Flights scraping and daily refresh.
11. Added flight cache, flight history, and deal highlighting.
12. Improved UI copy and flight date display.

## Bugs Fixed

- Fixed `404 File not found` by serving from the correct workspace and later using `server.py`.
- Fixed missing city detail images by replacing CSS background images with real `<img>` hero elements.
- Fixed missing attraction/food images by adding Playwright thumbnail screenshot fallback.
- Fixed impossible flight prices such as Toronto to Rome for `C$190`; the scraper had been reading Google price-insight text instead of route fares.
- Fixed similar bad prices across multiple cities by rerunning all 36 routes with corrected parsing.
- Fixed weak subtitle copy in both English and Chinese.
- Removed visible history average while keeping internal deal comparison.

## Operating Notes

Start the app with:

```powershell
cd C:\Users\Ben\Documents\Codex\elsewhere
python server.py
```

Open:

```text
http://localhost:8000/index.html
```

The flight refresh runs once when the server starts, then once per day.
