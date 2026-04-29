/**
 * BCB Strategy Bot — Full BlockchainBacker Framework
 * Based on 99-video analysis of BlockchainBacker's macro cycle model
 *
 * Phases: Capitulation → Accumulation → Markup → Distribution
 * Entry: Tranches (25% capitulation + 25% spring + 1-2% daily DCA)
 * Exit: Distribution signal scoring (reduce at 3+, aggressive at 5+)
 * Coins: XRPUSDT ($8–$10 target) + ETHUSDT ($5k–$8k target)
 *
 * Every automatable BCB signal is implemented. See strategy doc for full list.
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";

// ─── Constants ────────────────────────────────────────────────────────────────

const NTFY_CHANNEL   = process.env.NTFY_CHANNEL || "xrp-bot-dhruvjyot";
const SHEET_URL      = process.env.GOOGLE_SHEET_URL ||
  "https://script.google.com/macros/s/AKfycbzWdRn61TrnC0M0z91wgcMnIOJ6cjhYti21xdEnyNVFV5335qtisHk-nT46ugpIAmSW/exec";
const INR_RATE             = 83.5;
const DOMINANCE_FILE       = "dominance-history.json";
const ALTCOIN_MCAP_2021_ATH = 1_850_000_000_000; // ~$1.85T — breaking = parabola phase
const PAPER_TRADING        = process.env.PAPER_TRADING !== "false";

// Known meme coin symbols/name fragments (for frenzy detection)
const MEME_COIN_TERMS = [
  "doge","shib","pepe","wif","bonk","floki","meme","brett","popcat",
  "neiro","turbo","bome","mog","myro","wen","slerf","cat","dog","babydoge",
  "wojak","cope","chad","moon","safe","inu","elon","cumrocket","sponge",
];

// ─── Coin Config ──────────────────────────────────────────────────────────────

const COINS = [
  {
    symbol: "XRPUSDT", displayName: "XRP",
    portfolioUSD: parseFloat(process.env.XRP_PORTFOLIO_USD || "60"),
    dailyDCAPct:  parseFloat(process.env.DAILY_DCA_PCT     || "1.5"),
    maxPositionPct: parseFloat(process.env.MAX_POSITION_PCT || "50"),
    targetLow: 8.0, targetHigh: 10.0,
    cmAsset: "xrp",
    dcaFile: "dca-state-XRPUSDT.json",
  },
  {
    symbol: "ETHUSDT", displayName: "ETH",
    portfolioUSD: parseFloat(process.env.ETH_PORTFOLIO_USD || "60"),
    dailyDCAPct:  parseFloat(process.env.DAILY_DCA_PCT     || "1.5"),
    maxPositionPct: parseFloat(process.env.MAX_POSITION_PCT || "50"),
    targetLow: 5000, targetHigh: 8000,
    cmAsset: "eth",
    dcaFile: "dca-state-ETHUSDT.json",
  },
];

// ─── Notifications ────────────────────────────────────────────────────────────

async function notify(title, message, priority = "default") {
  try {
    await fetch(`https://ntfy.sh/${NTFY_CHANNEL}`, {
      method: "POST",
      headers: { Title: title, Priority: priority, Tags: "chart_increasing" },
      body: message,
    });
  } catch {}
}

async function logToSheet(data) {
  try {
    await fetch(SHEET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    console.log("  📊 Logged to Google Sheet");
  } catch {}
}

// ─── External Data Sources ────────────────────────────────────────────────────

// Yahoo Finance — stocks, VIX, treasury yields, copper
async function fetchYahooFinance(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=90d`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data.chart?.result?.[0];
    if (!result) return null;
    const closes = result.indicators.quote[0].close.filter((v) => v !== null);
    if (closes.length === 0) return null;
    const current    = closes[closes.length - 1];
    const high90d    = Math.max(...closes);
    const low90d     = Math.min(...closes);
    const sma20      = closes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, closes.length);
    const pctFromHigh = ((current - high90d) / high90d) * 100;
    const aboveSMA20 = current > sma20;
    return { current, high90d, low90d, sma20, pctFromHigh, aboveSMA20, closes };
  } catch { return null; }
}

// Alternative.me — Crypto Fear & Greed Index
async function fetchFearGreed() {
  try {
    const res  = await fetch("https://api.alternative.me/fng/?limit=1");
    const data = await res.json();
    return { value: parseInt(data.data[0].value), label: data.data[0].value_classification };
  } catch { return null; }
}

// CoinMetrics community API — Realized Price (free, no key needed)
// Realized Price = Realized Cap / Circulating Supply
// If current price < realized price → most holders at a loss (BCB capitulation signal)
async function fetchRealizedPrice(asset) {
  try {
    const url = `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics` +
      `?assets=${asset}&metrics=SplyCur,CapRealUSD&frequency=1d&limit_per_page=2&sort=time`;
    const res  = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const data = await res.json();
    const row  = data.data?.[data.data.length - 1];
    if (!row?.CapRealUSD || !row?.SplyCur) return null;
    return parseFloat(row.CapRealUSD) / parseFloat(row.SplyCur);
  } catch { return null; }
}

// CoinGecko trending — detect meme coin frenzy (BCB's #1 cycle top signal)
async function fetchMemeCoinFrenzy() {
  try {
    const res  = await fetch("https://api.coingecko.com/api/v3/search/trending");
    const data = await res.json();
    const trending = data.coins || [];
    const memeCount = trending.filter((c) => {
      const sym  = (c.item?.symbol || "").toLowerCase();
      const name = (c.item?.name   || "").toLowerCase();
      return MEME_COIN_TERMS.some((m) => sym.includes(m) || name.includes(m));
    }).length;
    return {
      memeCount,
      total:    trending.length,
      isFrenzy: memeCount >= 3,
      coins:    trending.map((c) => c.item?.symbol).join(", "),
    };
  } catch { return null; }
}

// Google Trends RSS — detect crypto going mainstream (distribution/euphoria signal)
async function fetchGoogleTrends() {
  try {
    const res = await fetch(
      "https://trends.google.com/trends/trendingsearches/daily/rss?geo=US",
      { headers: { "User-Agent": "Mozilla/5.0" } }
    );
    const xml = await res.text();
    const CRYPTO_TERMS = ["bitcoin","crypto","xrp","ethereum","ripple","btc","eth","blockchain","coinbase","binance","altcoin"];
    const titles = [...xml.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>/gi)].map((m) => m[1].toLowerCase());
    const hits  = titles.filter((t) => CRYPTO_TERMS.some((term) => t.includes(term)));
    return { cryptoTrending: hits.length, terms: hits.slice(0, 3).join(" | "), isMainstream: hits.length >= 2 };
  } catch { return null; }
}

// ─── Market Data ──────────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval, limit = 120) {
  const map = { "1m":"1m","5m":"5m","15m":"15m","1H":"1h","4H":"4h","1D":"1d","1W":"1w","1M":"1M" };
  const i   = map[interval] || interval;
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${i}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${interval} error: ${res.status}`);
  const data = await res.json();
  return data.map((k) => ({
    time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
    low:  parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
  }));
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcSMA(closes, period) {
  if (closes.length < period) return null;
  return closes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcStochRSI(closes, rsiPeriod = 14, stochPeriod = 14) {
  if (closes.length < rsiPeriod + stochPeriod + 1) return null;
  const rsiSeries = [];
  for (let i = rsiPeriod; i < closes.length; i++) {
    const r = calcRSI(closes.slice(i - rsiPeriod, i + 1), rsiPeriod);
    if (r !== null) rsiSeries.push(r);
  }
  if (rsiSeries.length < stochPeriod) return null;
  const win     = rsiSeries.slice(-stochPeriod);
  const current = win[win.length - 1];
  const lowest  = Math.min(...win), highest = Math.max(...win);
  if (highest === lowest) return current > 50 ? 100 : 0;
  return ((current - lowest) / (highest - lowest)) * 100;
}

function detectBearishDivergence(weeklyCandles, weeklyCloses) {
  if (weeklyCandles.length < 10) return false;
  const recentCloses = weeklyCloses.slice(-10);
  const priceHighIdx = recentCloses.indexOf(Math.max(...recentCloses));
  const prevHigh = Math.max(...recentCloses.slice(0, priceHighIdx));
  if (recentCloses[priceHighIdx] <= prevHigh) return false;
  const rsiNow  = calcRSI(recentCloses, Math.min(5, recentCloses.length - 1));
  const rsiPrev = calcRSI(recentCloses.slice(0, -3), Math.min(5, recentCloses.length - 4));
  if (rsiNow === null || rsiPrev === null) return false;
  return rsiNow < rsiPrev * 0.95;
}

function detectCapitulationCandle(candles) {
  if (candles.length < 5) return false;
  const avgVol = candles.slice(-20).reduce((s, c) => s + c.volume, 0) / Math.min(20, candles.length);
  return candles.slice(-3).some((c) => {
    const body = Math.abs(c.close - c.open), range = c.high - c.low;
    return c.volume > avgVol * 2.5 && range > 0 && body / range > 0.5;
  });
}

function detectSpring(dailyCandles) {
  if (dailyCandles.length < 35) return false;
  const priorLow = Math.min(...dailyCandles.slice(-35, -5).map((c) => c.low));
  return dailyCandles.slice(-5).some((c) => c.low < priorLow * 0.995 && c.close > priorLow);
}

function detectParabola(dailyCandles) {
  if (dailyCandles.length < 11) return false;
  const tenDaysAgo = dailyCandles[dailyCandles.length - 11].close;
  const current    = dailyCandles[dailyCandles.length - 1].close;
  return (current - tenDaysAgo) / tenDaysAgo * 100 > 100;
}

function detectWyckoffPhase(weeklyCandles) {
  if (weeklyCandles.length < 20) return "UNKNOWN";
  const closes = weeklyCandles.map((c) => c.close);
  const current = closes[closes.length - 1];
  const low52w  = Math.min(...closes.slice(-52));
  const high52w = Math.max(...closes.slice(-52));
  const pos = (current - low52w) / (high52w - low52w);
  if (pos < 0.2) return "SPRING / ACCUMULATION LOW";
  if (pos < 0.4) return "PHASE B (base building)";
  if (pos < 0.6) return "SIGN OF STRENGTH";
  if (pos < 0.8) return "MARKUP PHASE";
  return "DISTRIBUTION ZONE";
}

// ─── BTC Dominance History ─────────────────────────────────────────────────────

function loadDominanceHistory() {
  if (!existsSync(DOMINANCE_FILE)) return [];
  try { return JSON.parse(readFileSync(DOMINANCE_FILE, "utf8")); } catch { return []; }
}

function updateDominanceHistory(dominance) {
  const history = loadDominanceHistory();
  const today   = new Date().toISOString().slice(0, 10);
  if (history.length === 0 || history[history.length - 1].date !== today) {
    history.push({ date: today, dominance });
    if (history.length > 200) history.shift();
    writeFileSync(DOMINANCE_FILE, JSON.stringify(history, null, 2));
  }
  return history;
}

function calcDominanceRSI(history) {
  // Downsample daily → weekly, need 15+ weeks
  const weekly = history.filter((_, i) => i % 7 === 0).map((d) => d.dominance);
  if (weekly.length < 15) return null;
  return calcRSI(weekly, 14);
}

function isDominanceDeclining(history) {
  if (history.length < 14) return null;
  const recent = history.slice(-7).reduce((a, b) => a + b.dominance, 0) / 7;
  const prior  = history.slice(-14, -7).reduce((a, b) => a + b.dominance, 0) / 7;
  return recent < prior;
}

// ─── BTC + Macro Data (fetched ONCE per cycle, shared across all coins) ────────

async function fetchBTCMacroData() {
  console.log("\n── Fetching market data ─────────────────────────────────\n");

  const [
    btcWeekly, btcMonthly, btcDaily,
    russell2000, dowJones, sp500, nasdaq, vix, igv,
    treasury10y, copper,
    fearGreed, memeFrenzy, googleTrends,
    btcRealizedPrice,
  ] = await Promise.all([
    fetchCandles("BTCUSDT", "1W", 220),
    fetchCandles("BTCUSDT", "1M", 60),
    fetchCandles("BTCUSDT", "1D", 90),
    fetchYahooFinance("IWM"),       // Russell 2000
    fetchYahooFinance("%5EDJI"),    // Dow Jones
    fetchYahooFinance("SPY"),       // S&P 500
    fetchYahooFinance("QQQ"),       // Nasdaq 100
    fetchYahooFinance("%5EVIX"),    // VIX
    fetchYahooFinance("IGV"),       // Software ETF (BCB's macro trigger)
    fetchYahooFinance("%5ETNX"),    // 10-year Treasury yield
    fetchYahooFinance("HG%3DF"),    // Copper futures (macro stress)
    fetchFearGreed(),
    fetchMemeCoinFrenzy(),
    fetchGoogleTrends(),
    fetchRealizedPrice("btc"),
  ]);

  // ── BTC Weekly ───────────────────────────────────────────────────────────────
  const btcWeeklyCloses = btcWeekly.map((c) => c.close);
  const btcPrice        = btcWeeklyCloses[btcWeeklyCloses.length - 1];
  const weeklyRSI       = calcRSI(btcWeeklyCloses, 14);
  const ma100w          = calcSMA(btcWeeklyCloses, 100);
  const ema200w         = calcEMA(btcWeeklyCloses, 200);
  const weeklyEMA12     = calcEMA(btcWeeklyCloses, 12);
  const weeklyEMA26     = calcEMA(btcWeeklyCloses, 26);
  const weeklyMACD      = weeklyEMA12 !== null && weeklyEMA26 !== null ? weeklyEMA12 - weeklyEMA26 : null;
  const btcVsMA100      = ma100w  ? ((btcPrice - ma100w)  / ma100w)  * 100 : null;
  const btcVsEMA200     = ema200w ? ((btcPrice - ema200w) / ema200w) * 100 : null;
  const bearishDivergence       = detectBearishDivergence(btcWeekly, btcWeeklyCloses);
  const weeklyCapitulationCandle = detectCapitulationCandle(btcWeekly.slice(-22));

  // ── BTC Monthly ──────────────────────────────────────────────────────────────
  const btcMonthlyCloses = btcMonthly.map((c) => c.close);
  const monthlyRSI       = calcRSI(btcMonthlyCloses, 14);
  const monthlyStochRSI  = calcStochRSI(btcMonthlyCloses, 14, 14);
  const monthlyEMA12     = calcEMA(btcMonthlyCloses, 12);
  const monthlyEMA26     = calcEMA(btcMonthlyCloses, 26);
  const monthlyMACD      = monthlyEMA12 !== null && monthlyEMA26 !== null ? monthlyEMA12 - monthlyEMA26 : null;

  // ── BTC Daily ─────────────────────────────────────────────────────────────
  const springDetected        = detectSpring(btcDaily);
  const dailyCapitulationCandle = detectCapitulationCandle(btcDaily.slice(-22));

  // Realized price proximity
  const btcVsRealized = btcRealizedPrice ? ((btcPrice - btcRealizedPrice) / btcRealizedPrice) * 100 : null;

  // ── Dominance + Altcoin Market Cap ─────────────────────────────────────────
  let btcDominance     = null;
  let altcoinMarketCap = null;
  let dominanceRSI     = null;
  let dominanceDeclining = null;
  try {
    const gData     = await fetch("https://api.coingecko.com/api/v3/global").then((r) => r.json());
    btcDominance    = gData.data?.market_cap_percentage?.btc || null;
    const totalMcap = gData.data?.total_market_cap?.usd      || null;
    if (totalMcap && btcDominance) altcoinMarketCap = totalMcap * (1 - btcDominance / 100);
    if (btcDominance) {
      const domHistory  = updateDominanceHistory(btcDominance);
      dominanceRSI      = calcDominanceRSI(domHistory);
      dominanceDeclining = isDominanceDeclining(domHistory);
    }
  } catch {}

  // ── Treasury yield trend (declining = bullish for risk assets) ─────────────
  let treasuryDeclining = null;
  if (treasury10y && treasury10y.closes.length >= 20) {
    const recent = treasury10y.closes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const prior  = treasury10y.closes.slice(-20, -5).reduce((a, b) => a + b, 0) / 15;
    treasuryDeclining = recent < prior;
  }

  // ── Copper volatility (extreme swing = macro stress) ───────────────────────
  const copperStress = copper && copper.pctFromHigh < -10;

  return {
    // BTC indicators
    btcPrice, weeklyRSI, ma100w, ema200w, weeklyMACD,
    btcVsMA100, btcVsEMA200, bearishDivergence, weeklyCapitulationCandle,
    monthlyRSI, monthlyStochRSI, monthlyMACD,
    springDetected, dailyCapitulationCandle,
    btcRealizedPrice, btcVsRealized,
    // Dominance
    btcDominance, dominanceRSI, dominanceDeclining, altcoinMarketCap,
    // Stocks
    russell2000, dowJones, sp500, nasdaq, vix, igv,
    // Macro
    treasury10y, treasuryDeclining, copper, copperStress,
    // Sentiment
    fearGreed, memeFrenzy, googleTrends,
  };
}

// ─── Per-Coin Phase Detection ─────────────────────────────────────────────────

async function detectCoinPhase(btc, coin) {
  const [coinWeekly, coinDaily, coinRealizedPrice] = await Promise.all([
    fetchCandles(coin.symbol, "1W", 60),
    fetchCandles(coin.symbol, "1D", 40),
    fetchRealizedPrice(coin.cmAsset),
  ]);

  const coinWeeklyCloses = coinWeekly.map((c) => c.close);
  const coinPrice        = coinWeeklyCloses[coinWeeklyCloses.length - 1];
  const coinWeeklyRSI    = calcRSI(coinWeeklyCloses, 14);
  const coinWyckoff      = detectWyckoffPhase(coinWeekly);
  const coinParabola     = detectParabola(coinDaily);
  const coinSpring       = detectSpring(coinDaily);
  const coinVsRealized   = coinRealizedPrice
    ? ((coinPrice - coinRealizedPrice) / coinRealizedPrice) * 100 : null;

  // ════════════════════════════════════════════════════════════════════════════
  // ACCUMULATION SCORE  (bottom zone — BUY signals)
  // ════════════════════════════════════════════════════════════════════════════
  const accumSignals = [];
  let accumScore = 0;

  // 1. BTC Weekly RSI
  if (btc.weeklyRSI !== null && btc.weeklyRSI < 30) {
    accumSignals.push({ signal: "BTC Weekly RSI below 30 — capitulation zone (marked bottom in every cycle)", score: 2 });
    accumScore += 2;
  } else if (btc.weeklyRSI !== null && btc.weeklyRSI < 40) {
    accumSignals.push({ signal: `BTC Weekly RSI ${btc.weeklyRSI.toFixed(1)} — recovery zone`, score: 1 });
    accumScore += 1;
  }

  // 2. Monthly StochRSI
  if (btc.monthlyStochRSI !== null && btc.monthlyStochRSI < 5) {
    accumSignals.push({ signal: `Monthly StochRSI ${btc.monthlyStochRSI.toFixed(1)} — extreme low (BCB: hits 0 at every bottom)`, score: 2 });
    accumScore += 2;
  } else if (btc.monthlyStochRSI !== null && btc.monthlyStochRSI < 20) {
    accumSignals.push({ signal: `Monthly StochRSI ${btc.monthlyStochRSI.toFixed(1)} — oversold`, score: 1 });
    accumScore += 1;
  }

  // 3. Monthly RSI extreme low
  if (btc.monthlyRSI !== null && btc.monthlyRSI < 35) {
    accumSignals.push({ signal: `Monthly RSI ${btc.monthlyRSI.toFixed(1)} — historically oversold`, score: 1 });
    accumScore += 1;
  }

  // 4. Capitulation candles
  if (btc.dailyCapitulationCandle) {
    accumSignals.push({ signal: "Daily capitulation candle — massive volume reversal (BCB's most important signal)", score: 2 });
    accumScore += 2;
  }
  if (btc.weeklyCapitulationCandle) {
    accumSignals.push({ signal: "Weekly capitulation candle detected", score: 1 });
    accumScore += 1;
  }

  // 5. BTC near 100W MA
  if (btc.btcVsMA100 !== null && Math.abs(btc.btcVsMA100) < 10) {
    accumSignals.push({ signal: `BTC within 10% of 100W MA ($${btc.ma100w.toFixed(0)}) — historical buy zone`, score: 1 });
    accumScore += 1;
  }

  // 6. BTC near 200W EMA
  if (btc.btcVsEMA200 !== null && Math.abs(btc.btcVsEMA200) < 15) {
    accumSignals.push({ signal: `BTC within 15% of 200W EMA ($${btc.ema200w.toFixed(0)})`, score: 1 });
    accumScore += 1;
  }

  // 7. Weekly MACD deeply negative
  if (btc.weeklyMACD !== null && btc.weeklyMACD < -2000) {
    accumSignals.push({ signal: `Weekly MACD deeply negative (${btc.weeklyMACD.toFixed(0)}) — extreme pessimism`, score: 1 });
    accumScore += 1;
  }

  // 8. BTC Spring
  if (btc.springDetected) {
    accumSignals.push({ signal: "BTC spring — swept below recent lows then recovered (Wyckoff spring)", score: 2 });
    accumScore += 2;
  }

  // 9. Coin spring
  if (coinSpring) {
    accumSignals.push({ signal: `${coin.displayName} spring — swept lows and recovered`, score: 1 });
    accumScore += 1;
  }

  // 10. VIX spike (every crypto low had one — BCB rule)
  if (btc.vix && btc.vix.current > 30) {
    accumSignals.push({ signal: `VIX ${btc.vix.current.toFixed(1)} — HIGH FEAR (BCB: every crypto low had a VIX spike)`, score: 2 });
    accumScore += 2;
  } else if (btc.vix && btc.vix.current > 20) {
    accumSignals.push({ signal: `VIX ${btc.vix.current.toFixed(1)} — mildly elevated`, score: 0.5 });
    accumScore += 0.5;
  }

  // 11. Fear & Greed extreme fear
  if (btc.fearGreed && btc.fearGreed.value <= 25) {
    accumSignals.push({ signal: `Fear & Greed ${btc.fearGreed.value} (${btc.fearGreed.label}) — extreme fear = buy signal`, score: 1 });
    accumScore += 1;
  }

  // 12. Russell 2000 deep correction = macro stress
  if (btc.russell2000 && btc.russell2000.pctFromHigh < -20) {
    accumSignals.push({ signal: `Russell 2000 ${btc.russell2000.pctFromHigh.toFixed(1)}% from 90d high — macro stress`, score: 0.5 });
    accumScore += 0.5;
  }

  // 13. BTC below realized price → majority of BTC holders at a loss (FREE proxy for Glassnode)
  if (btc.btcVsRealized !== null && btc.btcVsRealized < 0) {
    accumSignals.push({ signal: `BTC ${Math.abs(btc.btcVsRealized).toFixed(1)}% BELOW realized price ($${btc.btcRealizedPrice.toFixed(0)}) — most holders at a loss`, score: 2 });
    accumScore += 2;
  } else if (btc.btcVsRealized !== null && btc.btcVsRealized < 20) {
    accumSignals.push({ signal: `BTC only ${btc.btcVsRealized.toFixed(1)}% above realized price — near breakeven for avg holder`, score: 1 });
    accumScore += 1;
  }

  // 14. Coin below its own realized price
  if (coinVsRealized !== null && coinVsRealized < 0) {
    accumSignals.push({ signal: `${coin.displayName} ${Math.abs(coinVsRealized).toFixed(1)}% below realized price — most ${coin.displayName} holders at a loss`, score: 1 });
    accumScore += 1;
  }

  // 15. Copper stress = macro fear (BCB: extreme volatility = caution/bottom signal)
  if (btc.copperStress) {
    accumSignals.push({ signal: `Copper ${btc.copper.pctFromHigh.toFixed(1)}% from 90d high — macro stress signal`, score: 0.5 });
    accumScore += 0.5;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // DISTRIBUTION SCORE  (top zone — SELL signals)
  // ════════════════════════════════════════════════════════════════════════════
  const distSignals = [];
  let distScore = 0;

  // 1. Weekly RSI bearish divergence
  if (btc.bearishDivergence) {
    distSignals.push({ signal: "Weekly RSI bearish divergence — price higher high, RSI lower high", score: 2 });
    distScore += 2;
  }

  // 2. Weekly RSI > 70
  if (btc.weeklyRSI !== null && btc.weeklyRSI > 70) {
    distSignals.push({ signal: `Weekly RSI ${btc.weeklyRSI.toFixed(1)} — distribution zone`, score: 1 });
    distScore += 1;
  }

  // 3. Weekly MACD crossing red at highs
  if (btc.weeklyMACD !== null && btc.weeklyMACD > 0 && btc.weeklyRSI !== null && btc.weeklyRSI > 65) {
    distSignals.push({ signal: "Weekly MACD positive + RSI high — watch for red cross (BCB's MACD distribution signal)", score: 1 });
    distScore += 1;
  }

  // 4. Monthly MACD + monthly RSI high
  if (btc.monthlyMACD !== null && btc.monthlyMACD > 0 && btc.monthlyRSI !== null && btc.monthlyRSI > 70) {
    distSignals.push({ signal: "Monthly MACD positive + monthly RSI high — cycle top risk", score: 1 });
    distScore += 1;
  }

  // 5. BTC dominance < 40% = altcoin season peak
  if (btc.btcDominance !== null && btc.btcDominance < 40) {
    distSignals.push({ signal: `BTC dominance ${btc.btcDominance.toFixed(1)}% — altcoin season PEAK (BCB: < 40% = near cycle top)`, score: 2 });
    distScore += 2;
  }

  // 6. BTC dominance weekly RSI < 40 (BCB's specific distribution trigger)
  if (btc.dominanceRSI !== null && btc.dominanceRSI < 40) {
    distSignals.push({ signal: `BTC dominance weekly RSI ${btc.dominanceRSI.toFixed(1)} — below 40 (BCB: this is the altcoin season confirmed signal)`, score: 2 });
    distScore += 2;
  }

  // 7. Coin 10-day parabola — BCB's #1 coin cycle top signal
  if (coinParabola) {
    distSignals.push({ signal: `${coin.displayName} 100%+ in 10 days — BCB's #1 cycle top signal. SELL NOW.`, score: 3 });
    distScore += 3;
  }

  // 8. BTC overextended above 100W MA
  if (btc.btcVsMA100 !== null && btc.btcVsMA100 > 80) {
    distSignals.push({ signal: `BTC ${btc.btcVsMA100.toFixed(0)}% above 100W MA — historically overextended (tops at 80-100%)`, score: 1 });
    distScore += 1;
  }

  // 9. Monthly StochRSI > 90
  if (btc.monthlyStochRSI !== null && btc.monthlyStochRSI > 90) {
    distSignals.push({ signal: `Monthly StochRSI ${btc.monthlyStochRSI.toFixed(1)} — extremely overbought`, score: 1 });
    distScore += 1;
  }

  // 10. VIX extremely low = complacency
  if (btc.vix && btc.vix.current < 14) {
    distSignals.push({ signal: `VIX ${btc.vix.current.toFixed(1)} — extreme complacency (market not pricing in risk)`, score: 1 });
    distScore += 1;
  }

  // 11. Fear & Greed extreme greed
  if (btc.fearGreed && btc.fearGreed.value >= 75) {
    distSignals.push({ signal: `Fear & Greed ${btc.fearGreed.value} (${btc.fearGreed.label}) — extreme greed = sell signal`, score: 1 });
    distScore += 1;
  }

  // 12. IGV distributing
  if (btc.igv && btc.igv.pctFromHigh < -15 && !btc.igv.aboveSMA20) {
    distSignals.push({ signal: `IGV ETF ${btc.igv.pctFromHigh.toFixed(1)}% from high, below 20d MA — software sector weakening`, score: 1 });
    distScore += 1;
  }

  // 13. Meme coin frenzy — BCB's #1 signal cycle is over
  if (btc.memeFrenzy?.isFrenzy) {
    distSignals.push({ signal: `🚨 MEME COIN FRENZY — ${btc.memeFrenzy.memeCount}/${btc.memeFrenzy.total} trending coins are memes (${btc.memeFrenzy.coins}) — BCB: CYCLE IS OVER`, score: 3 });
    distScore += 3;
  } else if (btc.memeFrenzy && btc.memeFrenzy.memeCount >= 2) {
    distSignals.push({ signal: `${btc.memeFrenzy.memeCount} meme coins in top trending — frenzy building`, score: 1 });
    distScore += 1;
  }

  // 14. Crypto going mainstream on Google Trends = euphoria signal
  if (btc.googleTrends?.isMainstream) {
    distSignals.push({ signal: `Crypto trending on Google (${btc.googleTrends.terms}) — mainstream euphoria signal`, score: 1 });
    distScore += 1;
  }

  // 15. BTC far above realized price = euphoria (NUPL proxy)
  if (btc.btcVsRealized !== null && btc.btcVsRealized > 100) {
    distSignals.push({ signal: `BTC ${btc.btcVsRealized.toFixed(0)}% above realized price — extreme unrealized profit (euphoria zone)`, score: 1 });
    distScore += 1;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // BULL RUN CONFIRMATION  (hold / add signals)
  // ════════════════════════════════════════════════════════════════════════════
  const bullSignals = [];

  // Dominance declining = altcoin rotation underway
  if (btc.dominanceDeclining === true) {
    bullSignals.push("BTC dominance declining — altcoin rotation underway (BCB: dom falling = alts about to run)");
  }
  if (btc.dominanceRSI !== null && btc.dominanceRSI < 50) {
    bullSignals.push(`BTC dominance weekly RSI ${btc.dominanceRSI.toFixed(1)} — below 50, altcoin season building`);
  }
  if (btc.btcDominance !== null && btc.btcDominance < 50 && btc.btcDominance > 40) {
    bullSignals.push(`BTC dominance ${btc.btcDominance.toFixed(1)}% (40-50%) — altcoin season building`);
  }
  if (btc.weeklyMACD !== null && btc.weeklyMACD > 0 && btc.weeklyRSI !== null && btc.weeklyRSI < 65) {
    bullSignals.push("Weekly MACD positive + RSI not overbought — healthy markup");
  }
  if (btc.btcVsMA100 !== null && btc.btcVsMA100 > 10 && btc.btcVsMA100 < 50) {
    bullSignals.push(`BTC ${btc.btcVsMA100.toFixed(0)}% above 100W MA — normal markup territory`);
  }
  // Russell 2000 — BCB's #1 crypto bull trigger
  if (btc.russell2000 && btc.russell2000.pctFromHigh > -5 && btc.russell2000.aboveSMA20) {
    bullSignals.push(`🔑 Russell 2000 near ATH (${btc.russell2000.pctFromHigh.toFixed(1)}% from 90d high) — BCB's #1 crypto bull trigger`);
  }
  // Dow Jones ATH
  if (btc.dowJones && btc.dowJones.pctFromHigh > -3 && btc.dowJones.aboveSMA20) {
    bullSignals.push(`Dow Jones near ATH (${btc.dowJones.pctFromHigh.toFixed(1)}%) — macro bullish`);
  }
  // S&P 500 ATH
  if (btc.sp500 && btc.sp500.pctFromHigh > -3 && btc.sp500.aboveSMA20) {
    bullSignals.push(`S&P 500 near ATH (${btc.sp500.pctFromHigh.toFixed(1)}%) — macro bullish`);
  }
  // Nasdaq ATH
  if (btc.nasdaq && btc.nasdaq.pctFromHigh > -3 && btc.nasdaq.aboveSMA20) {
    bullSignals.push(`Nasdaq near ATH (${btc.nasdaq.pctFromHigh.toFixed(1)}%) — tech/risk-on bullish`);
  }
  // IGV breaking out — BCB's direct BTC correlation signal
  if (btc.igv && btc.igv.pctFromHigh > -5 && btc.igv.aboveSMA20) {
    bullSignals.push(`IGV software ETF near ATH (${btc.igv.pctFromHigh.toFixed(1)}%) — BCB: BTC follows IGV with near precision`);
  }
  // Altcoin market cap vs 2021 ATH — parabola trigger
  if (btc.altcoinMarketCap) {
    if (btc.altcoinMarketCap > ALTCOIN_MCAP_2021_ATH) {
      bullSignals.push(`🚀 ALTCOIN MCAP $${(btc.altcoinMarketCap / 1e12).toFixed(2)}T — ABOVE 2021 ATH! BCB: parabola phase activated`);
    } else {
      const pct = ((ALTCOIN_MCAP_2021_ATH - btc.altcoinMarketCap) / ALTCOIN_MCAP_2021_ATH * 100).toFixed(0);
      bullSignals.push(`Altcoin mcap $${(btc.altcoinMarketCap / 1e12).toFixed(2)}T — ${pct}% below 2021 ATH ($1.85T) — break it = parabola`);
    }
  }
  // Treasury yields declining = bullish for risk assets
  if (btc.treasuryDeclining === true) {
    bullSignals.push(`10Y Treasury yield declining — bond market easing, risk-on favorable`);
  }
  // Fear & Greed healthy range
  if (btc.fearGreed && btc.fearGreed.value >= 45 && btc.fearGreed.value < 75) {
    bullSignals.push(`Fear & Greed ${btc.fearGreed.value} (${btc.fearGreed.label}) — healthy sentiment`);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PHASE DETERMINATION
  // ════════════════════════════════════════════════════════════════════════════
  let phase;
  if (accumScore >= 6 && btc.weeklyRSI !== null && btc.weeklyRSI < 40) {
    phase = "CAPITULATION";
  } else if (accumScore >= 1 && btc.weeklyRSI !== null && btc.weeklyRSI < 55) {
    phase = "ACCUMULATION";
  } else if (distScore >= 5 || coinParabola || btc.memeFrenzy?.isFrenzy) {
    phase = "DISTRIBUTION";
  } else if (distScore >= 3) {
    phase = "LATE MARKUP";
  } else {
    phase = "MARKUP";
  }

  return {
    phase, accumScore, distScore,
    coinPrice, coinWeeklyRSI, coinWyckoff, coinParabola, coinSpring,
    coinRealizedPrice, coinVsRealized,
    accumSignals, distSignals, bullSignals,
  };
}

// ─── DCA State (per-coin) ─────────────────────────────────────────────────────

function loadDCAState(dcaFile, legacyMigrate = false) {
  if (legacyMigrate && !existsSync(dcaFile) && existsSync("dca-state.json")) {
    console.log("  📦 Migrating dca-state.json → " + dcaFile);
    const legacy   = JSON.parse(readFileSync("dca-state.json", "utf8"));
    const migrated = {
      totalCoin:    legacy.totalCoin ?? legacy.totalXRP ?? 0,
      totalCostUSD: legacy.totalCostUSD ?? 0,
      avgEntryPrice: legacy.avgEntryPrice ?? 0,
      lastDCADate:  legacy.lastDCADate ?? null,
      tranches:     legacy.tranches ?? { tranche1Deployed: false, tranche2Deployed: false },
      trades: (legacy.trades ?? []).map((t) => ({
        date: t.date, price: t.price ?? t.xrpPrice ?? 0,
        dcaUSD: t.dcaUSD ?? 0, coinQty: t.coinQty ?? t.xrpQty ?? 0,
        phase: t.phase, type: t.type,
      })),
    };
    writeFileSync(dcaFile, JSON.stringify(migrated, null, 2));
    return migrated;
  }
  if (!existsSync(dcaFile)) {
    return { totalCoin: 0, totalCostUSD: 0, avgEntryPrice: 0, lastDCADate: null,
      tranches: { tranche1Deployed: false, tranche2Deployed: false }, trades: [] };
  }
  const raw = JSON.parse(readFileSync(dcaFile, "utf8"));
  if (raw.totalXRP !== undefined && raw.totalCoin === undefined) { raw.totalCoin = raw.totalXRP; delete raw.totalXRP; }
  return raw;
}

function saveDCAState(dcaFile, state) {
  writeFileSync(dcaFile, JSON.stringify(state, null, 2));
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

async function generateDashboard() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║       📊 BCB STRATEGY DASHBOARD                        ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");
  for (const coin of COINS) {
    const state = loadDCAState(coin.dcaFile, coin.symbol === "XRPUSDT");
    let coinPrice = 0;
    try { const c = await fetchCandles(coin.symbol, "1D", 2); coinPrice = c[c.length - 1].close; } catch {}
    console.log(`\n── ${coin.displayName} (${coin.symbol}) ──────────────────────────────\n`);
    console.log(`  Portfolio: $${coin.portfolioUSD} (₹${(coin.portfolioUSD * INR_RATE).toFixed(0)})`);
    console.log(`  Daily DCA: ${coin.dailyDCAPct}% = $${(coin.portfolioUSD * coin.dailyDCAPct / 100).toFixed(2)}/day`);
    console.log(`  Target:    $${coin.targetLow.toLocaleString()} – $${coin.targetHigh.toLocaleString()}`);
    console.log(`  Mode:      ${PAPER_TRADING ? "PAPER" : "LIVE"}\n`);
    if (state.trades.length === 0) { console.log("  No trades yet.\n"); continue; }
    const val = state.totalCoin * coinPrice;
    const pnl = val - state.totalCostUSD;
    console.log(`  Total ${coin.displayName}:  ${state.totalCoin.toFixed(4)}`);
    console.log(`  Avg Entry: $${state.avgEntryPrice.toFixed(4)}`);
    console.log(`  Cost:      $${state.totalCostUSD.toFixed(2)} (₹${(state.totalCostUSD * INR_RATE).toFixed(0)})`);
    if (coinPrice > 0) {
      console.log(`  Price:     $${coinPrice.toFixed(4)}`);
      console.log(`  Value:     $${val.toFixed(2)} (₹${(val * INR_RATE).toFixed(0)})`);
      console.log(`  P&L:       ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (${(pnl / state.totalCostUSD * 100).toFixed(1)}%)`);
    }
    const tL = state.totalCoin * coin.targetLow, tH = state.totalCoin * coin.targetHigh;
    console.log(`  At $${coin.targetLow.toLocaleString()}: $${tL.toFixed(2)} | +${((tL / state.totalCostUSD - 1) * 100).toFixed(0)}%`);
    console.log(`  At $${coin.targetHigh.toLocaleString()}: $${tH.toFixed(2)} | +${((tH / state.totalCostUSD - 1) * 100).toFixed(0)}%`);
    console.log(`\n  T1 (capitulation): ${state.tranches?.tranche1Deployed ? "✅" : "⏳"}`);
    console.log(`  T2 (spring):       ${state.tranches?.tranche2Deployed ? "✅" : "⏳"}`);
    console.log(`  DCA buys:          ${state.trades.length}`);
  }
  console.log("\n══════════════════════════════════════════════════════════\n");
}

// ─── Run for a single coin ────────────────────────────────────────────────────

async function runCoin(coin, btc, today, now) {
  const state = loadDCAState(coin.dcaFile, coin.symbol === "XRPUSDT");

  console.log(`\n${"─".repeat(57)}`);
  console.log(`  ${coin.displayName} (${coin.symbol})`);
  console.log(`${"─".repeat(57)}`);

  if (state.totalCoin > 0) {
    console.log(`\n  📦 ${state.totalCoin.toFixed(4)} ${coin.displayName} | Avg $${state.avgEntryPrice.toFixed(4)} | Cost $${state.totalCostUSD.toFixed(2)}`);
  }

  if (state.lastDCADate === today) {
    console.log(`  ✅ DCA done today. Next check: tomorrow.\n`);
    return;
  }

  const p = await detectCoinPhase(btc, coin);

  // ── Signal Report ──────────────────────────────────────────────────────────
  console.log(`\n── BCB Signal Report — ${coin.displayName} ───────────────────────────\n`);
  console.log(`  BTC Price:         $${btc.btcPrice.toFixed(0)}`);
  console.log(`  100W MA:           $${btc.ma100w ? btc.ma100w.toFixed(0) : "N/A"} (BTC ${btc.btcVsMA100 !== null ? (btc.btcVsMA100 >= 0 ? "+" : "") + btc.btcVsMA100.toFixed(1) + "%" : "N/A"})`);
  console.log(`  200W EMA:          $${btc.ema200w ? btc.ema200w.toFixed(0) : "N/A"} (BTC ${btc.btcVsEMA200 !== null ? (btc.btcVsEMA200 >= 0 ? "+" : "") + btc.btcVsEMA200.toFixed(1) + "%" : "N/A"})`);
  console.log(`  BTC Realized:      $${btc.btcRealizedPrice ? btc.btcRealizedPrice.toFixed(0) : "N/A"} (BTC ${btc.btcVsRealized !== null ? (btc.btcVsRealized >= 0 ? "+" : "") + btc.btcVsRealized.toFixed(1) + "% vs realized)" : "N/A)"}`);
  console.log(`  Weekly RSI(14):    ${btc.weeklyRSI !== null ? btc.weeklyRSI.toFixed(1) : "N/A"}`);
  console.log(`  Weekly MACD:       ${btc.weeklyMACD !== null ? (btc.weeklyMACD >= 0 ? "+" : "") + btc.weeklyMACD.toFixed(0) : "N/A"}`);
  console.log(`  Monthly RSI:       ${btc.monthlyRSI !== null ? btc.monthlyRSI.toFixed(1) : "N/A"}`);
  console.log(`  Monthly StochRSI:  ${btc.monthlyStochRSI !== null ? btc.monthlyStochRSI.toFixed(1) : "N/A"}${btc.monthlyStochRSI !== null && btc.monthlyStochRSI < 5 ? " 🔴 EXTREME LOW" : ""}`);
  console.log(`  Monthly MACD:      ${btc.monthlyMACD !== null ? (btc.monthlyMACD >= 0 ? "+" : "") + btc.monthlyMACD.toFixed(0) : "N/A"}`);
  console.log(`  BTC Dominance:     ${btc.btcDominance !== null ? btc.btcDominance.toFixed(1) + "%" : "N/A"}`);
  console.log(`  Dom RSI (weekly):  ${btc.dominanceRSI !== null ? btc.dominanceRSI.toFixed(1) + (btc.dominanceRSI < 40 ? " 🔴 <40 SELL" : btc.dominanceRSI < 50 ? " 🟡 <50 alts building" : "") : "N/A (building…)"}`);
  console.log(`  Dom Trend:         ${btc.dominanceDeclining === null ? "N/A (need 14d data)" : btc.dominanceDeclining ? "📉 Declining" : "📈 Rising"}`);
  console.log(`  ${coin.displayName} Price:         $${p.coinPrice.toFixed(4)}`);
  console.log(`  ${coin.displayName} Realized:      $${p.coinRealizedPrice ? p.coinRealizedPrice.toFixed(4) : "N/A"}${p.coinVsRealized !== null ? " (" + (p.coinVsRealized >= 0 ? "+" : "") + p.coinVsRealized.toFixed(1) + "%)" : ""}`);
  console.log(`  ${coin.displayName} Weekly RSI:    ${p.coinWeeklyRSI !== null ? p.coinWeeklyRSI.toFixed(1) : "N/A"}`);
  console.log(`  ${coin.displayName} Wyckoff:       ${p.coinWyckoff}`);
  console.log(`  Spring (BTC):      ${btc.springDetected ? "🟢 YES" : "No"}`);
  console.log(`  Spring (${coin.displayName}):      ${p.coinSpring ? "🟢 YES" : "No"}`);
  console.log(`  ${coin.displayName} Parabola:      ${p.coinParabola ? "🔴 YES — SELL SIGNAL" : "No"}`);
  console.log(`  Bearish Div:       ${btc.bearishDivergence ? "⚠️  YES" : "No"}`);
  console.log(`\n  ── Macro ────────────────────────────────────────────`);
  console.log(`  VIX:               ${btc.vix ? btc.vix.current.toFixed(1) + (btc.vix.current > 30 ? " 🔴 HIGH FEAR" : btc.vix.current < 14 ? " 🟢 LOW (complacency)" : " — normal") : "N/A"}`);
  console.log(`  Fear & Greed:      ${btc.fearGreed ? btc.fearGreed.value + " — " + btc.fearGreed.label : "N/A"}`);
  console.log(`  Russell 2000:      ${btc.russell2000 ? "$" + btc.russell2000.current.toFixed(2) + " (" + btc.russell2000.pctFromHigh.toFixed(1) + "% from 90d high)" : "N/A"}`);
  console.log(`  Dow Jones:         ${btc.dowJones ? "$" + btc.dowJones.current.toFixed(0) + " (" + btc.dowJones.pctFromHigh.toFixed(1) + "%)" : "N/A"}`);
  console.log(`  S&P 500:           ${btc.sp500 ? "$" + btc.sp500.current.toFixed(2) + " (" + btc.sp500.pctFromHigh.toFixed(1) + "%)" : "N/A"}`);
  console.log(`  Nasdaq (QQQ):      ${btc.nasdaq ? "$" + btc.nasdaq.current.toFixed(2) + " (" + btc.nasdaq.pctFromHigh.toFixed(1) + "%)" : "N/A"}`);
  console.log(`  IGV (software):    ${btc.igv ? "$" + btc.igv.current.toFixed(2) + " (" + btc.igv.pctFromHigh.toFixed(1) + "%)" : "N/A"}`);
  console.log(`  10Y Treasury:      ${btc.treasury10y ? btc.treasury10y.current.toFixed(2) + "%" + (btc.treasuryDeclining ? " 📉 declining" : " 📈 rising") : "N/A"}`);
  console.log(`  Copper:            ${btc.copper ? "$" + btc.copper.current.toFixed(3) + " (" + btc.copper.pctFromHigh.toFixed(1) + "% from 90d high)" + (btc.copperStress ? " ⚠️  STRESS" : "") : "N/A"}`);
  console.log(`  Altcoin Mcap:      ${btc.altcoinMarketCap ? "$" + (btc.altcoinMarketCap / 1e12).toFixed(2) + "T (ATH: $1.85T)" : "N/A"}`);
  console.log(`\n  ── Sentiment ────────────────────────────────────────`);
  console.log(`  Meme Frenzy:       ${btc.memeFrenzy ? (btc.memeFrenzy.isFrenzy ? "🚨 YES — " : "No — ") + btc.memeFrenzy.memeCount + "/" + btc.memeFrenzy.total + " trending memes (" + btc.memeFrenzy.coins + ")" : "N/A"}`);
  console.log(`  Google Trends:     ${btc.googleTrends ? (btc.googleTrends.isMainstream ? "🚨 CRYPTO MAINSTREAM — " : "Normal — ") + btc.googleTrends.cryptoTrending + " crypto searches trending" + (btc.googleTrends.terms ? " (" + btc.googleTrends.terms + ")" : "") : "N/A"}`);

  console.log(`\n  📊 Accumulation Score: ${p.accumScore}/10`);
  p.accumSignals.forEach((s) => console.log(`    ✅ ${s.signal} (+${s.score})`));
  console.log(`\n  📊 Distribution Score: ${p.distScore}/10`);
  p.distSignals.forEach((s) => console.log(`    ⚠️  ${s.signal} (+${s.score})`));
  if (p.bullSignals.length > 0) {
    console.log(`\n  📊 Bull Run Confirmation:`);
    p.bullSignals.forEach((s) => console.log(`    🟢 ${s}`));
  }
  console.log(`\n  🎯 PHASE: ${p.phase}`);
  console.log("\n── Entry Decision ───────────────────────────────────────\n");

  const maxPositionUSD  = coin.portfolioUSD * (coin.maxPositionPct / 100);
  const remainingCap    = maxPositionUSD - state.totalCostUSD;
  const dailyDCAAmount  = coin.portfolioUSD * coin.dailyDCAPct / 100;

  // ── DISTRIBUTION ──────────────────────────────────────────────────────────
  if (p.phase === "DISTRIBUTION" || p.phase === "LATE MARKUP") {
    console.log(`  🚫 ${p.phase} — no new buys.`);
    let sellPct = 0;
    if (p.distScore >= 5 || p.coinParabola || btc.memeFrenzy?.isFrenzy) {
      sellPct = 75;
      console.log(`  🔴 URGENT: ${p.distScore} dist signals — reduce 75%!`);
    } else if (p.distScore >= 3) {
      sellPct = 25;
      console.log(`  ⚠️  ${p.distScore} dist signals — reduce 25%.`);
    }
    if (sellPct > 0 && state.totalCoin > 0) {
      const sellCoin     = state.totalCoin * (sellPct / 100);
      const sellValueUSD = sellCoin * p.coinPrice;
      const pnlUSD       = (p.coinPrice - state.avgEntryPrice) * sellCoin;
      console.log(`\n  📋 REDUCE: Sell ${sellCoin.toFixed(4)} ${coin.displayName} @ $${p.coinPrice.toFixed(4)}`);
      console.log(`  Value: $${sellValueUSD.toFixed(2)} (₹${(sellValueUSD * INR_RATE).toFixed(0)})`);
      console.log(`  P&L:   ${pnlUSD >= 0 ? "+" : ""}$${pnlUSD.toFixed(2)}`);
      await notify(
        `🔴 BCB SELL — ${coin.symbol} — ${p.distScore} SIGNALS`,
        `Reduce ${sellPct}% of ${coin.displayName}!\nSell ${sellCoin.toFixed(4)} @ $${p.coinPrice.toFixed(4)}\nValue: $${sellValueUSD.toFixed(2)} (₹${(sellValueUSD * INR_RATE).toFixed(0)})\nP&L: ${pnlUSD >= 0 ? "+" : ""}$${pnlUSD.toFixed(2)}\n\n${p.distSignals.map((s) => s.signal).join("\n")}`,
        p.distScore >= 5 ? "urgent" : "high"
      );
    }
    state.lastDCADate = today;
    saveDCAState(coin.dcaFile, state);
    return;
  }

  // ── Max position ──────────────────────────────────────────────────────────
  if (remainingCap <= 0) {
    console.log(`  ℹ️  Max position reached — holding.`);
    state.lastDCADate = today;
    saveDCAState(coin.dcaFile, state);
    return;
  }

  let executed = false;

  // ── TRANCHE 1 — 25% at capitulation (score ≥ 8) ──────────────────────────
  if (p.accumScore >= 8 && !state.tranches?.tranche1Deployed) {
    const amt = Math.min(coin.portfolioUSD * 0.25, remainingCap);
    const qty = amt / p.coinPrice;
    console.log(`  🚀 TRANCHE 1 — Capitulation entry (score: ${p.accumScore}/10)`);
    console.log(`     Buy $${amt.toFixed(2)} = ${qty.toFixed(4)} ${coin.displayName} @ $${p.coinPrice.toFixed(4)}`);
    state.totalCoin += qty; state.totalCostUSD += amt;
    state.avgEntryPrice = state.totalCostUSD / state.totalCoin;
    if (!state.tranches) state.tranches = {};
    state.tranches.tranche1Deployed = true; state.lastDCADate = today;
    state.trades.push({ date: today, price: p.coinPrice, dcaUSD: amt, coinQty: qty, phase: p.phase, type: "TRANCHE 1 (25%)" });
    await notify(`🚀 ${coin.displayName} T1 — CAPITULATION`, `Score: ${p.accumScore}/10\n${qty.toFixed(4)} ${coin.displayName} @ $${p.coinPrice.toFixed(4)}\n$${amt.toFixed(2)} (₹${(amt * INR_RATE).toFixed(0)})\nTarget: $${coin.targetLow}–$${coin.targetHigh}`, "high");
    await logToSheet({ timestamp: now.toISOString(), symbol: coin.symbol, side: "BUY", price: p.coinPrice, tradeSize: amt, pnlPct: null, pnlINR: null, exitReason: `TRANCHE 1 | Score: ${p.accumScore}`, mode: PAPER_TRADING ? "PAPER" : "LIVE", rsi3: btc.weeklyRSI, vwap: btc.monthlyStochRSI, ema8: btc.btcDominance || 0 });
    executed = true;
  }

  // ── TRANCHE 2 — 25% at spring ─────────────────────────────────────────────
  if ((btc.springDetected || p.coinSpring) && !state.tranches?.tranche2Deployed && !executed) {
    const amt = Math.min(coin.portfolioUSD * 0.25, remainingCap);
    const qty = amt / p.coinPrice;
    console.log(`  🌱 TRANCHE 2 — Spring detected`);
    console.log(`     Buy $${amt.toFixed(2)} = ${qty.toFixed(4)} ${coin.displayName} @ $${p.coinPrice.toFixed(4)}`);
    state.totalCoin += qty; state.totalCostUSD += amt;
    state.avgEntryPrice = state.totalCostUSD / state.totalCoin;
    if (!state.tranches) state.tranches = {};
    state.tranches.tranche2Deployed = true; state.lastDCADate = today;
    state.trades.push({ date: today, price: p.coinPrice, dcaUSD: amt, coinQty: qty, phase: p.phase, type: "TRANCHE 2 (25% spring)" });
    await notify(`🌱 ${coin.displayName} T2 — SPRING`, `${qty.toFixed(4)} ${coin.displayName} @ $${p.coinPrice.toFixed(4)}\n$${amt.toFixed(2)} (₹${(amt * INR_RATE).toFixed(0)})`, "high");
    await logToSheet({ timestamp: now.toISOString(), symbol: coin.symbol, side: "BUY", price: p.coinPrice, tradeSize: amt, pnlPct: null, pnlINR: null, exitReason: "TRANCHE 2 — Spring", mode: PAPER_TRADING ? "PAPER" : "LIVE", rsi3: btc.weeklyRSI, vwap: btc.monthlyStochRSI, ema8: btc.btcDominance || 0 });
    executed = true;
  }

  // ── DAILY DCA ─────────────────────────────────────────────────────────────
  if (!executed) {
    const amt = Math.min(dailyDCAAmount, remainingCap);
    if (amt < 0.5) {
      console.log("  ℹ️  DCA amount too small — position near max.");
    } else {
      const qty = amt / p.coinPrice;
      console.log(`  📈 DAILY DCA — ${coin.dailyDCAPct}% of portfolio`);
      console.log(`     Buy $${amt.toFixed(2)} = ${qty.toFixed(4)} ${coin.displayName} @ $${p.coinPrice.toFixed(4)}`);
      state.totalCoin += qty; state.totalCostUSD += amt;
      state.avgEntryPrice = state.totalCostUSD / state.totalCoin;
      state.lastDCADate = today;
      state.trades.push({ date: today, price: p.coinPrice, dcaUSD: amt, coinQty: qty, phase: p.phase, type: "DCA" });
      const tL = state.totalCoin * coin.targetLow, tH = state.totalCoin * coin.targetHigh;
      console.log(`\n  Total ${coin.displayName}:  ${state.totalCoin.toFixed(4)}`);
      console.log(`  Avg Entry: $${state.avgEntryPrice.toFixed(4)}`);
      console.log(`  P&L:       ${(state.totalCoin * p.coinPrice - state.totalCostUSD) >= 0 ? "+" : ""}$${(state.totalCoin * p.coinPrice - state.totalCostUSD).toFixed(2)}`);
      console.log(`  At $${coin.targetLow.toLocaleString()}: $${tL.toFixed(2)} (₹${(tL * INR_RATE).toFixed(0)}) | +${((tL / state.totalCostUSD - 1) * 100).toFixed(0)}%`);
      console.log(`  At $${coin.targetHigh.toLocaleString()}: $${tH.toFixed(2)} (₹${(tH * INR_RATE).toFixed(0)}) | +${((tH / state.totalCostUSD - 1) * 100).toFixed(0)}%`);
      await notify(`📈 DCA — ${coin.symbol}`, `${qty.toFixed(4)} ${coin.displayName} @ $${p.coinPrice.toFixed(4)}\nPhase: ${p.phase}\nTotal: ${state.totalCoin.toFixed(4)} ${coin.displayName}\nAvg: $${state.avgEntryPrice.toFixed(4)}\nAt $${coin.targetLow.toLocaleString()}: $${tL.toFixed(2)} (₹${(tL * INR_RATE).toFixed(0)})`, "default");
      await logToSheet({ timestamp: now.toISOString(), symbol: coin.symbol, side: "BUY", price: p.coinPrice, tradeSize: amt, pnlPct: null, pnlINR: null, exitReason: `DCA — ${p.phase} | RSI:${btc.weeklyRSI?.toFixed(0)} StochRSI:${btc.monthlyStochRSI?.toFixed(0)} Dom:${btc.btcDominance?.toFixed(1)}%`, mode: PAPER_TRADING ? "PAPER" : "LIVE", rsi3: btc.weeklyRSI, vwap: btc.monthlyStochRSI, ema8: btc.btcDominance || 0 });
    }
  }

  saveDCAState(coin.dcaFile, state);
}

// ─── Main Loop ────────────────────────────────────────────────────────────────

async function run() {
  const now   = new Date();
  const today = now.toISOString().slice(0, 10);
  if (!existsSync(".env")) console.log("☁️  Cloud — Railway");

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  BCB Strategy Bot — XRP + ETH");
  console.log(`  ${now.toISOString()}`);
  console.log(`  Mode: ${PAPER_TRADING ? "📋 PAPER" : "🔴 LIVE"}`);
  console.log("═══════════════════════════════════════════════════════════");

  const anyPending = COINS.some((c) => loadDCAState(c.dcaFile, c.symbol === "XRPUSDT").lastDCADate !== today);
  if (!anyPending) {
    console.log("  ✅ All coins DCA done today. Next check: tomorrow.\n");
    console.log("═══════════════════════════════════════════════════════════\n");
    return;
  }

  // Fetch BTC + macro ONCE, share across all coins
  const btc = await fetchBTCMacroData();

  for (const coin of COINS) {
    try { await runCoin(coin, btc, today, now); }
    catch (err) { console.error(`  ❌ ${coin.symbol} error: ${err.message}`); }
  }

  console.log("\n═══════════════════════════════════════════════════════════\n");
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

if (process.argv.includes("--summary")) {
  generateDashboard().catch(console.error);
} else {
  (async () => {
    while (true) {
      try { await run(); } catch (err) { console.error("Bot error:", err.message); }
      console.log("⏳ Waiting 60 seconds...\n");
      await new Promise((r) => setTimeout(r, 60_000));
    }
  })();
}
