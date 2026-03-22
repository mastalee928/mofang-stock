require('dotenv').config();

const SITE_URL = (process.env.SITE_URL || 'https://oci.ee').replace(/\/$/, '');
const WEBSSH_URL = (process.env.WEBSSH_URL || 'https://webssh.oci.ee').replace(/\/$/, '');
const CART_URL = `${SITE_URL}/cart`;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const NOTIFY_HEADER = process.env.NOTIFY_HEADER || '魔方库存';
const NOTIFY_SUBTITLE = process.env.NOTIFY_SUBTITLE || '';
const CACHE_TTL_SECONDS = Math.max(30, Number(process.env.CACHE_TTL_SECONDS) || 60);
const STOCK_ASKER_TTL_MS = Math.max(60, Number(process.env.STOCK_ASKER_TTL_SECONDS) || 3600) * 1000;
const STOCK_ASKER_MAX_SIZE = Math.max(100, Number(process.env.STOCK_ASKER_MAX_SIZE) || 2000);
/** 库存键盘消息多少秒后自动删除（仅对新发出的那条消息），0 表示不自动删 */
const STOCK_MESSAGE_DELETE_AFTER_SECONDS = Math.max(0, Number(process.env.STOCK_MESSAGE_DELETE_AFTER_SECONDS) || 900);
/** 同一聊天室 N 秒内只发一条库存菜单，防刷屏（0 表示不限制） */
const STOCK_CHAT_COOLDOWN_SECONDS = Math.max(0, Number(process.env.STOCK_CHAT_COOLDOWN_SECONDS) || 15);
/** 官网/webssh/独享 等简单回复的聊天室冷却秒数（0 表示不限制） */
const SIMPLE_REPLY_COOLDOWN_SECONDS = Math.max(0, Number(process.env.SIMPLE_REPLY_COOLDOWN_SECONDS) || 10);
/** 代发到群：管理员 user id 列表（逗号分隔），仅这些人可用 /say、/发群 */
const ADMIN_IDS = new Set((process.env.TELEGRAM_ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number));
/** 代发目标：bot 代发消息发到这个群/频道（留空则关闭代发） */
const ANNOUNCE_CHAT_ID = (process.env.TELEGRAM_ANNOUNCE_CHAT_ID || '').trim();
/** 群组内发送指定「退钱」动图时自动禁言秒数，0 关闭 */
const RNM_AUTO_MUTE_SECONDS = Math.max(0, Number(process.env.RNM_AUTO_MUTE_SECONDS) || 9999);
const RNM_MUTE_FILE_UNIQUE_ID = (process.env.RNM_MUTE_FILE_UNIQUE_ID || 'AgADDgQAAqdBFVE').trim();
const RNM_MUTE_FILE_NAME = (process.env.RNM_MUTE_FILE_NAME || 'rnm-退钱.mp4').trim();

let treeCache = { data: null, expiresAt: 0 };
/** 按聊天室冷却：chatId -> 上次发送库存菜单的时间戳 */
const chatLastStockAt = new Map();
/** 按聊天室冷却：官网/webssh/独享 上次回复时间戳 */
const chatLastSimpleReplyAt = new Map();
/** 群组内 /stock 键盘：key = `${chatId}:${messageId}`, value = { userId, at }，带 TTL 与容量上限 */
const stockAskerMap = new Map();

function getStockAsker(key) {
  const v = stockAskerMap.get(key);
  if (!v) return undefined;
  if (Date.now() - v.at > STOCK_ASKER_TTL_MS) {
    stockAskerMap.delete(key);
    return undefined;
  }
  return v.userId;
}

function setStockAsker(key, userId) {
  if (stockAskerMap.size >= STOCK_ASKER_MAX_SIZE) {
    for (const k of stockAskerMap.keys()) {
      const entry = stockAskerMap.get(k);
      if (Date.now() - entry.at > STOCK_ASKER_TTL_MS) stockAskerMap.delete(k);
    }
    while (stockAskerMap.size >= STOCK_ASKER_MAX_SIZE) {
      const first = stockAskerMap.keys().next().value;
      if (first == null) break;
      stockAskerMap.delete(first);
    }
  }
  stockAskerMap.set(key, { userId, at: Date.now() });
}

function getCachedTree() {
  if (treeCache.data && Date.now() < treeCache.expiresAt) return treeCache.data;
  return null;
}
function setCachedTree(data) {
  treeCache = { data, expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000 };
}

/** 检查官网/webssh/独享 冷却，若在冷却内返回剩余秒数，否则返回 null */
function getSimpleReplyCooldownSec(chatId) {
  if (SIMPLE_REPLY_COOLDOWN_SECONDS <= 0) return null;
  const lastAt = chatLastSimpleReplyAt.get(chatId);
  const now = Date.now();
  if (lastAt != null && now - lastAt < SIMPLE_REPLY_COOLDOWN_SECONDS * 1000)
    return Math.ceil((SIMPLE_REPLY_COOLDOWN_SECONDS * 1000 - (now - lastAt)) / 1000);
  return null;
}
function setSimpleReplyCooldown(chatId) {
  chatLastSimpleReplyAt.set(chatId, Date.now());
}

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

/** 从 cart?fid=X 页解析二级：可用区域/类型（gid + 名称），按 DOM 顺序；链接可能在单引号内 */
function parseLevel2(html, fid) {
  const list = [];
  const re = new RegExp(`fid=${fid}&gid=(\\d+)[\\s'\"][\\s\\S]*?yy-bth-text-a[^>]*>([^<]+)`, 'gi');
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
 * 拉取 /cart 解析一级；并行拉取各 fid 页解析二级；并行拉取各 fid&gid 页解析商品。
 * 返回 { level1Order, level2Order, tree }
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
  const html2List = await Promise.all(l1List.map(({ fid }) => fetchCartHtml(`fid=${fid}`).catch(() => '')));
  const productFetches = [];
  for (let i = 0; i < l1List.length; i++) {
    const { fid, label } = l1List[i];
    const html2 = html2List[i];
    level1Order.push(label);
    tree[label] = {};
    level2Order[label] = [];
    if (!html2) continue;
    const l2List = parseLevel2(html2, fid);
    for (const { query, label: l2Label } of l2List) {
      level2Order[label].push(l2Label);
      productFetches.push({ label, l2Label, query });
    }
  }
  const productHtmls = await Promise.all(productFetches.map(({ query }) => fetchCartHtml(query).catch(() => '')));
  for (let i = 0; i < productFetches.length; i++) {
    const { label, l2Label } = productFetches[i];
    tree[label][l2Label] = parseProductsFromHtml(productHtmls[i] || '');
  }
  return { level1Order, level2Order, tree };
}

function buildProductRows(products) {
  return products.map((p) => {
    const text = `${p.name} - ¥ ${p.price} - 剩余:${p.stock}`;
    return [{ text, url: p.url }];
  });
}

async function sendReply(chatId, message, inlineKeyboard, replyToMessageId) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text: message,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (replyToMessageId) body.reply_to_message_id = replyToMessageId;
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
  return data.result;
}

async function answerCallbackQuery(callbackQueryId, options = {}) {
  const u = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
  const body = { callback_query_id: callbackQueryId, ...options };
  await fetch(u, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function deleteMessage(chatId, messageId) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) console.warn('[mofang-notice] deleteMessage', data.description || res.status);
}

/** 是否为目标「退钱」MP4（file_unique_id 或指定文件名） */
function isRnmTuiqianMuteMedia(msg) {
  if (!msg || RNM_AUTO_MUTE_SECONDS <= 0) return false;
  const anim = msg.animation;
  const doc = msg.document;
  const uid = RNM_MUTE_FILE_UNIQUE_ID;
  if (uid && (anim?.file_unique_id === uid || doc?.file_unique_id === uid)) return true;
  const videoNamed = (f) =>
    f &&
    RNM_MUTE_FILE_NAME &&
    f.file_name === RNM_MUTE_FILE_NAME &&
    String(f.mime_type || '').toLowerCase().includes('video');
  if (videoNamed(anim) || videoNamed(doc)) return true;
  return false;
}

async function restrictUserMuteSeconds(chatId, userId, seconds) {
  const until = Math.floor(Date.now() / 1000) + seconds;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/restrictChatMember`;
  const permissions = {
    can_send_messages: false,
    can_send_audios: false,
    can_send_documents: false,
    can_send_photos: false,
    can_send_videos: false,
    can_send_video_notes: false,
    can_send_voice_notes: false,
    can_send_polls: false,
    can_send_other_messages: false,
    can_add_web_page_previews: false,
    can_change_info: false,
    can_invite_users: false,
    can_pin_messages: false,
    can_manage_topics: false,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      user_id: userId,
      permissions,
      until_date: until,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.description || `HTTP ${res.status}`);
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

async function sendStockLevel1(chatId, messageId, data, replyToId) {
  const { level1Order, tree } = data;
  const parts = [
    NOTIFY_HEADER.trim() ? `<b>${NOTIFY_HEADER}</b>` : '',
    NOTIFY_SUBTITLE.trim(),
  ].filter((s) => String(s).trim() !== '');
  const header = parts.length ? parts.join('\n\n') + '\n\n' : '';
  const text = header + '请选择产品类型：';
  const keyboard = level1Order.length
    ? [level1Order.map((name) => ({ text: name, callback_data: `L1:${name}` })), [{ text: '◀ 返回', callback_data: 'back:L0' }]]
    : [];
  if (messageId) await editMessageText(chatId, messageId, text, keyboard);
  else {
    const sent = await sendReply(chatId, text, keyboard, replyToId);
    return sent?.message_id;
  }
}

async function sendStockLevel2(chatId, messageId, data, level1, replyToId) {
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
  keyboard.push([{ text: '◀ 返回', callback_data: 'back:L1' }]);
  if (messageId) await editMessageText(chatId, messageId, text, keyboard);
  else await sendReply(chatId, text, keyboard, replyToId);
}

async function sendStockProducts(chatId, messageId, data, level1, level2, replyToId) {
  const { tree } = data;
  const products = tree[level1]?.[level2] || [];
  const parts = [
    NOTIFY_HEADER.trim() ? `<b>${NOTIFY_HEADER}</b>` : '',
    NOTIFY_SUBTITLE.trim(),
  ].filter((s) => String(s).trim() !== '');
  const header = parts.length ? parts.join('\n\n') + '\n\n' : '';
  if (products.length === 0) {
    const text = header + `该分类下暂无可用库存。`;
    const keyboard = [[{ text: '◀ 返回', callback_data: `back:L2:${level1}` }]];
    if (messageId) await editMessageText(chatId, messageId, text, keyboard);
    else await sendReply(chatId, text, keyboard, replyToId);
    return;
  }
  const rows = buildProductRows(products);
  rows.push([{ text: '◀ 返回', callback_data: `back:L2:${level1}` }]);
  const text = header + `${level1} · ${level2}\n共 ${products.length} 个有库存，点击跳转购买：`;
  if (messageId) await editMessageText(chatId, messageId, text, rows);
  else await sendReply(chatId, text, rows, replyToId);
}

/** 仅这三类触发库存菜单：/stock（及 /stock@bot）、纯文本 库存、纯文本 stock，避免与 nmBot 的 /库存 冲突 */
function isStockCommand(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  const tl = t.toLowerCase();
  return t === '/stock' || tl === 'stock' || t === '库存' || tl.startsWith('/stock@');
}

async function processUpdate(update, data) {
  const callback = update.callback_query;
  const chatId = update.message?.chat?.id ?? update.channel_post?.chat?.id ?? callback?.message?.chat?.id;
  const messageId = callback?.message?.message_id;
  const text = update.message?.text ?? update.channel_post?.text ?? callback?.data;
  const replyToId = update.message?.message_id ?? update.channel_post?.message_id;

  if (!chatId) return;

  if (
    RNM_AUTO_MUTE_SECONDS > 0 &&
    update.message &&
    !update.message.from?.is_bot &&
    (update.message.chat?.type === 'group' || update.message.chat?.type === 'supergroup') &&
    isRnmTuiqianMuteMedia(update.message)
  ) {
    try {
      await restrictUserMuteSeconds(chatId, update.message.from.id, RNM_AUTO_MUTE_SECONDS);
      console.log('[mofang-notice] 退钱梗图禁言', chatId, update.message.from.id, `${RNM_AUTO_MUTE_SECONDS}s`);
    } catch (e) {
      console.warn('[mofang-notice] 退钱梗图禁言失败（需 Bot 为管理员并开启「限制成员」）', e.message);
    }
    return;
  }

  if (callback?.data) {
    const key = `${chatId}:${messageId}`;
    const askerUserId = getStockAsker(key);
    if (askerUserId != null && callback.from.id !== askerUserId) {
      await answerCallbackQuery(callback.id, { show_alert: true, text: '仅限发起人操作' });
      return;
    }
  }

  if (callback) await answerCallbackQuery(callback.id);

  if (callback?.data) {
    const d = callback.data;
    if (d === 'back:L0') {
      const parts = [NOTIFY_HEADER.trim() ? `<b>${NOTIFY_HEADER}</b>` : '', NOTIFY_SUBTITLE.trim()].filter((s) => String(s).trim() !== '');
      const header = parts.length ? parts.join('\n\n') + '\n\n' : '';
      await editMessageText(chatId, messageId, header + '发送 /stock、库存 或 stock 查看有库存商品。', []);
      return;
    }
    if (d === 'back:L1') {
      await sendStockLevel1(chatId, messageId, data, replyToId);
      return;
    }
    if (d.startsWith('back:L2:')) {
      const level1 = d.slice(8); // "back:L2:OCI" -> "OCI"
      await sendStockLevel2(chatId, messageId, data, level1, replyToId);
      return;
    }
    if (d.startsWith('L1:')) {
      await sendStockLevel2(chatId, messageId, data, d.slice(3), replyToId);
      return;
    }
    if (d.startsWith('L2:')) {
      const parts = d.split(':');
      const level1 = parts[1];
      const level2 = parts.slice(2).join(':'); // 二级名称可能含 :
      await sendStockProducts(chatId, messageId, data, level1, level2, replyToId);
      return;
    }
  }

  const msgText = (update.message?.text || update.channel_post?.text || '').trim();

  if (/^\/help(@\w+)?\s*$/i.test(msgText)) {
    const helpText = [
      '<b>可用指令</b>',
      '• <code>/stock</code> — 查看有库存商品（也可发纯文本 <code>库存</code> 或 <code>stock</code>）',
      '• <code>/say 内容</code> — 私聊代发到群（仅管理员，需配置）',
      '',
      '<b>关键词回复</b>',
      '• 发 <code>主页</code> 或 <code>官网</code> → 站点链接',
      '• 消息含 <code>webssh</code> → WebSSH 链接',
      '• 问独享相关 → 有/没有 + 提示发 库存 查看',
    ].join('\n');
    await sendReply(chatId, helpText, undefined, replyToId);
    return;
  }

  /** 代发仅允许私聊，避免在群里发 /say 被所有人看到指令和内容 */
  if (ANNOUNCE_CHAT_ID && update.message?.from?.id && ADMIN_IDS.has(update.message.from.id)) {
    const sayMatch = msgText.match(/^\/(say|发群)(@\w+)?\s*([\s\S]*)$/);
    if (sayMatch) {
      const isPrivate = update.message.chat?.type === 'private';
      if (!isPrivate) {
        await sendReply(
          chatId,
          '代发请<strong>私聊</strong>本机器人发送 <code>/say 内容</code>。群内不会代发；若你已在群里打出内容，他人可能已看到，请以后只在私聊发。',
          undefined,
          replyToId,
        );
        return;
      }
      const content = (sayMatch[3] || '').trim();
      if (!content) {
        await sendReply(chatId, '请写上要代发的内容，例如：/say 大家好', undefined, replyToId);
        return;
      }
      try {
        await sendReply(ANNOUNCE_CHAT_ID, content, undefined, undefined);
        await sendReply(chatId, '已代发到群。', undefined, replyToId);
      } catch (e) {
        console.error('[mofang-notice] 代发失败', e.message);
        await sendReply(chatId, `代发失败：${e.message}`, undefined, replyToId);
      }
      return;
    }
  }

  const DEDICATED_TRIGGERS = [
    '还有独享吗', '独享机还有吗', '独享还有吗', '还有什么独享', '独享还有啥',
    '独享机库存', '看看独享库存', '我要买独享机', '买独享机', '独享还有库存吗',
    '库存还有独享没', '还有没有独享', '有没有独享机', '还有没有独享机',
    '我想买独享机', '我想买独享',
  ];
  function normalizeForTrigger(t) {
    return String(t)
      .replace(/\s/g, '')
      .replace(/[。，？！?！.．,，、；;：:""''（）()【】[]\s]/g, '')
      .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '');
  }
  const normalized = normalizeForTrigger(msgText);
  if (msgText && DEDICATED_TRIGGERS.some((phrase) => normalized.includes(phrase))) {
    const sec = getSimpleReplyCooldownSec(chatId);
    if (sec != null) {
      await sendReply(chatId, `操作太频繁，请 ${sec} 秒后再试。`, undefined, replyToId);
      return;
    }
    const dedicated = (data.tree && data.tree['独享机器']) || {};
    const hasStock = Object.values(dedicated).some((arr) => Array.isArray(arr) && arr.length > 0);
    await sendReply(chatId, hasStock ? '有。请发送 /stock 查看' : '没有。请发送 /stock 查看', undefined, replyToId);
    setSimpleReplyCooldown(chatId);
    return;
  }

  if (msgText && msgText.toLowerCase().includes('webssh')) {
    const sec = getSimpleReplyCooldownSec(chatId);
    if (sec != null) {
      await sendReply(chatId, `操作太频繁，请 ${sec} 秒后再试。`, undefined, replyToId);
      return;
    }
    try {
      let displayName = 'webssh.oci.ee';
      try {
        displayName = new URL(WEBSSH_URL).hostname;
      } catch (_) {}
      const linkHtml = `👉<b><a href="${escapeHtml(WEBSSH_URL)}">${escapeHtml(displayName)}</a></b>👈带文件管理的在线SSH工具`;
      console.log('[mofang-notice] 触发 webssh 回复, chatId=', chatId);
      await sendReply(chatId, linkHtml, undefined, replyToId);
      setSimpleReplyCooldown(chatId);
    } catch (e) {
      console.error('[mofang-notice] webssh 回复失败', e.message);
    }
    return;
  }

  if (msgText === '主页' || msgText === '官网') {
    const sec = getSimpleReplyCooldownSec(chatId);
    if (sec != null) {
      await sendReply(chatId, `操作太频繁，请 ${sec} 秒后再试。`, undefined, replyToId);
      return;
    }
    try {
      const displayName = (() => {
        try {
          return new URL(SITE_URL).hostname;
        } catch (_) {
          return '官网';
        }
      })();
      const linkHtml = `OCI官网是👉<b><a href="${escapeHtml(SITE_URL)}">${escapeHtml(displayName)}</a></b>👈`;
      await sendReply(chatId, linkHtml, undefined, replyToId);
      setSimpleReplyCooldown(chatId);
    } catch (e) {
      console.error('[mofang-notice] 主页/官网回复失败', e.message);
    }
    return;
  }

  if (isStockCommand(text)) {
    try {
      if (STOCK_CHAT_COOLDOWN_SECONDS > 0 && messageId == null) {
        const lastAt = chatLastStockAt.get(chatId);
        const now = Date.now();
        if (lastAt != null && now - lastAt < STOCK_CHAT_COOLDOWN_SECONDS * 1000) {
          const sec = Math.ceil((STOCK_CHAT_COOLDOWN_SECONDS * 1000 - (now - lastAt)) / 1000);
          await sendReply(chatId, `操作太频繁，请 ${sec} 秒后再试。`, undefined, replyToId);
          return;
        }
      }
      let data = getCachedTree();
      if (!data) {
        data = await fetchAndBuildTree();
        setCachedTree(data);
      }
      const sentMessageId = await sendStockLevel1(chatId, messageId, data, replyToId);
      if (sentMessageId != null) chatLastStockAt.set(chatId, Date.now());
      const askerUserId = update.message?.from?.id ?? update.channel_post?.from?.id;
      if (sentMessageId != null && askerUserId != null) setStockAsker(`${chatId}:${sentMessageId}`, askerUserId);
      if (sentMessageId != null && STOCK_MESSAGE_DELETE_AFTER_SECONDS > 0) {
        const cid = chatId;
        const mid = sentMessageId;
        setTimeout(() => deleteMessage(cid, mid).catch(() => {}), STOCK_MESSAGE_DELETE_AFTER_SECONDS * 1000);
      }
    } catch (e) {
      console.error('[mofang-notice] 回复失败', e.message);
      try {
        await sendReply(chatId, `拉取失败：${e.message}`, undefined, replyToId);
      } catch (_) {}
    }
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
        let treeData = getCachedTree();
        if (!treeData) {
          treeData = await fetchAndBuildTree();
          setCachedTree(treeData);
        }
        await processUpdate(u, treeData);
      }
    } catch (e) {
      console.error('[mofang-notice] longPoll', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

/** 设置 Bot 命令列表，用户输入 / 时会在输入框上方显示这些指令提示 */
async function setBotCommands() {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setMyCommands`;
  const commands = [
    { command: 'help', description: '查看本 bot 可用指令与触发词' },
    { command: 'stock', description: '查看有库存商品（也可发 库存 或 stock）' },
    { command: 'say', description: '私聊代发到群（仅管理员）' },
  ];
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands }),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) console.warn('[mofang-notice] setMyCommands', data.description || res.status);
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
  try {
    await setBotCommands();
  } catch (e) {
    console.warn('[mofang-notice] setMyCommands 失败', e.message);
  }
  console.log('[mofang-notice] Bot 已启动：/stock → 一级/二级/商品均从站点 /cart 解析，顺序与站点一致。CART=', CART_URL);
  await longPoll();
}

main().catch((e) => {
  console.error('[mofang-notice]', e);
  process.exit(1);
});
