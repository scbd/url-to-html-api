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

// `sections` is a list of { tab, selector }. `tab` is optional — pass it when the
// section now lives behind a dashboard tab (v-show), since a hidden tab panel has a
// zero-size bounding box and page.$(selector).screenshot() would fail on it otherwise.
async function renderUrlSectionPngs(url, sections) {
  return withBrowser(async (page) => {
    await page.goto(url, { waitUntil: 'networkidle0' });
    await page.waitForSelector('.tile-value');
    const pngs = [];
    for (const { tab, selector } of sections) {
      if (tab) {
        await page.click(`[data-tab-btn="${tab}"]`);
        await page.waitForSelector(`[data-tab-panel="${tab}"]`, { visible: true });
      }
      const el = await page.$(selector);
      pngs.push(await el.screenshot());
    }
    return pngs;
  });
}

module.exports = { renderUrlPng, renderUrlSectionPngs };
