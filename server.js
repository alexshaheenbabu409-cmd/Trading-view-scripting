/**
 * Real-time Dynamic Trading Signal API
 * Powered by @mathieuc/tradingview (Mathieu2301/TradingView-API)
 *
 * "Strong Buy/Sell" rating comes from TradingView's scanner via
 * TradingView.getTA("EXCHANGE:SYMBOL"). Candles come from the chart WebSocket.
 * Both run in parallel; partial failures are tolerated.
 *
 * Endpoints:
 * GET /get-signal?pair=BTCUSD&timeframe=5m
 * GET /health
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const TradingView = require('@mathieuc/tradingview');

const app = express();
const PORT = process.env.PORT || 3000;

// Behind Render/Railway/Sevalla proxies, trust the proxy so rate-limit reads the real IP.
app.set('trust proxy', 1);

/* ---------- 0. Rate limiting (protects us AND avoids TradingView blocking) ---------- */

const limiter = rateLimit({
  windowMs: 60 * 1000,      // 1 minute
  max: 30,                  // 30 requests / minute / IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Slow down and try again shortly.' },
});

/* ---------- 0b. Tiny in-memory cache (avoid hammering TradingView for repeats) ---------- */

const CACHE_TTL_MS = 8000; // serve identical pair+timeframe from cache for 8s
const cache = new Map();   // key -> { expires, payload }

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    cache.delete(key);
    return null;
  }
  return hit.payload;
}

function cacheSet(key, payload) {
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, payload });
  // Opportunistic cleanup so the Map never grows unbounded.
  if (cache.size > 500) {
    const now = Date.now();
    for (const [k, v] of cache) if (now > v.expires) cache.delete(k);
  }
}

/* ---------- 0c. Health check (for Render/Railway/Sevalla probes) ---------- */

app.get('/health', (_req, res) => {
  res.json({
    status: 'healthy',
    uptime_seconds: Math.round(process.uptime()),
    cache_entries: cache.size,
    timestamp: new Date().toISOString(),
  });
});

// Rate limit only the data endpoint, not / or /health.
app.use('/get-signal', limiter);

/* ---------- 1. Input validation patterns ---------- */

const VALID_PAIR = /^[A-Za-z0-9]{1,15}(:[A-Za-z0-9]{1,15})?$/;
const VALID_TF = /^[0-9]{1,4}$|^[0-9]{1,3}(m|h|d|w|mo)$|^[1]?[DWM]$/i;

/* ---------- 2. Helpers: normalize timeframe + symbol ---------- */

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

  if (p.includes(':')) return p; // already EXCHANGE:SYMBOL -> use exactly as given

  // Crypto guesses (Binance quotes in USDT). Convenience guess only;
  // for anything non-standard the caller should pass EXCHANGE:SYMBOL explicitly.
  if (/^(BTC|ETH|BNB|XRP|SOL|ADA|DOGE|LTC|MATIC|DOT|AVAX)/.test(p)) {
    const sym = p.endsWith('USD') ? p + 'T' : p;
    return `BINANCE:${sym}`;
  }

  // Forex guesses (6-letter pairs like EURUSD)
  if (/^[A-Z]{6}$/.test(p)) return `FX:${p}`;

  return p; // fallback - let TradingView try to resolve
}

/* ---------- 3. Rating value (-1..1) -> label ---------- */

function ratingToSignal(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'NEUTRAL';
  if (value >= 0.5) return 'STRONG_BUY';
  if (value >= 0.1) return 'BUY';
  if (value > -0.1) return 'NEUTRAL';
  if (value > -0.5) return 'SELL';
  return 'STRONG_SELL';
}

/* ---------- 4a. Candle snapshot from the chart WebSocket (with full cleanup) ---------- */

function fetchCandle(symbol, timeframe) {
  return new Promise((resolve, reject) => {
    const opts = {};
    if (process.env.TV_TOKEN && process.env.TV_SIGNATURE) {
      opts.token = process.env.TV_TOKEN;
      opts.signature = process.env.TV_SIGNATURE;
    }

    let client;
    let chart;
    let settled = false;

    const cleanup = () => {
      try { if (chart && typeof chart.delete === 'function') chart.delete(); } catch (e) { /* ignore */ }
      try { if (client) client.end(); } catch (e) { /* ignore */ }
      chart = null;
      client = null;
    };

    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      fn(arg);
    };

    const timer = setTimeout(
      () => done(reject, new Error('Timeout fetching candles')), 15000);

    try {
      client = new TradingView.Client(opts);
      chart = new client.Session.Chart();

      client.onError((...err) => done(reject, new Error(err.join(' '))));

      chart.setTimezone('UTC');
      chart.setMarket(symbol, { timeframe, range: 2 });
      chart.onError((...err) => done(reject, new Error(err.join(' '))));

      chart.onUpdate(() => {
        const c = chart && chart.periods && chart.periods[0];
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
    } catch (err) {
      done(reject, err);
    }
  });
}

/* ---------- 4b. Technical rating from the scanner via getTA() (self-contained) ---------- */

async function fetchRating(symbol, timeframe) {
  try {
    const ta = await TradingView.getTA(symbol); // expects "EXCHANGE:SYMBOL"
    if (!ta) return { rating: null, raw: null };

    const bucket = ta[timeframe] || ta[String(timeframe)] || Object.values(ta)[0];
    if (!bucket) return { rating: null, raw: null };

    const rating = typeof bucket.All === 'number'
      ? bucket.All
      : (typeof bucket.Recommend === 'number' ? bucket.Recommend : null);

    return { rating, raw: bucket };
  } catch (err) {
    return { rating: null, raw: null, error: String(err.message || err) };
  }
}

/* ---------- 5. Routes ---------- */

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
  if (!VALID_PAIR.test(rawPair)) {
    return res.status(400).json({
      error: 'Invalid pair format. Use letters/digits, optional EXCHANGE: prefix (e.g. BTCUSD or BINANCE:BTCUSDT).',
    });
  }
  if (rawTf && !VALID_TF.test(rawTf)) {
    return res.status(400).json({
      error: 'Invalid timeframe. Use values like 1m, 5m, 15m, 1h, 4h, 1d, 1w.',
    });
  }

  const symbol = normalizeSymbol(rawPair);
  const timeframe = normalizeTimeframe(rawTf);

  // --- Cache: serve recent identical requests without re-hitting TradingView ---
  const cacheKey = `${symbol}|${timeframe}`;
  const cached = cacheGet(cacheKey);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  // Run candle + rating in parallel; tolerate partial failure.
  const [candleResult, ratingResult] = await Promise.allSettled([
    fetchCandle(symbol, timeframe),
    fetchRating(symbol, timeframe),
  ]);

  const candle = candleResult.status === 'fulfilled' ? candleResult.value : null;
  const rating = ratingResult.status === 'fulfilled' ? ratingResult.value.rating : null;

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

  // সম্পূর্ণ পেলোড (কাটা পড়া অংশ জোড়া দেওয়া হয়েছে)
  const payload = {
    pair: rawPair.toUpperCase(),
    resolved_symbol: symbol,
    timeframe: rawTf || '5m',
    signal: ratingToSignal(rating),
    recommendation: rating,
    candle,
    partial: candle === null || rating === null,
    timestamp: new Date().toISOString(),
  };

  // ক্যাশে সেভ করা
  cacheSet(cacheKey, payload);

  res.json({ ...payload, cached: false });
});

// সার্ভার চালু করার কোড
app.listen(PORT, () => {
  console.log(`✅ API running on port ${PORT}`);
});
    
