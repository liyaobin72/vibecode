const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const root = __dirname;
const citiesPath = path.join(root, "travel_cities_en.json");
const imageMapPath = path.join(root, "assets", "image-map.json");
const outDir = path.join(root, "assets", "images", "cities");
const edgePath = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";

function slugify(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "item";
}

async function fetchImage(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    },
  });

  if (!response.ok) return null;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("image/")) return null;

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 20_000) return null;
  return { bytes, contentType };
}

function extensionFor(contentType) {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  return "jpg";
}

async function findImageUrl(page, city) {
  const query = `${city} skyline travel landmark`;
  const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&first=1&safeSearch=moderate`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2500);

  return page.evaluate(() => {
    const candidates = [];

    for (const anchor of document.querySelectorAll("a.iusc")) {
      const metadata = anchor.getAttribute("m");
      if (!metadata) continue;
      try {
        const parsed = JSON.parse(metadata);
        if (parsed.murl) candidates.push(parsed.murl);
      } catch (_) {
        // Bing stores the original image URL as JSON in this attribute.
      }
    }

    for (const img of document.querySelectorAll("img.mimg")) {
      const src = img.currentSrc || img.src || img.getAttribute("data-src");
      if (src && /^https?:\/\//i.test(src)) candidates.push(src);
    }

    return [...new Set(candidates)].slice(0, 12);
  });
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });

  const cities = JSON.parse(fs.readFileSync(citiesPath, "utf8"));
  const imageMap = fs.existsSync(imageMapPath)
    ? JSON.parse(fs.readFileSync(imageMapPath, "utf8"))
    : {};

  const browser = await chromium.launch({
    headless: true,
    executablePath: edgePath,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  try {
    const context = await browser.newContext({
      locale: "en-CA",
      timezoneId: "America/Toronto",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    let downloaded = 0;
    for (const cityRecord of cities) {
      const city = cityRecord.city;
      const slug = slugify(city);
      imageMap[slug] ||= { city: "", attractions: {}, foods: {} };

      const urls = await findImageUrl(page, city);
      let savedPath = "";

      for (const imageUrl of urls) {
        try {
          const image = await fetchImage(imageUrl);
          if (!image) continue;

          const ext = extensionFor(image.contentType);
          const fileName = `${slug}.${ext}`;
          const absolutePath = path.join(outDir, fileName);
          fs.writeFileSync(absolutePath, image.bytes);
          savedPath = `assets/images/cities/${fileName}`;
          downloaded += 1;
          break;
        } catch (_) {
          // Try the next search result if a host blocks direct image download.
        }
      }

      if (savedPath) {
        imageMap[slug].city = savedPath;
      }

      console.log(`${savedPath ? "saved" : "blank"}: ${city}`);
    }

    fs.writeFileSync(imageMapPath, JSON.stringify(imageMap, null, 2), "utf8");
    console.log(`downloaded=${downloaded}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
