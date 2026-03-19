require('dotenv').config();

const SITE_URL = (process.env.SITE_URL || 'https://oci.ee').replace(/\/$/, '');
const CART_URL = `${SITE_URL}/cart`;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const NOTIFY_HEADER = process.env.NOTIFY_HEADER || '魔方库存';
const NOTIFY_SUBTITLE = process.env.NOTIFY_SUBTITLE || '';

async function fetchCartHtml(query) {
  const url = query ? `${CART_URL}${query.startsWith('?') ? query : '?' + query}` : CART_URL;
  const res = await fetch(url, { headers: { 'User-Agent': 'MofangNotice/1.0' } });
  if (!res.ok) throw new Error(`Cart ${res.status}`);
  return res.text();
}

/** 从购物车页解析一级：产品类型（fid + 名称），按 DOM 顺序；一级用 firstgroup_item */
function parseLevel1(html) {
  const list = [];
  const re = /firstgroup_item[^>]+onclick="[^"]*\/cart\?fid=(\d+)"[^>]*>[\s\S]*?yy-bth-text-a[^>]*>([^<]+)/gi;
  let m;
  const seen = new Set();
  while ((m = re.exec(html)) !== null) {
    const fid = m[1];
    const label = m[2].replace(/\s*<[^>]+>\s*/gi, '').trim();
    if (seen.has(fid) || !label) continue;
    seen.add(fid);
    list.push({ fid, label });
  }
  return list;
}

/** 从 cart?fid=X 页解析二级：可用区域/类型（gid + 名称），按 DOM 顺序 */
function parseLevel2(html, fid) {
  const list = [];
  const re = new RegExp(`onclick="[^"]*\\/cart\\?fid=${fid}&gid=(\\d+)"[^>]*>[\s\S]*?yy-bth-text-a[^>]*>([^<]+)`, 'gi');
  let m;
  while ((m = re.exec(html)) !== null) {
    const gid = m[1];
    const label = m[2].replace(/\s*<[^>]+>\s*/gi, '').trim();
    if (!label) continue;
    list.push({ query: `fid=${fid}&gid=${gid}`, label });
  }
  return list;
}

/** 从页面解析有库存商品（名称、库存、价格、链接） */
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

/**
 * 拉取 /cart，解析一级；对每个一级拉取 cart?fid=X 解析二级（顺序同站）；对每个二级拉取 cart?fid=X&gid=Y 解析商品。
 * 返回 { level1Order, level2Order, tree }，tree[level1Label][level2Label] = products
 */
async function fetchAndBuildTree() {
  const level1Order = [];
  const level2Order = {};
  const tree = {};
  let html;
  try {
    html = await fetchCartHtml('');
  } catch (e) {
    return { level1Order: [], level2Order: {}, tree: {} };
  }
  let l1List = parseLevel1(html);
  if (l1List.length === 0) {
    l1List = [{ fid: '1', label: 'OCI' }, { fid: '3', label: 'Special' }, { fid: '2', label: '独享机器' }];
  }
  for (const { fid, label } of l1List) {
    level1Order.push(label);
    tree[label] = {};
    level2Order[label] = [];
    let html2;
    try {
      html2 = await fetchCartHtml(`fid=${fid}`);
    } catch (_) {
      continue;
    }
    const l2List = parseLevel2(html2, fid);
    for (const { query, label: l2Label } of l2List) {
      level2Order[label].push(l2Label);
      let products;
      try {
        const html3 = await fetchCartHtml(query);
        products = parseProductsFromHtml(html3);
      } catch (_) {
        products = [];
      }
      tree[label][l2Label] = products;
    }
  }
  return { level1Order, level2Order, tree };
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

async function answerCallbackQuery(callbackQueryId) {
  const u = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
  await fetch(u, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
}

async function editMessageText(chatId, messageId, message, inlineKeyboard) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`;
  const body = {
    chat_id: chatId,
    message_id: messageId,
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

async function sendStockLevel1(chatId, messageId, data) {
  const { level1Order, tree } = data;
  const parts = [
    NOTIFY_HEADER.trim() ? `<b>${NOTIFY_HEADER}</b>` : '',
    NOTIFY_SUBTITLE.trim(),
  ].filter((s) => String(s).trim() !== '');
  const header = parts.length ? parts.join('\n\n') + '\n\n' : '';
  const text = header + '请选择产品类型：';
  const keyboard = level1Order.length
    ? [level1Order.map((name) => ({ text: name, callback_data: `L1:${name}` }))]
    : [];
  if (messageId) await editMessageText(chatId, messageId, text, keyboard);
  else await sendReply(chatId, text, keyboard);
}

async function sendStockLevel2(chatId, messageId, data, level1) {
  const { level2Order, tree } = data;
  const order = level2Order[level1] || [];
  const sub = tree[level1] || {};
  const buttons = order.filter((r) => sub[r] && sub[r].length > 0).map((r) => ({
    text: r,
    callback_data: `L2:${level1}:${r}`,
  }));
  const text = buttons.length
    ? `请选择区域（${level1}）：`
    : `${level1} 下暂无可用库存。`;
  const keyboard = buttons.length ? buttons.map((b) => [b]) : [];
  if (messageId) await editMessageText(chatId, messageId, text, keyboard);
  else await sendReply(chatId, text, keyboard);
}

async function sendStockProducts(chatId, messageId, data, level1, level2) {
  const { tree } = data;
  const products = tree[level1]?.[level2] || [];
  const parts = [
    NOTIFY_HEADER.trim() ? `<b>${NOTIFY_HEADER}</b>` : '',
    NOTIFY_SUBTITLE.trim(),
  ].filter((s) => String(s).trim() !== '');
  const header = parts.length ? parts.join('\n\n') + '\n\n' : '';
  if (products.length === 0) {
    const text = header + `该分类下暂无可用库存。`;
    if (messageId) await editMessageText(chatId, messageId, text, []);
    else await sendReply(chatId, text);
    return;
  }
  const rows = buildProductRows(products);
  const text = header + `${level1} · ${level2}\n共 ${products.length} 个有库存，点击跳转购买：`;
  if (messageId) await editMessageText(chatId, messageId, text, rows);
  else await sendReply(chatId, text, rows);
}

function isStockCommand(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim().toLowerCase();
  return t === '/stock' || t === '/库存' || t === '/start' || t.startsWith('/stock@') || t.startsWith('/库存@');
}

async function processUpdate(update, data) {
  const callback = update.callback_query;
  const chatId = update.message?.chat?.id ?? callback?.message?.chat?.id;
  const messageId = callback?.message?.message_id;
  const text = update.message?.text ?? callback?.data;

  if (!chatId) return;

  if (callback) await answerCallbackQuery(callback.id);

  if (callback?.data) {
    const d = callback.data;
    if (d.startsWith('L1:')) {
      await sendStockLevel2(chatId, messageId, data, d.slice(3));
      return;
    }
    if (d.startsWith('L2:')) {
      const parts = d.split(':');
      const level1 = parts[1];
      const level2 = parts.slice(2).join(':'); // 二级名称可能含 :
      await sendStockProducts(chatId, messageId, data, level1, level2);
      return;
    }
  }

  if (isStockCommand(text)) {
    try {
      const freshData = await fetchAndBuildTree();
      await sendStockLevel1(chatId, messageId, freshData);
    } catch (e) {
      console.error('[mofang-notice] 回复失败', e.message);
      try {
        await sendReply(chatId, `拉取失败：${e.message}`);
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
        const freshData = await fetchAndBuildTree();
        await processUpdate(u, freshData);
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
    const data = await fetchAndBuildTree();
    await sendStockLevel1(chatId, null, data);
    setTimeout(() => process.exit(0), 100);
    return;
  }
  if (!TELEGRAM_BOT_TOKEN) {
    console.error('[mofang-notice] 请设置 TELEGRAM_BOT_TOKEN');
    process.exit(1);
  }
  console.log('[mofang-notice] Bot 已启动：/stock → 一级/二级/商品均从站点 /cart 解析，顺序与站点一致。CART=', CART_URL);
  await longPoll();
}

main().catch((e) => {
  console.error('[mofang-notice]', e);
  process.exit(1);
});
