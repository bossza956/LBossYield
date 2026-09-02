export async function onRequest(context) {
  const { searchParams } = new URL(context.request.url);
  const symbolParam = (searchParams.get('symbols') || searchParams.get('symbol') || '').trim();
  
  if (!symbolParam) {
    return new Response(JSON.stringify({ error: 'Symbol or symbols parameter is required' }), {
      status: 400,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*' 
      }
    });
  }

  // กรณีเป็นเรทเงิน USD/THB ให้ดึงจาก Exchange Rate API ตรงที่เสถียรและเร็วมาก
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
    } catch (e) {
      // Fallback ไปลอง Yahoo ตามปกติ
    }
  }

  const rawSymbols = symbolParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const cleanSymbolsStr = encodeURIComponent(rawSymbols.join(','));

  const browserHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://finance.yahoo.com',
    'Referer': 'https://finance.yahoo.com/',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site'
  };

  // 1. ลองดึงผ่าน Yahoo Spark API (รองรับหลายหุ้นพร้อมกันใน request เดียว และไม่ติด rate limit)
  const sparkUrls = [
    `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${cleanSymbolsStr}&range=1d&interval=1d`,
    `https://query2.finance.yahoo.com/v8/finance/spark?symbols=${cleanSymbolsStr}&range=1d&interval=1d`
  ];

  for (const sUrl of sparkUrls) {
    try {
      const response = await fetch(sUrl, {
        headers: browserHeaders,
        signal: AbortSignal.timeout(3000),
        cf: { cacheTtl: 60, cacheEverything: true }
      });

      if (!response.ok) continue;

      const sparkData = await response.json();
      if (sparkData && typeof sparkData === 'object') {
        const prices = {};
        for (const sym of rawSymbols) {
          const item = sparkData[sym];
          if (item) {
            let price = null;
            if (Array.isArray(item.close) && item.close.length > 0) {
              for (let i = item.close.length - 1; i >= 0; i--) {
                if (item.close[i] !== null && item.close[i] !== undefined && !isNaN(item.close[i])) {
                  price = item.close[i];
                  break;
                }
              }
            }
            if (price === null && item.chartPreviousClose && !isNaN(item.chartPreviousClose)) {
              price = item.chartPreviousClose;
            }
            if (price !== null) {
              prices[sym] = price;
            }
          }
        }

        if (Object.keys(prices).length > 0) {
          // ถ้าขอตัวเดียว ให้สร้าง chart format ให้เข้ากับ frontend เดิมด้วย
          const singleSym = rawSymbols[0];
          const singlePrice = prices[singleSym];
          return new Response(JSON.stringify({
            prices: prices,
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
              'Cache-Control': 'public, max-age=60, s-maxage=60'
            }
          });
        }
      }
    } catch (e) {}
  }

  // 2. ถ้า Spark ไม่ผ่าน และเป็นตัวเดียว ให้ลอง Chart API เดิม
  if (rawSymbols.length === 1) {
    const singleSym = encodeURIComponent(rawSymbols[0]);
    const chartUrls = [
      `https://query2.finance.yahoo.com/v8/finance/chart/${singleSym}`,
      `https://query1.finance.yahoo.com/v8/finance/chart/${singleSym}`
    ];

    for (const cUrl of chartUrls) {
      try {
        const response = await fetch(cUrl, {
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
      } catch (e) {}
    }
  }

  return new Response(JSON.stringify({ error: `Unable to fetch data for ${symbolParam}` }), {
    status: 502,
    headers: { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*' 
    }
  });
}
