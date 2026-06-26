Const express = require('express');
const TradingView = require('@mathieuc/tradingview');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- timeframe map: "5m" -> TradingView code "5" ----
const TF_MAP = {
  '1m':'1','3m':'3','5m':'5','15m':'15','30m':'30','45m':'45',
  '1h':'60','2h':'120','3h':'180','4h':'240',
  '1d':'1D','d':'1D','1w':'1W','w':'1W','1mo':'1M','m':'1M',
};
function normalizeTimeframe(tf){
  if(!tf) return '5';
  const k = String(tf).toLowerCase();
  if(TF_MAP[k]) return TF_MAP[k];
  return String(tf).toUpperCase().replace('MIN','');
}

// ---- symbol map: "BTCUSD" -> "BINANCE:BTCUSDT", "EURUSD" -> "FX:EURUSD" ----
function normalizeSymbol(pair){
  if(!pair) return null;
  const p = pair.toUpperCase().trim();
  if(p.includes(':')) return p;                       // already EXCHANGE:SYMBOL
  if(/^(BTC|ETH|BNB|XRP|SOL|ADA|DOGE|LTC)/.test(p)){
    const sym = p.endsWith('USD') ? p+'T' : p;        // USD -> USDT for Binance
    return `BINANCE:${sym}`;
  }
  if(/^[A-Z]{6}$/.test(p)) return `FX:${p}`;          // forex 6-letter
  return p;
}

function ratingToSignal(v){
  if(v==null || Number.isNaN(v)) return 'NEUTRAL';
  if(v>=0.5) return 'STRONG_BUY';
  if(v>=0.1) return 'BUY';
  if(v>-0.1) return 'NEUTRAL';
  if(v>-0.5) return 'SELL';
  return 'STRONG_SELL';
}

function fetchSignal(symbol, timeframe){
  return new Promise((resolve, reject) => {
    const opts = {};
    if(process.env.TV_TOKEN && process.env.TV_SIGNATURE){
      opts.token = process.env.TV_TOKEN;
      opts.signature = process.env.TV_SIGNATURE;
    }
    const client = new TradingView.Client(opts);
    const chart = new client.Session.Chart();

    let settled = false;
    const done = (fn, arg) => {
      if(settled) return; settled = true;
      clearTimeout(timer);
      try { client.end(); } catch(e){}
      fn(arg);
    };
    const timer = setTimeout(
      () => done(reject, new Error('TradingView timeout')), 20000);

    client.onError((...e) => done(reject, new Error(e.join(' '))));
    chart.setTimezone('UTC');
    chart.setMarket(symbol, { timeframe, range: 2 });
    chart.onError((...e) => done(reject, new Error(e.join(' '))));

    TradingView.getIndicator('STD;Recommend%1All').then((indic) => {
      const study = new chart.Study(indic);
      study.onError((...e) => done(reject, new Error(e.join(' '))));
      study.onUpdate(() => {
        const s = study.periods && study.periods[0];
        const c = chart.periods && chart.periods[0];
        let rating = null;
        if(s){
          rating = typeof s.Recommend === 'number'
            ? s.Recommend
            : Object.values(s).find(v => typeof v === 'number');
        }
        done(resolve, {
          rating,
          signal: ratingToSignal(rating),
          candle: c ? {
            time:c.time, open:c.open, high:c.max,
            low:c.min, close:c.close, volume:c.volume
          } : null,
        });
      });
    }).catch(e => done(reject, e));
  });
}

app.get('/', (_req,res) => res.json({
  status:'ok',
  usage:'/get-signal?pair=BTCUSD&timeframe=5m'
}));

app.get('/get-signal', async (req,res) => {
  const rawPair = req.query.pair;
  const rawTf = req.query.timeframe;
  if(!rawPair) return res.status(400).json({error:'Missing query param: pair'});

  const symbol = normalizeSymbol(rawPair);
  const timeframe = normalizeTimeframe(rawTf);
  try {
    const d = await fetchSignal(symbol, timeframe);
    res.json({
      pair: rawPair.toUpperCase(),
      resolved_symbol: symbol,
      timeframe: rawTf || '5m',
      signal: d.signal,
      recommendation: d.rating,
      candle: d.candle,
      timestamp: new Date().toISOString(),
    });
  } catch(err){
    res.status(502).json({
      pair:rawPair, timeframe:rawTf,
      error:'Could not fetch data from TradingView',
      detail:String(err.message||err),
      timestamp:new Date().toISOString(),
    });
  }
});

app.listen(PORT, () => console.log(`✅ API running on port ${PORT}`));
