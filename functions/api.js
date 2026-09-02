export async function onRequest(context) {
  const { searchParams } = new URL(context.request.url);
  const symbol = (searchParams.get('symbol') || '').trim();
  
  if (!symbol) {
    return new Response(JSON.stringify({ error: 'Symbol parameter is required' }), {
      status: 400,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*' 
      }
    });
  }

  // กรณีเป็นเรทเงิน USD/THB ให้ดึงจาก Exchange Rate API ตรงที่เสถียรและเร็วมาก
  if (symbol.toUpperCase() === 'USDTHB=X' || symbol.toUpperCase() === 'USDTHB') {
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
            }
          }), {
            headers: { 
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'public, max-age=300, s-maxage=300'
            }
          });
        }
      }
    } catch (e) {
      // Fallback ไปลอง Yahoo ตามปกติ
    }
  }

  const cleanSym = encodeURIComponent(symbol);
  const endpoints = [
    `https://query2.finance.yahoo.com/v8/finance/chart/${cleanSym}`,
    `https://query1.finance.yahoo.com/v8/finance/chart/${cleanSym}`,
    `https://api.allorigins.win/raw?url=${encodeURIComponent('https://query2.finance.yahoo.com/v8/finance/chart/' + cleanSym)}`
  ];

  const browserHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://finance.yahoo.com',
    'Referer': `https://finance.yahoo.com/quote/${cleanSym}`,
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site'
  };

  for (const url of endpoints) {
    try {
      const response = await fetch(url, {
        headers: browserHeaders,
        signal: AbortSignal.timeout(2500),
        cf: { cacheTtl: 60, cacheEverything: true }
      });

      if (!response.ok) continue;

      const data = await response.json();
      if (data && data.chart && data.chart.result && data.chart.result[0]) {
        return new Response(JSON.stringify(data), {
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=60, s-maxage=60'
          }
        });
      }
    } catch (error) {
      // ลอง endpoint ถัดไป
    }
  }

  return new Response(JSON.stringify({ error: `Unable to fetch data for ${symbol} from Yahoo Finance` }), {
    status: 502,
    headers: { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*' 
    }
  });
}
