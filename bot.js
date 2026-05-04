/**
 * BCB-Informed Scalping Bot
 * BlockchainBacker 4-Phase Macro Cycle × Sub-Hourly Scalping
 *
 * Architecture:
 *   Macro phase detection (BCB) → bias filter → micro scalp execution
 *
 * Setups implemented:
 *   1. Wyckoff Spring      — false break below support + volume spike + reversal
 *   2. BB Mean Reversion   — price at Bollinger Band extreme + RSI confirmation
 *   3. RSI Divergence      — 5-min price/RSI divergence → fade the move
 *
 * Timeframes: 5-min (setup detection) + 1-min (entry/exit)
 * Max hold:   15 minutes per trade
 * Paper trading mode by default.
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";

// ─── Config ───────────────────────────────────────────────────────────────────

const SYMBOL         = process.env.SCALP_SYMBOL       || "XRPUSDT";
const ACCOUNT_USD    = parseFloat(process.env.ACCOUNT_USD      || "120");
const RISK_PCT       = parseFloat(process.env.RISK_PCT         || "1.0");   // % account per trade
const MAX_DAILY_LOSS = parseFloat(process.env.MAX_DAILY_LOSS   || "2.0");   // % account, then stop
const MAX_TRADE_USD  = parseFloat(process.env.MAX_TRADE_USD    || "18");    // cap per trade
const PAPER_TRADING  = process.env.PAPER_TRADING !== "false";
const NTFY_CHANNEL   = process.env.NTFY_CHANNEL       || "xrp-bot-dhruvjyot";
const SHEET_URL      = process.env.GOOGLE_SHEET_URL   ||
  "https://script.google.com/macros/s/AKfycbzWdRn61TrnC0M0z91wgcMnIOJ6cjhYti21xdEnyNVFV5335qtisHk-nT46ugpIAmSW/exec";

// Indicator settings
const BB_PERIOD      = 20;
const BB_STD         = 2;
const RSI_PERIOD     = 14;
const ATR_PERIOD     = 14;
const VOL_MA_PERIOD  = 20;
const MACRO_CACHE_TTL = 60 * 60 * 1000;  // re-fetch macro every 1 hour

// Files
const POSITION_FILE  = "scalp-position.json";
const DAILY_PNL_FILE = "scalp-daily-pnl.json";
const MACRO_CACHE    = "macro-cache.json";

// ─── File Helpers ─────────────────────────────────────────────────────────────

function readJSON(file, def) {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { return def; }
}
function writeJSON(file, data) {
  writeFileSync(file, JSON.stringify(data, null, 2));
}
function deleteFile(file) {
  try { unlinkSync(file); } catch {}
}

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
  if (!SHEET_URL) return;
  try {
    await fetch(SHEET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    console.log("  📊 Logged to Sheet");
  } catch {}
}

// ─── Market Data ──────────────────────────────────────────────────────────────

async function fetchBinanceOHLCV(symbol, interval, limit = 100) {
  try {
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res  = await fetch(url);
    if (!res.ok) return null;
    const raw  = await res.json();
    return {
      times:   raw.map(c => c[0]),
      opens:   raw.map(c => parseFloat(c[1])),
      highs:   raw.map(c => parseFloat(c[2])),
      lows:    raw.map(c => parseFloat(c[3])),
      closes:  raw.map(c => parseFloat(c[4])),
      volumes: raw.map(c => parseFloat(c[5])),
    };
  } catch { return null; }
}

async function fetchYahooBar(symbol) {
  try {
    const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=90d`;
    const res  = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } });
    if (!res.ok) return null;
    const data = await res.json();
    const r    = data.chart?.result?.[0];
    if (!r) return null;
    const closes = r.indicators.quote[0].close.filter(v => v !== null);
    return { current: closes.at(-1), closes, high90d: Math.max(...closes), low90d: Math.min(...closes) };
  } catch { return null; }
}

async function fetchCoinGeckoDominance() {
  try {
    const res  = await fetch("https://api.coingecko.com/api/v3/global");
    const data = await res.json();
    return data.data?.market_cap_percentage?.btc ?? null;
  } catch { return null; }
}

async function fetchFearGreed() {
  try {
    const res  = await fetch("https://api.alternative.me/fng/?limit=1");
    const data = await res.json();
    return parseInt(data.data[0].value);
  } catch { return null; }
}

// ─── Technical Indicators ─────────────────────────────────────────────────────

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgG = gains / period, avgL = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + (d > 0 ? d : 0)) / period;
    avgL = (avgL * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG / avgL);
}

function calcRSIArray(closes, period = 14) {
  const out = [];
  for (let i = period + 1; i <= closes.length; i++) {
    out.push(calcRSI(closes.slice(0, i), period));
  }
  return out;
}

function calcSMA(values, period) {
  if (values.length < period) return null;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcBB(closes, period = 20, numStd = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mid   = slice.reduce((a, b) => a + b, 0) / period;
  const std   = Math.sqrt(slice.reduce((a, v) => a + (v - mid) ** 2, 0) / period);
  return { upper: mid + numStd * std, mid, lower: mid - numStd * std, std };
}

function calcATR(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1])
    ));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function calcVolMA(volumes, period = 20) {
  if (volumes.length < period) return null;
  return volumes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ─── Macro Bias (BCB Phase, cached 1 hour) ────────────────────────────────────

async function getMacroBias() {
  const cache = readJSON(MACRO_CACHE, {});
  if (cache.ts && Date.now() - cache.ts < MACRO_CACHE_TTL) {
    console.log(`  📡 Macro (cached): Phase=${cache.phase} Bias=${cache.bias} WeeklyRSI=${cache.weeklyRSI}`);
    return cache;
  }

  console.log("  📡 Fetching macro data...");
  const [weeklyBTC, russell, vix, fearGreed, dominance] = await Promise.all([
    fetchBinanceOHLCV("BTCUSDT", "1w", 120),
    fetchYahooBar("%5ERUT"),
    fetchYahooBar("%5EVIX"),
    fetchFearGreed(),
    fetchCoinGeckoDominance(),
  ]);

  if (!weeklyBTC) {
    console.log("  ⚠️  Weekly BTC data unavailable — using NEUTRAL bias");
    return { phase: "NEUTRAL", bias: "NONE", ts: Date.now() };
  }

  const weeklyRSI   = calcRSI(weeklyBTC.closes, 14);
  const sma100w     = calcSMA(weeklyBTC.closes, 100);
  const currentBTC  = weeklyBTC.closes.at(-1);
  const aboveMa100w = sma100w ? currentBTC > sma100w : null;

  // Russell 2000: 786 Fib from 90-day high/low
  let russellAbove786 = null;
  if (russell) {
    const fib786 = russell.high90d - (russell.high90d - russell.low90d) * 0.786;
    russellAbove786 = russell.current > fib786;
  }

  const vixSpike = vix ? vix.current > 28 : false;

  let phase = "NEUTRAL";
  let bias  = "NONE";

  // CAPITULATION — Weekly RSI < 30 + BTC near/below 100W MA or VIX spike
  if (weeklyRSI < 30 && (aboveMa100w === false || vixSpike)) {
    phase = "CAPITULATION";
    bias  = "BOTH";
  }
  // DISTRIBUTION — RSI > 70 + extreme greed
  else if (weeklyRSI > 70 && fearGreed !== null && fearGreed > 75) {
    phase = "DISTRIBUTION";
    bias  = "SHORT";
  }
  // MARKUP — RSI > 50 + above 100W MA + Russell above 786 Fib
  else if (weeklyRSI > 50 && aboveMa100w && russellAbove786 !== false) {
    phase = "MARKUP";
    bias  = "LONG";
  }
  // ACCUMULATION — RSI 30–55, recovering from capitulation
  else if (weeklyRSI >= 30 && weeklyRSI <= 55 && aboveMa100w) {
    phase = "ACCUMULATION";
    bias  = "LONG";
  }

  const result = {
    phase, bias,
    weeklyRSI:      weeklyRSI?.toFixed(1),
    currentBTC:     currentBTC?.toFixed(0),
    sma100w:        sma100w?.toFixed(0),
    aboveMa100w,
    dominance:      dominance?.toFixed(1),
    russellAbove786,
    fearGreed,
    vixSpike,
    ts: Date.now(),
  };
  writeJSON(MACRO_CACHE, result);
  console.log(`  📡 Macro: Phase=${phase} Bias=${bias} WeeklyRSI=${weeklyRSI?.toFixed(1)} BTC=${currentBTC?.toFixed(0)} DOM=${dominance?.toFixed(1)}%`);
  return result;
}

// ─── Setup 1: Wyckoff Spring ──────────────────────────────────────────────────
// False break below 5-min support + volume spike + immediate recovery + RSI extreme

function detectSpring(m5, m1, atr) {
  if (!atr) return null;
  const rsi1m   = calcRSI(m1.closes, RSI_PERIOD);
  const volMA5m = calcVolMA(m5.volumes.slice(0, -1), VOL_MA_PERIOD);
  if (rsi1m === null || !volMA5m) return null;

  const support   = Math.min(...m5.lows.slice(-21, -1));
  const prevClose = m5.closes.at(-2);
  const prevLow   = m5.lows.at(-2);
  const prevVol   = m5.volumes.at(-2);
  const price     = m1.closes.at(-1);

  if (
    prevClose < support &&          // prev 5-min closed below support (spring)
    prevVol   > volMA5m * 2.0 &&   // volume spike ≥ 2× average
    price     > support &&          // price has recovered above support
    rsi1m     < 25                  // 1-min RSI deeply oversold
  ) {
    const swingHigh = Math.max(...m5.highs.slice(-15));
    return {
      setup: "WYCKOFF_SPRING",
      direction: "LONG",
      entry: price,
      target: swingHigh + 0.3 * atr,
      stop:   Math.min(prevLow, support) - 0.5 * atr,
      maxHoldMin: 15,
      reason: `Spring: support=${support.toFixed(5)} vol=${(prevVol / volMA5m).toFixed(1)}x RSI1m=${rsi1m.toFixed(1)}`,
    };
  }
  return null;
}

// ─── Setup 2: Bollinger Band Mean Reversion ───────────────────────────────────
// Price at 5-min BB extreme + 1-min RSI confirmation + volume

function detectBBReversion(m5, m1, atr) {
  if (!atr) return null;
  const bb5m    = calcBB(m5.closes, BB_PERIOD, BB_STD);
  const rsi1m   = calcRSI(m1.closes, RSI_PERIOD);
  const volMA1m = calcVolMA(m1.volumes.slice(0, -1), VOL_MA_PERIOD);
  if (!bb5m || rsi1m === null || !volMA1m) return null;

  const price   = m1.closes.at(-1);
  const lastVol = m1.volumes.at(-1);
  const volOK   = lastVol > volMA1m * 1.3;

  // LONG: price at/below lower BB + RSI oversold + volume spike
  if (price <= bb5m.lower && rsi1m < 30 && volOK) {
    return {
      setup: "BB_REVERSION",
      direction: "LONG",
      entry:  price,
      target: bb5m.mid,
      stop:   bb5m.lower - 0.3 * atr,
      maxHoldMin: 10,
      reason: `BB lower: price=${price.toFixed(5)} lower=${bb5m.lower.toFixed(5)} RSI1m=${rsi1m.toFixed(1)}`,
    };
  }

  // SHORT: price at/above upper BB + RSI overbought + volume spike
  if (price >= bb5m.upper && rsi1m > 70 && volOK) {
    return {
      setup: "BB_REVERSION",
      direction: "SHORT",
      entry:  price,
      target: bb5m.mid,
      stop:   bb5m.upper + 0.3 * atr,
      maxHoldMin: 10,
      reason: `BB upper: price=${price.toFixed(5)} upper=${bb5m.upper.toFixed(5)} RSI1m=${rsi1m.toFixed(1)}`,
    };
  }
  return null;
}

// ─── Setup 3: RSI Divergence ──────────────────────────────────────────────────
// 5-min price higher high + RSI lower high + volume decline → SHORT the fakeout

function detectDivergence(m5, m1, atr, bias) {
  if (!atr || bias !== "LONG") return null;  // only fade uptrends

  const rsiArr = calcRSIArray(m5.closes, RSI_PERIOD);
  if (rsiArr.length < 12) return null;

  const lb = 6;
  const recentHighPrice = Math.max(...m5.highs.slice(-lb));
  const recentHighRSI   = Math.max(...rsiArr.slice(-lb));
  const prevHighPrice   = Math.max(...m5.highs.slice(-(lb * 2), -lb));
  const prevHighRSI     = Math.max(...rsiArr.slice(-(lb * 2), -lb));
  const volMA5m         = calcVolMA(m5.volumes.slice(0, -1), VOL_MA_PERIOD);
  const currentVol5m    = m5.volumes.at(-1);
  if (!volMA5m) return null;

  const price = m1.closes.at(-1);

  if (
    recentHighPrice > prevHighPrice * 1.002 &&  // price: higher high (≥ 0.2% higher)
    recentHighRSI   < prevHighRSI - 3 &&         // RSI: lower high (≥ 3 pts divergence)
    currentVol5m    < volMA5m * 0.85             // volume declining on new high
  ) {
    return {
      setup: "RSI_DIVERGENCE",
      direction: "SHORT",
      entry:  price,
      target: Math.min(...m5.lows.slice(-lb)),
      stop:   recentHighPrice + 0.5 * atr,
      maxHoldMin: 12,
      reason: `Bearish div: price ${prevHighPrice.toFixed(5)}→${recentHighPrice.toFixed(5)} RSI ${prevHighRSI.toFixed(1)}→${recentHighRSI.toFixed(1)} vol ${(currentVol5m / volMA5m).toFixed(2)}x`,
    };
  }
  return null;
}

// ─── Position Management ──────────────────────────────────────────────────────

function loadPosition()      { return readJSON(POSITION_FILE, null); }
function savePosition(pos)   {
  if (pos === null) { deleteFile(POSITION_FILE); return; }
  writeJSON(POSITION_FILE, pos);
}
function loadDailyPnL() {
  const today = new Date().toISOString().slice(0, 10);
  const data  = readJSON(DAILY_PNL_FILE, {});
  if (data.date !== today) return { date: today, pnlUSD: 0, trades: 0, wins: 0 };
  return data;
}
function saveDailyPnL(data)  { writeJSON(DAILY_PNL_FILE, data); }

async function managePosition(pos, currentPrice) {
  const ageMin = (Date.now() - pos.entryTime) / 60000;
  const pnlPct = pos.direction === "LONG"
    ? (currentPrice - pos.entry) / pos.entry * 100
    : (pos.entry - currentPrice) / pos.entry * 100;

  let closeReason = null;
  if (pos.direction === "LONG") {
    if (currentPrice >= pos.target) closeReason = "TARGET_HIT";
    if (currentPrice <= pos.stop)   closeReason = "STOP_HIT";
  } else {
    if (currentPrice <= pos.target) closeReason = "TARGET_HIT";
    if (currentPrice >= pos.stop)   closeReason = "STOP_HIT";
  }
  if (ageMin >= pos.maxHoldMin) closeReason = "TIME_LIMIT";

  if (!closeReason) {
    console.log(`  📌 Holding ${pos.direction} ${pos.setup} | P&L: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(3)}% | Age: ${ageMin.toFixed(1)}min | Target: ${pos.target.toFixed(5)} | Stop: ${pos.stop.toFixed(5)}`);
    return false;
  }

  // ── Close position ──
  const pnlUSD = (pnlPct / 100) * pos.sizeUSD;
  const daily  = loadDailyPnL();
  daily.pnlUSD += pnlUSD;
  daily.trades++;
  if (pnlUSD > 0) daily.wins++;
  saveDailyPnL(daily);
  savePosition(null);

  const emoji = pnlUSD > 0 ? "✅" : "❌";
  console.log(`  ${emoji} CLOSED ${pos.direction} ${pos.setup} | ${closeReason} | P&L: ${pnlUSD >= 0 ? "+" : ""}$${pnlUSD.toFixed(3)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(3)}%)`);
  console.log(`  📅 Daily: $${daily.pnlUSD.toFixed(3)} | Trades: ${daily.trades} | Wins: ${daily.wins}/${daily.trades}`);

  const tag = PAPER_TRADING ? "[PAPER] " : "";
  await notify(
    `${tag}Scalp ${closeReason === "TARGET_HIT" ? "✅ Win" : "❌ Loss"} — ${pos.setup}`,
    `${pos.direction} ${SYMBOL}\n` +
    `Entry: ${pos.entry.toFixed(5)} → Exit: ${currentPrice.toFixed(5)}\n` +
    `P&L: ${pnlUSD >= 0 ? "+" : ""}$${pnlUSD.toFixed(3)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(3)}%)\n` +
    `Reason: ${closeReason} | Age: ${ageMin.toFixed(1)}min\n` +
    `Daily: ${daily.pnlUSD >= 0 ? "+" : ""}$${daily.pnlUSD.toFixed(3)} | ${daily.wins}W/${daily.trades - daily.wins}L`,
    pnlUSD > 0 ? "high" : "default"
  );

  await logToSheet({
    Date:           new Date().toISOString().slice(0, 10),
    Time:           new Date().toISOString().slice(11, 19),
    Symbol:         SYMBOL,
    Side:           pos.direction === "LONG" ? "BUY" : "SELL",
    Setup:          pos.setup,
    "Entry ($)":    pos.entry,
    "Exit ($)":     currentPrice,
    "Size ($)":     pos.sizeUSD.toFixed(2),
    "P&L ($)":      pnlUSD.toFixed(3),
    "P&L %":        pnlPct.toFixed(3),
    "Close Reason": closeReason,
    "Hold Min":     ageMin.toFixed(1),
    Phase:          pos.phase,
    Mode:           PAPER_TRADING ? "PAPER" : "LIVE",
  });

  return true;
}

async function openPosition(setup, macro) {
  const { direction, entry, target, stop, maxHoldMin, reason, setup: setupName } = setup;

  // ATR-based sizing: risk% of account ÷ distance to stop
  const riskUSD  = ACCOUNT_USD * (RISK_PCT / 100);
  const distance = Math.abs(entry - stop);
  const units    = distance > 0 ? riskUSD / distance : 0;
  const sizeUSD  = Math.min(units * entry, MAX_TRADE_USD);

  // Enforce minimum R/R of 1.5
  const rrRatio = Math.abs(target - entry) / Math.abs(entry - stop);
  if (rrRatio < 1.5) {
    console.log(`  ⚠️  ${setupName} R/R=${rrRatio.toFixed(2)} < 1.5 — skipping`);
    return;
  }

  const pos = {
    symbol: SYMBOL, direction,
    setup: setupName,
    entry, target, stop, maxHoldMin, sizeUSD,
    entryTime: Date.now(),
    phase: macro.phase,
    reason,
  };
  savePosition(pos);

  const tgtPct = (Math.abs(target - entry) / entry * 100).toFixed(2);
  const stpPct = (Math.abs(stop   - entry) / entry * 100).toFixed(2);
  const tag    = PAPER_TRADING ? "[PAPER] " : "";

  console.log(`  🚀 ENTER ${direction} via ${setupName} @ ${entry.toFixed(5)}`);
  console.log(`     Target: ${target.toFixed(5)} (+${tgtPct}%) | Stop: ${stop.toFixed(5)} (-${stpPct}%) | R/R: ${rrRatio.toFixed(2)} | Size: $${sizeUSD.toFixed(2)}`);
  console.log(`     Reason: ${reason}`);

  await notify(
    `${tag}New Scalp — ${setupName} ${direction}`,
    `${direction} ${SYMBOL} @ ${entry.toFixed(5)}\n` +
    `Target: ${target.toFixed(5)} (+${tgtPct}%)\n` +
    `Stop:   ${stop.toFixed(5)} (-${stpPct}%)\n` +
    `R/R: ${rrRatio.toFixed(2)} | Size: $${sizeUSD.toFixed(2)}\n` +
    `Phase: ${macro.phase}`,
    "high"
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const timeStr = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`\n⚡ BCB Scalper — ${timeStr} UTC [${PAPER_TRADING ? "PAPER" : "LIVE"}]`);

  // 1. Daily loss guard
  const daily    = loadDailyPnL();
  const lossLimit = ACCOUNT_USD * (MAX_DAILY_LOSS / 100);
  if (daily.pnlUSD <= -lossLimit) {
    console.log(`  🛑 Daily loss limit hit ($${daily.pnlUSD.toFixed(2)}). No new trades today.`);
    return;
  }
  console.log(`  📅 Daily: ${daily.pnlUSD >= 0 ? "+" : ""}$${daily.pnlUSD.toFixed(3)} | Trades: ${daily.trades} | Wins: ${daily.wins}`);

  // 2. Macro bias (cached hourly)
  const macro = await getMacroBias();
  if (macro.phase === "NEUTRAL" || macro.bias === "NONE") {
    console.log("  ⏸️  No clear macro phase — waiting.");
    return;
  }

  // 3. Accumulation phase: max 2 scalps/day
  if (macro.phase === "ACCUMULATION" && daily.trades >= 2) {
    console.log("  ⏸️  Accumulation phase: 2-trade daily limit reached. Patience.");
    return;
  }

  // 4. Fetch 5-min + 1-min candles
  const [m5, m1] = await Promise.all([
    fetchBinanceOHLCV(SYMBOL, "5m", 100),
    fetchBinanceOHLCV(SYMBOL, "1m", 100),
  ]);
  if (!m5 || !m1) { console.log("  ⚠️  Market data unavailable."); return; }

  const price  = m1.closes.at(-1);
  const atr5m  = calcATR(m5.highs, m5.lows, m5.closes, ATR_PERIOD);
  const rsi1m  = calcRSI(m1.closes, RSI_PERIOD);
  const bb5m   = calcBB(m5.closes, BB_PERIOD, BB_STD);

  console.log(`  💹 ${SYMBOL} @ $${price.toFixed(5)} | ATR5m: ${atr5m?.toFixed(5)} | RSI1m: ${rsi1m?.toFixed(1)}`);
  if (bb5m) {
    const pos = price < bb5m.lower ? "BELOW ↓" : price > bb5m.upper ? "ABOVE ↑" : "inside";
    console.log(`  📐 BB5m: ${bb5m.lower.toFixed(5)} / ${bb5m.mid.toFixed(5)} / ${bb5m.upper.toFixed(5)} [${pos}]`);
  }

  // 5. Manage any open position
  const openPos = loadPosition();
  if (openPos) {
    await managePosition(openPos, price);
    return;  // one position at a time
  }

  // 6. Scan setups, filtered by macro bias
  const canLong  = macro.bias === "LONG"  || macro.bias === "BOTH";
  const canShort = macro.bias === "SHORT" || macro.bias === "BOTH";

  const candidates = [
    detectSpring(m5, m1, atr5m),
    detectBBReversion(m5, m1, atr5m),
    detectDivergence(m5, m1, atr5m, macro.bias),
  ]
    .filter(Boolean)
    .filter(s =>
      (s.direction === "LONG"  && canLong) ||
      (s.direction === "SHORT" && canShort)
    );

  if (candidates.length === 0) {
    const bbStatus = bb5m
      ? (price < bb5m.lower ? "at lower" : price > bb5m.upper ? "at upper" : `inside (${((price - bb5m.lower) / (bb5m.upper - bb5m.lower) * 100).toFixed(0)}%)`)
      : "n/a";
    console.log(`  💤 No setups. Bias=${macro.bias} RSI1m=${rsi1m?.toFixed(1)} BB: ${bbStatus}`);
    return;
  }

  console.log(`  🎯 ${candidates.length} setup(s): ${candidates.map(s => `${s.setup}(${s.direction})`).join(", ")}`);
  await openPosition(candidates[0], macro);
}

run().catch(e => {
  console.error("❌ Fatal:", e.message);
  process.exit(1);
});
