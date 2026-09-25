const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { chromium } = require("playwright");

const root = __dirname;
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".jpg": "image/jpeg", ".webp": "image/webp", ".png": "image/png" };
const server = http.createServer((request, response) => {
  const requestPath = request.url.split("?", 1)[0];
  const relative = requestPath === "/" ? "index.html" : requestPath.replace(/^\//, "");
  const target = requestPath === "/api/flights" ? path.join(root, "assets", "flights.json") : path.join(root, relative);
  if (!target.startsWith(root) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "Content-Type": mime[path.extname(target)] || "application/octet-stream" });
  fs.createReadStream(target).pipe(response);
});

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const cache = JSON.parse(fs.readFileSync(path.join(root, "assets", "flights.json"), "utf8"));
  const expected = `C$${cache.prices["new-york"].price_cad}`;
  const browser = await chromium.launch({ headless: true, executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/index.html`);
    const card = page.locator('a[href*="city=new-york"]').first().locator("xpath=ancestor::article");
    await card.waitFor();
    assert((await card.innerText()).includes(expected));
    assert((await card.innerText()).includes("Checked"));
    await page.getByRole("button", { name: "中文" }).click();
    assert((await card.innerText()).includes("核实于"));
    await page.goto(`http://127.0.0.1:${port}/city.html?city=new-york`);
    const panel = page.locator(".flight-panel");
    await panel.waitFor();
    assert((await panel.innerText()).includes(expected));
    assert((await panel.innerText()).includes("核实于"));
    await page.getByRole("button", { name: "EN" }).click();
    assert((await panel.innerText()).includes("Open exact itinerary"));
    console.log("frontend list/detail bilingual flight tests passed");
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((error) => { console.error(error); server.close(); process.exit(1); });
