# mofang-notice

从**魔方财务**购物车页面（如 [oci.ee/cart](https://oci.ee/cart)）拉取商品与库存，**仅展示有库存的商品**。  
**不推频道、不刷屏**：用户对 Bot 发 **/stock** 或 **/库存** 或 **/start** 时，Bot 才拉取并回复当前有库存列表（带 inline 按钮，点击跳转购买页）。

**仅提供 Docker 部署，建议在 Linux 服务器上运行。**

---

## 一键命令部署（推荐）

```bash
git clone https://github.com/mastalee928/mofang-stock.git mofang-notice && cd mofang-notice && cp .env.example .env
```

编辑 `.env`，填写 `SITE_URL`、`TELEGRAM_BOT_TOKEN` 后，在项目根目录执行：

```bash
docker compose up -d --build
```

---

## Docker Compose 部署

**克隆项目**

```bash
git clone https://github.com/mastalee928/mofang-stock.git mofang-notice
cd mofang-notice
```

**配置环境变量**

```bash
cp .env.example .env
# 编辑 .env，填写 SITE_URL、TELEGRAM_BOT_TOKEN（必填）
```

**启动**

```bash
docker compose up -d --build
```

**查看状态 / 日志**

```bash
docker compose ps
docker compose logs -f
```

**停止**

```bash
docker compose down
```

**更新**

```bash
cd mofang-notice
git pull && docker compose up -d --build
```

---

## 使用方式

- 私聊或群组里对 Bot 发送：**/stock**、**/库存** 或 **/start**
- Bot 会拉取购物车并回复一条「当前有库存商品」列表，每条带链接按钮，点击跳转购买页

不向频道定时推送，只有用户主动查时才回复，不会吵到别人。

---

## 环境变量说明

| 变量 | 说明 |
|------|------|
| `SITE_URL` | 魔方站点根地址，如 `https://oci.ee`（不要以 `/` 结尾） |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token（@BotFather 创建） |
| `NOTIFY_HEADER` / `NOTIFY_SUBTITLE` | Bot 回复的标题文案，可选 |
| `TEST_CHAT_ID` | 仅 `--once` 时使用，发到指定 chat_id 测试 |

---

## 仅发一次到指定聊天（测试）

```bash
TEST_CHAT_ID=你的chat_id docker compose run --rm mofang-notice node index.js --once
```

或本地：`TEST_CHAT_ID=xxx npm run run-once`。
