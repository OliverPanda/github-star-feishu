const path = require("node:path");
const fs = require("node:fs");

const playwrightDir = "C:/Users/zzjhy/AppData/Local/npm-cache/_npx/84539a01c0e4c364/node_modules/playwright";
const { chromium } = require(playwrightDir);

const extensionDir = path.resolve(__dirname, "extension", ".output", "chrome-mv3-dev");
const profileDir = path.resolve(__dirname, "data", "chromium-ext-profile");
const executablePath =
  "C:/Users/zzjhy/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe";

/** Read API_TOKEN / API_PORT out of the project .env so the user types nothing. */
function readEnvValue(key, fallback) {
  const envPath = path.resolve(__dirname, ".env");
  const raw = fs.readFileSync(envPath, "utf8");
  const match = new RegExp("^" + key + "=(.*)$", "m").exec(raw);
  return match ? match[1].trim() : fallback;
}

function readEnv() {
  const port = readEnvValue("API_PORT", "8787");
  const host = readEnvValue("API_HOST", "127.0.0.1");
  return {
    baseUrl: "http://" + host + ":" + port,
    token: readEnvValue("API_TOKEN", ""),
  };
}

async function main() {
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: null,
    executablePath,
    args: [
      "--disable-extensions-except=" + extensionDir,
      "--load-extension=" + extensionDir,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  // The extension has no background worker, so Playwright cannot learn the id
  // from a service worker URL. An unpacked build gets a stable id derived from
  // its path, so read it back from the browser instead of hardcoding it.
  let extensionId = null;
  const workers = context.serviceWorkers();
  if (workers.length > 0) {
    extensionId = new URL(workers[0].url()).host;
  } else {
    const manager = await context.newPage();
    await manager.goto("chrome://extensions/");
    await manager.waitForTimeout(1500);
    extensionId = await manager.evaluate(() => {
      const node = document.querySelector("extensions-manager");
      const list = node && node.shadowRoot.querySelector("extensions-item-list");
      const items = list ? Array.from(list.shadowRoot.querySelectorAll("extensions-item")) : [];
      const first = items[0];
      return first ? first.id : null;
    });
    await manager.close();
  }
  if (!extensionId) throw new Error("could not resolve the extension id");
  console.log("extensionId =", extensionId);

  const optionsPage = await context.newPage();
  await optionsPage.goto("chrome-extension://" + extensionId + "/options.html");
  console.log("options page opened:", optionsPage.url());

  const settings = readEnv();
  await optionsPage.evaluate(async (value) => {
    await chrome.storage.local.set({ settings: value });
  }, settings);
  console.log("settings written: baseUrl =", settings.baseUrl);

  // Probe through the extension page itself, so this proves the very same
  // origin + bearer token the popup and content script will use.
  const probe = await optionsPage.evaluate(async (value) => {
    const response = await fetch(value.baseUrl + "/api/health", {
      headers: { Authorization: "Bearer " + value.token },
    });
    return { status: response.status, body: await response.json() };
  }, settings);

  console.log("health status =", probe.status);
  console.log("health body =", JSON.stringify({
    ok: probe.body.ok,
    github: probe.body.github,
    githubUser: probe.body.githubUser,
    llm: probe.body.llm,
    feishu: probe.body.feishu,
    feishuUser: probe.body.feishuUser,
    feishuMissingScopes: probe.body.feishuMissingScopes,
  }));

  const subs = await optionsPage.evaluate(async (value) => {
    const response = await fetch(value.baseUrl + "/api/subscriptions", {
      headers: { Authorization: "Bearer " + value.token },
    });
    return response.json();
  }, settings);
  console.log("subscriptions =", JSON.stringify(subs.subscriptions.map((s) => ({
    login: s.login,
    alias: s.alias,
    enabled: s.enabled,
    syncedRepos: s.syncedRepos,
  }))));

  const shotPath = path.resolve(__dirname, "data", "_options-preview.png");
  await optionsPage.setViewportSize({ width: 720, height: 1400 });
  await optionsPage.screenshot({ path: shotPath, fullPage: true });
  console.log("screenshot =", shotPath);

  // The extension UI must render without surfacing a transport error. Before the
  // fetch binding fix this page showed "Illegal invocation" from ApiClient.
  const dom = await optionsPage.evaluate(() => {
    const text = document.body.innerText;
    return {
      hasIllegalInvocation: text.includes("Illegal invocation"),
      errorLines: text
        .split("\n")
        .filter((line) => /失败|错误|无法连接|Failed/.test(line))
        .slice(0, 6),
      length: text.length,
    };
  });
  console.log("dom hasIllegalInvocation =", dom.hasIllegalInvocation);
  console.log("dom error lines =", JSON.stringify(dom.errorLines));
  console.log("dom text length =", dom.length);

  const popupPage = await context.newPage();
  await popupPage.goto("chrome-extension://" + extensionId + "/popup.html");
  await popupPage.setViewportSize({ width: 420, height: 760 });
  await popupPage.waitForTimeout(2500);
  const popupShot = path.resolve(__dirname, "data", "_popup-preview.png");
  await popupPage.screenshot({ path: popupShot });
  const popupDom = await popupPage.evaluate(() => {
    const text = document.body.innerText;
    return {
      hasIllegalInvocation: text.includes("Illegal invocation"),
      errorLines: text
        .split("\n")
        .filter((line) => /失败|错误|无法连接|Failed/.test(line))
        .slice(0, 6),
      mentionsKarpathy: text.includes("karpathy"),
      length: text.length,
    };
  });
  console.log("popup screenshot =", popupShot);
  console.log("popup hasIllegalInvocation =", popupDom.hasIllegalInvocation);
  console.log("popup error lines =", JSON.stringify(popupDom.errorLines));
  console.log("popup mentions karpathy =", popupDom.mentionsKarpathy);
  console.log("popup text length =", popupDom.length);

  // Clicking a subscription must land on the extension's own categorized page,
  // not on github.com. Assert the link target first, then render the page.
  const popupLink = await popupPage.evaluate(() => {
    const button = Array.from(document.querySelectorAll("button.link")).find((node) =>
      node.textContent.includes("karpathy")
    );
    const anchor = Array.from(document.querySelectorAll("a")).find((node) =>
      node.href.includes("github.com")
    );
    return {
      buttonText: button ? button.textContent.trim() : null,
      githubAnchor: anchor ? anchor.href : null,
    };
  });
  console.log("popup account button =", JSON.stringify(popupLink));

  // The button must actually open the extension's own page: an href would keep
  // sending readers to github.com, which is the behaviour being replaced.
  const accountTab = await Promise.all([
    context.waitForEvent("page", { timeout: 15000 }),
    popupPage.evaluate(() => {
      const button = Array.from(document.querySelectorAll("button.link")).find((node) =>
        node.textContent.includes("karpathy")
      );
      button.click();
    }),
  ]).then(([page]) => page);
  await accountTab.waitForLoadState("domcontentloaded");
  await accountTab.waitForTimeout(3000);
  console.log("popup account click url =", accountTab.url());
  const accountDom = await accountTab.evaluate(() => ({
    headline: document.body.innerText.split("\n")[0],
    rows: document.querySelectorAll("tbody tr").length,
  }));
  console.log("popup account click headline =", JSON.stringify(accountDom.headline));
  console.log("popup account click rows =", accountDom.rows);
  await accountTab.close();

  const starsPage = await context.newPage();
  await starsPage.goto("chrome-extension://" + extensionId + "/stars.html?login=karpathy");
  await starsPage.setViewportSize({ width: 1280, height: 1000 });
  await starsPage.waitForTimeout(3000);
  const starsShot = path.resolve(__dirname, "data", "_stars-preview.png");
  await starsPage.screenshot({ path: starsShot, fullPage: false });
  const starsDom = await starsPage.evaluate(() => {
    const text = document.body.innerText;
    return {
      hasIllegalInvocation: text.includes("Illegal invocation"),
      errorLines: text
        .split("\n")
        .filter((line) => /失败|错误|无法连接|Failed/.test(line))
        .slice(0, 6),
      headline: text.split("\n").slice(0, 3),
      hasMoneyBoard: text.includes("变现机会榜"),
      hasShared: text.includes("多位关注对象共同收藏"),
      categoryHeadings: Array.from(document.querySelectorAll("h2"))
        .map((node) => node.textContent.trim())
        .filter((value) => value.includes("（"))
        .slice(0, 8),
      repoLinks: Array.from(document.querySelectorAll("table a"))
        .map((node) => node.getAttribute("href"))
        .filter((href) => href && href.startsWith("https://github.com/")).length,
      rowCount: document.querySelectorAll("tbody tr").length,
      length: text.length,
    };
  });
  console.log("stars screenshot =", starsShot);
  console.log("stars hasIllegalInvocation =", starsDom.hasIllegalInvocation);
  console.log("stars error lines =", JSON.stringify(starsDom.errorLines));
  console.log("stars headline =", JSON.stringify(starsDom.headline));
  console.log("stars hasMoneyBoard =", starsDom.hasMoneyBoard);
  console.log("stars hasShared =", starsDom.hasShared);
  console.log("stars category headings =", JSON.stringify(starsDom.categoryHeadings));
  console.log("stars repo links =", starsDom.repoLinks, "rows =", starsDom.rowCount);
  console.log("stars text length =", starsDom.length);

  // The search box filters both the ranking and the per-category tables.
  await starsPage.fill("input[type=text]", "agent");
  await starsPage.waitForTimeout(600);
  const searchDom = await starsPage.evaluate(() => ({
    rows: document.querySelectorAll("tbody tr").length,
    hasHitLine: document.body.innerText.includes("命中"),
  }));
  console.log("stars search rows =", searchDom.rows, "hasHitLine =", searchDom.hasHitLine);

  // antfu carries ~1750 repos, so this is the case that proves the page still
  // renders when a subscription is an order of magnitude bigger than karpathy.
  const bigPage = await context.newPage();
  await bigPage.goto("chrome-extension://" + extensionId + "/stars.html?login=antfu");
  await bigPage.setViewportSize({ width: 1280, height: 1000 });
  await bigPage.waitForTimeout(4000);
  const bigShot = path.resolve(__dirname, "data", "_stars-antfu-preview.png");
  await bigPage.screenshot({ path: bigShot, fullPage: false });
  const bigDom = await bigPage.evaluate(() => {
    const text = document.body.innerText;
    return {
      headline: text.split("\n")[0],
      // Match the empty-state / banner copy only; repo summaries legitimately
      // contain the word "错误" when a tool fixes mistakes in text.
      errorLines: text
        .split("\n")
        .filter((line) => /读取失败|无法连接|Illegal invocation|Failed to fetch/.test(line))
        .slice(0, 6),
      hasUnclassifiedWarning: text.includes("尚未按当前分类体系重新归类"),
      categoryCount: Array.from(document.querySelectorAll("h2")).filter((node) =>
        node.textContent.includes("（")
      ).length,
      expandButtons: Array.from(document.querySelectorAll("button")).filter((node) =>
        node.textContent.startsWith("展开其余")
      ).length,
      rows: document.querySelectorAll("tbody tr").length,
    };
  });
  console.log("antfu screenshot =", bigShot);
  console.log("antfu headline =", JSON.stringify(bigDom.headline));
  console.log("antfu error lines =", JSON.stringify(bigDom.errorLines));
  console.log("antfu hasUnclassifiedWarning =", bigDom.hasUnclassifiedWarning);
  console.log("antfu category sections =", bigDom.categoryCount);
  console.log("antfu expand buttons =", bigDom.expandButtons);
  console.log("antfu collapsed rows =", bigDom.rows);
  await bigPage.close();

  // The roster page is the entry point for "organize somebody else's stars":
  // it is served from the checked-in list, so it must render even for accounts
  // that were never subscribed, and its buttons must stay inside the extension.
  const rosterPage = await context.newPage();
  await rosterPage.goto("chrome-extension://" + extensionId + "/roster.html");
  await rosterPage.setViewportSize({ width: 1280, height: 1000 });
  await rosterPage.waitForTimeout(3500);
  const rosterShot = path.resolve(__dirname, "data", "_roster-preview.png");
  await rosterPage.screenshot({ path: rosterShot, fullPage: false });
  const rosterDom = await rosterPage.evaluate(() => {
    const text = document.body.innerText;
    return {
      headline: text.split("\n")[0],
      errorLines: text
        .split("\n")
        .filter((line) => /读取失败|无法连接|Illegal invocation|Failed to fetch|Not Found/.test(line))
        .slice(0, 6),
      summary: text.split("\n").find((line) => line.startsWith("共 ")) ?? null,
      cards: document.querySelectorAll(".card").length,
      arrangeButtons: Array.from(document.querySelectorAll("button")).filter((node) =>
        /一键整理|重新整理/.test(node.textContent)
      ).length,
      badges: Array.from(document.querySelectorAll(".badge.accent")).map((node) =>
        node.textContent.trim()
      ).slice(0, 4),
      length: text.length,
    };
  });
  console.log("roster screenshot =", rosterShot);
  console.log("roster headline =", JSON.stringify(rosterDom.headline));
  console.log("roster error lines =", JSON.stringify(rosterDom.errorLines));
  console.log("roster summary =", JSON.stringify(rosterDom.summary));
  console.log("roster cards =", rosterDom.cards, "arrange buttons =", rosterDom.arrangeButtons);
  console.log("roster tags =", JSON.stringify(rosterDom.badges));
  console.log("roster text length =", rosterDom.length);

  // The search box has to narrow the grid, otherwise 28 cards cannot be scanned.
  await rosterPage.fill("input[type=text]", "karpathy");
  await rosterPage.waitForTimeout(500);
  const rosterSearch = await rosterPage.evaluate(() => ({
    cards: document.querySelectorAll(".card").length,
    hasKarpathy: document.body.innerText.includes("@karpathy"),
  }));
  console.log("roster search cards =", rosterSearch.cards, "hasKarpathy =", rosterSearch.hasKarpathy);

  // "查看分类列表" must open the extension's own page for that author.
  const rosterLinkTab = await Promise.all([
    context.waitForEvent("page", { timeout: 15000 }),
    rosterPage.evaluate(() => {
      const button = Array.from(document.querySelectorAll("button")).find((node) =>
        node.textContent.includes("查看分类列表")
      );
      button.click();
    }),
  ]).then(([page]) => page);
  await rosterLinkTab.waitForLoadState("domcontentloaded");
  await rosterLinkTab.waitForTimeout(3000);
  console.log("roster view-list url =", rosterLinkTab.url());
  const rosterLinkDom = await rosterLinkTab.evaluate(() => ({
    headline: document.body.innerText.split("\n")[0],
    hasMoneyBoard: document.body.innerText.includes("变现机会榜"),
  }));
  console.log("roster view-list headline =", JSON.stringify(rosterLinkDom.headline));
  console.log("roster view-list hasMoneyBoard =", rosterLinkDom.hasMoneyBoard);
  await rosterLinkTab.close();

  // An account with no local data must offer "一键整理" instead of an error.
  const emptyStars = await context.newPage();
  await emptyStars.goto(
    "chrome-extension://" + extensionId + "/stars.html?login=yyx990803"
  );
  await emptyStars.waitForTimeout(3000);
  const emptyDom = await emptyStars.evaluate(() => {
    const text = document.body.innerText;
    return {
      headline: text.split("\n")[0],
      hasArrange: text.includes("一键整理"),
      hasError: /读取失败|Not Found|失败/.test(text),
      length: text.length,
    };
  });
  console.log("empty author headline =", JSON.stringify(emptyDom.headline));
  console.log("empty author hasArrange =", emptyDom.hasArrange, "hasError =", emptyDom.hasError);
  await emptyStars.close();
  await rosterPage.close();

  const notSynced = await starsPage.evaluate(async (value) => {
    const response = await fetch(value.baseUrl + "/api/authors/ghost-nobody/stars", {
      headers: { Authorization: "Bearer " + value.token },
    });
    return { status: response.status, body: await response.json() };
  }, settings);
  console.log("unknown author status =", notSynced.status);
  console.log("unknown author body =", JSON.stringify(notSynced.body));

  await new Promise(() => {});
}

main().catch((error) => {
  console.error("failed:", error);
  process.exit(1);
});
