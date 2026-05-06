/**
 * VWAP Scalping Bot — 7-Condition System
 * Symbol: XRPUSDT | Timeframe: 1m | Paper Trading
 *
 * LONG  (all 7 must be true):
 *   1. Price > VWAP
 *   2. Price > EMA(8) on 1m
 *   3. RSI(3) < 30  (oversold pullback into trend)
 *   4. Price within 1.5% of VWAP  (not overextended)
 *   5. Price > PDL  (above previous day low)
 *   6. Price < PDH  (below previous day high — room to run)
 *   7. BTC > EMA(50) daily  (macro bull bias)
 *
 * SHORT (all 7 must be true):
 *   1. Price < VWAP
 *   2. Price < EMA(8) on 1m
 *   3. RSI(3) > 70  (overbought push into trend)
 *   4. Price within 1.5% of VWAP
 *   5. Price < PDH
 *   6. Price > PDL
 *   7. BTC < EMA(50) daily
 *
 * Exit:
 *   - Stop:    0.5 × ATR(14) from entry
 *   - Target:  1.0 × ATR(14) from entry  →  R:R = 1:2
 *   - Partial: 50% closed at half-target, stop moved to breakeven
 *   - Time:    15 min max hold — no overnight
 */

import "dotenv/config";
import { readFileSync, writeFileSync, unlinkSync } from "fs";

// ─── Config ───────────────────────────────────────────────────────────────────

const SYMBOL         = process.env.SCALP_SYMBOL    || "XRPUSDT";
const BTC_SYMBOL     = "BTCUSDT";
const ACCOUNT_USD    = parseFloat(process.env.ACCOUNT_USD    || "120");
const RISK_PCT       = parseFloat(process.env.RISK_PCT       || "1.0");   // % of account per trade
const MAX_TRADE_USD  = parseFloat(process.env.MAX_TRADE_USD  || "18");    // hard cap per trade
const MAX_TRADES_DAY = parseInt(process.env.MAX_TRADES_DAY   || "5");
const MAX_DAILY_LOSS = parseFloat(process.env.MAX_DAILY_LOSS || "3.0");   // % of account
const PAPER          = process.env.PAPER_TRADING !== "false";
const NTFY           = process.env.NTFY_CHANNEL   || "xrp-bot-dhruvjyot";
const SHEET_URL      = process.env.GOOGLE_SHEET_URL ||
  "https://script.google.com/macros/s/AKfycbzWdRn61TrnC0M0z91wgcMnIOJ6cjhYti21xdEnyNVFV5335qtisHk-nT46ugpIAmSW/exec";

const MIN_RR         = 2.0;     // minimum risk:reward ratio
const MAX_HOLD_MIN   = 15;      // time stop in minutes
const VWAP_BAND      = 0.015;   // 1.5% max distance from VWAP

const POS_FILE   = "scalp-position.json";
const DAILY_FILE = "scalp-daily-pnl.json";

// ─── File Helpers ─────────────────────────────────────────────────────────────

const readJSON  = (f, d) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return d; } };
const writeJSON = (f, d) => writeFileSync(f, JSON.stringify(d, null, 2));
const delFile   = (f)    => { try { unlinkSync(f); } catch {} };

// ─── Math / Indicators ────────────────────────────────────────────────────────

function ema(arr, period) {
  if (!arr || arr.length < period) return null;
  const k = 2 / (period + 1);
  let e = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}

// RSI with period 3 — fast, designed for scalping
function rsi(closes, p = 3) {
  if (!closes || closes.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) {
    const d = closes[i] - closes[i - 1];
    d > 0 ? (g += d) : (l -= d);
  }
  let ag = g / p, al = l / p;
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p;
    al = (al * (p - 1) + (d < 0 ? -d : 0)) / p;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function atr(highs, lows, closes, p = 14) {
  if (!closes || closes.length < p + 1) return null;
  const trs = [];
  for (let i = 1; i < closes.length; i++)
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  return trs.slice(-p).reduce((a, b) => a + b, 0) / p;
}

// VWAP resets at midnight UTC — filters bars to today only
function calcVWAP(candles) {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const start = midnight.getTime();
  let cumPV = 0, cumV = 0;
  for (let i = 0; i < candles.times.length; i++) {
    if (candles.times[i] < start) continue;
    const tp = (candles.highs[i] + candles.lows[i] + candles.closes[i]) / 3;
    cumPV += tp * candles.volumes[i];
    cumV  += candles.volumes[i];
  }
  return cumV > 0 ? cumPV / cumV : null;
}

// ─── Market Data ──────────────────────────────────────────────────────────────

async function fetchOHLCV(symbol, interval, limit = 200) {
  try {
    const r = await fetch(
      `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
    );
    if (!r.ok) return null;
    const raw = await r.json();
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

// ─── Notifications ────────────────────────────────────────────────────────────

async function notify(title, body, priority = "default") {
  try {
    await fetch(`https://ntfy.sh/${NTFY}`, {
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

// ─── Daily P&L ────────────────────────────────────────────────────────────────

function loadDaily() {
  const today = new Date().toISOString().slice(0, 10);
  const d = readJSON(DAILY_FILE, {});
  return d.date === today ? d : { date: today, pnlUSD: 0, trades: 0, wins: 0 };
}
const saveDaily = d => writeJSON(DAILY_FILE, d);

// ─── Position ────────────────────────────────────────────────────────────────

const loadPos = ()  => readJSON(POS_FILE, null);
const savePos = (p) => writeJSON(POS_FILE, p);

// ─── Entry Signal ─────────────────────────────────────────────────────────────

function getSignal({ price, vwap, ema8, rsi3val, pdh, pdl, btcAboveEma50, atrVal }) {
  // All inputs must exist
  if (!vwap || !ema8 || rsi3val === null || !pdh || !pdl || btcAboveEma50 === null || !atrVal) {
    return null;
  }

  const dist = Math.abs(price - vwap) / vwap;
  if (dist > VWAP_BAND) return null;  // condition 4: within 1.5%

  const stop   = 0.5 * atrVal;
  const target = MIN_RR * stop;  // 1.0 ATR → R:R exactly 2.0

  // ── LONG: all 7 conditions ────────────────────────────────────────────────
  if (
    price > vwap        &&   // 1. above VWAP
    price > ema8        &&   // 2. above EMA(8)
    rsi3val < 30        &&   // 3. RSI(3) oversold
                             // 4. within 1.5% VWAP — already checked above
    price > pdl         &&   // 5. above PDL
    price < pdh         &&   // 6. below PDH
    btcAboveEma50            // 7. BTC above EMA50 daily
  ) {
    return {
      direction: "LONG",
      entry:  price,
      stop:   price - stop,
      target: price + target,
    };
  }

  // ── SHORT: all 7 conditions ───────────────────────────────────────────────
  if (
    price < vwap        &&   // 1. below VWAP
    price < ema8        &&   // 2. below EMA(8)
    rsi3val > 70        &&   // 3. RSI(3) overbought
                             // 4. within 1.5% VWAP — already checked above
    price < pdh         &&   // 5. below PDH
    price > pdl         &&   // 6. above PDL
    !btcAboveEma50           // 7. BTC below EMA50 daily
  ) {
    return {
      direction: "SHORT",
      entry:  price,
      stop:   price + stop,
      target: price - target,
    };
  }

  return null;
}

// ─── Open Position ────────────────────────────────────────────────────────────

async function openPosition(signal, indicators) {
  const { direction, entry, stop, target } = signal;
  const dist    = Math.abs(entry - stop);
  const riskUSD = ACCOUNT_USD * (RISK_PCT / 100);
  const sizeUSD = Math.min(dist > 0 ? (riskUSD / dist) * entry : MAX_TRADE_USD, MAX_TRADE_USD);
  const rr      = Math.abs(target - entry) / Math.abs(entry - stop);

  if (rr < MIN_RR) {
    console.log(`  ⚠️  R:R ${rr.toFixed(2)} < ${MIN_RR} — skip`);
    return;
  }

  const pos = {
    symbol: SYMBOL, direction, entry, stop, target,
    sizeUSD, entryTime: Date.now(), scaled: false,
  };
  savePos(pos);

  const tPct = (Math.abs(target - entry) / entry * 100).toFixed(3);
  const sPct = (Math.abs(stop   - entry) / entry * 100).toFixed(3);
  const tag  = PAPER ? "[PAPER] " : "";

  console.log(`  🟢 OPEN ${direction} @ ${entry.toFixed(5)}`);
  console.log(`     Target: ${target.toFixed(5)} (+${tPct}%)  Stop: ${stop.toFixed(5)} (-${sPct}%)  Size: $${sizeUSD.toFixed(2)}  R:R ${rr.toFixed(1)}`);
  console.log(`     VWAP=${indicators.vwap?.toFixed(5)} EMA8=${indicators.ema8?.toFixed(5)} RSI3=${indicators.rsi3val?.toFixed(1)}`);

  await notify(
    `${tag}${direction} ${SYMBOL}`,
    `Entry:  ${entry.toFixed(5)}\nTarget: ${target.toFixed(5)} (+${tPct}%)\nStop:   ${stop.toFixed(5)} (-${sPct}%)\nSize:   $${sizeUSD.toFixed(2)} | R:R ${rr.toFixed(1)}\nRSI3=${indicators.rsi3val?.toFixed(1)} VWAP=${indicators.vwap?.toFixed(5)}`,
    "high"
  );

  await logToSheet({
    date: new Date().toISOString(), type: "OPEN",
    symbol: SYMBOL, direction, entry, stop, target,
    sizeUSD: sizeUSD.toFixed(2), rr: rr.toFixed(2), paper: PAPER,
  });
}

// ─── Manage Open Position ─────────────────────────────────────────────────────

async function managePosition(pos, price) {
  const ageMin = (Date.now() - pos.entryTime) / 60000;
  const pnlPct = pos.direction === "LONG"
    ? (price - pos.entry) / pos.entry * 100
    : (pos.entry - price) / pos.entry * 100;

  // Partial scale-out: at 50% of target distance, close 50% and move stop to breakeven
  if (!pos.scaled) {
    const halfDist  = Math.abs(pos.target - pos.entry) * 0.5;
    const halfLevel = pos.direction === "LONG" ? pos.entry + halfDist : pos.entry - halfDist;
    const reached   = pos.direction === "LONG" ? price >= halfLevel : price <= halfLevel;

    if (reached) {
      pos.scaled  = true;
      pos.sizeUSD = pos.sizeUSD * 0.5;   // only half remaining
      pos.stop    = pos.entry;            // stop moved to breakeven
      savePos(pos);
      const halfPnl = (halfDist / pos.entry * 100).toFixed(3);
      console.log(`  📤 PARTIAL EXIT 50% @ ${price.toFixed(5)} (+${halfPnl}%) — stop → breakeven`);
      await notify(
        `${PAPER ? "[PAPER] " : ""}Partial Exit`,
        `${pos.direction} ${SYMBOL} — took 50% profit @ ${price.toFixed(5)}\n+${halfPnl}% | Remaining half now risk-free`
      );
    }
  }

  // Check exit conditions
  let reason = null;
  if (pos.direction === "LONG") {
    if (price >= pos.target) reason = "TARGET_HIT";
    if (price <= pos.stop)   reason = "STOP_HIT";
  } else {
    if (price <= pos.target) reason = "TARGET_HIT";
    if (price >= pos.stop)   reason = "STOP_HIT";
  }
  if (ageMin >= MAX_HOLD_MIN) reason = "TIME_STOP";

  // Still open — just log status
  if (!reason) {
    const emoji = pnlPct >= 0 ? "📈" : "📉";
    console.log(`  ${emoji} ${pos.direction} | P&L ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(3)}% | Age ${ageMin.toFixed(1)}min | T=${pos.target.toFixed(5)} S=${pos.stop.toFixed(5)}${pos.scaled ? " ✂️" : ""}`);
    return;
  }

  // Close position
  const pnlUSD = (pnlPct / 100) * pos.sizeUSD;
  const daily  = loadDaily();
  daily.pnlUSD += pnlUSD;
  daily.trades++;
  if (pnlPct > 0) daily.wins++;
  saveDaily(daily);
  delFile(POS_FILE);

  const emoji = reason === "TARGET_HIT" ? "✅" : reason === "STOP_HIT" ? "🛑" : "⏱️";
  const tag   = PAPER ? "[PAPER] " : "";
  console.log(`  ${emoji} CLOSE ${reason} | ${pos.direction} | ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(3)}% | $${pnlUSD >= 0 ? "+" : ""}${pnlUSD.toFixed(2)} | Day: $${daily.pnlUSD.toFixed(2)} (${daily.wins}W/${daily.trades}T)`);

  await notify(
    `${tag}${emoji} ${reason}`,
    `${pos.direction} ${SYMBOL}\nEntry: ${pos.entry.toFixed(5)} → Exit: ${price.toFixed(5)}\nP&L: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(3)}% ($${pnlUSD >= 0 ? "+" : ""}${pnlUSD.toFixed(2)})\nDay: $${daily.pnlUSD.toFixed(2)} | ${daily.wins}W / ${daily.trades}T`,
    reason === "TARGET_HIT" ? "high" : "default"
  );

  await logToSheet({
    date: new Date().toISOString(), type: "CLOSE",
    symbol: SYMBOL, direction: pos.direction,
    entry: pos.entry, exit: price,
    pnlPct: pnlPct.toFixed(3), pnlUSD: pnlUSD.toFixed(2),
    reason, dayPnl: daily.pnlUSD.toFixed(2), paper: PAPER,
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`\n⚡ VWAP Scalper — ${ts} UTC ${PAPER ? "[PAPER]" : "[LIVE]"}`);

  // ── Daily limits ──────────────────────────────────────────────────────────
  const daily       = loadDaily();
  const maxLossUSD  = ACCOUNT_USD * (MAX_DAILY_LOSS / 100);
  if (daily.pnlUSD <= -maxLossUSD) {
    console.log(`  🛑 Daily loss limit: $${daily.pnlUSD.toFixed(2)} ≤ -$${maxLossUSD.toFixed(2)} — flat for today`);
    return;
  }
  if (daily.trades >= MAX_TRADES_DAY) {
    console.log(`  🛑 Max trades hit: ${daily.trades}/${MAX_TRADES_DAY} — done for today`);
    return;
  }

  // ── Fetch data ────────────────────────────────────────────────────────────
  const [xrp1m, xrpDaily, btcDaily] = await Promise.all([
    fetchOHLCV(SYMBOL,     "1m",  1000),  // 1000 1m bars (~16.7h) for VWAP + indicators
    fetchOHLCV(SYMBOL,     "1d",  3),     // PDH / PDL
    fetchOHLCV(BTC_SYMBOL, "1d",  60),    // BTC EMA(50) daily
  ]);

  if (!xrp1m || !xrpDaily || !btcDaily) {
    console.log("  ❌ Data fetch failed");
    return;
  }

  // ── Calculate indicators ──────────────────────────────────────────────────
  const price        = xrp1m.closes.at(-1);
  const vwap         = calcVWAP(xrp1m);
  const ema8         = ema(xrp1m.closes, 8);
  const rsi3val      = rsi(xrp1m.closes, 3);
  const atrVal       = atr(xrp1m.highs, xrp1m.lows, xrp1m.closes, 14);
  const btcEma50     = ema(btcDaily.closes, 50);
  const btcNow       = btcDaily.closes.at(-1);
  const btcAboveEma50 = btcEma50 !== null ? btcNow > btcEma50 : null;

  // PDH / PDL from yesterday
  const yi  = xrpDaily.closes.length - 2;  // index of yesterday
  const pdh = yi >= 0 ? xrpDaily.highs[yi]  : null;
  const pdl = yi >= 0 ? xrpDaily.lows[yi]   : null;

  // ── Status log ────────────────────────────────────────────────────────────
  const vwapDist = vwap ? ((price - vwap) / vwap * 100).toFixed(3) : "N/A";
  const btcTag   = btcAboveEma50 ? "✅ BULL" : "❌ BEAR";
  console.log(`  Price=${price.toFixed(5)}  VWAP=${vwap?.toFixed(5)} (${vwapDist}%)  EMA8=${ema8?.toFixed(5)}  RSI3=${rsi3val?.toFixed(1)}`);
  console.log(`  PDH=${pdh?.toFixed(5)}  PDL=${pdl?.toFixed(5)}  BTC/EMA50=${btcTag}  ATR=${atrVal?.toFixed(5)}`);

  // ── Manage existing position ───────────────────────────────────────────────
  const pos = loadPos();
  if (pos) {
    await managePosition(pos, price);
    return;  // one position at a time
  }

  // ── Look for entry ────────────────────────────────────────────────────────
  const indicators = { vwap, ema8, rsi3val, pdh, pdl, btcAboveEma50, atrVal };
  const signal     = getSignal({ price, ...indicators });

  if (signal) {
    await openPosition(signal, indicators);
  } else {
    // Show which conditions passed / failed for transparency
    const vwapBias = price > (vwap || price) ? "above" : "below";
    const emaBias  = price > (ema8  || price) ? "above" : "below";
    const rsiStr   = rsi3val !== null ? rsi3val.toFixed(1) : "N/A";
    const rsiTag   = rsi3val !== null
      ? (rsi3val < 30 ? "✅ <30" : rsi3val > 70 ? "✅ >70" : `❌ neutral (${rsiStr})`)
      : "❌ null";

    console.log(`  ⏸️  No signal | VWAP:${vwapBias} EMA8:${emaBias} RSI3:${rsiTag} BTC:${btcTag} Dist:${vwapDist}%`);
  }
}

main().catch(e => console.error("ERROR:", e.message));
