const puppeteer = require('puppeteer');

async function withBrowser(fn) {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-gpu', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 900 });
    return await fn(page);
  } finally {
    await browser.close();
  }
}

async function renderUrlPng(url) {
  return withBrowser(async (page) => {
    await page.goto(url, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.tile-value');
    return page.screenshot({ fullPage: true });
  });
}

async function renderUrlSectionPngs(url, selectors) {
  return withBrowser(async (page) => {
    await page.goto(url, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.tile-value');
    const pngs = [];
    for (const selector of selectors) {
      const el = await page.$(selector);
      pngs.push(await el.screenshot());
    }
    return pngs;
  });
}

module.exports = { renderUrlPng, renderUrlSectionPngs };
