let cachedCookie = null;
let cachedCrumb = null;
let lastCrumbFetch = 0;

async function getYahooCrumbAndCookie() {
  const now = Date.now();
  if (cachedCookie && cachedCrumb && (now - lastCrumbFetch < 3600000)) {
    return { cookie: cachedCookie, crumb: cachedCrumb };
  }

  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  
  let cookie = '';
  try {
    const resCookie = await fetch('https://fc.yahoo.com', {
      headers: { 'User-Agent': userAgent },
      redirect: 'manual'
    });
    const setCookie = resCookie.headers.get('set-cookie');
    if (setCookie) {
      cookie = setCookie.split(';')[0];
    }
  } catch (e) {}

  let crumb = '';
  try {
    const resCrumb = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: {
        'User-Agent': userAgent,
        'Cookie': cookie
      }
    });
    if (resCrumb.ok) {
      crumb = (await resCrumb.text()).trim();
    }
  } catch (e) {}

  if (cookie && crumb) {
    cachedCookie = cookie;
    cachedCrumb = crumb;
    lastCrumbFetch = now;
    return { cookie, crumb };
  }

  return { cookie: null, crumb: null };
}

export async function onRequest(context) {
  const { searchParams } = new URL(context.request.url);
  const symbolParam = (searchParams.get('symbols') || searchParams.get('symbol') || '').trim();
  
  if (!symbolParam) {
    return new Response(JSON.stringify({ error: 'Symbol parameter is required' }), {
      status: 400,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*' 
      }
    });
  }

  // 1. เรทเงิน USD/THB ดึงจาก API ตรง (เสถียรและเร็วมาก)
  if (symbolParam.toUpperCase() === 'USDTHB=X' || symbolParam.toUpperCase() === 'USDTHB') {
    try {
      const erRes = await fetch('https://open.er-api.com/v6/latest/USD', {
        cf: { cacheTtl: 300, cacheEverything: true }
      });
      if (erRes.ok) {
        const erData = await erRes.json();
        const thbRate = erData?.rates?.THB;
        if (thbRate && !isNaN(thbRate)) {
          return new Response(JSON.stringify({
            chart: {
              result: [{
                meta: {
                  currency: 'THB',
                  symbol: 'USDTHB=X',
                  regularMarketPrice: thbRate
                }
              }]
            },
            price: thbRate
          }), {
            headers: { 
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'public, max-age=300, s-maxage=300'
            }
          });
        }
      }
    } catch (e) {}
  }

  const rawSymbols = symbolParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  // 2. วิธีหลัก: ดึงผ่าน Yahoo Crumb Quote API (Official & 100% Reliable)
  try {
    const { cookie, crumb } = await getYahooCrumbAndCookie();
    if (crumb) {
      const quoteUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(rawSymbols.join(','))}&crumb=${encodeURIComponent(crumb)}`;
      const qRes = await fetch(quoteUrl, {
        headers: {
          'User-Agent': userAgent,
          'Cookie': cookie || ''
        },
        cf: { cacheTtl: 30, cacheEverything: true }
      });

      if (qRes.ok) {
        const qData = await qRes.json();
        const results = qData?.quoteResponse?.result || [];
        if (results.length > 0) {
          const prices = {};
          results.forEach(r => {
            const p = r.regularMarketPrice !== undefined ? r.regularMarketPrice : r.chartPreviousClose;
            if (p !== undefined && p !== null && !isNaN(p)) {
              prices[r.symbol.toUpperCase()] = Number(p);
            }
          });

          const singleSym = rawSymbols[0];
          const singlePrice = prices[singleSym];
          return new Response(JSON.stringify({
            prices: prices,
            price: singlePrice,
            chart: {
              result: [{
                meta: {
                  symbol: singleSym,
                  regularMarketPrice: singlePrice
                }
              }]
            }
          }), {
            headers: { 
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'public, max-age=30, s-maxage=30'
            }
          });
        }
      }
    }
  } catch (e) {}

  // 3. Fallback: Spark API
  try {
    const sparkUrl = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${encodeURIComponent(rawSymbols.join(','))}&range=1d&interval=1d`;
    const sRes = await fetch(sparkUrl, {
      headers: { 'User-Agent': userAgent },
      cf: { cacheTtl: 30, cacheEverything: true }
    });
    if (sRes.ok) {
      const sparkData = await sRes.json();
      const prices = {};
      rawSymbols.forEach(sym => {
        const item = sparkData[sym];
        if (item) {
          let price = null;
          if (Array.isArray(item.close) && item.close.length > 0) {
            for (let i = item.close.length - 1; i >= 0; i--) {
              if (item.close[i] !== null && item.close[i] !== undefined && !isNaN(item.close[i])) {
                price = Number(item.close[i]);
                break;
              }
            }
          }
          if (price === null && item.chartPreviousClose && !isNaN(item.chartPreviousClose)) {
            price = Number(item.chartPreviousClose);
          }
          if (price !== null) prices[sym] = price;
        }
      });

      if (Object.keys(prices).length > 0) {
        const singleSym = rawSymbols[0];
        const singlePrice = prices[singleSym];
        return new Response(JSON.stringify({
          prices: prices,
          price: singlePrice,
          chart: {
            result: [{
              meta: {
                symbol: singleSym,
                regularMarketPrice: singlePrice
              }
            }]
          }
        }), {
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=30, s-maxage=30'
          }
        });
      }
    }
  } catch (e) {}

  return new Response(JSON.stringify({ error: `Unable to fetch data for ${symbolParam}` }), {
    status: 502,
    headers: { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*' 
    }
  });
}
