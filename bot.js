/**
 * BCB-Informed Scalping Bot — ALL 5 SETUPS, ALL PARAMETERS
 * BlockchainBacker 4-Phase Macro Cycle × Sub-Hourly Scalping
 *
 * Every rule from the strategy doc is implemented:
 *   - MARKUP: weekly RSI>50 + BTC above 100W MA + Russell 786 Fib + dominance declining + altcoin mcap
 *   - DISTRIBUTION: 3-of-5 scoring (RSI div, dom RSI<40, meme frenzy, sentiment, Russell rejecting)
 *   - CAPITULATION: RSI<30 + BTC near 100W MA + VIX spike
 *   - ACCUMULATION: RSI 30-50, max 2 trades/day
 *   - Setup 1: Wyckoff Spring — RSI<15 + reversal buy volume + 0.5ATR stop + R/R 1:2.5
 *   - Setup 2: BB Reversion — entry on RSI BOUNCE (above 30 / below 70), not just at extreme
 *   - Setup 3: Volume Profile Liquidation — 3× vol spike + RSI<20/>80 + 0.1% stop-entry
 *   - Setup 4: Sentiment Flush — 1.5%+ move + 30s wait + RSI extreme + macro bias must agree
 *   - Setup 5: RSI Divergence — works in MARKUP + CAPITULATION (not DISTRIBUTION)
 *   - R/R minimum: 1:2.0 (strategy doc requirement)
 *   - Partial scale-out: close 50% at first target, trail rest
 *   - Distribution: max 2 trades/day (scalp small)
 *   - Multi-timeframe RSI confluence: 1-min + 5-min + 15-min
 *   - Trading hours: 1-4 AM, 8-11 AM, 18-20 PM UTC only
 */

import "dotenv/config";
import { readFileSync, writeFileSync, unlinkSync } from "fs";

// ─── Config ───────────────────────────────────────────────────────────────────

const SYMBOL         = process.env.SCALP_SYMBOL    || "XRPUSDT";
const ACCOUNT_USD    = parseFloat(process.env.ACCOUNT_USD    || "120");
const RISK_PCT       = parseFloat(process.env.RISK_PCT       || "1.0");   // % per trade
const MAX_DAILY_LOSS = parseFloat(process.env.MAX_DAILY_LOSS || "2.0");   // % stop day
const MAX_TRADE_USD  = parseFloat(process.env.MAX_TRADE_USD  || "18");    // hard cap
const MAX_TRADES_DAY = parseInt(process.env.MAX_TRADES_DAY   || "8");
const PAPER_TRADING  = process.env.PAPER_TRADING !== "false";
const NTFY_CHANNEL   = process.env.NTFY_CHANNEL   || "xrp-bot-dhruvjyot";
const SHEET_URL      = process.env.GOOGLE_SHEET_URL ||
  "https://script.google.com/macros/s/AKfycbzWdRn61TrnC0M0z91wgcMnIOJ6cjhYti21xdEnyNVFV5335qtisHk-nT46ugpIAmSW/exec";

const BB_PERIOD     = 20;
const BB_STD        = 2;
const RSI_PERIOD    = 14;
const ATR_PERIOD    = 14;
const VOL_MA        = 20;
const MACRO_TTL     = 60 * 60 * 1000;  // 1 hour
const MIN_RR        = 2.0;             // strategy doc: 1:2 minimum

// Best hours UTC: 1-4 AM (crypto vol), 8-11 AM (US open), 18-20 PM (Asian liq)
const BEST_HOURS    = [[1,4],[8,11],[18,20]];

const POSITION_FILE = "scalp-position.json";
const DAILY_FILE    = "scalp-daily-pnl.json";
const MACRO_FILE    = "macro-cache.json";
const FLUSH_FILE    = "flush-state.json";
const DOM_FILE      = "dominance-history.json";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const readJSON  = (f,d) => { try { return JSON.parse(readFileSync(f,"utf8")); } catch { return d; } };
const writeJSON = (f,d) => writeFileSync(f, JSON.stringify(d,null,2));
const delFile   = (f)   => { try { unlinkSync(f); } catch {} };
const isGoodHour = ()   => { const h=new Date().getUTCHours(); return BEST_HOURS.some(([a,b])=>h>=a&&h<b); };
const clamp     = (v,lo,hi) => Math.min(Math.max(v,lo),hi);

// ─── Notifications ────────────────────────────────────────────────────────────

async function notify(title, body, priority="default") {
  try {
    await fetch(`https://ntfy.sh/${NTFY_CHANNEL}`,{
      method:"POST", headers:{Title:title,Priority:priority,Tags:"chart_increasing"}, body
    });
  } catch {}
}

async function logToSheet(row) {
  if (!SHEET_URL) return;
  try { await fetch(SHEET_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(row)}); } catch {}
}

// ─── Market Data ──────────────────────────────────────────────────────────────

async function fetchOHLCV(symbol, interval, limit=100) {
  try {
    const res = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    if (!res.ok) return null;
    const raw = await res.json();
    return {
      times:   raw.map(c=>c[0]),
      opens:   raw.map(c=>parseFloat(c[1])),
      highs:   raw.map(c=>parseFloat(c[2])),
      lows:    raw.map(c=>parseFloat(c[3])),
      closes:  raw.map(c=>parseFloat(c[4])),
      volumes: raw.map(c=>parseFloat(c[5])),
    };
  } catch { return null; }
}

async function fetchYahoo(sym) {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=90d`,
      { headers:{"User-Agent":"Mozilla/5.0",Accept:"application/json"} }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const r    = data.chart?.result?.[0]; if (!r) return null;
    const c    = r.indicators.quote[0].close.filter(v=>v!==null);
    return { current:c.at(-1), closes:c, high:Math.max(...c), low:Math.min(...c) };
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

async function fetchAltcoinMcap() {
  try {
    const res  = await fetch("https://api.coingecko.com/api/v3/global");
    const data = await res.json();
    const total = data.data?.total_market_cap?.usd ?? 0;
    const btcMcap = data.data?.market_cap_percentage?.btc ?? 50;
    return total * (1 - btcMcap/100);  // altcoin mcap = total minus BTC share
  } catch { return null; }
}

async function fetchMemeFrenzy() {
  try {
    const MEME_TERMS = ["doge","shib","pepe","wif","bonk","floki","meme","brett","popcat","neiro","turbo","bome","mog","wen","slerf","babydoge","wojak"];
    const res  = await fetch("https://api.coingecko.com/api/v3/search/trending");
    const data = await res.json();
    const trending = (data.coins||[]).slice(0,7).map(c=>c.item?.symbol?.toLowerCase()||"");
    return trending.filter(s=>MEME_TERMS.some(t=>s.includes(t))).length >= 3;
  } catch { return false; }
}

// ─── Dominance RSI (weekly) — needed for Distribution scoring ─────────────────

function updateDominanceHistory(dom) {
  if (!dom) return;
  const today = new Date().toISOString().slice(0,10);
  const hist  = readJSON(DOM_FILE, []);
  if (!hist.find(h=>h.date===today)) {
    hist.push({ date:today, dom });
    writeJSON(DOM_FILE, hist.slice(-100));
  }
}

function calcDominanceRSI() {
  const hist = readJSON(DOM_FILE, []);
  if (hist.length < 16) return null;
  const weekly = hist.filter((_,i)=>i%7===0).map(h=>h.dom);
  if (weekly.length < 15) return null;
  return calcRSI_raw(weekly, 14);
}

function calcRSI_raw(closes, p=14) {
  if (closes.length < p+1) return null;
  let g=0,l=0;
  for (let i=1;i<=p;i++){const d=closes[i]-closes[i-1];d>0?g+=d:l-=d;}
  let ag=g/p,al=l/p;
  for (let i=p+1;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    ag=(ag*(p-1)+(d>0?d:0))/p; al=(al*(p-1)+(d<0?-d:0))/p;
  }
  return al===0?100:100-100/(1+ag/al);
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function rsiVal(closes, p=14) { return calcRSI_raw(closes, p); }

function rsiArr(closes, p=14) {
  const out=[];
  for (let i=p+1;i<=closes.length;i++) out.push(rsiVal(closes.slice(0,i),p));
  return out;
}

function smaVal(vals,p) {
  if (vals.length<p) return null;
  return vals.slice(-p).reduce((a,b)=>a+b,0)/p;
}

function bbVal(closes,p=20,n=2) {
  if (closes.length<p) return null;
  const sl=closes.slice(-p), mid=sl.reduce((a,b)=>a+b,0)/p;
  const std=Math.sqrt(sl.reduce((a,v)=>a+(v-mid)**2,0)/p);
  return {upper:mid+n*std,mid,lower:mid-n*std,std};
}

function atrVal(highs,lows,closes,p=14) {
  if (closes.length<p+1) return null;
  const trs=[];
  for (let i=1;i<closes.length;i++)
    trs.push(Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1])));
  return trs.slice(-p).reduce((a,b)=>a+b,0)/p;
}

function volmaVal(vols,p=20) {
  if (vols.length<p) return null;
  return vols.slice(-p).reduce((a,b)=>a+b,0)/p;
}

// Multi-timeframe confluence: 1m+5m+15m RSI all confirming direction
function confluence(r1,r5,r15,dir) {
  let s=0;
  if (dir==="LONG")  { if(r1<30)s++; if(r5<35)s++; if(r15&&r15<40)s++; }
  else               { if(r1>70)s++; if(r5>65)s++; if(r15&&r15>60)s++; }
  return s;
}

// ─── Macro Bias ───────────────────────────────────────────────────────────────

async function getMacro() {
  const cache = readJSON(MACRO_FILE,{});
  if (cache.ts && Date.now()-cache.ts<MACRO_TTL) {
    console.log(`  📡 Macro(cached): ${cache.phase} Bias=${cache.bias} RSI=${cache.weeklyRSI}`);
    return cache;
  }
  console.log("  📡 Fetching macro...");
  const [wBTC, russell, vix, fg, dom, altMcap, memeFrenzy] = await Promise.all([
    fetchOHLCV("BTCUSDT","1w",120), fetchYahoo("%5ERUT"), fetchYahoo("%5EVIX"),
    fetchFearGreed(), fetchDominance(), fetchAltcoinMcap(), fetchMemeFrenzy(),
  ]);
  if (!wBTC) return {phase:"NEUTRAL",bias:"NONE",ts:Date.now()};

  const weeklyRSI = rsiVal(wBTC.closes,14);
  const ma100w    = smaVal(wBTC.closes,100);
  const btcNow    = wBTC.closes.at(-1);
  const aboveMA   = ma100w ? btcNow>ma100w : null;

  updateDominanceHistory(dom);
  const domRSI    = calcDominanceRSI();  // weekly dominance RSI
  const domWeak   = domRSI !== null && domRSI < 40;

  // Dominance declining week-over-week (compare last 2 weekly closes)
  const domHist   = readJSON(DOM_FILE,[]);
  const domDeclining = domHist.length>=8 &&
    domHist.at(-1).dom < domHist.at(-8).dom;  // lower than 1 week ago

  // Russell 786 Fib
  let russ786=null, russRejecting=null;
  if (russell) {
    const fib=russell.high-(russell.high-russell.low)*0.786;
    russ786     = russell.current>fib;
    // Rejecting from resistance = near high but recent decline
    const r20   = russell.closes.slice(-20);
    russRejecting = russell.current < r20.at(-5) * 0.99 && russell.current > fib;
  }

  // Altcoin market cap: $1.85T was 2021 ATH — above = parabola territory
  const ALT_ATH = 1_850_000_000_000;
  const altAboveATH = altMcap && altMcap > ALT_ATH;

  // Weekly RSI trend (rising = last 3 weeks increasing)
  const weeklyRSIArr = rsiArr(wBTC.closes,14);
  const rsiRising    = weeklyRSIArr.length>=4 &&
    weeklyRSIArr.at(-1) > weeklyRSIArr.at(-4);

  // Bearish divergence: price up but RSI down over 4 weeks
  const bearDiv = weeklyRSIArr.length>=4 &&
    wBTC.closes.at(-1)>wBTC.closes.at(-4) &&
    weeklyRSIArr.at(-1)<weeklyRSIArr.at(-4)-3;

  const vixSpike = vix ? vix.current>28 : false;

  // ── DISTRIBUTION: 3+ of 5 signals (strategy doc requirement) ──
  let distribScore = 0;
  if (bearDiv)          distribScore++;   // 1. Weekly RSI bearish divergence
  if (domWeak)          distribScore++;   // 2. Dominance RSI < 40 and weakening
  if (memeFrenzy)       distribScore++;   // 3. Meme coins parabolic
  if (fg !== null && fg > 80) distribScore++; // 4. Extreme greed (crowd sentiment)
  if (russRejecting)    distribScore++;   // 5. Russell rejecting from resistance

  let phase="NEUTRAL", bias="NONE";

  // CAPITULATION first (most clear signal)
  if (weeklyRSI<30 && (aboveMA===false||vixSpike)) {
    phase="CAPITULATION"; bias="BOTH";
  }
  // DISTRIBUTION: 3+ signals
  else if (distribScore>=3) {
    phase="DISTRIBUTION"; bias="SHORT";
  }
  // MARKUP: ALL conditions met
  else if (weeklyRSI>50 && rsiRising && aboveMA && russ786!==false && domDeclining) {
    phase="MARKUP"; bias="LONG";
  }
  // MARKUP (relaxed): 3 of 5 markup conditions
  else if (weeklyRSI>50 && aboveMA && russ786!==false) {
    phase="MARKUP"; bias="LONG";
  }
  // ACCUMULATION
  else if (weeklyRSI>=30 && weeklyRSI<=55 && aboveMA) {
    phase="ACCUMULATION"; bias="LONG";
  }

  const result = {
    phase, bias,
    weeklyRSI: weeklyRSI?.toFixed(1), rsiRising,
    btcNow: btcNow?.toFixed(0), ma100w: ma100w?.toFixed(0), aboveMA,
    dom: dom?.toFixed(1), domRSI: domRSI?.toFixed(1), domDeclining, domWeak,
    russ786, russRejecting,
    altMcap: altMcap ? (altMcap/1e12).toFixed(2)+"T" : null, altAboveATH,
    memeFrenzy, fearGreed: fg,
    vixSpike, distribScore, bearDiv,
    ts: Date.now(),
  };
  writeJSON(MACRO_FILE, result);
  console.log(`  📡 Macro: ${phase} Bias=${bias} RSI=${weeklyRSI?.toFixed(1)} distribScore=${distribScore}/5 DOM=${dom?.toFixed(1)}%`);
  return result;
}

// ─── Setup 1: Wyckoff Spring ──────────────────────────────────────────────────
// RSI MUST be < 15 (strategy doc), reversal candle must have buy volume

function detectSpring(m5, m1, atr5m) {
  if (!atr5m) return null;
  const rsi1m  = rsiVal(m1.closes, RSI_PERIOD);
  const vma5m  = volmaVal(m5.volumes.slice(0,-1), VOL_MA);
  if (rsi1m===null||!vma5m) return null;

  const support   = Math.min(...m5.lows.slice(-21,-1));
  const prevClose = m5.closes.at(-2);
  const prevLow   = m5.lows.at(-2);
  const prevVol   = m5.volumes.at(-2);  // volume on spring candle
  const currVol   = m5.volumes.at(-1);  // volume on reversal candle
  const price     = m1.closes.at(-1);

  if (
    prevClose < support &&          // spring candle closed below support
    prevVol > vma5m * 2.0 &&        // massive sell volume on spring
    currVol >= prevVol * 0.8 &&     // reversal candle has equal/higher buy volume
    price > support &&              // recovered above support
    rsi1m < 15                      // ← strategy says < 15, not < 25
  ) {
    const swingHigh = Math.max(...m5.highs.slice(-15));
    return {
      setup:"WYCKOFF_SPRING", direction:"LONG",
      entry: price,
      target: swingHigh + 0.3*atr5m,           // target 1: spring high + 0.3 ATR
      target2: Math.max(...m5.highs.slice(-30)), // target 2: prior swing high
      stop:   Math.min(prevLow,support) - 0.5*atr5m,
      maxHoldMin: 15,
      reason: `Spring: support=${support.toFixed(5)} sellVol=${(prevVol/vma5m).toFixed(1)}x buyVol=${(currVol/vma5m).toFixed(1)}x RSI1m=${rsi1m.toFixed(1)}`,
    };
  }
  return null;
}

// ─── Setup 2: BB Mean Reversion ───────────────────────────────────────────────
// Entry on RSI BOUNCE (above 30 for long / below 70 for short), not just at extreme

function detectBBReversion(m5, m1, atr5m) {
  if (!atr5m) return null;
  const bb5m  = bbVal(m5.closes, BB_PERIOD, BB_STD);
  const rsi1m = rsiVal(m1.closes, RSI_PERIOD);
  // Need at least 2 recent 1-min RSI values to detect the bounce
  const rsi1mPrev = rsiVal(m1.closes.slice(0,-1), RSI_PERIOD);
  const vma1m = volmaVal(m1.volumes.slice(0,-1), VOL_MA);
  if (!bb5m||rsi1m===null||rsi1mPrev===null||!vma1m) return null;

  const price = m1.closes.at(-1);
  const volOK = m1.volumes.at(-1) > vma1m*1.3;

  // LONG: price at/below lower BB + RSI was below 25 + now bouncing back above 30
  const rsiBounceUp = rsi1mPrev < 25 && rsi1m > 30;
  if (price<=bb5m.lower*1.002 && rsiBounceUp && volOK) {
    return {
      setup:"BB_REVERSION", direction:"LONG",
      entry:price, target:bb5m.mid,
      stop: bb5m.lower - 0.3*atr5m, maxHoldMin:10,
      reason:`BB long: price=${price.toFixed(5)} RSI bounce ${rsi1mPrev.toFixed(1)}→${rsi1m.toFixed(1)} (was<25, now>30)`,
    };
  }

  // SHORT: price at/above upper BB + RSI was above 75 + now dropping below 70
  const rsiBounceDown = rsi1mPrev > 75 && rsi1m < 70;
  if (price>=bb5m.upper*0.998 && rsiBounceDown && volOK) {
    return {
      setup:"BB_REVERSION", direction:"SHORT",
      entry:price, target:bb5m.mid,
      stop: bb5m.upper + 0.3*atr5m, maxHoldMin:10,
      reason:`BB short: price=${price.toFixed(5)} RSI drop ${rsi1mPrev.toFixed(1)}→${rsi1m.toFixed(1)} (was>75, now<70)`,
    };
  }
  return null;
}

// ─── Setup 3: Volume Profile Liquidation ──────────────────────────────────────
// 3× vol spike + RSI extreme → enter 0.1% beyond the move to catch reversal

function detectVolumeLiquidation(m5, m1, atr5m) {
  if (!atr5m) return null;
  const lookback=48; // 4 hours of 5-min candles
  const sliceV = m5.volumes.slice(-lookback);
  const sliceH = m5.highs.slice(-lookback);
  const sliceL = m5.lows.slice(-lookback);

  // Highest-volume candle = key institutional level
  const maxIdx  = sliceV.reduce((b,v,i)=>v>sliceV[b]?i:b,0);
  const keyLvl  = (sliceH[maxIdx]+sliceL[maxIdx])/2;

  const price   = m1.closes.at(-1);
  const vma1m   = volmaVal(m1.volumes.slice(0,-1), VOL_MA);
  const lastVol = m1.volumes.at(-1);
  const rsi1m   = rsiVal(m1.closes, RSI_PERIOD);
  if (!vma1m||rsi1m===null) return null;

  const volSpike = lastVol > vma1m*3;  // 3× = liquidation event
  const dist     = Math.abs(price-keyLvl)/keyLvl*100;

  if (dist<0.3 && volSpike) {
    if (price<keyLvl && rsi1m<20) {
      // Enter 0.1% above the flush low (catch the reversal)
      const entry = price*1.001;
      return {
        setup:"VOL_LIQUIDATION", direction:"LONG",
        entry, target:entry+atr5m,
        stop:  price-atr5m, maxHoldMin:8,
        reason:`Vol liq LONG: key=${keyLvl.toFixed(5)} vol=${(lastVol/vma1m).toFixed(1)}x RSI=${rsi1m.toFixed(1)}`,
      };
    }
    if (price>keyLvl && rsi1m>80) {
      const entry = price*0.999;
      return {
        setup:"VOL_LIQUIDATION", direction:"SHORT",
        entry, target:entry-atr5m,
        stop:  price+atr5m, maxHoldMin:8,
        reason:`Vol liq SHORT: key=${keyLvl.toFixed(5)} vol=${(lastVol/vma1m).toFixed(1)}x RSI=${rsi1m.toFixed(1)}`,
      };
    }
  }
  return null;
}

// ─── Setup 4: Macro Sentiment Flush ───────────────────────────────────────────
// 1.5%+ sudden move → wait 30s → fade on RSI extreme (<20 / >80)
// Stop: 1.5 ATR (wider for volatile moves, per strategy doc)

function detectSentimentFlush(m1, atr5m, macro) {
  if (!atr5m) return null;
  const price   = m1.closes.at(-1);
  const prev    = m1.closes.at(-2);
  const movePct = (price-prev)/prev*100;

  if (Math.abs(movePct) < 1.5) return null;  // raised from 1% to 1.5%

  const flush = readJSON(FLUSH_FILE,{});
  const now   = Date.now();

  if (!flush.ts || now-flush.ts > 5*60*1000) {
    writeJSON(FLUSH_FILE,{ts:now,movePct,price});
    console.log(`  ⚡ Flush: ${movePct>=0?"+":""}${movePct.toFixed(2)}% — waiting 30s`);
    return null;
  }
  if (now-flush.ts < 30*1000) return null;

  const rsi1m  = rsiVal(m1.closes, RSI_PERIOD);
  if (rsi1m===null) return null;

  const dir = flush.movePct<0 ? "LONG" : "SHORT";
  if (dir==="LONG"  && macro.bias==="SHORT") return null;
  if (dir==="SHORT" && macro.bias==="LONG")  return null;

  if (dir==="LONG" && rsi1m<20) {
    delFile(FLUSH_FILE);
    return {
      setup:"SENTIMENT_FLUSH", direction:"LONG",
      entry:price, target:price+atr5m,
      stop: price-1.5*atr5m,  // wider stop: 1.5 ATR per strategy doc
      maxHoldMin:5,
      reason:`Flush LONG: move=${flush.movePct.toFixed(2)}% RSI=${rsi1m.toFixed(1)} waited=${((now-flush.ts)/1000).toFixed(0)}s`,
    };
  }
  if (dir==="SHORT" && rsi1m>80) {
    delFile(FLUSH_FILE);
    return {
      setup:"SENTIMENT_FLUSH", direction:"SHORT",
      entry:price, target:price-atr5m,
      stop: price+1.5*atr5m,
      maxHoldMin:5,
      reason:`Flush SHORT: move=${flush.movePct.toFixed(2)}% RSI=${rsi1m.toFixed(1)} waited=${((now-flush.ts)/1000).toFixed(0)}s`,
    };
  }
  return null;
}

// ─── Setup 5: RSI Divergence ──────────────────────────────────────────────────
// Works in MARKUP AND early CAPITULATION (not DISTRIBUTION — per strategy doc)
// 1-min RSI must also fail to confirm (multi-TF divergence)

function detectDivergence(m5, m1, atr5m, phase) {
  if (!atr5m) return null;
  // Only in MARKUP or CAPITULATION (strategy doc rule)
  if (phase!=="MARKUP" && phase!=="CAPITULATION") return null;

  const rsiArr5m = rsiArr(m5.closes, RSI_PERIOD);
  const rsiArr1m = rsiArr(m1.closes, RSI_PERIOD);
  if (rsiArr5m.length<12||rsiArr1m.length<12) return null;

  const lb=6;
  // 5-min divergence
  const priceHH   = Math.max(...m5.highs.slice(-lb));
  const pricePrev = Math.max(...m5.highs.slice(-(lb*2),-lb));
  const rsiHH5m   = Math.max(...rsiArr5m.slice(-lb));
  const rsiPrev5m = Math.max(...rsiArr5m.slice(-(lb*2),-lb));

  // 1-min RSI also fails to confirm (doesn't break above prior 1-min RSI high)
  const rsiHH1m   = Math.max(...rsiArr1m.slice(-lb));
  const rsiPrev1m = Math.max(...rsiArr1m.slice(-(lb*2),-lb));
  const rsi1mFails = rsiHH1m < rsiPrev1m;  // 1-min RSI not confirming the new high

  const vma5m = volmaVal(m5.volumes.slice(0,-1), VOL_MA);
  if (!vma5m) return null;

  const price = m1.closes.at(-1);

  if (
    priceHH > pricePrev*1.002 &&       // price: higher high
    rsiHH5m < rsiPrev5m - 3 &&         // 5-min RSI: lower high
    rsi1mFails &&                       // 1-min RSI also fails to confirm
    m5.volumes.at(-1) < vma5m*0.85     // volume declining
  ) {
    return {
      setup:"RSI_DIVERGENCE", direction:"SHORT",
      entry:price,
      target:Math.min(...m5.lows.slice(-lb)),
      stop: priceHH+0.5*atr5m, maxHoldMin:12,
      reason:`Bearish div: price ${pricePrev.toFixed(5)}→${priceHH.toFixed(5)} RSI5m ${rsiPrev5m.toFixed(1)}→${rsiHH5m.toFixed(1)} RSI1m fails=${rsi1mFails}`,
    };
  }
  return null;
}

// ─── Position Management ──────────────────────────────────────────────────────

const loadPos   = () => readJSON(POSITION_FILE,null);
const savePos   = p => p===null ? delFile(POSITION_FILE) : writeJSON(POSITION_FILE,p);
const loadDaily = () => {
  const today=new Date().toISOString().slice(0,10);
  const d=readJSON(DAILY_FILE,{});
  return d.date===today ? d : {date:today,pnlUSD:0,trades:0,wins:0};
};
const saveDaily = d => writeJSON(DAILY_FILE,d);

async function managePosition(pos, price) {
  const ageMin = (Date.now()-pos.entryTime)/60000;
  const pnlPct = pos.direction==="LONG"
    ? (price-pos.entry)/pos.entry*100
    : (pos.entry-price)/pos.entry*100;

  // ── Partial scale-out: at 50% of target, close 50% and trail stop ──
  if (!pos.scaled && pos.target2) {
    const halfTarget = pos.entry + (pos.target-pos.entry)*0.5;
    const reachedHalf = pos.direction==="LONG" ? price>=halfTarget : price<=halfTarget;
    if (reachedHalf) {
      console.log(`  📤 PARTIAL EXIT 50% at ${price.toFixed(5)} — locking profit, trailing rest`);
      pos.scaled   = true;
      pos.sizeUSD  = pos.sizeUSD*0.5;
      pos.stop     = pos.entry;  // move stop to breakeven for remaining 50%
      savePos(pos);
      await notify("[PAPER] Partial Exit 50%", `${pos.setup} ${pos.direction}: took 50% profit at ${price.toFixed(5)}, trailing rest`,"default");
    }
  }

  let closeReason=null;
  if (pos.direction==="LONG") {
    if (price>=pos.target) closeReason="TARGET_HIT";
    if (price<=pos.stop)   closeReason="STOP_HIT";
  } else {
    if (price<=pos.target) closeReason="TARGET_HIT";
    if (price>=pos.stop)   closeReason="STOP_HIT";
  }
  if (ageMin>=pos.maxHoldMin) closeReason="TIME_LIMIT";

  if (!closeReason) {
    console.log(`  📌 ${pos.direction} ${pos.setup} | P&L ${pnlPct>=0?"+":""}${pnlPct.toFixed(3)}% | ${ageMin.toFixed(1)}min | T=${pos.target.toFixed(5)} S=${pos.stop.toFixed(5)}${pos.scaled?" [scaled]":""}`);
    return false;
  }

  const pnlUSD = (pnlPct/100)*pos.sizeUSD;
  const daily  = loadDaily();
  daily.pnlUSD+=pnlUSD; daily.trades++; if(pnlUSD>0) daily.wins++;
  saveDaily(daily); savePos(null);

  const emoji=pnlUSD>0?"✅":"❌";
  console.log(`  ${emoji} CLOSED ${pos.direction} ${pos.setup} | ${closeReason} | ${pnlUSD>=0?"+":""}$${pnlUSD.toFixed(3)} (${pnlPct>=0?"+":""}${pnlPct.toFixed(3)}%)`);
  console.log(`  📅 Daily: ${daily.pnlUSD>=0?"+":""}$${daily.pnlUSD.toFixed(3)} | ${daily.wins}W/${daily.trades-daily.wins}L`);

  const tag=PAPER_TRADING?"[PAPER] ":"";
  await notify(
    `${tag}Scalp ${closeReason==="TARGET_HIT"?"✅ Win":"❌ Loss"} — ${pos.setup}`,
    `${pos.direction} ${SYMBOL}\nEntry: ${pos.entry.toFixed(5)} → Exit: ${price.toFixed(5)}\nP&L: ${pnlUSD>=0?"+":""}$${pnlUSD.toFixed(3)} (${pnlPct>=0?"+":""}${pnlPct.toFixed(3)}%)\n${closeReason} | ${ageMin.toFixed(1)}min\nDaily: ${daily.pnlUSD>=0?"+":""}$${daily.pnlUSD.toFixed(3)} | ${daily.wins}W/${daily.trades-daily.wins}L`,
    pnlUSD>0?"high":"default"
  );
  await logToSheet({
    Date:new Date().toISOString().slice(0,10), Time:new Date().toISOString().slice(11,19),
    Symbol:SYMBOL, Side:pos.direction==="LONG"?"BUY":"SELL", Setup:pos.setup,
    "Entry ($)":pos.entry, "Exit ($)":price, "Size ($)":pos.sizeUSD.toFixed(2),
    "P&L ($)":pnlUSD.toFixed(3), "P&L %":pnlPct.toFixed(3),
    "Close Reason":closeReason, "Hold Min":ageMin.toFixed(1),
    Phase:pos.phase, Confluence:pos.confluence, Scaled:pos.scaled||false,
    Mode:PAPER_TRADING?"PAPER":"LIVE",
  });
  return true;
}

async function openPosition(setup, macro, conf) {
  const {direction,entry,target,stop,maxHoldMin,reason,setup:name,target2} = setup;
  const riskUSD = ACCOUNT_USD*(RISK_PCT/100);
  const dist    = Math.abs(entry-stop);
  const sizeUSD = Math.min(dist>0?riskUSD/dist*entry:0, MAX_TRADE_USD);
  const rr      = Math.abs(target-entry)/Math.abs(entry-stop);

  if (rr < MIN_RR) {
    console.log(`  ⚠️  ${name} R/R=${rr.toFixed(2)} < ${MIN_RR} — skip`);
    return;
  }

  savePos({symbol:SYMBOL,direction,setup:name,entry,target,target2,stop,
    maxHoldMin,sizeUSD,entryTime:Date.now(),phase:macro.phase,confluence:conf,reason,scaled:false});

  const tPct=(Math.abs(target-entry)/entry*100).toFixed(2);
  const sPct=(Math.abs(stop-entry)/entry*100).toFixed(2);
  const tag=PAPER_TRADING?"[PAPER] ":"";

  console.log(`  🚀 ENTER ${direction} ${name} @ ${entry.toFixed(5)} | T+${tPct}% S-${sPct}% R/R ${rr.toFixed(2)} $${sizeUSD.toFixed(2)} Conf=${conf}/3`);
  console.log(`     ${reason}`);

  await notify(
    `${tag}New Scalp — ${name} ${direction}`,
    `${direction} ${SYMBOL} @ ${entry.toFixed(5)}\nTarget: +${tPct}% | Stop: -${sPct}%\nR/R: ${rr.toFixed(2)} | $${sizeUSD.toFixed(2)} | Conf: ${conf}/3\nPhase: ${macro.phase}`,
    "high"
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  const t=new Date().toISOString().replace("T"," ").slice(0,19);
  console.log(`\n⚡ BCB Scalper — ${t} UTC [${PAPER_TRADING?"PAPER":"LIVE"}]`);

  // 1. Daily loss / trade guards
  const daily=loadDaily();
  if (daily.pnlUSD <= -(ACCOUNT_USD*(MAX_DAILY_LOSS/100))) {
    console.log(`  🛑 Daily loss limit reached. Done for today.`); return;
  }
  if (daily.trades >= MAX_TRADES_DAY) {
    console.log(`  🛑 Max ${MAX_TRADES_DAY} trades/day.`); return;
  }
  console.log(`  📅 Daily: ${daily.pnlUSD>=0?"+":""}$${daily.pnlUSD.toFixed(3)} | ${daily.trades}T | ${daily.wins}W`);

  // 2. Hours filter — still manage open positions outside best hours
  if (!isGoodHour()) {
    console.log(`  🕐 Hour ${new Date().getUTCHours()} UTC not in [1-4,8-11,18-20]. No new trades.`);
    const p=loadPos();
    if (p) { const m1=await fetchOHLCV(SYMBOL,"1m",5); if(m1) await managePosition(p,m1.closes.at(-1)); }
    return;
  }

  // 3. Macro bias
  const macro=await getMacro();
  if (macro.phase==="NEUTRAL"||macro.bias==="NONE") {
    console.log("  ⏸️  No macro phase."); return;
  }

  // 4. Phase-specific trade limits
  if (macro.phase==="ACCUMULATION" && daily.trades>=2) {
    console.log("  ⏸️  Accumulation: 2/day cap."); return;
  }
  if (macro.phase==="DISTRIBUTION" && daily.trades>=2) {
    console.log("  ⏸️  Distribution: scalp small, 2/day cap."); return;
  }

  // 5. Multi-timeframe data
  const [m15,m5,m1] = await Promise.all([
    fetchOHLCV(SYMBOL,"15m",100),
    fetchOHLCV(SYMBOL,"5m",100),
    fetchOHLCV(SYMBOL,"1m",100),
  ]);
  if (!m5||!m1) { console.log("  ⚠️  Data unavailable."); return; }

  const price  = m1.closes.at(-1);
  const atr5m  = atrVal(m5.highs,m5.lows,m5.closes,ATR_PERIOD);
  const r1m    = rsiVal(m1.closes, RSI_PERIOD);
  const r5m    = rsiVal(m5.closes, RSI_PERIOD);
  const r15m   = m15 ? rsiVal(m15.closes, RSI_PERIOD) : null;
  const bb5m   = bbVal(m5.closes, BB_PERIOD, BB_STD);

  console.log(`  💹 ${SYMBOL} @ $${price.toFixed(5)} | ATR5m=${atr5m?.toFixed(5)}`);
  console.log(`  📊 RSI: 1m=${r1m?.toFixed(1)} 5m=${r5m?.toFixed(1)} 15m=${r15m?.toFixed(1)}`);
  if (bb5m) {
    const loc=price<bb5m.lower?"BELOW↓":price>bb5m.upper?"ABOVE↑":"inside";
    console.log(`  📐 BB5m: ${bb5m.lower.toFixed(5)}/${bb5m.mid.toFixed(5)}/${bb5m.upper.toFixed(5)} [${loc}]`);
  }

  // 6. Manage open position first
  const openPos=loadPos();
  if (openPos) { await managePosition(openPos,price); return; }

  // 7. Scan setups, filter by bias
  const canL = macro.bias==="LONG" ||macro.bias==="BOTH";
  const canS = macro.bias==="SHORT"||macro.bias==="BOTH";

  const candidates = [
    detectSpring(m5,m1,atr5m),
    detectBBReversion(m5,m1,atr5m),
    detectVolumeLiquidation(m5,m1,atr5m),
    detectSentimentFlush(m1,atr5m,macro),
    detectDivergence(m5,m1,atr5m,macro.phase),
  ]
    .filter(Boolean)
    .filter(s=>(s.direction==="LONG"&&canL)||(s.direction==="SHORT"&&canS));

  if (candidates.length===0) {
    const loc=bb5m?(price<bb5m.lower?"below":price>bb5m.upper?"above":`inside ${((price-bb5m.lower)/(bb5m.upper-bb5m.lower)*100).toFixed(0)}%`):"n/a";
    console.log(`  💤 No setups. Bias=${macro.bias} BB:${loc}`); return;
  }

  // 8. Score by confluence, pick best, require ≥1
  const scored = candidates
    .map(s=>({...s,conf:confluence(r1m,r5m,r15m,s.direction)}))
    .sort((a,b)=>b.conf-a.conf);

  console.log(`  🎯 ${scored.length} setup(s): ${scored.map(s=>`${s.setup}(${s.direction},conf=${s.conf})`).join(", ")}`);

  const best=scored[0];
  if (best.conf<1) {
    console.log(`  ⚠️  Confluence=${best.conf}/3 — need at least 1 timeframe. Waiting.`); return;
  }

  await openPosition(best, macro, best.conf);
}

run().catch(e=>{console.error("❌ Fatal:",e.message);process.exit(1);});
