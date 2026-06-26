/**
 * Real-time Dynamic Trading Signal API
 * Powered by @mathieuc/tradingview (Mathieu2301/TradingView-API)
 *
 * FIX: "Strong Buy/Sell" rating is NOT a WebSocket study. It comes from
 *      TradingView's scanner via TradingView.getTA(id), where id is
 *      "EXCHANGE:SYMBOL". We fetch candles from the chart WebSocket and the
 *      rating from getTA() in parallel, then merge.
 *
 * Endpoint:
 *   GET /get-signal?pair=BTCUSD&timeframe=5m
 *   GET /get-signal?pair=BINANCE:BTCUSDT&timeframe=1h
 */

const express = require('express');
const TradingView = require('@mathieuc/tradingview');

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------- 1. Helpers: normalize timeframe + symbol ---------- */

const TF_MAP = {
  '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '45m': '45',
  '1h': '60', '2h': '120', '3h': '180', '4h': '240',
  '1d': '1D', 'd': '1D', '1w': '1W', 'w': '1W', '1mo': '1M', 'm': '1M',
};

function normalizeTimeframe(tf) {
  if (!tf) return '5';
  const key = String(tf).toLowerCase();
  if (TF_MAP[key]) return TF_MAP[key];
  return String(tf).toUpperCase().replace('MIN', '');
}

function normalizeSymbol(pair) {
  if (!pair) return null;
  const p = pair.toUpperCase().trim();

  if (p.includes(':')) return p; // already EXCHANGE:SYMBOL

  // Crypto guesses (Binance uses USDT)
  if (/^(BTC|ETH|BNB|XRP|SOL|ADA|DOGE|LTC|MATIC|DOT|AVAX)/.test(p)) {
    const sym = p.endsWith('USD') ? p + 'T' : p;
    return `BINANCE:${sym}`;
  }

  // Forex guesses (6-letter pairs like EURUSD)
  if (/^[A-Z]{6}$/.test(p)) return `FX:${p}`;

  return p; // fallback - let TradingView try to resolve
}

/* ---------- 2. Rating value (-1..1) -> label ---------- */

function ratingToSignal(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'NEUTRAL';
  if (value >= 0.5) return 'STRONG_BUY';
  if (value >= 0.1) return 'BUY';
  if (value > -0.1) return 'NEUTRAL';
  if (value > -0.5) return 'SELL';
  return 'STRONG_SELL';
}

/* ---------- 3a. Candle snapshot from the chart WebSocket ---------- */

function fetchCandle(symbol, timeframe) {
  return new Promise((resolve, reject) => {
    const opts = {};
    if (process.env.TV_TOKEN && process.env.TV_SIGNATURE) {
      opts.token = process.env.TV_TOKEN;
      opts.signature = process.env.TV_SIGNATURE;
    }

    const client = new TradingView.Client(opts);
    const chart = new client.Session.Chart();

    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { client.end(); } catch (e) { /* ignore */ }
      fn(arg);
    };

    const timer = setTimeout(
      () => done(reject, new Error('Timeout fetching candles')), 15000);

    client.onError((...err) => done(reject, new Error(err.join(' '))));

    chart.setTimezone('UTC');
    chart.setMarket(symbol, { timeframe, range: 2 });
    chart.onError((...err) => done(reject, new Error(err.join(' '))));

    chart.onUpdate(() => {
      const c = chart.periods && chart.periods[0];
      if (!c) return;
      done(resolve, {
        time: c.time,
        open: c.open,
        high: c.max,
        low: c.min,
        close: c.close,
        volume: c.volume,
      });
    });
  });
}

/* ---------- 3b. Technical rating from the scanner via getTA() ----------
 * getTA(id) -> object keyed by interval, e.g.
 * { "1": { Other, All, MA, ... }, "5": {...}, "60": {...} }
 */

async function fetchRating(symbol, timeframe) {
  const ta = await TradingView.getTA(symbol); // expects "EXCHANGE:SYMBOL"
  if (!ta) return { rating: null, raw: null };

  // Find the bucket matching our timeframe; fall back to first available.
  const bucket = ta[timeframe] || ta[String(timeframe)] || Object.values(ta)[0];
  if (!bucket) return { rating: null, raw: null };

  // "All" is the overall Recommend.All score in [-1, 1]
  const rating = typeof bucket.All === 'number'
    ? bucket.All
    : (typeof bucket.Recommend === 'number' ? bucket.Recommend : null);

  return { rating, raw: bucket };
}

/* ---------- 4. Routes ---------- */

app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    usage: '/get-signal?pair=BTCUSD&timeframe=5m',
    examples: [
      '/get-signal?pair=EURUSD&timeframe=5m',
      '/get-signal?pair=BTCUSD&timeframe=1h',
      '/get-signal?pair=BINANCE:BTCUSDT&timeframe=15m',
    ],
  });
});

app.get('/get-signal', async (req, res) => {
  const rawPair = req.query.pair;
  const rawTf = req.query.timeframe;

  if (!rawPair) {
    return res.status(400).json({ error: 'Missing required query param: pair' });
  }

  const symbol = normalizeSymbol(rawPair);
  const timeframe = normalizeTimeframe(rawTf);

  // Run candle + rating in parallel; tolerate partial failure.
  const [candleResult, ratingResult] = await Promise.allSettled([
    fetchCandle(symbol, timeframe),
    fetchRating(symbol, timeframe),
  ]);

  const candle = candleResult.status === 'fulfilled' ? candleResult.value : null;
  const rating = ratingResult.status === 'fulfilled' ? ratingResult.value.rating : null;

  // If BOTH failed, the symbol is almost certainly wrong/unsupported.
  if (candle === null && rating === null) {
    return res.status(502).json({
      pair: rawPair,
      resolved_symbol: symbol,
      timeframe: rawTf || '5m',
      error: 'Could not fetch data from TradingView. Check the symbol (try EXCHANGE:SYMBOL).',
      detail: {
        candle: candleResult.status === 'rejected' ? String(candleResult.reason) : 'ok',
        rating: ratingResult.status === 'rejected' ? String(ratingResult.reason) : 'ok',
      },
      timestamp: new Date().toISOString(),
    });
  }

  res.json({
    pair: rawPair.toUpperCase(),
    resolved_symbol: symbol,
    timeframe: rawTf || '5m',
    signal: ratingToSignal(rating),
    recommendation: rating,
    candle,
    partial: candle === null || rating === null,
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`✅ Trading Signal API running on port ${PORT}`);
});
