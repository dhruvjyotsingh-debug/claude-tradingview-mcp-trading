/**
 * BCB Strategy Bot — Full BlockchainBacker Framework
 * Based on 99-video analysis of BlockchainBacker's macro cycle model
 *
 * Phases: Capitulation → Accumulation → Markup → Distribution
 * Entry: Tranches (25% capitulation + 25% spring + 1-2% daily DCA)
 * Exit: Distribution signal scoring (reduce at 3+, aggressive at 5+)
 * Coins: XRPUSDT ($8–$10 target) + ETHUSDT ($5k–$8k target)
 *
 * Multi-coin: same BCB strategy runs independently for each coin.
 * BTC/macro data is fetched ONCE per cycle and shared.
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";

// ─── Constants ────────────────────────────────────────────────────────────────

const NTFY_CHANNEL = process.env.NTFY_CHANNEL || "xrp-bot-dhruvjyot";
const SHEET_URL =
  process.env.GOOGLE_SHEET_URL ||
  "https://script.google.com/macros/s/AKfycbzWdRn61TrnC0M0z91wgcMnIOJ6cjhYti21xdEnyNVFV5335qtisHk-nT46ugpIAmSW/exec";
const INR_RATE = 83.5;

// ─── Coin Config ──────────────────────────────────────────────────────────────

const COINS = [
  {
    symbol: "XRPUSDT",
    displayName: "XRP",
    portfolioUSD: parseFloat(process.env.XRP_PORTFOLIO_USD || "60"),
    dailyDCAPct: parseFloat(process.env.DAILY_DCA_PCT || "1.5"),
    maxPositionPct: parseFloat(process.env.MAX_POSITION_PCT || "50"),
    targetLow: 8.0,
    targetHigh: 10.0,
    dcaFile: "dca-state-XRPUSDT.json",
  },
  {
    symbol: "ETHUSDT",
    displayName: "ETH",
    portfolioUSD: parseFloat(process.env.ETH_PORTFOLIO_USD || "60"),
    dailyDCAPct: parseFloat(process.env.DAILY_DCA_PCT || "1.5"),
    maxPositionPct: parseFloat(process.env.MAX_POSITION_PCT || "50"),
    targetLow: 5000,
    targetHigh: 8000,
    dcaFile: "dca-state-ETHUSDT.json",
  },
];

const PAPER_TRADING = process.env.PAPER_TRADING !== "false";

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

// ─── Free External Data Sources ───────────────────────────────────────────────

async function fetchYahooFinance(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=90d`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const result = data.chart?.result?.[0];
    if (!result) return null;
    const closes = result.indicators.quote[0].close.filter((v) => v !== null);
    if (closes.length === 0) return null;
    const current = closes[closes.length - 1];
    const high90d = Math.max(...closes);
    const low90d = Math.min(...closes);
    const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, closes.length);
    const pctFromHigh = ((current - high90d) / high90d) * 100;
    const aboveSMA20 = current > sma20;
    return { current, high90d, low90d, sma20, pctFromHigh, aboveSMA20, closes };
  } catch {
    return null;
  }
}

async function fetchFearGreed() {
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=1");
    const data = await res.json();
    return {
      value: parseInt(data.data[0].value),
      label: data.data[0].value_classification,
    };
  } catch {
    return null;
  }
}

// ─── Market Data ──────────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval, limit = 120) {
  const map = {
    "1m": "1m", "5m": "5m", "15m": "15m", "1H": "1h",
    "4H": "4h", "1D": "1d", "1W": "1w", "1M": "1M",
  };
  const i = map[interval] || interval;
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${i}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${interval} error: ${res.status}`);
  const data = await res.json();
  return data.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
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
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function calcStochRSI(closes, rsiPeriod = 14, stochPeriod = 14) {
  if (closes.length < rsiPeriod + stochPeriod + 1) return null;
  const rsiSeries = [];
  for (let i = rsiPeriod; i < closes.length; i++) {
    const slice = closes.slice(i - rsiPeriod, i + 1);
    const r = calcRSI(slice, rsiPeriod);
    if (r !== null) rsiSeries.push(r);
  }
  if (rsiSeries.length < stochPeriod) return null;
  const window = rsiSeries.slice(-stochPeriod);
  const current = window[window.length - 1];
  const lowest = Math.min(...window);
  const highest = Math.max(...window);
  if (highest === lowest) return current > 50 ? 100 : 0;
  return ((current - lowest) / (highest - lowest)) * 100;
}

function detectBearishDivergence(weeklyCandles, weeklyCloses) {
  if (weeklyCandles.length < 10) return false;
  const recent = weeklyCandles.slice(-10);
  const recentCloses = weeklyCloses.slice(-10);
  const priceHighIdx = recentCloses.indexOf(Math.max(...recentCloses));
  const priceHigh = recentCloses[priceHighIdx];
  const prevHigh = Math.max(...recentCloses.slice(0, priceHighIdx));
  if (priceHigh <= prevHigh) return false;
  if (recentCloses.length < 5) return false;
  const rsiNow = calcRSI(recentCloses, Math.min(5, recentCloses.length - 1));
  const rsiPrev = calcRSI(recentCloses.slice(0, -3), Math.min(5, recentCloses.length - 4));
  if (rsiNow === null || rsiPrev === null) return false;
  return rsiNow < rsiPrev * 0.95;
}

function detectCapitulationCandle(candles) {
  if (candles.length < 5) return false;
  const avgVolume = candles.slice(-20).reduce((s, c) => s + c.volume, 0) / Math.min(20, candles.length);
  const recent = candles.slice(-3);
  return recent.some((c) => {
    const body = Math.abs(c.close - c.open);
    const range = c.high - c.low;
    return c.volume > avgVolume * 2.5 && range > 0 && body / range > 0.5;
  });
}

function detectSpring(dailyCandles) {
  if (dailyCandles.length < 35) return false;
  const priorLow = Math.min(...dailyCandles.slice(-35, -5).map((c) => c.low));
  const recent = dailyCandles.slice(-5);
  return recent.some((c) => c.low < priorLow * 0.995 && c.close > priorLow);
}

function detectParabola(dailyCandles) {
  if (dailyCandles.length < 11) return false;
  const tenDaysAgo = dailyCandles[dailyCandles.length - 11].close;
  const current = dailyCandles[dailyCandles.length - 1].close;
  return (current - tenDaysAgo) / tenDaysAgo * 100 > 100;
}

function detectWyckoffPhase(weeklyCandles) {
  if (weeklyCandles.length < 20) return "UNKNOWN";
  const closes = weeklyCandles.map((c) => c.close);
  const current = closes[closes.length - 1];
  const low52w = Math.min(...closes.slice(-52));
  const high52w = Math.max(...closes.slice(-52));
  const range = high52w - low52w;
  const posInRange = (current - low52w) / range;
  if (posInRange < 0.2) return "SPRING / ACCUMULATION LOW";
  if (posInRange < 0.4) return "PHASE B (base building)";
  if (posInRange < 0.6) return "SIGN OF STRENGTH";
  if (posInRange < 0.8) return "MARKUP PHASE";
  return "DISTRIBUTION ZONE";
}

// ─── BTC + Macro Data (fetched ONCE, shared across all coins) ─────────────────

async function fetchBTCMacroData() {
  console.log("\n── Fetching BTC + macro data ────────────────────────────\n");

  const [
    btcWeekly, btcMonthly, btcDaily,
    russell2000, dowJones, vix, igv, fearGreed,
  ] = await Promise.all([
    fetchCandles("BTCUSDT", "1W", 220),
    fetchCandles("BTCUSDT", "1M", 60),
    fetchCandles("BTCUSDT", "1D", 90),
    fetchYahooFinance("IWM"),
    fetchYahooFinance("%5EDJI"),
    fetchYahooFinance("%5EVIX"),
    fetchYahooFinance("IGV"),
    fetchFearGreed(),
  ]);

  const btcWeeklyCloses = btcWeekly.map((c) => c.close);
  const btcPrice = btcWeeklyCloses[btcWeeklyCloses.length - 1];
  const weeklyRSI = calcRSI(btcWeeklyCloses, 14);
  const ma100w = calcSMA(btcWeeklyCloses, 100);
  const ema200w = calcEMA(btcWeeklyCloses, 200);
  const weeklyEMA12 = calcEMA(btcWeeklyCloses, 12);
  const weeklyEMA26 = calcEMA(btcWeeklyCloses, 26);
  const weeklyMACD = weeklyEMA12 !== null && weeklyEMA26 !== null ? weeklyEMA12 - weeklyEMA26 : null;
  const btcVsMA100 = ma100w ? ((btcPrice - ma100w) / ma100w) * 100 : null;
  const btcVsEMA200 = ema200w ? ((btcPrice - ema200w) / ema200w) * 100 : null;
  const bearishDivergence = detectBearishDivergence(btcWeekly, btcWeeklyCloses);
  const weeklyCapitulationCandle = detectCapitulationCandle(btcWeekly.slice(-22));

  const btcMonthlyCloses = btcMonthly.map((c) => c.close);
  const monthlyRSI = calcRSI(btcMonthlyCloses, 14);
  const monthlyStochRSI = calcStochRSI(btcMonthlyCloses, 14, 14);
  const monthlyEMA12 = calcEMA(btcMonthlyCloses, 12);
  const monthlyEMA26 = calcEMA(btcMonthlyCloses, 26);
  const monthlyMACD = monthlyEMA12 !== null && monthlyEMA26 !== null ? monthlyEMA12 - monthlyEMA26 : null;

  const springDetected = detectSpring(btcDaily);
  const dailyCapitulationCandle = detectCapitulationCandle(btcDaily.slice(-22));

  let btcDominance = null;
  try {
    const globalData = await fetch("https://api.coingecko.com/api/v3/global").then((r) => r.json());
    btcDominance = globalData.data?.market_cap_percentage?.btc || null;
  } catch {}

  return {
    btcPrice, weeklyRSI, ma100w, ema200w, weeklyMACD,
    btcVsMA100, btcVsEMA200, bearishDivergence, weeklyCapitulationCandle,
    monthlyRSI, monthlyStochRSI, monthlyMACD,
    springDetected, dailyCapitulationCandle,
    btcDominance,
    russell2000, dowJones, vix, igv, fearGreed,
  };
}

// ─── Per-Coin BCB Phase Detection ─────────────────────────────────────────────

async function detectCoinPhase(btc, symbol) {
  const [coinWeekly, coinDaily] = await Promise.all([
    fetchCandles(symbol, "1W", 60),
    fetchCandles(symbol, "1D", 40),
  ]);

  const coinWeeklyCloses = coinWeekly.map((c) => c.close);
  const coinPrice = coinWeeklyCloses[coinWeeklyCloses.length - 1];
  const coinWeeklyRSI = calcRSI(coinWeeklyCloses, 14);
  const coinWyckoff = detectWyckoffPhase(coinWeekly);
  const coinParabola = detectParabola(coinDaily);
  const coinSpring = detectSpring(coinDaily);

  const accumSignals = [];
  let accumScore = 0;

  if (btc.weeklyRSI !== null && btc.weeklyRSI < 30) {
    accumSignals.push({ signal: "BTC Weekly RSI below 30 (capitulation zone)", score: 2 });
    accumScore += 2;
  } else if (btc.weeklyRSI !== null && btc.weeklyRSI < 40) {
    accumSignals.push({ signal: `BTC Weekly RSI ${btc.weeklyRSI.toFixed(1)} (recovery zone)`, score: 1 });
    accumScore += 1;
  }

  if (btc.monthlyStochRSI !== null && btc.monthlyStochRSI < 5) {
    accumSignals.push({ signal: `Monthly StochRSI ${btc.monthlyStochRSI.toFixed(1)} — extreme low`, score: 2 });
    accumScore += 2;
  } else if (btc.monthlyStochRSI !== null && btc.monthlyStochRSI < 20) {
    accumSignals.push({ signal: `Monthly StochRSI ${btc.monthlyStochRSI.toFixed(1)} — oversold`, score: 1 });
    accumScore += 1;
  }

  if (btc.monthlyRSI !== null && btc.monthlyRSI < 35) {
    accumSignals.push({ signal: `Monthly RSI ${btc.monthlyRSI.toFixed(1)} — historically oversold`, score: 1 });
    accumScore += 1;
  }

  if (btc.dailyCapitulationCandle) {
    accumSignals.push({ signal: "Daily capitulation candle (massive volume reversal)", score: 2 });
    accumScore += 2;
  }
  if (btc.weeklyCapitulationCandle) {
    accumSignals.push({ signal: "Weekly capitulation candle detected", score: 1 });
    accumScore += 1;
  }

  if (btc.btcVsMA100 !== null && Math.abs(btc.btcVsMA100) < 10) {
    accumSignals.push({ signal: `BTC within 10% of 100w MA ($${btc.ma100w.toFixed(0)})`, score: 1 });
    accumScore += 1;
  }

  if (btc.btcVsEMA200 !== null && Math.abs(btc.btcVsEMA200) < 15) {
    accumSignals.push({ signal: `BTC within 15% of 200w EMA ($${btc.ema200w.toFixed(0)})`, score: 1 });
    accumScore += 1;
  }

  if (btc.weeklyMACD !== null && btc.weeklyMACD < -2000) {
    accumSignals.push({ signal: `Weekly MACD deeply negative (${btc.weeklyMACD.toFixed(0)})`, score: 1 });
    accumScore += 1;
  }

  if (btc.springDetected) {
    accumSignals.push({ signal: "BTC spring — swept below recent lows and recovered", score: 2 });
    accumScore += 2;
  }

  if (coinSpring) {
    accumSignals.push({ signal: `${symbol.replace("USDT", "")} spring detected — swept lows and recovered`, score: 1 });
    accumScore += 1;
  }

  if (btc.vix && btc.vix.current > 30) {
    accumSignals.push({ signal: `VIX ${btc.vix.current.toFixed(1)} — elevated fear (BCB: every crypto low had VIX spike)`, score: 2 });
    accumScore += 2;
  } else if (btc.vix && btc.vix.current > 20) {
    accumSignals.push({ signal: `VIX ${btc.vix.current.toFixed(1)} — mildly elevated`, score: 0.5 });
    accumScore += 0.5;
  }

  if (btc.fearGreed && btc.fearGreed.value <= 25) {
    accumSignals.push({ signal: `Fear & Greed: ${btc.fearGreed.value} (${btc.fearGreed.label}) — extreme fear = buy signal`, score: 1 });
    accumScore += 1;
  }

  if (btc.russell2000 && btc.russell2000.pctFromHigh < -20) {
    accumSignals.push({ signal: `Russell 2000 ${btc.russell2000.pctFromHigh.toFixed(1)}% from 90d high — macro stress`, score: 0.5 });
    accumScore += 0.5;
  }

  const distSignals = [];
  let distScore = 0;

  if (btc.bearishDivergence) {
    distSignals.push({ signal: "Weekly RSI bearish divergence (price higher, RSI lower)", score: 2 });
    distScore += 2;
  }

  if (btc.weeklyRSI !== null && btc.weeklyRSI > 70) {
    distSignals.push({ signal: `Weekly RSI ${btc.weeklyRSI.toFixed(1)} — distribution zone`, score: 1 });
    distScore += 1;
  }

  if (btc.weeklyMACD !== null && btc.weeklyMACD > 0 && btc.weeklyRSI !== null && btc.weeklyRSI > 65) {
    distSignals.push({ signal: "Weekly MACD positive + RSI high — watch for red cross", score: 1 });
    distScore += 1;
  }

  if (btc.monthlyMACD !== null && btc.monthlyMACD > 0 && btc.monthlyRSI !== null && btc.monthlyRSI > 70) {
    distSignals.push({ signal: "Monthly MACD positive + monthly RSI high — cycle top risk", score: 1 });
    distScore += 1;
  }

  if (btc.btcDominance !== null && btc.btcDominance < 40) {
    distSignals.push({ signal: `BTC dominance ${btc.btcDominance.toFixed(1)}% — altcoin season PEAK, near cycle top`, score: 2 });
    distScore += 2;
  }

  if (coinParabola) {
    distSignals.push({ signal: `${symbol.replace("USDT", "")} 100%+ gain in 10 days — BCB's #1 cycle top signal. SELL NOW.`, score: 3 });
    distScore += 3;
  }

  if (btc.btcVsMA100 !== null && btc.btcVsMA100 > 80) {
    distSignals.push({ signal: `BTC ${btc.btcVsMA100.toFixed(0)}% above 100w MA — historically overextended`, score: 1 });
    distScore += 1;
  }

  if (btc.monthlyStochRSI !== null && btc.monthlyStochRSI > 90) {
    distSignals.push({ signal: `Monthly StochRSI ${btc.monthlyStochRSI.toFixed(1)} — extremely overbought`, score: 1 });
    distScore += 1;
  }

  if (btc.vix && btc.vix.current < 14) {
    distSignals.push({ signal: `VIX ${btc.vix.current.toFixed(1)} — extreme complacency`, score: 1 });
    distScore += 1;
  }

  if (btc.fearGreed && btc.fearGreed.value >= 75) {
    distSignals.push({ signal: `Fear & Greed: ${btc.fearGreed.value} (${btc.fearGreed.label}) — extreme greed = sell signal`, score: 1 });
    distScore += 1;
  }

  if (btc.igv && btc.igv.pctFromHigh < -15 && !btc.igv.aboveSMA20) {
    distSignals.push({ signal: `IGV ETF ${btc.igv.pctFromHigh.toFixed(1)}% from high, below 20d MA — software weakening`, score: 1 });
    distScore += 1;
  }

  const bullSignals = [];

  if (btc.btcDominance !== null && btc.btcDominance < 50 && btc.btcDominance > 40) {
    bullSignals.push(`BTC dominance 40-50% — altcoin season building`);
  }
  if (btc.weeklyMACD !== null && btc.weeklyMACD > 0 && btc.weeklyRSI !== null && btc.weeklyRSI < 65) {
    bullSignals.push("Weekly MACD positive + RSI not overbought — healthy markup");
  }
  if (btc.btcVsMA100 !== null && btc.btcVsMA100 > 10 && btc.btcVsMA100 < 50) {
    bullSignals.push(`BTC ${btc.btcVsMA100.toFixed(0)}% above 100w MA — normal markup territory`);
  }
  if (btc.russell2000 && btc.russell2000.pctFromHigh > -5 && btc.russell2000.aboveSMA20) {
    bullSignals.push(`Russell 2000 near ATH (${btc.russell2000.pctFromHigh.toFixed(1)}% from 90d high) — BCB's #1 crypto bull trigger`);
  }
  if (btc.dowJones && btc.dowJones.pctFromHigh > -3 && btc.dowJones.aboveSMA20) {
    bullSignals.push(`Dow Jones near ATH (${btc.dowJones.pctFromHigh.toFixed(1)}% from 90d high) — macro bullish`);
  }
  if (btc.igv && btc.igv.pctFromHigh > -5 && btc.igv.aboveSMA20) {
    bullSignals.push(`IGV software ETF near ATH (${btc.igv.pctFromHigh.toFixed(1)}%) — BCB says BTC follows IGV`);
  }
  if (btc.fearGreed && btc.fearGreed.value >= 45 && btc.fearGreed.value < 75) {
    bullSignals.push(`Fear & Greed: ${btc.fearGreed.value} (${btc.fearGreed.label}) — healthy market sentiment`);
  }

  let phase;
  if (accumScore >= 6 && btc.weeklyRSI !== null && btc.weeklyRSI < 40) {
    phase = "CAPITULATION";
  } else if (accumScore >= 1 && btc.weeklyRSI !== null && btc.weeklyRSI < 55) {
    phase = "ACCUMULATION";
  } else if (distScore >= 5 || coinParabola) {
    phase = "DISTRIBUTION";
  } else if (distScore >= 3) {
    phase = "LATE MARKUP";
  } else {
    phase = "MARKUP";
  }

  return {
    phase, accumScore, distScore,
    coinPrice, coinWeeklyRSI, coinWyckoff, coinParabola, coinSpring,
    accumSignals, distSignals, bullSignals,
  };
}

// ─── DCA State (per-coin files) ───────────────────────────────────────────────

function loadDCAState(dcaFile, legacyMigrate = false) {
  if (legacyMigrate && !existsSync(dcaFile) && existsSync("dca-state.json")) {
    console.log("  📦 Migrating dca-state.json → " + dcaFile);
    const legacy = JSON.parse(readFileSync("dca-state.json", "utf8"));
    const migrated = {
      totalCoin: legacy.totalCoin ?? legacy.totalXRP ?? 0,
      totalCostUSD: legacy.totalCostUSD ?? 0,
      avgEntryPrice: legacy.avgEntryPrice ?? 0,
      lastDCADate: legacy.lastDCADate ?? null,
      tranches: legacy.tranches ?? { tranche1Deployed: false, tranche2Deployed: false },
      trades: (legacy.trades ?? []).map((t) => ({
        date: t.date,
        price: t.price ?? t.xrpPrice ?? 0,
        dcaUSD: t.dcaUSD ?? 0,
        coinQty: t.coinQty ?? t.xrpQty ?? 0,
        phase: t.phase,
        type: t.type,
      })),
    };
    writeFileSync(dcaFile, JSON.stringify(migrated, null, 2));
    return migrated;
  }

  if (!existsSync(dcaFile)) {
    return {
      totalCoin: 0,
      totalCostUSD: 0,
      avgEntryPrice: 0,
      lastDCADate: null,
      tranches: { tranche1Deployed: false, tranche2Deployed: false },
      trades: [],
    };
  }

  const raw = JSON.parse(readFileSync(dcaFile, "utf8"));
  if (raw.totalXRP !== undefined && raw.totalCoin === undefined) {
    raw.totalCoin = raw.totalXRP;
    delete raw.totalXRP;
  }
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
    try {
      const c = await fetchCandles(coin.symbol, "1D", 2);
      coinPrice = c[c.length - 1].close;
    } catch {}

    console.log(`\n── ${coin.displayName} (${coin.symbol}) ─────────────────────────────────\n`);
    console.log(`  Portfolio:       ₹${(coin.portfolioUSD * INR_RATE).toFixed(0)} ($${coin.portfolioUSD})`);
    console.log(`  Daily DCA:       ${coin.dailyDCAPct}% = $${(coin.portfolioUSD * coin.dailyDCAPct / 100).toFixed(2)}/day`);
    console.log(`  Target:          $${coin.targetLow.toLocaleString()} – $${coin.targetHigh.toLocaleString()}`);
    console.log(`  Mode:            ${PAPER_TRADING ? "PAPER" : "LIVE"}\n`);

    if (state.trades.length === 0) {
      console.log("  No trades yet.\n");
      continue;
    }

    const currentVal = state.totalCoin * coinPrice;
    const pnlUSD = currentVal - state.totalCostUSD;
    const pnlPct = state.totalCostUSD > 0 ? (pnlUSD / state.totalCostUSD * 100).toFixed(2) : 0;
    console.log(`  Total ${coin.displayName}:      ${state.totalCoin.toFixed(4)}`);
    console.log(`  Avg Entry:       $${state.avgEntryPrice.toFixed(4)}`);
    console.log(`  Cost Basis:      $${state.totalCostUSD.toFixed(2)} (₹${(state.totalCostUSD * INR_RATE).toFixed(0)})`);
    if (coinPrice > 0) {
      console.log(`  Current Price:   $${coinPrice.toFixed(4)}`);
      console.log(`  Current Value:   $${currentVal.toFixed(2)} (₹${(currentVal * INR_RATE).toFixed(0)})`);
      console.log(`  P&L:             ${pnlUSD >= 0 ? "+" : ""}$${pnlUSD.toFixed(2)} (${pnlPct}%)`);
    }

    const tLow = state.totalCoin * coin.targetLow;
    const tHigh = state.totalCoin * coin.targetHigh;
    console.log(`\n  At $${coin.targetLow.toLocaleString()} target: $${tLow.toFixed(2)} (₹${(tLow * INR_RATE).toFixed(0)}) | +${state.totalCostUSD > 0 ? ((tLow / state.totalCostUSD - 1) * 100).toFixed(0) : 0}%`);
    console.log(`  At $${coin.targetHigh.toLocaleString()} target: $${tHigh.toFixed(2)} (₹${(tHigh * INR_RATE).toFixed(0)}) | +${state.totalCostUSD > 0 ? ((tHigh / state.totalCostUSD - 1) * 100).toFixed(0) : 0}%`);

    console.log("\n  Tranches:");
    console.log(`    T1 (25% capitulation): ${state.tranches?.tranche1Deployed ? "✅ Deployed" : "⏳ Waiting"}`);
    console.log(`    T2 (25% spring):       ${state.tranches?.tranche2Deployed ? "✅ Deployed" : "⏳ Waiting"}`);
    console.log(`    DCA (${coin.dailyDCAPct}%/day):         Running — ${state.trades.length} buys`);
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
    console.log(`\n  📦 Holding: ${state.totalCoin.toFixed(4)} ${coin.displayName} | Avg: $${state.avgEntryPrice.toFixed(4)} | Cost: $${state.totalCostUSD.toFixed(2)}`);
  }

  if (state.lastDCADate === today) {
    console.log(`  ✅ DCA done today. Next check: tomorrow.\n`);
    return;
  }

  const p = await detectCoinPhase(btc, coin.symbol);

  console.log(`\n── BCB Signal Report — ${coin.displayName} ───────────────────────────\n`);
  console.log(`  BTC Price:         $${btc.btcPrice.toFixed(0)}`);
  console.log(`  100-week MA:       $${btc.ma100w ? btc.ma100w.toFixed(0) : "N/A"} (BTC ${btc.btcVsMA100 !== null ? (btc.btcVsMA100 >= 0 ? "+" : "") + btc.btcVsMA100.toFixed(1) + "%" : "N/A"})`);
  console.log(`  200-week EMA:      $${btc.ema200w ? btc.ema200w.toFixed(0) : "N/A"} (BTC ${btc.btcVsEMA200 !== null ? (btc.btcVsEMA200 >= 0 ? "+" : "") + btc.btcVsEMA200.toFixed(1) + "%" : "N/A"})`);
  console.log(`  Weekly RSI(14):    ${btc.weeklyRSI !== null ? btc.weeklyRSI.toFixed(1) : "N/A"}`);
  console.log(`  Weekly MACD:       ${btc.weeklyMACD !== null ? (btc.weeklyMACD >= 0 ? "+" : "") + btc.weeklyMACD.toFixed(0) : "N/A"}`);
  console.log(`  Monthly RSI:       ${btc.monthlyRSI !== null ? btc.monthlyRSI.toFixed(1) : "N/A"}`);
  console.log(`  Monthly StochRSI:  ${btc.monthlyStochRSI !== null ? btc.monthlyStochRSI.toFixed(1) : "N/A"} ${btc.monthlyStochRSI !== null && btc.monthlyStochRSI < 5 ? "🔴 EXTREME LOW" : ""}`);
  console.log(`  Monthly MACD:      ${btc.monthlyMACD !== null ? (btc.monthlyMACD >= 0 ? "+" : "") + btc.monthlyMACD.toFixed(0) : "N/A"}`);
  console.log(`  BTC Dominance:     ${btc.btcDominance !== null ? btc.btcDominance.toFixed(1) + "%" : "N/A"}`);
  console.log(`  ${coin.displayName} Price:         $${p.coinPrice.toFixed(4)}`);
  console.log(`  ${coin.displayName} Weekly RSI:    ${p.coinWeeklyRSI !== null ? p.coinWeeklyRSI.toFixed(1) : "N/A"}`);
  console.log(`  ${coin.displayName} Wyckoff:       ${p.coinWyckoff}`);
  console.log(`  Spring (BTC):      ${btc.springDetected ? "🟢 YES" : "No"}`);
  console.log(`  Spring (${coin.displayName}):      ${p.coinSpring ? "🟢 YES" : "No"}`);
  console.log(`  ${coin.displayName} Parabola:      ${p.coinParabola ? "🔴 YES — 100%+ in 10 days! SELL SIGNAL" : "No"}`);
  console.log(`  Bearish Divergence:${btc.bearishDivergence ? " ⚠️ YES" : " No"}`);
  console.log(`\n  ── Macro & Sentiment ─────────────────────────────────`);
  console.log(`  VIX:               ${btc.vix ? btc.vix.current.toFixed(1) + (btc.vix.current > 30 ? " 🔴 HIGH FEAR" : btc.vix.current < 14 ? " 🟢 LOW (complacency)" : " — normal") : "N/A"}`);
  console.log(`  Fear & Greed:      ${btc.fearGreed ? btc.fearGreed.value + " — " + btc.fearGreed.label : "N/A"}`);
  console.log(`  Russell 2000:      ${btc.russell2000 ? "$" + btc.russell2000.current.toFixed(2) + " (" + btc.russell2000.pctFromHigh.toFixed(1) + "% from 90d high)" : "N/A"}`);
  console.log(`  Dow Jones:         ${btc.dowJones ? "$" + btc.dowJones.current.toFixed(0) + " (" + btc.dowJones.pctFromHigh.toFixed(1) + "% from 90d high)" : "N/A"}`);
  console.log(`  IGV (software):    ${btc.igv ? "$" + btc.igv.current.toFixed(2) + " (" + btc.igv.pctFromHigh.toFixed(1) + "% from 90d high)" : "N/A"}`);

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

  const maxPositionUSD = coin.portfolioUSD * (coin.maxPositionPct / 100);
  const remainingCapacity = maxPositionUSD - state.totalCostUSD;
  const dailyDCAAmount = coin.portfolioUSD * coin.dailyDCAPct / 100;

  if (p.phase === "DISTRIBUTION" || p.phase === "LATE MARKUP") {
    console.log(`  🚫 ${p.phase} — no new buys.`);
    let sellPct = 0;
    if (p.distScore >= 5 || p.coinParabola) {
      sellPct = 75;
      console.log(`  🔴 URGENT: ${p.distScore} distribution signals — reduce 75% of position!`);
    } else if (p.distScore >= 3) {
      sellPct = 25;
      console.log(`  ⚠️  ${p.distScore} distribution signals — reduce 25% of position.`);
    }
    if (sellPct > 0 && state.totalCoin > 0) {
      const sellCoin = state.totalCoin * (sellPct / 100);
      const sellValueUSD = sellCoin * p.coinPrice;
      const sellValueINR = sellValueUSD * INR_RATE;
      const pnlUSD = (p.coinPrice - state.avgEntryPrice) * sellCoin;
      console.log(`\n  📋 REDUCE: Sell ${sellCoin.toFixed(4)} ${coin.displayName} @ $${p.coinPrice.toFixed(4)}`);
      console.log(`  Value: $${sellValueUSD.toFixed(2)} (₹${sellValueINR.toFixed(0)})`);
      console.log(`  P&L:   ${pnlUSD >= 0 ? "+" : ""}$${pnlUSD.toFixed(2)}`);
      await notify(
        `🔴 BCB SELL ALERT — ${coin.symbol} — ${p.distScore} SIGNALS`,
        `Reduce ${sellPct}% of ${coin.displayName} position!\nSell ${sellCoin.toFixed(4)} ${coin.displayName} @ $${p.coinPrice.toFixed(4)}\nValue: $${sellValueUSD.toFixed(2)} (₹${sellValueINR.toFixed(0)})\nP&L: ${pnlUSD >= 0 ? "+" : ""}$${pnlUSD.toFixed(2)}\n\nSignals:\n${p.distSignals.map((s) => s.signal).join("\n")}`,
        p.distScore >= 5 ? "urgent" : "high"
      );
    }
    state.lastDCADate = today;
    saveDCAState(coin.dcaFile, state);
    return;
  }

  if (remainingCapacity <= 0) {
    console.log(`  ℹ️  Max position reached ($${maxPositionUSD.toFixed(2)}) — holding.`);
    state.lastDCADate = today;
    saveDCAState(coin.dcaFile, state);
    return;
  }

  let executed = false;

  if (p.accumScore >= 8 && !state.tranches?.tranche1Deployed) {
    const t1Amount = Math.min(coin.portfolioUSD * 0.25, remainingCapacity);
    const coinQty = t1Amount / p.coinPrice;
    console.log(`  🚀 TRANCHE 1 — Capitulation entry (score: ${p.accumScore}/10)`);
    console.log(`     Buy $${t1Amount.toFixed(2)} = ${coinQty.toFixed(4)} ${coin.displayName} @ $${p.coinPrice.toFixed(4)}`);
    state.totalCoin += coinQty;
    state.totalCostUSD += t1Amount;
    state.avgEntryPrice = state.totalCostUSD / state.totalCoin;
    if (!state.tranches) state.tranches = {};
    state.tranches.tranche1Deployed = true;
    state.lastDCADate = today;
    state.trades.push({ date: today, price: p.coinPrice, dcaUSD: t1Amount, coinQty, phase: p.phase, type: "TRANCHE 1 (25%)" });
    await notify(`🚀 ${coin.displayName} TRANCHE 1 — CAPITULATION`, `BCB Score: ${p.accumScore}/10\n${coinQty.toFixed(4)} ${coin.displayName} @ $${p.coinPrice.toFixed(4)}\n$${t1Amount.toFixed(2)} (₹${(t1Amount * INR_RATE).toFixed(0)})\nTarget: $${coin.targetLow}–$${coin.targetHigh}`, "high");
    await logToSheet({ timestamp: now.toISOString(), symbol: coin.symbol, side: "BUY", price: p.coinPrice, tradeSize: t1Amount, pnlPct: null, pnlINR: null, exitReason: `TRANCHE 1 | Score: ${p.accumScore}`, mode: PAPER_TRADING ? "PAPER" : "LIVE", rsi3: btc.weeklyRSI, vwap: btc.monthlyStochRSI, ema8: btc.btcDominance || 0 });
    executed = true;
  }

  if ((btc.springDetected || p.coinSpring) && !state.tranches?.tranche2Deployed && !executed) {
    const t2Amount = Math.min(coin.portfolioUSD * 0.25, remainingCapacity);
    const coinQty = t2Amount / p.coinPrice;
    console.log(`  🌱 TRANCHE 2 — Spring entry detected`);
    console.log(`     Buy $${t2Amount.toFixed(2)} = ${coinQty.toFixed(4)} ${coin.displayName} @ $${p.coinPrice.toFixed(4)}`);
    state.totalCoin += coinQty;
    state.totalCostUSD += t2Amount;
    state.avgEntryPrice = state.totalCostUSD / state.totalCoin;
    if (!state.tranches) state.tranches = {};
    state.tranches.tranche2Deployed = true;
    state.lastDCADate = today;
    state.trades.push({ date: today, price: p.coinPrice, dcaUSD: t2Amount, coinQty, phase: p.phase, type: "TRANCHE 2 (25% spring)" });
    await notify(`🌱 ${coin.displayName} TRANCHE 2 — SPRING`, `Spring detected!\n${coinQty.toFixed(4)} ${coin.displayName} @ $${p.coinPrice.toFixed(4)}\n$${t2Amount.toFixed(2)} (₹${(t2Amount * INR_RATE).toFixed(0)})`, "high");
    await logToSheet({ timestamp: now.toISOString(), symbol: coin.symbol, side: "BUY", price: p.coinPrice, tradeSize: t2Amount, pnlPct: null, pnlINR: null, exitReason: "TRANCHE 2 — Spring", mode: PAPER_TRADING ? "PAPER" : "LIVE", rsi3: btc.weeklyRSI, vwap: btc.monthlyStochRSI, ema8: btc.btcDominance || 0 });
    executed = true;
  }

  if (!executed) {
    const dcaAmount = Math.min(dailyDCAAmount, remainingCapacity);
    if (dcaAmount < 0.5) {
      console.log("  ℹ️  DCA amount too small — position near max.");
    } else {
      const coinQty = dcaAmount / p.coinPrice;
      console.log(`  📈 DAILY DCA — ${coin.dailyDCAPct}% of portfolio`);
      console.log(`     Buy $${dcaAmount.toFixed(2)} = ${coinQty.toFixed(4)} ${coin.displayName} @ $${p.coinPrice.toFixed(4)}`);
      state.totalCoin += coinQty;
      state.totalCostUSD += dcaAmount;
      state.avgEntryPrice = state.totalCostUSD / state.totalCoin;
      state.lastDCADate = today;
      state.trades.push({ date: today, price: p.coinPrice, dcaUSD: dcaAmount, coinQty, phase: p.phase, type: "DCA" });
      const newVal = state.totalCoin * p.coinPrice;
      const pnlUSD = newVal - state.totalCostUSD;
      const tLow = state.totalCoin * coin.targetLow;
      const tHigh = state.totalCoin * coin.targetHigh;
      console.log(`\n  Total ${coin.displayName}:    ${state.totalCoin.toFixed(4)} ${coin.displayName}`);
      console.log(`  Avg Entry:    $${state.avgEntryPrice.toFixed(4)}`);
      console.log(`  P&L:          ${pnlUSD >= 0 ? "+" : ""}$${pnlUSD.toFixed(2)}`);
      console.log(`  At $${coin.targetLow.toLocaleString()} target: $${tLow.toFixed(2)} (₹${(tLow * INR_RATE).toFixed(0)}) | +${((tLow / state.totalCostUSD - 1) * 100).toFixed(0)}%`);
      console.log(`  At $${coin.targetHigh.toLocaleString()} target: $${tHigh.toFixed(2)} (₹${(tHigh * INR_RATE).toFixed(0)}) | +${((tHigh / state.totalCostUSD - 1) * 100).toFixed(0)}%`);
      await notify(
        `📈 DCA BUY — ${coin.symbol}`,
        `${coinQty.toFixed(4)} ${coin.displayName} @ $${p.coinPrice.toFixed(4)}\nPhase: ${p.phase}\nTotal: ${state.totalCoin.toFixed(4)} ${coin.displayName}\nAvg: $${state.avgEntryPrice.toFixed(4)}\nAt $${coin.targetLow.toLocaleString()}: $${tLow.toFixed(2)} (₹${(tLow * INR_RATE).toFixed(0)})`,
        "default"
      );
      await logToSheet({ timestamp: now.toISOString(), symbol: coin.symbol, side: "BUY", price: p.coinPrice, tradeSize: dcaAmount, pnlPct: null, pnlINR: null, exitReason: `DCA — ${p.phase} | RSI:${btc.weeklyRSI?.toFixed(0)} StochRSI:${btc.monthlyStochRSI?.toFixed(0)} Dom:${btc.btcDominance?.toFixed(1)}%`, mode: PAPER_TRADING ? "PAPER" : "LIVE", rsi3: btc.weeklyRSI, vwap: btc.monthlyStochRSI, ema8: btc.btcDominance || 0 });
    }
  }

  saveDCAState(coin.dcaFile, state);
}

// ─── Main Loop ────────────────────────────────────────────────────────────────

async function run() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const isCloud = !existsSync(".env");
  if (isCloud) console.log("☁️  Cloud mode — Railway");

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  BCB Strategy Bot — XRP + ETH");
  console.log(`  ${now.toISOString()}`);
  console.log(`  Mode: ${PAPER_TRADING ? "📋 PAPER" : "🔴 LIVE"}`);
  console.log("═══════════════════════════════════════════════════════════");

  const anyPending = COINS.some((coin) => {
    const state = loadDCAState(coin.dcaFile, coin.symbol === "XRPUSDT");
    return state.lastDCADate !== today;
  });

  if (!anyPending) {
    console.log("  ✅ All coins DCA done today. Next check: tomorrow.\n");
    console.log("═══════════════════════════════════════════════════════════\n");
    return;
  }

  const btc = await fetchBTCMacroData();

  for (const coin of COINS) {
    try {
      await runCoin(coin, btc, today, now);
    } catch (err) {
      console.error(`  ❌ ${coin.symbol} error: ${err.message}`);
    }
  }

  console.log("\n═══════════════════════════════════════════════════════════\n");
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

if (process.argv.includes("--summary")) {
  generateDashboard().catch(console.error);
} else {
  (async () => {
    while (true) {
      try {
        await run();
      } catch (err) {
        console.error("Bot error:", err.message);
      }
      console.log("⏳ Waiting 60 seconds...\n");
      await new Promise((r) => setTimeout(r, 60_000));
    }
  })();
}
