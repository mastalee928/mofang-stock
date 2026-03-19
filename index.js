require('dotenv').config();

const SITE_URL = (process.env.SITE_URL || 'https://oci.ee').replace(/\/$/, '');
const CART_URL = `${SITE_URL}/cart`;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const NOTIFY_HEADER = process.env.NOTIFY_HEADER || '魔方库存';
const NOTIFY_SUBTITLE = process.env.NOTIFY_SUBTITLE || '';

async function fetchCartHtml() {
  const res = await fetch(CART_URL, {
    headers: { 'User-Agent': 'MofangNotice/1.0' },
  });
  if (!res.ok) throw new Error(`Cart ${res.status}: ${await res.text()}`);
  return res.text();
}

/**
 * 从购物车 HTML 解析商品：以「库存：」为锚点，向前取名称，向后取价格与链接。仅返回库存 > 0 的。
 */
function parseProductsFromHtml(html) {
  const products = [];
  const stockRegex = /库存[：:]\s*(\d+)/g;
  let m;
  while ((m = stockRegex.exec(html)) !== null) {
    const stock = parseInt(m[1], 10);
    if (stock <= 0) continue;
    const before = html.slice(0, m.index);
    const after = html.slice(m.index);
    const nameMatch = before.match(/<h4[^>]*>([^<]+)<\/h4>|####\s*([^\n<]+)/gi);
    const name = nameMatch ? (nameMatch[nameMatch.length - 1].replace(/<[^>]+>|####\s*/gi, '').trim()) : '';
    const priceMatch = after.match(/¥\s*([\d.]+)\s*元/);
    const price = priceMatch ? priceMatch[1] : '';
    let url = CART_URL;
    const hrefMatch = after.match(/href="(https?:\/\/[^"]*cart[^"]*action=configureproduct[^"]*)"/i);
    if (hrefMatch) url = hrefMatch[1];
    else {
      const pidMatch = after.match(/action=configureproduct&pid=(\d+)/i);
      if (pidMatch) url = `${SITE_URL}/cart?action=configureproduct&pid=${pidMatch[1]}`;
    }
    if (name) products.push({ name, stock, price, url });
  }
  return products;
}

function buildProductRows(products) {
  return products.map((p) => {
    const text = `${p.name} - ¥ ${p.price} - 剩余:${p.stock}`;
    return [{ text, url: p.url }];
  });
}

async function sendReply(chatId, message, inlineKeyboard) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text: message,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (inlineKeyboard && inlineKeyboard.length) {
    body.reply_markup = { inline_keyboard: inlineKeyboard };
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.description || `Telegram ${res.status}`);
}

async function getStockAndReply(chatId) {
  let html;
  try {
    html = await fetchCartHtml();
  } catch (e) {
    await sendReply(chatId, `拉取购物车失败：${e.message}`);
    return;
  }
  const products = parseProductsFromHtml(html);
  const parts = [
    NOTIFY_HEADER.trim() ? `<b>${NOTIFY_HEADER}</b>` : '',
    NOTIFY_SUBTITLE.trim(),
  ].filter((s) => String(s).trim() !== '');
  const header = parts.length ? parts.join('\n\n') + '\n\n' : '';
  if (products.length === 0) {
    await sendReply(chatId, header + '当前没有可购买库存。');
    return;
  }
  const rows = buildProductRows(products);
  await sendReply(chatId, header + `共 ${products.length} 个有库存商品，点击下方跳转购买：`, rows);
}

function isStockCommand(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim().toLowerCase();
  return t === '/stock' || t === '/库存' || t === '/start' || t.startsWith('/stock@') || t.startsWith('/库存@');
}

async function processUpdate(update) {
  const chatId = update.message?.chat?.id ?? update.callback_query?.message?.chat?.id;
  const text = update.message?.text ?? update.callback_query?.data;
  if (!chatId) return;
  if (update.callback_query?.data === 'stock' || isStockCommand(text)) {
    try {
      await getStockAndReply(chatId);
    } catch (e) {
      console.error('[mofang-notice] 回复失败', e.message);
      try {
        await sendReply(chatId, `发送失败：${e.message}`);
      } catch (_) {}
    }
  }
}

async function longPoll() {
  let offset = 0;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`;
  while (true) {
    try {
      const res = await fetch(`${url}?offset=${offset}&timeout=30`);
      const data = await res.json().catch(() => ({}));
      if (!data.ok) {
        console.error('[mofang-notice] getUpdates 错误', data.description);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      const updates = data.result || [];
      for (const u of updates) {
        offset = u.update_id + 1;
        await processUpdate(u);
      }
    } catch (e) {
      console.error('[mofang-notice] longPoll', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function main() {
  if (process.argv.includes('--once')) {
    const chatId = process.env.TEST_CHAT_ID || '';
    if (!chatId) {
      console.log('用法：TEST_CHAT_ID=你的聊天ID node index.js --once');
      process.exit(1);
    }
    await getStockAndReply(chatId);
    setTimeout(() => process.exit(0), 100);
    return;
  }
  if (!TELEGRAM_BOT_TOKEN) {
    console.error('[mofang-notice] 请设置 TELEGRAM_BOT_TOKEN');
    process.exit(1);
  }
  console.log('[mofang-notice] Bot 已启动，发 /stock 或 /库存 或 /start 查看当前有库存商品。CART=', CART_URL);
  await longPoll();
}

main().catch((e) => {
  console.error('[mofang-notice]', e);
  process.exit(1);
});
