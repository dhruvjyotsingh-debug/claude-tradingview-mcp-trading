/**
 * BCB-Informed Scalping Bot — ALL 5 SETUPS
 * BlockchainBacker 4-Phase Macro Cycle × Sub-Hourly Scalping
 *
 * Architecture:
 *   Macro phase (BCB) → bias filter → micro scalp on 15-min/5-min/1-min
 *
 * Setups (ALL 5 from strategy doc):
 *   1. Wyckoff Spring          — false break below support + volume spike + reversal
 *   2. BB Mean Reversion       — price at Bollinger Band extreme + RSI confirmation
 *   3. Volume Profile Liq.     — break of high-volume level + 3× vol spike → fade
 *   4. Macro Sentiment Flush   — sudden 1%+ move → wait 30s → fade on RSI extreme
 *   5. RSI Divergence          — 5-min price/RSI divergence → short the fakeout
 *
 * Extras:
 *   - Multi-timeframe RSI confluence (1-min + 5-min + 15-min) → higher probability
 *   - Trading hours filter (best hours: 1-4 AM, 8-11 AM, 6-8 PM UTC)
 *   - Phase-specific rules (Accumulation max 2/day, Distribution short-only, etc.)
 *   - ATR-based stops, 1:1.5 min R/R, daily 2% loss limit
 */

import "dotenv/config";
import { readFileSync, writeFileSync, unlinkSync } from "fs";

// ─── Config ───────────────────────────────────────────────────────────────────

const SYMBOL          = process.env.SCALP_SYMBOL     || "XRPUSDT";
const ACCOUNT_USD     = parseFloat(process.env.ACCOUNT_USD     || "120");
const RISK_PCT        = parseFloat(process.env.RISK_PCT        || "1.0");  // % per trade
const MAX_DAILY_LOSS  = parseFloat(process.env.MAX_DAILY_LOSS  || "2.0");  // % stop day
const MAX_TRADE_USD   = parseFloat(process.env.MAX_TRADE_USD   || "18");   // hard cap
const MAX_TRADES_DAY  = parseInt(process.env.MAX_TRADES_DAY    || "8");    // quality > qty
const PAPER_TRADING   = process.env.PAPER_TRADING !== "false";
const NTFY_CHANNEL    = process.env.NTFY_CHANNEL     || "xrp-bot-dhruvjyot";
const SHEET_URL       = process.env.GOOGLE_SHEET_URL ||
  "https://script.google.com/macros/s/AKfycbzWdRn61TrnC0M0z91wgcMnIOJ6cjhYti21xdEnyNVFV5335qtisHk-nT46ugpIAmSW/exec";

const BB_PERIOD       = 20;
const BB_STD          = 2;
const RSI_PERIOD      = 14;
const ATR_PERIOD      = 14;
const VOL_MA_PERIOD   = 20;
const MACRO_TTL       = 60 * 60 * 1000;  // 1 hour cache

// Best scalping hours UTC (from strategy doc)
// 1–4 AM = crypto volatility spike
// 8–11 AM = US market open / macro news
// 18–20 PM = Asian liquidations
const BEST_HOURS_UTC  = [[1,4],[8,11],[18,20]];

const POSITION_FILE   = "scalp-position.json";
const DAILY_FILE      = "scalp-daily-pnl.json";
const MACRO_FILE      = "macro-cache.json";
const FLUSH_FILE      = "flush-state.json";  // tracks last big move for Setup 4

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readJSON(f, d) { try { return JSON.parse(readFileSync(f,"utf8")); } catch { return d; } }
function writeJSON(f, d) { writeFileSync(f, JSON.stringify(d, null, 2)); }
function delFile(f) { try { unlinkSync(f); } catch {} }

function isGoodHour() {
  const h = new Date().getUTCHours();
  return BEST_HOURS_UTC.some(([from, to]) => h >= from && h < to);
}

// ─── Notifications ────────────────────────────────────────────────────────────

async function notify(title, body, priority = "default") {
  try {
    await fetch(`https://ntfy.sh/${NTFY_CHANNEL}`, {
      method: "POST",
      headers: { Title: title, Priority: priority, Tags: "chart_increasing" },
      body,
    });
  } catch {}
}

async function logToSheet(row) {
  if (!SHEET_URL) return;
  try {
    await fetch(SHEET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(row),
    });
  } catch {}
}

// ─── Market Data ──────────────────────────────────────────────────────────────

async function fetchOHLCV(symbol, interval, limit = 100) {
  try {
    const res = await fetch(
      `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
    );
    if (!res.ok) return null;
    const raw = await res.json();
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

async function fetchYahoo(symbol) {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=90d`,
      { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const r    = data.chart?.result?.[0];
    if (!r) return null;
    const closes = r.indicators.quote[0].close.filter(v => v !== null);
    return { current: closes.at(-1), closes, high: Math.max(...closes), low: Math.min(...closes) };
  } catch { return null; }
}

async function fetchDominance() {
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

// ─── Indicators ───────────────────────────────────────────────────────────────

function rsi(closes, p = 14) {
  if (closes.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = closes[i]-closes[i-1]; d>0 ? g+=d : l-=d; }
  let ag = g/p, al = l/p;
  for (let i = p+1; i < closes.length; i++) {
    const d = closes[i]-closes[i-1];
    ag = (ag*(p-1)+(d>0?d:0))/p;
    al = (al*(p-1)+(d<0?-d:0))/p;
  }
  return al===0 ? 100 : 100-100/(1+ag/al);
}

function rsiArray(closes, p = 14) {
  const out = [];
  for (let i = p+1; i <= closes.length; i++) out.push(rsi(closes.slice(0,i), p));
  return out;
}

function sma(vals, p) {
  if (vals.length < p) return null;
  return vals.slice(-p).reduce((a,b)=>a+b,0)/p;
}

function bb(closes, p = 20, n = 2) {
  if (closes.length < p) return null;
  const sl  = closes.slice(-p);
  const mid = sl.reduce((a,b)=>a+b,0)/p;
  const std = Math.sqrt(sl.reduce((a,v)=>a+(v-mid)**2,0)/p);
  return { upper: mid+n*std, mid, lower: mid-n*std, std };
}

function atr(highs, lows, closes, p = 14) {
  if (closes.length < p+1) return null;
  const trs = [];
  for (let i = 1; i < closes.length; i++)
    trs.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
  return trs.slice(-p).reduce((a,b)=>a+b,0)/p;
}

function volma(vols, p = 20) {
  if (vols.length < p) return null;
  return vols.slice(-p).reduce((a,b)=>a+b,0)/p;
}

// Multi-timeframe RSI confluence score (1=low, 3=high probability)
function confluenceScore(rsi1m, rsi5m, rsi15m, direction) {
  let score = 0;
  if (direction === "LONG") {
    if (rsi1m  !== null && rsi1m  < 30) score++;
    if (rsi5m  !== null && rsi5m  < 35) score++;
    if (rsi15m !== null && rsi15m < 40) score++;
  } else {
    if (rsi1m  !== null && rsi1m  > 70) score++;
    if (rsi5m  !== null && rsi5m  > 65) score++;
    if (rsi15m !== null && rsi15m > 60) score++;
  }
  return score;
}

// ─── Macro Bias ───────────────────────────────────────────────────────────────

async function getMacro() {
  const cache = readJSON(MACRO_FILE, {});
  if (cache.ts && Date.now()-cache.ts < MACRO_TTL) {
    console.log(`  📡 Macro(cached): ${cache.phase} Bias=${cache.bias} RSI=${cache.weeklyRSI}`);
    return cache;
  }
  console.log("  📡 Fetching macro...");
  const [wBTC, russell, vix, fg, dom] = await Promise.all([
    fetchOHLCV("BTCUSDT","1w",120), fetchYahoo("%5ERUT"),
    fetchYahoo("%5EVIX"), fetchFearGreed(), fetchDominance(),
  ]);
  if (!wBTC) return { phase:"NEUTRAL", bias:"NONE", ts: Date.now() };

  const weeklyRSI  = rsi(wBTC.closes, 14);
  const ma100w     = sma(wBTC.closes, 100);
  const btcNow     = wBTC.closes.at(-1);
  const aboveMA    = ma100w ? btcNow > ma100w : null;

  // Russell 786 Fib
  let russ786 = null;
  if (russell) {
    const fib = russell.high - (russell.high - russell.low) * 0.786;
    russ786   = russell.current > fib;
  }

  // Weekly RSI bearish divergence (price higher but RSI lower over last 4 weeks)
  const rsiArr4w      = rsiArray(wBTC.closes, 14).slice(-5);
  const bearishRSIDiv = rsiArr4w.length >= 4 &&
    wBTC.closes.at(-1) > wBTC.closes.at(-4) &&   // price going up
    rsiArr4w.at(-1) < rsiArr4w.at(-4) - 3;        // RSI going down

  const vixSpike = vix ? vix.current > 28 : false;

  let phase = "NEUTRAL", bias = "NONE";

  if (weeklyRSI < 30 && (aboveMA === false || vixSpike)) {
    phase = "CAPITULATION"; bias = "BOTH";
  } else if (weeklyRSI > 70 && fg !== null && fg > 75) {
    phase = "DISTRIBUTION"; bias = "SHORT";
  } else if (bearishRSIDiv && weeklyRSI > 60) {
    phase = "DISTRIBUTION"; bias = "SHORT";  // RSI divergence at top
  } else if (weeklyRSI > 50 && aboveMA && russ786 !== false) {
    phase = "MARKUP"; bias = "LONG";
  } else if (weeklyRSI >= 30 && weeklyRSI <= 55 && aboveMA) {
    phase = "ACCUMULATION"; bias = "LONG";
  }

  const result = {
    phase, bias,
    weeklyRSI:   weeklyRSI?.toFixed(1),
    btcNow:      btcNow?.toFixed(0),
    ma100w:      ma100w?.toFixed(0),
    aboveMA, russ786, dom: dom?.toFixed(1),
    fearGreed: fg, vixSpike, bearishRSIDiv,
    ts: Date.now(),
  };
  writeJSON(MACRO_FILE, result);
  console.log(`  📡 Macro: ${phase} Bias=${bias} RSI=${weeklyRSI?.toFixed(1)} BTC=${btcNow?.toFixed(0)} DOM=${dom?.toFixed(1)}%`);
  return result;
}

// ─── Setup 1: Wyckoff Spring ──────────────────────────────────────────────────

function detectSpring(m5, m1, atr5m) {
  if (!atr5m) return null;
  const rsi1m   = rsi(m1.closes, RSI_PERIOD);
  const vma5m   = volma(m5.volumes.slice(0,-1), VOL_MA_PERIOD);
  if (rsi1m === null || !vma5m) return null;

  const support   = Math.min(...m5.lows.slice(-21,-1));
  const prevClose = m5.closes.at(-2);
  const prevLow   = m5.lows.at(-2);
  const prevVol   = m5.volumes.at(-2);
  const price     = m1.closes.at(-1);

  if (prevClose < support && prevVol > vma5m*2.0 && price > support && rsi1m < 25) {
    const swingHigh = Math.max(...m5.highs.slice(-15));
    return {
      setup: "WYCKOFF_SPRING", direction: "LONG",
      entry: price,
      target: swingHigh + 0.3*atr5m,
      stop:   Math.min(prevLow, support) - 0.5*atr5m,
      maxHoldMin: 15,
      reason: `Spring: support=${support.toFixed(5)} vol=${(prevVol/vma5m).toFixed(1)}x RSI1m=${rsi1m.toFixed(1)}`,
    };
  }
  return null;
}

// ─── Setup 2: BB Mean Reversion ───────────────────────────────────────────────

function detectBBReversion(m5, m1, atr5m) {
  if (!atr5m) return null;
  const bb5m  = bb(m5.closes, BB_PERIOD, BB_STD);
  const rsi1m = rsi(m1.closes, RSI_PERIOD);
  const vma1m = volma(m1.volumes.slice(0,-1), VOL_MA_PERIOD);
  if (!bb5m || rsi1m === null || !vma1m) return null;

  const price   = m1.closes.at(-1);
  const volOK   = m1.volumes.at(-1) > vma1m * 1.3;

  if (price <= bb5m.lower && rsi1m < 30 && volOK) {
    return {
      setup: "BB_REVERSION", direction: "LONG",
      entry: price, target: bb5m.mid,
      stop:  bb5m.lower - 0.3*atr5m, maxHoldMin: 10,
      reason: `BB lower: ${price.toFixed(5)} lower=${bb5m.lower.toFixed(5)} RSI1m=${rsi1m.toFixed(1)}`,
    };
  }
  if (price >= bb5m.upper && rsi1m > 70 && volOK) {
    return {
      setup: "BB_REVERSION", direction: "SHORT",
      entry: price, target: bb5m.mid,
      stop:  bb5m.upper + 0.3*atr5m, maxHoldMin: 10,
      reason: `BB upper: ${price.toFixed(5)} upper=${bb5m.upper.toFixed(5)} RSI1m=${rsi1m.toFixed(1)}`,
    };
  }
  return null;
}

// ─── Setup 3: Volume Profile Liquidation ──────────────────────────────────────
// Find the highest-volume price level in last 4h, detect break + spike → fade

function detectVolumeLiquidation(m5, m1, atr5m) {
  if (!atr5m) return null;

  // Use last 48 x 5-min candles = 4 hours
  const lookback = 48;
  const sliceH   = m5.highs.slice(-lookback);
  const sliceL   = m5.lows.slice(-lookback);
  const sliceC   = m5.closes.slice(-lookback);
  const sliceV   = m5.volumes.slice(-lookback);

  // Find highest-volume candle → that's the key level
  const maxVolIdx = sliceV.reduce((best, v, i) => v > sliceV[best] ? i : best, 0);
  const keyLevel  = (sliceH[maxVolIdx] + sliceL[maxVolIdx]) / 2;

  const price      = m1.closes.at(-1);
  const vma1m      = volma(m1.volumes.slice(0,-1), VOL_MA_PERIOD);
  const lastVol1m  = m1.volumes.at(-1);
  const rsi1m      = rsi(m1.closes, RSI_PERIOD);

  if (!vma1m || rsi1m === null) return null;

  const volSpike   = lastVol1m > vma1m * 3;   // 3× volume = liquidation
  const distFromKey = Math.abs(price - keyLevel) / keyLevel * 100;

  // Price broke through key level with 3× volume spike → RSI extreme → fade
  if (distFromKey < 0.3 && volSpike) {
    if (price < keyLevel && rsi1m < 20) {
      // Price dumped through key level → fade (buy the reversal)
      return {
        setup: "VOL_LIQUIDATION", direction: "LONG",
        entry: price,
        target: keyLevel + 0.5*atr5m,
        stop:   price - atr5m,
        maxHoldMin: 8,
        reason: `Vol liq: key=${keyLevel.toFixed(5)} vol=${(lastVol1m/vma1m).toFixed(1)}x RSI=${rsi1m.toFixed(1)} below level`,
      };
    }
    if (price > keyLevel && rsi1m > 80) {
      // Price pumped through key level → fade (short the reversal)
      return {
        setup: "VOL_LIQUIDATION", direction: "SHORT",
        entry: price,
        target: keyLevel - 0.5*atr5m,
        stop:   price + atr5m,
        maxHoldMin: 8,
        reason: `Vol liq: key=${keyLevel.toFixed(5)} vol=${(lastVol1m/vma1m).toFixed(1)}x RSI=${rsi1m.toFixed(1)} above level`,
      };
    }
  }
  return null;
}

// ─── Setup 4: Macro Sentiment Flush ───────────────────────────────────────────
// Sudden 1%+ move in last 1-min candle → wait 30s → fade on RSI extreme
// Strategy: "News hits → overshoot → reversal"

function detectSentimentFlush(m1, atr5m, macro) {
  if (!atr5m) return null;

  const closes  = m1.closes;
  const price   = closes.at(-1);
  const prev    = closes.at(-2);
  const movePct = (price - prev) / prev * 100;

  // Need a sudden ≥1% move on the last candle
  if (Math.abs(movePct) < 1.0) return null;

  // Check flush state — was there a big move recently?
  const flushState = readJSON(FLUSH_FILE, {});
  const now        = Date.now();

  // If new big move detected, record it and wait 30 seconds
  if (!flushState.ts || now - flushState.ts > 5 * 60 * 1000) {
    writeJSON(FLUSH_FILE, { ts: now, movePct, price });
    console.log(`  ⚡ Flush detected: ${movePct >= 0 ? "+" : ""}${movePct.toFixed(2)}% — waiting 30s for RSI extreme`);
    return null;
  }

  // Wait at least 30 seconds after the flush
  if (now - flushState.ts < 30 * 1000) return null;

  // Now check RSI extreme for the fade
  const rsi1m  = rsi(closes, RSI_PERIOD);
  const vma1m  = volma(m1.volumes.slice(0,-1), VOL_MA_PERIOD);
  if (rsi1m === null || !vma1m) return null;

  const direction = flushState.movePct < 0 ? "LONG" : "SHORT";  // fade the move

  // Macro must agree (in bull bias, fade dumps; in bear bias, fade pumps)
  if (direction === "LONG"  && macro.bias === "SHORT") return null;
  if (direction === "SHORT" && macro.bias === "LONG")  return null;

  if (direction === "LONG"  && rsi1m < 20) {
    delFile(FLUSH_FILE);
    return {
      setup: "SENTIMENT_FLUSH", direction: "LONG",
      entry: price,
      target: price + 1.0 * atr5m,
      stop:   price - 1.5 * atr5m,  // wider stop: volatile move
      maxHoldMin: 5,
      reason: `Flush fade LONG: move=${flushState.movePct.toFixed(2)}% RSI1m=${rsi1m.toFixed(1)} waited ${((now-flushState.ts)/1000).toFixed(0)}s`,
    };
  }
  if (direction === "SHORT" && rsi1m > 80) {
    delFile(FLUSH_FILE);
    return {
      setup: "SENTIMENT_FLUSH", direction: "SHORT",
      entry: price,
      target: price - 1.0 * atr5m,
      stop:   price + 1.5 * atr5m,
      maxHoldMin: 5,
      reason: `Flush fade SHORT: move=${flushState.movePct.toFixed(2)}% RSI1m=${rsi1m.toFixed(1)} waited ${((now-flushState.ts)/1000).toFixed(0)}s`,
    };
  }
  return null;
}

// ─── Setup 5: RSI Divergence ──────────────────────────────────────────────────
// 5-min price higher high + RSI lower high + volume declining → SHORT
// Only in Markup or Accumulation (fade the overbought)

function detectDivergence(m5, m1, atr5m, bias) {
  if (!atr5m || bias !== "LONG") return null;
  const rsiArr = rsiArray(m5.closes, RSI_PERIOD);
  if (rsiArr.length < 12) return null;

  const lb = 6;
  const priceHH  = Math.max(...m5.highs.slice(-lb));
  const rsiHH    = Math.max(...rsiArr.slice(-lb));
  const pricePrev = Math.max(...m5.highs.slice(-(lb*2),-lb));
  const rsiPrev   = Math.max(...rsiArr.slice(-(lb*2),-lb));
  const vma5m     = volma(m5.volumes.slice(0,-1), VOL_MA_PERIOD);
  if (!vma5m) return null;

  const price = m1.closes.at(-1);

  if (
    priceHH  > pricePrev * 1.002 &&   // price higher high ≥ 0.2%
    rsiHH    < rsiPrev - 3 &&          // RSI lower high ≥ 3 pts
    m5.volumes.at(-1) < vma5m * 0.85  // volume declining
  ) {
    return {
      setup: "RSI_DIVERGENCE", direction: "SHORT",
      entry: price,
      target: Math.min(...m5.lows.slice(-lb)),
      stop:   priceHH + 0.5*atr5m,
      maxHoldMin: 12,
      reason: `Bearish div: price ${pricePrev.toFixed(5)}→${priceHH.toFixed(5)} RSI ${rsiPrev.toFixed(1)}→${rsiHH.toFixed(1)} vol ${(m5.volumes.at(-1)/vma5m).toFixed(2)}x`,
    };
  }
  return null;
}

// ─── Position Management ──────────────────────────────────────────────────────

function loadPos()    { return readJSON(POSITION_FILE, null); }
function savePos(p)   { p === null ? delFile(POSITION_FILE) : writeJSON(POSITION_FILE, p); }
function loadDaily()  {
  const today = new Date().toISOString().slice(0,10);
  const d = readJSON(DAILY_FILE, {});
  return d.date === today ? d : { date: today, pnlUSD: 0, trades: 0, wins: 0 };
}
function saveDaily(d) { writeJSON(DAILY_FILE, d); }

async function managePosition(pos, price) {
  const ageMin = (Date.now()-pos.entryTime)/60000;
  const pnlPct = pos.direction === "LONG"
    ? (price-pos.entry)/pos.entry*100
    : (pos.entry-price)/pos.entry*100;

  let closeReason = null;
  if (pos.direction === "LONG") {
    if (price >= pos.target) closeReason = "TARGET_HIT";
    if (price <= pos.stop)   closeReason = "STOP_HIT";
  } else {
    if (price <= pos.target) closeReason = "TARGET_HIT";
    if (price >= pos.stop)   closeReason = "STOP_HIT";
  }
  if (ageMin >= pos.maxHoldMin) closeReason = "TIME_LIMIT";

  if (!closeReason) {
    console.log(`  📌 Holding ${pos.direction} ${pos.setup} | P&L ${pnlPct>=0?"+":""}${pnlPct.toFixed(3)}% | ${ageMin.toFixed(1)}min | T=${pos.target.toFixed(5)} S=${pos.stop.toFixed(5)}`);
    return false;
  }

  const pnlUSD = (pnlPct/100)*pos.sizeUSD;
  const daily  = loadDaily();
  daily.pnlUSD += pnlUSD; daily.trades++; if (pnlUSD>0) daily.wins++;
  saveDaily(daily); savePos(null);

  const emoji = pnlUSD > 0 ? "✅" : "❌";
  console.log(`  ${emoji} CLOSED ${pos.direction} ${pos.setup} | ${closeReason} | ${pnlUSD>=0?"+":""}$${pnlUSD.toFixed(3)} (${pnlPct>=0?"+":""}${pnlPct.toFixed(3)}%)`);
  console.log(`  📅 Daily: ${daily.pnlUSD>=0?"+":""}$${daily.pnlUSD.toFixed(3)} | ${daily.wins}W/${daily.trades-daily.wins}L`);

  const tag = PAPER_TRADING ? "[PAPER] " : "";
  await notify(
    `${tag}Scalp ${closeReason==="TARGET_HIT"?"✅ Win":"❌ Loss"} — ${pos.setup}`,
    `${pos.direction} ${SYMBOL}\nEntry: ${pos.entry.toFixed(5)} → Exit: ${price.toFixed(5)}\n` +
    `P&L: ${pnlUSD>=0?"+":""}$${pnlUSD.toFixed(3)} (${pnlPct>=0?"+":""}${pnlPct.toFixed(3)}%)\n` +
    `${closeReason} | ${ageMin.toFixed(1)}min\nDaily: ${daily.pnlUSD>=0?"+":""}$${daily.pnlUSD.toFixed(3)} | ${daily.wins}W/${daily.trades-daily.wins}L`,
    pnlUSD>0?"high":"default"
  );
  await logToSheet({
    Date: new Date().toISOString().slice(0,10), Time: new Date().toISOString().slice(11,19),
    Symbol: SYMBOL, Side: pos.direction==="LONG"?"BUY":"SELL", Setup: pos.setup,
    "Entry ($)": pos.entry, "Exit ($)": price, "Size ($)": pos.sizeUSD.toFixed(2),
    "P&L ($)": pnlUSD.toFixed(3), "P&L %": pnlPct.toFixed(3),
    "Close Reason": closeReason, "Hold Min": ageMin.toFixed(1),
    Phase: pos.phase, Confluence: pos.confluence, Mode: PAPER_TRADING?"PAPER":"LIVE",
  });
  return true;
}

async function openPosition(setup, macro, confluence) {
  const { direction, entry, target, stop, maxHoldMin, reason, setup: name } = setup;
  const riskUSD = ACCOUNT_USD*(RISK_PCT/100);
  const dist    = Math.abs(entry-stop);
  const sizeUSD = Math.min(dist>0 ? riskUSD/dist*entry : 0, MAX_TRADE_USD);
  const rr      = Math.abs(target-entry)/Math.abs(entry-stop);

  if (rr < 1.5) {
    console.log(`  ⚠️  ${name} R/R=${rr.toFixed(2)} < 1.5 — skip`);
    return;
  }

  savePos({ symbol: SYMBOL, direction, setup: name, entry, target, stop,
    maxHoldMin, sizeUSD, entryTime: Date.now(), phase: macro.phase,
    confluence, reason });

  const tPct = (Math.abs(target-entry)/entry*100).toFixed(2);
  const sPct = (Math.abs(stop-entry)/entry*100).toFixed(2);
  const tag  = PAPER_TRADING?"[PAPER] ":"";

  console.log(`  🚀 ENTER ${direction} ${name} @ ${entry.toFixed(5)} | T +${tPct}% S -${sPct}% R/R ${rr.toFixed(2)} $${sizeUSD.toFixed(2)} [Confluence: ${confluence}/3]`);
  console.log(`     ${reason}`);

  await notify(
    `${tag}New Scalp — ${name} ${direction}`,
    `${direction} ${SYMBOL} @ ${entry.toFixed(5)}\nTarget: +${tPct}% | Stop: -${sPct}%\nR/R: ${rr.toFixed(2)} | $${sizeUSD.toFixed(2)} | Confluence: ${confluence}/3\nPhase: ${macro.phase}`,
    "high"
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const t = new Date().toISOString().replace("T"," ").slice(0,19);
  console.log(`\n⚡ BCB Scalper — ${t} UTC [${PAPER_TRADING?"PAPER":"LIVE"}]`);

  // 1. Daily loss / trade limit
  const daily = loadDaily();
  if (daily.pnlUSD <= -(ACCOUNT_USD*(MAX_DAILY_LOSS/100))) {
    console.log(`  🛑 Daily loss limit hit. Stopped.`); return;
  }
  if (daily.trades >= MAX_TRADES_DAY) {
    console.log(`  🛑 Max ${MAX_TRADES_DAY} trades/day reached.`); return;
  }
  console.log(`  📅 Daily: ${daily.pnlUSD>=0?"+":""}$${daily.pnlUSD.toFixed(3)} | ${daily.trades} trades | ${daily.wins}W`);

  // 2. Trading hours filter (skip low-volume dead zones)
  if (!isGoodHour()) {
    const h = new Date().getUTCHours();
    console.log(`  🕐 Hour ${h} UTC not in best windows [1-4, 8-11, 18-20]. Skipping.`);
    // Still manage open positions even outside best hours
    const openPos = loadPos();
    if (openPos) {
      const m1 = await fetchOHLCV(SYMBOL,"1m",5);
      if (m1) await managePosition(openPos, m1.closes.at(-1));
    }
    return;
  }

  // 3. Macro bias (cached 1 hour)
  const macro = await getMacro();
  if (macro.phase === "NEUTRAL" || macro.bias === "NONE") {
    console.log("  ⏸️  No clear macro phase."); return;
  }

  // 4. Accumulation: max 2 scalps/day
  if (macro.phase === "ACCUMULATION" && daily.trades >= 2) {
    console.log("  ⏸️  Accumulation: 2-trade cap reached."); return;
  }

  // 5. Fetch multi-timeframe data
  const [m15, m5, m1] = await Promise.all([
    fetchOHLCV(SYMBOL,"15m",100),
    fetchOHLCV(SYMBOL,"5m",100),
    fetchOHLCV(SYMBOL,"1m",100),
  ]);
  if (!m5 || !m1) { console.log("  ⚠️  Market data unavailable."); return; }

  const price  = m1.closes.at(-1);
  const atr5m  = atr(m5.highs, m5.lows, m5.closes, ATR_PERIOD);
  const rsi1m  = rsi(m1.closes, RSI_PERIOD);
  const rsi5m  = rsi(m5.closes, RSI_PERIOD);
  const rsi15m = m15 ? rsi(m15.closes, RSI_PERIOD) : null;
  const bb5m   = bb(m5.closes, BB_PERIOD, BB_STD);

  console.log(`  💹 ${SYMBOL} @ $${price.toFixed(5)} | ATR5m: ${atr5m?.toFixed(5)}`);
  console.log(`  📊 RSI: 1m=${rsi1m?.toFixed(1)} 5m=${rsi5m?.toFixed(1)} 15m=${rsi15m?.toFixed(1)}`);
  if (bb5m) {
    const loc = price<bb5m.lower?"BELOW↓":price>bb5m.upper?"ABOVE↑":"inside";
    console.log(`  📐 BB5m: ${bb5m.lower.toFixed(5)}/${bb5m.mid.toFixed(5)}/${bb5m.upper.toFixed(5)} [${loc}]`);
  }

  // 6. Manage open position
  const openPos = loadPos();
  if (openPos) {
    await managePosition(openPos, price);
    return;
  }

  // 7. Scan all 5 setups, filter by bias
  const canLong  = macro.bias==="LONG"  || macro.bias==="BOTH";
  const canShort = macro.bias==="SHORT" || macro.bias==="BOTH";

  const candidates = [
    detectSpring(m5, m1, atr5m),
    detectBBReversion(m5, m1, atr5m),
    detectVolumeLiquidation(m5, m1, atr5m),
    detectSentimentFlush(m1, atr5m, macro),
    detectDivergence(m5, m1, atr5m, macro.bias),
  ]
    .filter(Boolean)
    .filter(s => (s.direction==="LONG"&&canLong)||(s.direction==="SHORT"&&canShort));

  if (candidates.length === 0) {
    const bbLoc = bb5m
      ? (price<bb5m.lower?"below":price>bb5m.upper?"above":`inside ${((price-bb5m.lower)/(bb5m.upper-bb5m.lower)*100).toFixed(0)}%`)
      : "n/a";
    console.log(`  💤 No setups. Bias=${macro.bias} BB:${bbLoc}`);
    return;
  }

  // 8. Score by multi-timeframe RSI confluence, pick best
  const scored = candidates.map(s => ({
    ...s,
    confluence: confluenceScore(rsi1m, rsi5m, rsi15m, s.direction),
  })).sort((a,b) => b.confluence - a.confluence);

  console.log(`  🎯 ${scored.length} setup(s): ${scored.map(s=>`${s.setup}(${s.direction},conf=${s.confluence})`).join(", ")}`);

  // Only enter if confluence ≥ 1 (at least 1 timeframe confirms)
  const best = scored[0];
  if (best.confluence < 1) {
    console.log(`  ⚠️  Best setup confluence=${best.confluence} — waiting for at least 1 timeframe to confirm`);
    return;
  }

  await openPosition(best, macro, best.confluence);
}

run().catch(e => { console.error("❌ Fatal:", e.message); process.exit(1); });
