# mofang-notice

从**魔方财务**购物车页面（如 [oci.ee/cart](https://oci.ee/cart)）拉取商品与库存，**仅展示有库存的商品**。  
用户对 Bot 发库存相关指令时，Bot 先展示**一级分类**（产品类型），点选后展示**二级分类**（可用区域/类型），再点选后展示该分类下的有库存商品（inline 按钮跳转购买）。一级、二级名称与顺序均从站点 `/cart` 页面解析，与网站一致。

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

### 库存查询（三种触发）

为避免与其它 Bot（如 nmBot）的 **`/库存`** 冲突，库存菜单**仅**由以下三种触发：

| 触发 | 说明 |
|------|------|
| **`/stock`** | 命令；群组里可为 `/stock@你的bot用户名` |
| **`库存`** | 纯文本，整条消息就是「库存」二字 |
| **`stock`** | 纯文本，整条消息（大小写不敏感） |

**不再**用 `/库存`、`/start` 打开库存菜单。

Bot 依次展示：**一级（产品类型）** → **二级（可用区域/类型）** → **有库存商品列表**（每条带链接按钮，点击跳转购买页）。

### 其它自动回复（关键词）

- **主页 / 官网**：回复站点链接  
- **消息含 `webssh`**：回复 WebSSH 链接（`WEBSSH_URL`）  
- **独享相关问句**：根据解析结果回复「有/没有」，并提示用库存指令查看  

### 群组行为说明

- Bot 回复会**引用**用户原消息（频道/群均适用）。  
- **库存内联键盘**：默认仅**发指令的那个人**可点「选择 / 返回」；他人点击会提示「仅限发起人操作」。  
- **防刷**：同一聊天室在设定时间内对「库存菜单」「官网/webssh/独享」有冷却，详见环境变量。  
- **库存那条键盘消息**：默认在发出后约 **15 分钟**自动删除（仅删 Bot 那条，减轻公屏占用）；私聊是否删除由同一配置决定，可用环境变量关闭或改时间。  

### 管理员代发（私聊）

配置 `TELEGRAM_ADMIN_IDS` 与 `TELEGRAM_ANNOUNCE_CHAT_ID` 后，**仅管理员**可在**私聊**中对 Bot 发送：

- `/say 要在群里显示的文字`  
- 或 `/发群 要在群里显示的文字`  

Bot 会以自己身份发到目标群/频道；**群内发 `/say` 不会代发**，只会提示改私聊，避免他人看到指令与内容。

---

## 环境变量说明

| 变量 | 说明 |
|------|------|
| `SITE_URL` | 魔方站点根地址，如 `https://oci.ee`（不要以 `/` 结尾） |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token（@BotFather 创建） |
| `WEBSSH_URL` | 回复 webssh 关键词时的链接，默认 `https://webssh.oci.ee` |
| `NOTIFY_HEADER` / `NOTIFY_SUBTITLE` | Bot 库存回复的标题文案，可选 |
| `CACHE_TTL_SECONDS` | 站点解析结果缓存秒数，默认 `60`，最少 `30` |
| `STOCK_ASKER_TTL_SECONDS` | 「仅发起人可点键盘」记录过期时间（秒），默认 `3600` |
| `STOCK_ASKER_MAX_SIZE` | 上述记录最大条数，默认 `2000` |
| `STOCK_MESSAGE_DELETE_AFTER_SECONDS` | 库存键盘消息发出后多少秒自动删除，`0` 表示不删，默认 `900`（15 分钟） |
| `STOCK_CHAT_COOLDOWN_SECONDS` | 同一聊天室发库存菜单的冷却（秒），`0` 不限制，默认 `15` |
| `SIMPLE_REPLY_COOLDOWN_SECONDS` | 官网 / webssh / 独享 三类回复的聊天室冷却（秒），`0` 不限制，默认 `10` |
| `TELEGRAM_ADMIN_IDS` | 代发功能：管理员 Telegram 数字 ID，多个用英文逗号分隔 |
| `TELEGRAM_ANNOUNCE_CHAT_ID` | 代发目标群或频道的 chat id（如 `-100...`）；留空则关闭代发 |
| `TEST_CHAT_ID` | 仅 `--once` 时使用，发到指定 chat_id 测试 |

---

## 仅发一次到指定聊天（测试）

```bash
TEST_CHAT_ID=你的chat_id docker compose run --rm mofang-notice node index.js --once
```

或本地：`TEST_CHAT_ID=xxx npm run run-once`。
