const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const root = __dirname;
const citiesPath = path.join(root, "travel_cities_en.json");
const imageMapPath = path.join(root, "assets", "image-map.json");
const edgePath = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

const outputDirs = {
  attractions: path.join(root, "assets", "images", "attractions"),
  foods: path.join(root, "assets", "images", "foods"),
};

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

async function fetchImage(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    },
  });

  if (!response.ok) return null;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("image/")) return null;

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 12_000) return null;
  return { bytes, contentType };
}

function extensionFor(contentType) {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  return "jpg";
}

async function findImageUrls(page, query) {
  const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&first=1&safeSearch=moderate`;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(1600);
      break;
    } catch (error) {
      if (attempt === 2) return [];
      await page.waitForTimeout(1500);
    }
  }

  return page.evaluate(() => {
    const candidates = [];

    for (const anchor of document.querySelectorAll("a.iusc")) {
      const metadata = anchor.getAttribute("m");
      if (!metadata) continue;
      try {
        const parsed = JSON.parse(metadata);
        if (parsed.murl) candidates.push(parsed.murl);
      } catch (_) {
        // Ignore malformed search metadata.
      }
    }

    for (const img of document.querySelectorAll("img.mimg")) {
      const src = img.currentSrc || img.src || img.getAttribute("data-src");
      if (src && /^https?:\/\//i.test(src)) candidates.push(src);
    }

    return [...new Set(candidates)].slice(0, 16);
  });
}

function existingRelativePath(absoluteBasePath, relativeBasePath) {
  for (const ext of ["jpg", "jpeg", "png", "webp"]) {
    const absolutePath = `${absoluteBasePath}.${ext}`;
    if (fs.existsSync(absolutePath)) return `${relativeBasePath}.${ext}`;
  }
  return "";
}

async function saveFirstAvailable(page, query, absoluteBasePath, relativeBasePath) {
  const existingPath = existingRelativePath(absoluteBasePath, relativeBasePath);
  if (existingPath) return existingPath;

  const urls = await findImageUrls(page, query);

  for (const imageUrl of urls) {
    try {
      const image = await fetchImage(imageUrl);
      if (!image) continue;

      const ext = extensionFor(image.contentType);
      const absolutePath = `${absoluteBasePath}.${ext}`;
      fs.writeFileSync(absolutePath, image.bytes);
      return `${relativeBasePath}.${ext}`;
    } catch (_) {
      // Some image hosts block direct fetches; try the next search result.
    }
  }

  const thumbnail = page.locator("img.mimg").first();
  if (await thumbnail.count()) {
    try {
      const absolutePath = `${absoluteBasePath}.png`;
      await thumbnail.screenshot({ path: absolutePath });
      if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).size > 5000) {
        return `${relativeBasePath}.png`;
      }
    } catch (_) {
      // Leave the item blank if the search page does not expose a usable thumbnail.
    }
  }

  return "";
}

async function main() {
  fs.mkdirSync(outputDirs.attractions, { recursive: true });
  fs.mkdirSync(outputDirs.foods, { recursive: true });

  const cities = JSON.parse(fs.readFileSync(citiesPath, "utf8"));
  const imageMap = fs.existsSync(imageMapPath)
    ? JSON.parse(fs.readFileSync(imageMapPath, "utf8"))
    : {};

  const browser = await chromium.launch({
    headless: true,
    executablePath: edgePath,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  let downloaded = 0;
  let attempted = 0;

  try {
    const context = await browser.newContext({
      locale: "en-CA",
      timezoneId: "America/Toronto",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    for (const cityRecord of cities) {
      const city = cityRecord.city;
      const citySlug = slugify(city);
      imageMap[citySlug] ||= { city: "", attractions: {}, foods: {} };
      imageMap[citySlug].attractions ||= {};
      imageMap[citySlug].foods ||= {};

      for (const attraction of cityRecord.attractions || []) {
        attempted += 1;
        const name = attraction.name;
        const itemSlug = slugify(name);
        const baseName = `${citySlug}--${itemSlug}`;
        const absoluteBase = path.join(outputDirs.attractions, baseName);
        const relativeBase = `assets/images/attractions/${baseName}`;
        const query = `${name} ${city} landmark travel`;
        const savedPath = await saveFirstAvailable(page, query, absoluteBase, relativeBase);
        imageMap[citySlug].attractions[name] = savedPath;
        fs.writeFileSync(imageMapPath, JSON.stringify(imageMap, null, 2), "utf8");
        if (savedPath) downloaded += 1;
        console.log(`${savedPath ? "saved" : "blank"} attraction: ${city} / ${name}`);
      }

      for (const food of cityRecord.foods || []) {
        attempted += 1;
        const itemSlug = slugify(food);
        const baseName = `${citySlug}--${itemSlug}`;
        const absoluteBase = path.join(outputDirs.foods, baseName);
        const relativeBase = `assets/images/foods/${baseName}`;
        const query = `${food} ${city} food dish`;
        const savedPath = await saveFirstAvailable(page, query, absoluteBase, relativeBase);
        imageMap[citySlug].foods[food] = savedPath;
        fs.writeFileSync(imageMapPath, JSON.stringify(imageMap, null, 2), "utf8");
        if (savedPath) downloaded += 1;
        console.log(`${savedPath ? "saved" : "blank"} food: ${city} / ${food}`);
      }
    }

    fs.writeFileSync(imageMapPath, JSON.stringify(imageMap, null, 2), "utf8");
    console.log(`downloaded=${downloaded}; attempted=${attempted}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
