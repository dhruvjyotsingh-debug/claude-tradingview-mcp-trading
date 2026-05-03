/**
 * scalper.js — VWAP + RSI(3) + EMA(8) Intraday Scalper
 * Symbol:    XRPUSDT (1m) on Binance
 * Portfolio: $120  |  Max trade: $18  |  Max 5 trades/day
 *
 * Strategy — 7 conditions must ALL pass:
 *   1. Price above/below VWAP (directional bias)
 *   2. Price above/below EMA(8) (short-term trend confirmation)
 *   3. RSI(3) < 30 for long / > 70 for short (entry timing — buy oversold, sell overbought)
 *   4. Price within 1.5% of VWAP (not overextended from fair value)
 *   5. Price above PDL long / below PDH short (not at extremes)
 *   6. Price below PDH long / above PDL short (not at extremes)
 *   7. BTC above EMA50 daily long / below short (macro filter)
 *
 * Exit rules:
 *   - Take profit: +0.8% from entry
 *   - Stop loss:   -0.4% from entry
 *   - Max hold:    5 candles (5 minutes)
 *
 * DO NOT mix with BCB DCA bot (bot.js) — separate strategy, separate state.
 */

import "dotenv/config";
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";

// ─── Config ───────────────────────────────────────────────────────────────────

const SYMBOL         = process.env.SCALPER_SYMBOL        || "XRPUSDT";
const BTC_SYMBOL     = "BTCUSDT";
const PORTFOLIO_USD  = parseFloat(process.env.SCALPER_PORTFOLIO_USD  || "120");
const MAX_TRADE_USD  = parseFloat(process.env.SCALPER_MAX_TRADE_USD  || "18");
const MAX_TRADES_DAY = parseInt(process.env.SCALPER_MAX_TRADES_DAY   || "5");
const PAPER_TRADING  = process.env.PAPER_TRADING !== "false";
const INR_RATE       = 83.5;

const NTFY_CHANNEL = process.env.NTFY_CHANNEL   || "xrp-bot-dhruvjyot";
const SHEET_URL    = process.env.GOOGLE_SHEET_URL ||
  "https://script.google.com/macros/s/AKfycbzWdRn61TrnC0M0z91wgcMnIOJ6cjhYti21xdEnyNVFV5335qtisHk-nT46ugpIAmSW/exec";

const BINANCE_API_KEY = process.env.BINANCE_API_KEY || "";
const BINANCE_SECRET  = process.env.BINANCE_SECRET  || "";
const BINANCE_BASE    = "https://api.binance.com";
const DATA_BASE       = "https://data-api.binance.vision";

const STATE_FILE = "scalper-state.json";

// ─── State ────────────────────────────────────────────────────────────────────

function loadState() {
  const defaults = {
    position:      null,   // null | { side, entryPrice, qty, entryTime, holdCandles, orderId }
    tradesToday:   0,
    lastTradeDate: null,
    trades:        [],
  };
  if (!existsSync(STATE_FILE)) return defaults;
  try { return { ...defaults, ...JSON.parse(readFileSync(STATE_FILE, "utf8")) }; }
  catch { return defaults; }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─── Notifications ────────────────────────────────────────────────────────────

async function notify(title, message, priority = "default") {
  try {
    await fetch(`https://ntfy.sh/${NTFY_CHANNEL}`, {
      method:  "POST",
      headers: { Title: title, Priority: priority, Tags: "chart_increasing" },
      body:    message,
    });
  } catch {}
}

async function logToSheet(data) {
  try {
    await fetch(SHEET_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ ...data, bot: "scalper" }),
    });
    console.log("  Logged to Sheet");
  } catch {}
}

// ─── Market Data ──────────────────────────────────────────────────────────────

async function fetchCandles(symbol, interval, limit) {
  const url = `${DATA_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${interval} ${symbol}: ${res.status}`);
  return (await res.json()).map((k) => ({
    time:   k[0],
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// Fetch all 1m candles since midnight UTC for a true session VWAP
async function fetchSessionCandles(symbol) {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const url = `${DATA_BASE}/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${midnight.getTime()}&limit=1000`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance session 1m ${symbol}: ${res.status}`);
  return (await res.json()).map((k) => ({
    time:   k[0],
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
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

function calcRSI(closes, period) {
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

function calcVWAP(candles) {
  let cumTPV = 0, cumVol = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.volume;
    cumVol += c.volume;
  }
  return cumVol === 0 ? candles[candles.length - 1].close : cumTPV / cumVol;
}

// ─── Signal Engine ────────────────────────────────────────────────────────────

function evaluateSignal({ candles1m, sessionCandles, dailyXRP, dailyBTC }) {
  if (sessionCandles.length < 5 || candles1m.length < 20) {
    return { signal: "NONE", reason: "Not enough candle data", checks: {} };
  }

  const closes = candles1m.map((c) => c.close);
  const price  = closes[closes.length - 1];

  const vwap = calcVWAP(sessionCandles);
  const ema8 = calcEMA(closes, 8);
  const rsi3 = calcRSI(closes, 3);

  // PDH/PDL — yesterday's completed daily candle (second-to-last)
  const pdh = dailyXRP.length >= 2 ? dailyXRP[dailyXRP.length - 2].high : null;
  const pdl = dailyXRP.length >= 2 ? dailyXRP[dailyXRP.length - 2].low  : null;

  // BTC EMA(50) on daily closes
  const btcCloses  = dailyBTC.map((c) => c.close);
  const btcPrice   = btcCloses[btcCloses.length - 1];
  const btcEma50   = calcEMA(btcCloses, 50);
  const btcAbove50 = btcEma50 !== null ? btcPrice > btcEma50 : null;

  const vwapDistPct = vwap ? Math.abs(price - vwap) / vwap * 100 : 999;

  const checks = {
    price, vwap, ema8, rsi3, pdh, pdl,
    btcPrice, btcEma50, btcAbove50,
    vwapDistPct: +vwapDistPct.toFixed(3),
  };

  if (ema8 === null || rsi3 === null || btcEma50 === null) {
    return { signal: "NONE", reason: "Insufficient data for indicators", checks };
  }

  const longConds = [
    { name: "above_vwap",      pass: price > vwap,       desc: `price ${price.toFixed(4)} > VWAP ${vwap.toFixed(4)}` },
    { name: "above_ema8",      pass: price > ema8,       desc: `price ${price.toFixed(4)} > EMA8 ${ema8.toFixed(4)}` },
    { name: "rsi_oversold",    pass: rsi3 < 30,          desc: `RSI(3) ${rsi3.toFixed(1)} < 30` },
    { name: "near_vwap",       pass: vwapDistPct <= 1.5, desc: `VWAP dist ${vwapDistPct.toFixed(2)}% ≤ 1.5%` },
    { name: "above_pdl",       pass: pdl ? price > pdl : false, desc: `price ${price.toFixed(4)} > PDL ${pdl}` },
    { name: "below_pdh",       pass: pdh ? price < pdh : false, desc: `price ${price.toFixed(4)} < PDH ${pdh}` },
    { name: "btc_above_ema50", pass: btcAbove50 === true, desc: `BTC ${btcPrice.toFixed(0)} > EMA50 ${btcEma50.toFixed(0)}` },
  ];

  const shortConds = [
    { name: "below_vwap",      pass: price < vwap,       desc: `price ${price.toFixed(4)} < VWAP ${vwap.toFixed(4)}` },
    { name: "below_ema8",      pass: price < ema8,       desc: `price ${price.toFixed(4)} < EMA8 ${ema8.toFixed(4)}` },
    { name: "rsi_overbought",  pass: rsi3 > 70,          desc: `RSI(3) ${rsi3.toFixed(1)} > 70` },
    { name: "near_vwap",       pass: vwapDistPct <= 1.5, desc: `VWAP dist ${vwapDistPct.toFixed(2)}% ≤ 1.5%` },
    { name: "below_pdh",       pass: pdh ? price < pdh : false, desc: `price ${price.toFixed(4)} < PDH ${pdh}` },
    { name: "above_pdl",       pass: pdl ? price > pdl : false, desc: `price ${price.toFixed(4)} > PDL ${pdl}` },
    { name: "btc_below_ema50", pass: btcAbove50 === false, desc: `BTC ${btcPrice.toFixed(0)} < EMA50 ${btcEma50.toFixed(0)}` },
  ];

  if (longConds.every((c) => c.pass))  return { signal: "LONG",  conditions: longConds,  checks, reason: "All 7 long conditions met" };
  if (shortConds.every((c) => c.pass)) return { signal: "SHORT", conditions: shortConds, checks, reason: "All 7 short conditions met" };

  const longFails  = longConds.filter((c) => !c.pass);
  const shortFails = shortConds.filter((c) => !c.pass);
  const fewerFails = longFails.length <= shortFails.length ? longFails : shortFails;
  const reason = `No signal — ${fewerFails.length} cond failed: ${fewerFails.map((c) => c.name).join(", ")}`;
  return { signal: "NONE", checks, reason };
}

// ─── Exit Logic ───────────────────────────────────────────────────────────────

function checkExit(position, currentPrice) {
  const { side, entryPrice, holdCandles } = position;
  const pct = side === "LONG"
    ? (currentPrice - entryPrice) / entryPrice * 100
    : (entryPrice - currentPrice) / entryPrice * 100;

  if (pct >= 0.8)     return { exit: true,  pct, reason: `TP +${pct.toFixed(2)}%` };
  if (pct <= -0.4)    return { exit: true,  pct, reason: `SL ${pct.toFixed(2)}%` };
  if (holdCandles >= 5) return { exit: true, pct, reason: `Max hold reached (5 candles)` };
  return { exit: false, pct };
}

// ─── Order Placement ──────────────────────────────────────────────────────────

async function placeOrder(side, qty) {
  if (PAPER_TRADING) {
    const id = `PAPER-${Date.now()}`;
    console.log(`  [PAPER] ${side} ${qty.toFixed(4)} ${SYMBOL}`);
    return { orderId: id, status: "FILLED" };
  }

  if (!BINANCE_API_KEY || !BINANCE_SECRET) {
    throw new Error("Set BINANCE_API_KEY + BINANCE_SECRET for live trading");
  }

  const ts     = Date.now().toString();
  const params = `symbol=${SYMBOL}&side=${side}&type=MARKET&quantity=${qty.toFixed(4)}&timestamp=${ts}`;
  const sig    = createHmac("sha256", BINANCE_SECRET).update(params).digest("hex");

  const res = await fetch(`${BINANCE_BASE}/api/v3/order?${params}&signature=${sig}`, {
    method: "POST", headers: { "X-MBX-APIKEY": BINANCE_API_KEY },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Order rejected: ${JSON.stringify(data)}`);
  return data;
}

// ─── Summary ──────────────────────────────────────────────────────────────────

function printSummary() {
  const state = loadState();
  const trades = (state.trades || []).filter((t) => t.pnlUSD !== undefined);
  if (trades.length === 0) { console.log("No completed trades yet."); return; }

  const wins   = trades.filter((t) => t.pnlUSD > 0).length;
  const losses = trades.filter((t) => t.pnlUSD < 0).length;
  const totalPnl = trades.reduce((s, t) => s + t.pnlUSD, 0);
  const winRate  = (wins / trades.length * 100).toFixed(1);

  console.log("\n══════════════════════════════════");
  console.log("  SCALPER SUMMARY");
  console.log("══════════════════════════════════");
  console.log(`  Total trades:  ${trades.length}`);
  console.log(`  Wins / Losses: ${wins} / ${losses}  (${winRate}%)`);
  console.log(`  Total P&L:     ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(4)}`);
  console.log(`  Total P&L INR: ₹${(totalPnl * INR_RATE).toFixed(0)}`);
  console.log("══════════════════════════════════\n");
  trades.slice(-10).forEach((t) => {
    const sign = t.pnlUSD >= 0 ? "+" : "";
    console.log(`  ${t.date?.slice(0, 16)}  ${t.side}  ${sign}$${t.pnlUSD?.toFixed(4)}  (${t.exitReason})`);
  });
}

// ─── Main Run ─────────────────────────────────────────────────────────────────

async function run() {
  const now   = new Date();
  const today = now.toISOString().slice(0, 10);

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  XRP Scalper — VWAP + RSI(3) + EMA(8)  [SEPARATE from BCB]");
  console.log(`  ${now.toISOString()}`);
  console.log(`  Mode: ${PAPER_TRADING ? "PAPER" : "LIVE"}`);
  console.log("═══════════════════════════════════════════════════════════");

  const state = loadState();

  // Reset daily counter at midnight UTC
  if (state.lastTradeDate !== today) {
    state.tradesToday   = 0;
    state.lastTradeDate = today;
  }

  // ── Fetch all data in parallel ──
  const [candles1m, sessionCandles, dailyXRP, dailyBTC] = await Promise.all([
    fetchCandles(SYMBOL,     "1m", 60),
    fetchSessionCandles(SYMBOL),
    fetchCandles(SYMBOL,     "1d", 5),
    fetchCandles(BTC_SYMBOL, "1d", 60),
  ]);

  const price = candles1m[candles1m.length - 1].close;

  // ── Handle open position first ──
  if (state.position) {
    state.position.holdCandles = (state.position.holdCandles || 0) + 1;
    const { exit, pct, reason } = checkExit(state.position, price);
    const pos = state.position;

    if (exit) {
      console.log(`\n  EXIT ${pos.side} — ${reason}`);
      const exitSide = pos.side === "LONG" ? "SELL" : "BUY";

      try {
        await placeOrder(exitSide, pos.qty);

        const pnlUSD = pos.qty * pos.entryPrice * (pct / 100);
        const record = {
          date:        now.toISOString(),
          side:        pos.side,
          entryPrice:  pos.entryPrice,
          exitPrice:   price,
          qty:         pos.qty,
          pnlPct:      +pct.toFixed(3),
          pnlUSD:      +pnlUSD.toFixed(4),
          holdCandles: pos.holdCandles,
          exitReason:  reason,
          paper:       PAPER_TRADING,
        };

        state.trades.push(record);
        state.position = null;
        saveState(state);

        console.log(`  Entry $${pos.entryPrice.toFixed(4)} → Exit $${price.toFixed(4)}`);
        console.log(`  P&L: ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%  ($${pnlUSD.toFixed(4)})`);

        await notify(
          `${pct >= 0 ? "✅" : "❌"} SCALPER EXIT — ${pos.side} ${SYMBOL}`,
          `Entry: $${pos.entryPrice.toFixed(4)} → Exit: $${price.toFixed(4)}\nP&L: ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% ($${pnlUSD.toFixed(4)})\nHeld: ${pos.holdCandles} candles | ${reason}`,
          pct >= 0 ? "default" : "high"
        );
        await logToSheet({
          timestamp:  now.toISOString(),
          symbol:     SYMBOL,
          side:       `EXIT ${pos.side}`,
          price,
          tradeSize:  pos.qty * price,
          pnlPct:     pct.toFixed(2),
          pnlINR:     (pnlUSD * INR_RATE).toFixed(0),
          exitReason: reason,
          mode:       PAPER_TRADING ? "PAPER" : "LIVE",
        });
      } catch (err) {
        console.error(`  Exit failed: ${err.message}`);
        saveState(state);
      }
      return;
    }

    // Still holding
    console.log(`\n  HOLDING ${pos.side} @ $${pos.entryPrice.toFixed(4)} | now $${price.toFixed(4)} | ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% | candle ${pos.holdCandles}/5`);
    saveState(state);
    return;
  }

  // ── Daily limit check ──
  if (state.tradesToday >= MAX_TRADES_DAY) {
    console.log(`\n  Daily limit reached (${state.tradesToday}/${MAX_TRADES_DAY}) — no entries today.`);
    saveState(state);
    return;
  }

  // ── Evaluate signal ──
  const { signal, conditions, checks, reason } = evaluateSignal({ candles1m, sessionCandles, dailyXRP, dailyBTC });

  console.log(`\n  Price:  $${checks.price?.toFixed(4)}`);
  console.log(`  VWAP:   $${checks.vwap?.toFixed(4)}   dist: ${checks.vwapDistPct}%`);
  console.log(`  EMA(8): $${checks.ema8?.toFixed(4)}`);
  console.log(`  RSI(3): ${checks.rsi3?.toFixed(1)}`);
  console.log(`  PDH:    $${checks.pdh?.toFixed(4)}   PDL: $${checks.pdl?.toFixed(4)}`);
  console.log(`  BTC:    $${checks.btcPrice?.toFixed(0)}   EMA50: $${checks.btcEma50?.toFixed(0)}   above50: ${checks.btcAbove50}`);
  console.log(`  Session candles: ${sessionCandles.length}`);

  if (signal !== "NONE" && conditions) {
    console.log(`\n  ── Conditions ─────────────────────────────`);
    conditions.forEach((c) => console.log(`  [${c.pass ? "✓" : "✗"}] ${c.name.padEnd(16)} ${c.desc}`));
  }

  console.log(`\n  Signal: ${signal}  —  ${reason}`);

  if (signal === "NONE") {
    saveState(state);
    return;
  }

  // ── Place entry ──
  const tradeSize = Math.min(MAX_TRADE_USD, PORTFOLIO_USD * 0.15);
  const qty       = tradeSize / price;
  const orderSide = signal === "LONG" ? "BUY" : "SELL";

  console.log(`\n  ENTRY ${signal} — ${qty.toFixed(4)} ${SYMBOL} @ $${price.toFixed(4)}`);
  console.log(`  Size: $${(qty * price).toFixed(2)} (₹${(qty * price * INR_RATE).toFixed(0)})`);
  console.log(`  TP: $${(signal === "LONG" ? price * 1.008 : price * 0.992).toFixed(4)}  SL: $${(signal === "LONG" ? price * 0.996 : price * 1.004).toFixed(4)}`);
  console.log(`  Trades today: ${state.tradesToday + 1}/${MAX_TRADES_DAY}`);

  try {
    const order = await placeOrder(orderSide, qty);

    state.position = {
      side:        signal,
      entryPrice:  price,
      qty,
      entryTime:   now.toISOString(),
      orderId:     order.orderId,
      holdCandles: 0,
    };
    state.tradesToday++;
    saveState(state);

    await notify(
      `📈 SCALPER ${signal} — ${SYMBOL}`,
      `Entry: $${price.toFixed(4)}\nQty: ${qty.toFixed(4)} | Size: $${(qty * price).toFixed(2)} (₹${(qty * price * INR_RATE).toFixed(0)})\nTP: $${(signal === "LONG" ? price * 1.008 : price * 0.992).toFixed(4)} | SL: $${(signal === "LONG" ? price * 0.996 : price * 1.004).toFixed(4)}\nTrades today: ${state.tradesToday}/${MAX_TRADES_DAY}`,
      "default"
    );
    await logToSheet({
      timestamp:  now.toISOString(),
      symbol:     SYMBOL,
      side:       `ENTRY ${signal}`,
      price,
      tradeSize:  qty * price,
      pnlPct:     null,
      pnlINR:     null,
      exitReason: reason,
      mode:       PAPER_TRADING ? "PAPER" : "LIVE",
      rsi3:       checks.rsi3,
      vwap:       checks.vwap,
      ema8:       checks.ema8,
    });
  } catch (err) {
    console.error(`  Entry failed: ${err.message}`);
    saveState(state);
  }
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

if (process.argv.includes("--summary")) {
  printSummary();
} else {
  (async () => {
    while (true) {
      try { await run(); }
      catch (err) { console.error("Scalper error:", err.message); }
      console.log(`\n⏳ Next tick in 60s...\n`);
      await new Promise((r) => setTimeout(r, 60_000));
    }
  })();
}
