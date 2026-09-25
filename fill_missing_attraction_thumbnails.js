const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const root = __dirname;
const citiesPath = path.join(root, "travel_cities_en.json");
const imageMapPath = path.join(root, "assets", "image-map.json");
const outDir = path.join(root, "assets", "images", "attractions");
const edgePath = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

function slugify(value) {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "item"
  );
}

async function saveThumbnail(page, city, name, absolutePath) {
  const query = `${name} ${city} attraction landmark`;
  const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&first=1&safeSearch=moderate`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => null);
  await page.waitForTimeout(1800);

  const thumbnails = page.locator("img.mimg");
  const count = await thumbnails.count();
  for (let i = 0; i < Math.min(count, 8); i += 1) {
    const thumb = thumbnails.nth(i);
    try {
      const box = await thumb.boundingBox();
      if (!box || box.width < 80 || box.height < 60) continue;
      await thumb.screenshot({ path: absolutePath });
      if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).size > 3000) return true;
    } catch (_) {
      // Try the next visible thumbnail.
    }
  }
  return false;
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const cities = JSON.parse(fs.readFileSync(citiesPath, "utf8"));
  const imageMap = JSON.parse(fs.readFileSync(imageMapPath, "utf8"));

  const browser = await chromium.launch({
    headless: true,
    executablePath: edgePath,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  let filled = 0;
  try {
    const context = await browser.newContext({
      locale: "en-CA",
      timezoneId: "America/Toronto",
      viewport: { width: 1365, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    for (const cityRecord of cities) {
      const citySlug = slugify(cityRecord.city);
      imageMap[citySlug] ||= { city: "", attractions: {}, foods: {} };
      imageMap[citySlug].attractions ||= {};

      for (const attraction of cityRecord.attractions || []) {
        if (imageMap[citySlug].attractions[attraction.name]) continue;

        const itemSlug = slugify(attraction.name);
        const fileName = `${citySlug}--${itemSlug}.png`;
        const absolutePath = path.join(outDir, fileName);
        const ok = await saveThumbnail(page, cityRecord.city, attraction.name, absolutePath);
        if (ok) {
          imageMap[citySlug].attractions[attraction.name] = `assets/images/attractions/${fileName}`;
          fs.writeFileSync(imageMapPath, JSON.stringify(imageMap, null, 2), "utf8");
          filled += 1;
        }
        console.log(`${ok ? "saved" : "blank"} attraction: ${cityRecord.city} / ${attraction.name}`);
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`filled=${filled}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
