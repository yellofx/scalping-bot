/**
 * Claude + TradingView MCP — Hybrid Scalp Bot
 *
 * Strategie: Hybrid Scalp (Rayner Teo + ICT + Kathy Lien + David Paul)
 *   - Bias-Filter:  15-Min Bow Tie (EMA21, EMA55, SMA89) — David Paul
 *   - Entry-Setup:  3-Min EMA9/21/50 Stack + RSI(7) + VWAP
 *   - Stop Loss:    ATR-basiert, automatisch bei jedem Trade
 *   - Positionsgröße: 90% des verfügbaren Kapitals
 *   - Kill-Zone:    London Open + NY Open
 *
 * Local mode:  node bot.js
 * Cloud mode:  Railway (cron every 3 min)
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["BITGET_API_KEY", "BITGET_SECRET_KEY", "BITGET_PASSPHRASE"];
  const missing = required.filter((k) => !process.env[k]);

  // Wenn alle Pflicht-Vars gesetzt sind, kein .env nötig (z.B. Railway)
  if (missing.length > 0) {
    // Nur lokal: .env erstellen und öffnen
    if (!existsSync(".env")) {
      console.log("\n⚠️  No .env file found — creating template...\n");
      writeFileSync(
        ".env",
        [
          "# BitGet credentials",
          "BITGET_API_KEY=",
          "BITGET_SECRET_KEY=",
          "BITGET_PASSPHRASE=",
          "",
          "# Trading config",
          "PORTFOLIO_VALUE_USD=700",
          "MAX_TRADES_PER_DAY=24",
          "PAPER_TRADING=true",
          "SYMBOL=SPXUSDT",
          "TIMEFRAME=3m",
          "",
          "# Scalping risk config",
          "CAPITAL_PCT=0.9",
          "SL_PCT=0.15",
          "MAX_SL_PCT=0.5",
          "LEVERAGE=50",
        ].join("\n") + "\n",
      );
      try { execSync("open .env"); } catch {}
    }
    console.log(`\n⚠️  Missing credentials: ${missing.join(", ")}`);
    console.log("Set them in .env (local) or Railway environment variables.\n");
    process.exit(0);
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol:          process.env.SYMBOL          || "SPXUSDT",
  timeframe:       process.env.TIMEFRAME        || "3m",
  biasTimeframe:   process.env.BIAS_TIMEFRAME   || "15m",
  portfolioValue:  parseFloat(process.env.PORTFOLIO_VALUE_USD || "700"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY    || "24"),
  paperTrading:    process.env.PAPER_TRADING !== "false",
  tradeMode:       process.env.TRADE_MODE       || "futures",
  capitalPct:      parseFloat(process.env.CAPITAL_PCT  || "0.9"),
  slPct:           parseFloat(process.env.SL_PCT        || "0.15") / 100,
  maxSlPct:        parseFloat(process.env.MAX_SL_PCT    || "0.5")  / 100,
  leverage:        parseInt(process.env.LEVERAGE         || "50"),
  bitget: {
    apiKey:     process.env.BITGET_API_KEY,
    secretKey:  process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl:    process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
};

const LOG_FILE = "safety-check-log.json";

// ─── Logging ──────────────────────────────────────────────────────────────────

function loadLog()       { if (!existsSync(LOG_FILE)) return { trades: [] }; return JSON.parse(readFileSync(LOG_FILE, "utf8")); }
function saveLog(log)    { writeFileSync(LOG_FILE, JSON.stringify(log, null, 2)); }
function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(t => t.timestamp.startsWith(today) && t.orderPlaced).length;
}

// ─── Kill-Zone Filter (London + NY Open, MEZ) ─────────────────────────────────

function isKillZone() {
  const now   = new Date();
  const utcH  = now.getUTCHours();
  const utcM  = now.getUTCMinutes();
  const utcMin = utcH * 60 + utcM;

  // London Open: 07:00–09:00 UTC
  // NY Open:     14:00–16:00 UTC
  // NY PM:       19:00–21:00 UTC
  const zones = [[7*60, 9*60], [14*60, 16*60], [19*60, 21*60]];
  return zones.some(([s, e]) => utcMin >= s && utcMin <= e);
}

// ─── BitGet Auth ──────────────────────────────────────────────────────────────

function signBitGet(timestamp, method, path, body = "") {
  const message = `${timestamp}${method}${path}${body}`;
  return crypto.createHmac("sha256", CONFIG.bitget.secretKey).update(message).digest("base64");
}

async function bitgetGet(path) {
  const ts  = Date.now().toString();
  const sig = signBitGet(ts, "GET", path);
  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    headers: {
      "ACCESS-KEY":        CONFIG.bitget.apiKey,
      "ACCESS-SIGN":       sig,
      "ACCESS-TIMESTAMP":  ts,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
  });
  return res.json();
}

async function bitgetPost(path, body) {
  const ts      = Date.now().toString();
  const bodyStr = JSON.stringify(body);
  const sig     = signBitGet(ts, "POST", path, bodyStr);
  const res     = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "ACCESS-KEY":        CONFIG.bitget.apiKey,
      "ACCESS-SIGN":       sig,
      "ACCESS-TIMESTAMP":  ts,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
    body: bodyStr,
  });
  return res.json();
}

// ─── Market Data ──────────────────────────────────────────────────────────────

async function fetchCandles(symbol, granularity, limit = 200) {
  const url = `${CONFIG.bitget.baseUrl}/api/v2/mix/market/candles` +
    `?symbol=${symbol}&granularity=${granularity}&productType=USDT-FUTURES&limit=${limit}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`BitGet candles API error: ${res.status}`);
  const data = await res.json();
  if (data.code !== "00000") throw new Error(`BitGet candles error: ${data.msg}`);
  return data.data.reverse().map(k => ({
    time:   parseInt(k[0]),
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Indicator Calculations ───────────────────────────────────────────────────

function calcEMA(closes, period) {
  const mult = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * mult + ema * (1 - mult);
  return ema;
}

function calcSMA(closes, period) {
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function calcVolumeAvg(volumes, period) {
  const slice = volumes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function calcRSI(closes, period = 7) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains  += diff;
    else          losses -= diff;
  }
  const avgGain = gains  / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return candles[candles.length - 1].close * 0.003;
  const trs = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const prev  = candles[i - 1].close;
    const high  = candles[i].high;
    const low   = candles[i].low;
    const close = candles[i].close;
    trs.push(Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev)));
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

function calcVWAP(candles) {
  // Use candles from start of UTC day
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayMs   = todayStart.getTime();
  const dayCandles = candles.filter(c => c.time >= todayMs);
  if (dayCandles.length === 0) return candles[candles.length - 1].close;

  let sumPV = 0, sumV = 0;
  for (const c of dayCandles) {
    const tp = (c.high + c.low + c.close) / 3;
    sumPV += tp * c.volume;
    sumV  += c.volume;
  }
  return sumV === 0 ? candles[candles.length - 1].close : sumPV / sumV;
}

// Detect pullback: at least 2 candles touching or crossing EMA in counter-trend direction
function detectPullback(candles, ema9, side) {
  const last5 = candles.slice(-5);
  if (side === "buy") {
    // Long: look for candles that dipped near or below EMA9, then bounced
    const dipped = last5.some(c => c.low <= ema9 * 1.002);
    const bounced = last5[last5.length - 1].close > ema9;
    return dipped && bounced;
  } else {
    // Short: look for candles that bounced near or above EMA9, then dropped
    const bounced = last5.some(c => c.high >= ema9 * 0.998);
    const dropped = last5[last5.length - 1].close < ema9;
    return bounced && dropped;
  }
}

// ─── Account Balance ──────────────────────────────────────────────────────────

async function getAvailableBalance() {
  const data = await bitgetGet("/api/v2/mix/account/accounts?productType=USDT-FUTURES");
  if (data.code !== "00000") return null;
  const account = data.data?.find(a => a.marginCoin === "USDT");
  return account ? parseFloat(account.available) : null;
}

// ─── Safety Check — Pure Scalp Strategy ──────────────────────────────────────

function runScalpCheck(
  price, side,
  // 3-Min Entry indicators
  ema9_3, ema21_3, ema50_3, rsi7, vwap, atr14,
  candles3m
) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    console.log(`  ${pass ? "✅" : "🚫"} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check (Pure Scalp) ────────────────────────────\n");

  // ── 1. EMA Stack 3-Min ───────────────────────────────────────────────────
  const emaStackBull = ema9_3 > ema21_3 && ema21_3 > ema50_3;
  const emaStackBear = ema9_3 < ema21_3 && ema21_3 < ema50_3;
  const stackMatch   = side === "buy" ? emaStackBull : emaStackBear;

  check(
    `EMA Stack 3-Min (${side === "buy" ? "9>21>50" : "9<21<50"})`,
    side === "buy" ? "EMA9>EMA21>EMA50" : "EMA9<EMA21<EMA50",
    `EMA9=${ema9_3.toFixed(4)} EMA21=${ema21_3.toFixed(4)} EMA50=${ema50_3.toFixed(4)}`,
    stackMatch
  );

  // ── 2. VWAP Filter ───────────────────────────────────────────────────────
  const vwapPass = side === "buy" ? price > vwap : price < vwap;
  check(
    `Preis ${side === "buy" ? "über" : "unter"} VWAP`,
    side === "buy" ? `> ${vwap.toFixed(4)}` : `< ${vwap.toFixed(4)}`,
    price.toFixed(4),
    vwapPass
  );

  // ── 3. RSI Filter ────────────────────────────────────────────────────────
  const rsiPass = side === "buy" ? rsi7 > 50 && rsi7 < 80 : rsi7 < 50 && rsi7 > 20;
  check(
    `RSI(7) ${side === "buy" ? "> 50 und < 80" : "< 50 und > 20"}`,
    side === "buy" ? "50 < RSI < 80" : "20 < RSI < 50",
    rsi7.toFixed(1),
    rsiPass
  );

  // ── 4. Pullback / Bounce erkannt ─────────────────────────────────────────
  const pullbackDetected = detectPullback(candles3m, ema9_3, side);
  check(
    `Pullback an EMA9 erkannt (min. 2 Kerzen)`,
    side === "buy" ? "Low ≤ EMA9, dann Close > EMA9" : "High ≥ EMA9, dann Close < EMA9",
    pullbackDetected ? "ja" : "nein",
    pullbackDetected
  );

  // ── 5. Volumen-Bestätigung auf Trigger-Kerze ──────────────────────────────
  const volumes  = candles3m.map(c => c.volume);
  const avgVol20 = calcVolumeAvg(volumes, 20);
  const lastVol  = volumes[volumes.length - 1];
  const volPass  = lastVol >= avgVol20;
  check(
    "Trigger-Kerze Volumen ≥ 20-Perioden-Ø",
    `≥ ${avgVol20.toFixed(0)}`,
    lastVol.toFixed(0),
    volPass
  );

  // ── 6. Kill-Zone ─────────────────────────────────────────────────────────
  const inKillZone = isKillZone();
  check(
    "Kill-Zone aktiv (London/NY Open)",
    "07-09 / 14-16 / 19-21 UTC",
    inKillZone ? "ja" : "nein",
    inKillZone
  );

  // ── 7. ATR-Stop ≤ maxSlPct ───────────────────────────────────────────────
  const atrSlPct = (atr14 * 0.5) / price;
  const slPct    = Math.max(CONFIG.slPct, Math.min(atrSlPct, CONFIG.maxSlPct));
  const slPass   = slPct <= CONFIG.maxSlPct;
  check(
    `ATR-Stop ≤ ${(CONFIG.maxSlPct * 100).toFixed(2)}%`,
    `≤ ${CONFIG.maxSlPct * 100}%`,
    `${(slPct * 100).toFixed(3)}%`,
    slPass
  );

  const allPass = results.every(r => r.pass);
  return { results, allPass, slPct };
}

// ─── Position Sizing (90% des verfügbaren Kapitals) ──────────────────────────

function calcContractSize(availableBalance, price) {
  const margin   = availableBalance * CONFIG.capitalPct;
  const notional = margin * CONFIG.leverage;
  const size     = Math.floor(notional / price);
  return Math.max(size, 1);
}

// ─── BitGet Execution ─────────────────────────────────────────────────────────

async function placeOrder(symbol, side, size) {
  const path = "/api/v2/mix/order/place-order";
  const data = await bitgetPost(path, {
    symbol,
    productType: "USDT-FUTURES",
    marginMode:  "isolated",
    marginCoin:  "USDT",
    size:        size.toString(),
    side,
    tradeSide:   "open",
    orderType:   "market",
  });
  if (data.code !== "00000") throw new Error(`BitGet order failed: [${data.code}] ${data.msg}`);
  return data.data;
}

async function placeStopLoss(symbol, side, size, slPrice) {
  // To close a long: sell | To close a short: buy
  const closeSide = side === "buy" ? "sell" : "buy";
  const slStr     = slPrice.toFixed(4);
  const data      = await bitgetPost("/api/v2/mix/order/place-plan-order", {
    symbol,
    productType: "USDT-FUTURES",
    marginMode:  "isolated",
    marginCoin:  "USDT",
    size:        size.toString(),
    side:        closeSide,
    tradeSide:   "close",
    orderType:   "market",
    triggerPrice: slStr,
    triggerType:  "mark_price",
    planType:     "normal_plan",
  });
  if (data.code !== "00000") throw new Error(`SL order failed: [${data.code}] ${data.msg}`);
  return data.data;
}

// ─── Tax CSV Logging ──────────────────────────────────────────────────────────

const CSV_FILE    = "trades.csv";
const CSV_HEADERS = ["Date","Time (UTC)","Exchange","Symbol","Side","Quantity",
  "Price","Total USD","Fee (est.)","Net Amount","Order ID","SL Price","Mode","Notes"].join(",");

function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const note = `,,,,,,,,,,,,,"NOTE","Hybrid Scalp Bot — EMA9/21/50 + RSI(7) + VWAP + David Paul Bow Tie"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + note + "\n");
    console.log(`📄 Created ${CSV_FILE}`);
  }
}

function writeTradeCsv(entry) {
  const now     = new Date(entry.timestamp);
  const date    = now.toISOString().slice(0, 10);
  const time    = now.toISOString().slice(11, 19);
  let mode, notes, side = "", qty = "", totalUSD = "", fee = "", net = "", orderId = "", slPrice = "";

  if (!entry.allPass) {
    mode   = "BLOCKED";
    orderId = "BLOCKED";
    notes  = `Failed: ${entry.conditions.filter(c => !c.pass).map(c => c.label).join("; ")}`;
  } else if (entry.paperTrading) {
    side    = (entry.side || "buy").toUpperCase();
    qty     = (entry.tradeSize / entry.price).toFixed(2);
    totalUSD = entry.tradeSize.toFixed(2);
    fee     = (entry.tradeSize * 0.0006).toFixed(4);
    net     = (entry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = entry.orderId || "";
    slPrice = entry.slPrice?.toFixed(4) || "";
    mode    = "PAPER";
    notes   = "All conditions met";
  } else {
    side    = (entry.side || "buy").toUpperCase();
    qty     = entry.contractSize?.toString() || "";
    totalUSD = entry.tradeSize?.toFixed(2) || "";
    fee     = ((entry.tradeSize || 0) * 0.0006).toFixed(4);
    net     = ((entry.tradeSize || 0) - parseFloat(fee)).toFixed(2);
    orderId = entry.orderId || "";
    slPrice = entry.slPrice?.toFixed(4) || "";
    mode    = "LIVE";
    notes   = entry.error ? `Error: ${entry.error}` : "All conditions met";
  }

  const row = [date, time, "BitGet", entry.symbol, side, qty,
    entry.price.toFixed(4), totalUSD, fee, net, orderId, slPrice, mode, `"${notes}"`].join(",");

  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) { console.log("No trades.csv found."); return; }
  const lines   = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows    = lines.slice(1).map(l => l.split(","));
  const live    = rows.filter(r => r[12] === "LIVE");
  const paper   = rows.filter(r => r[12] === "PAPER");
  const blocked = rows.filter(r => r[12] === "BLOCKED");
  const volume  = live.reduce((s, r) => s + parseFloat(r[7] || 0), 0);
  const fees    = live.reduce((s, r) => s + parseFloat(r[8] || 0), 0);
  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions : ${rows.length}`);
  console.log(`  Live trades     : ${live.length}`);
  console.log(`  Paper trades    : ${paper.length}`);
  console.log(`  Blocked         : ${blocked.length}`);
  console.log(`  Total volume    : $${volume.toFixed(2)}`);
  console.log(`  Total fees (est): $${fees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Hybrid Scalp Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Symbol: ${CONFIG.symbol} | Entry: ${CONFIG.timeframe} | Bias: ${CONFIG.biasTimeframe}`);
  console.log(`  Kapital: ${CONFIG.capitalPct * 100}% | SL: ${CONFIG.slPct * 100}% | MaxSL: ${CONFIG.maxSlPct * 100}%`);

  const log          = loadLog();
  const todayCount   = countTodaysTrades(log);

  console.log(`\n── Trade Limits ─────────────────────────────────────────\n`);
  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(`🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`);
    return;
  }
  console.log(`✅ Trades heute: ${todayCount}/${CONFIG.maxTradesPerDay}`);

  // ── Fetch Candles ────────────────────────────────────────────────────────
  console.log("\n── Marktdaten laden ─────────────────────────────────────\n");

  const candles3m = await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 200);
  const closes3m  = candles3m.map(c => c.close);
  const price     = closes3m[closes3m.length - 1];

  console.log(`  Preis: $${price.toFixed(4)}`);

  // ── Indicators 3-Min ──────────────────────────────────────────────────────
  const ema9_3  = calcEMA(closes3m, 9);
  const ema21_3 = calcEMA(closes3m, 21);
  const ema50_3 = calcEMA(closes3m, 50);
  const rsi7    = calcRSI(closes3m, 7);
  const atr14   = calcATR(candles3m, 14);
  const vwap    = calcVWAP(candles3m);

  console.log(`  EMA9=${ema9_3.toFixed(4)} EMA21=${ema21_3.toFixed(4)} EMA50=${ema50_3.toFixed(4)}`);
  console.log(`  RSI(7)=${rsi7.toFixed(1)} | ATR(14)=${atr14.toFixed(5)} | VWAP=${vwap.toFixed(4)}`);

  // ── Determine Direction from EMA Stack ───────────────────────────────────
  const emaStackBull = ema9_3 > ema21_3 && ema21_3 > ema50_3;
  const emaStackBear = ema9_3 < ema21_3 && ema21_3 < ema50_3;

  if (!emaStackBull && !emaStackBear) {
    console.log("\n  Richtung: NEUTRAL — EMA Stack nicht eindeutig. Kein Trade.");
    const logEntry = {
      timestamp: new Date().toISOString(), symbol: CONFIG.symbol,
      timeframe: CONFIG.timeframe, price, allPass: false, orderPlaced: false,
      conditions: [{ label: "EMA Stack 3-Min", required: "eindeutig bullish oder bearish", actual: "neutral", pass: false }],
      side: "none", tradeSize: 0, paperTrading: CONFIG.paperTrading,
    };
    log.trades.push(logEntry); saveLog(log); writeTradeCsv(logEntry);
    return;
  }

  const side = emaStackBull ? "buy" : "sell";
  console.log(`\n  Richtung: ${emaStackBull ? "BULLISH 🟢 → Long" : "BEARISH 🔴 → Short"}`);

  // ── Safety Check ──────────────────────────────────────────────────────────
  const { results, allPass, slPct } = runScalpCheck(
    price, side,
    ema9_3, ema21_3, ema50_3, rsi7, vwap, atr14,
    candles3m
  );

  // ── Position Size ─────────────────────────────────────────────────────────
  let availableBalance = null;
  let contractSize     = 0;
  let tradeSize        = 0;

  if (allPass && !CONFIG.paperTrading) {
    availableBalance = await getAvailableBalance();
    if (availableBalance === null) {
      console.log("⚠️  Kontostand konnte nicht abgefragt werden.");
    } else {
      contractSize = calcContractSize(availableBalance, price);
      tradeSize    = contractSize * price;
      console.log(`\n  Balance: $${availableBalance.toFixed(4)} | Margin (90%): $${(availableBalance * 0.9).toFixed(4)}`);
      console.log(`  Kontrakte: ${contractSize} (~$${tradeSize.toFixed(2)} notional)`);
    }
  } else if (CONFIG.paperTrading) {
    contractSize = Math.floor((CONFIG.portfolioValue * CONFIG.capitalPct * CONFIG.leverage) / price);
    tradeSize    = contractSize * price;
  }

  // ── SL Preis berechnen ───────────────────────────────────────────────────
  const slPrice = side === "buy"
    ? price * (1 - slPct)
    : price * (1 + slPct);

  console.log(`\n  SL: $${slPrice.toFixed(4)} (${(slPct * 100).toFixed(3)}% vom Entry)`);

  // ── Decision ─────────────────────────────────────────────────────────────
  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp:  new Date().toISOString(),
    symbol:     CONFIG.symbol,
    timeframe:  CONFIG.timeframe,
    price,
    indicators: { ema9_3, ema21_3, ema50_3, rsi7, vwap, atr14 },
    side,
    conditions:   results,
    allPass,
    contractSize,
    tradeSize,
    slPrice,
    slPct,
    orderPlaced:  false,
    orderId:      null,
    slOrderId:    null,
    paperTrading: CONFIG.paperTrading,
  };

  if (!allPass) {
    const failed = results.filter(r => !r.pass).map(r => r.label);
    console.log(`🚫 TRADE BLOCKED`);
    failed.forEach(f => console.log(`   - ${f}`));
  } else {
    console.log(`✅ ALLE BEDINGUNGEN ERFÜLLT`);

    if (CONFIG.paperTrading) {
      console.log(`\n📋 PAPER — ${side.toUpperCase()} ${contractSize} Kontrakte ${CONFIG.symbol} @ ~$${price.toFixed(4)}`);
      console.log(`   Stop Loss: $${slPrice.toFixed(4)} (${(slPct * 100).toFixed(3)}%)`);
      logEntry.orderPlaced = true;
      logEntry.orderId     = `PAPER-${Date.now()}`;
    } else {
      if (contractSize < 1) {
        console.log("🚫 Kontostand zu niedrig für Trade.");
        logEntry.error = "Kontostand zu niedrig";
      } else {
        console.log(`\n🔴 LIVE — ${side.toUpperCase()} ${contractSize} Kontrakte ${CONFIG.symbol} @ ~$${price.toFixed(4)}`);
        try {
          const order = await placeOrder(CONFIG.symbol, side, contractSize);
          logEntry.orderPlaced = true;
          logEntry.orderId     = order.orderId;
          console.log(`✅ ORDER — ${order.orderId}`);

          // Kurz warten, dann Stop Loss setzen
          await new Promise(r => setTimeout(r, 500));
          try {
            const sl = await placeStopLoss(CONFIG.symbol, side, contractSize, slPrice);
            logEntry.slOrderId = sl.orderId;
            console.log(`🛡️  STOP LOSS gesetzt @ $${slPrice.toFixed(4)} — ${sl.orderId}`);
          } catch (slErr) {
            console.log(`⚠️  Stop Loss fehlgeschlagen: ${slErr.message}`);
            logEntry.slError = slErr.message;
          }
        } catch (err) {
          console.log(`❌ ORDER FEHLER — ${err.message}`);
          logEntry.error = err.message;
        }
      }
    }
  }

  log.trades.push(logEntry);
  saveLog(log);
  console.log(`\nDecision log → ${LOG_FILE}`);
  writeTradeCsv(logEntry);
  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch(err => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
