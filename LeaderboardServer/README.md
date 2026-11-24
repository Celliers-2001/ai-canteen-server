# 美众点评联机榜单

这个服务把不同玩家的餐厅汇总到一张榜单。玩家打开新版游戏后，各自电脑上的存档会自动同步。每个存档是一家餐厅，重名餐厅可以同时存在。在游戏里删档后，该餐厅会在下一次成功同步时撤榜。每台电脑的游戏会自动创建自己的发布凭据，无需在客户端填写服务器密钥。

## 部署

1. 在服务器上安装 Node.js 24，克隆本仓库，并将工作目录设为仓库根目录。
2. 使用下面的命令启动。把 `/var/lib/ai-canteen` 换成应用可写的持久化目录。数据库和 WAL 文件应留在该目录。

   ```sh
   CANTEEN_RANKINGS_DB=/var/lib/ai-canteen/leaderboard.sqlite node LeaderboardServer/server.mjs
   ```

3. 默认监听 `127.0.0.1:18766`。可用 `CANTEEN_RANKINGS_HOST` 和 `CANTEEN_RANKINGS_PORT` 修改监听位置。让服务器的 HTTPS 网关将专用域名的请求转发到这个监听地址，保持 `/health` 和 `/api/v1/` 路径，并转发 `Authorization` 请求头。把 Node 进程配置为登录退出后继续运行及故障后自动重启。
4. 检查公开地址的 `GET /health`。响应应为 `{"status":"ok","protocol":1}`。再访问 `GET /api/v1/rankings`，首次部署会得到空的餐厅列表。
5. 在 Unity 项目里打开 `Assets/Resources/LeaderboardConfig.json`，把 `url` 改为公开 HTTPS 根地址。比如 `{"url":"https://rankings.example.com"}`。重新打包给测试玩家。开发测试可通过环境变量 `CANTEEN_LEADERBOARD_URL` 覆盖该配置。

```sh
curl https://rankings.example.com/health
curl 'https://rankings.example.com/api/v1/rankings?sort=overall&filter=all&page=1'
```

未配置网址或服务器暂时不可达时，游戏会显示本机榜单，并标明当前状态。网络恢复后，正在运行的游戏会重试同步。AI 对话继续使用现有的对话服务。全服榜单公开店名、头像、开业天数、评价数量、平均分和净利润。点榜单中的店名可看公开评价正文与分项评分。客人的聊天记录、库存、余额和存档文件留在玩家侧。玩家可在「手机 → 美众点评 → 本店点评 → 更换头像」选择 8 MB 内的 JPG 或 PNG。这套服务适合邀请制试玩，统计来自客户端存档。

## HTTP 接口 v1

| 请求 | 用途 |
| --- | --- |
| `GET /health` | 检查服务是否可访问 |
| `GET /api/v1/rankings?sort=overall&filter=all&page=1` | 查询榜单，每页 50 家 |
| `GET /api/v1/restaurants/{ownerId}/{slotId}?page=1` | 查看一家餐厅及评价，评价每页 20 条 |
| `PUT /api/v1/owners/{ownerId}/restaurants` | 同步一台电脑的存档统计和已删除存档 |
| `PUT /api/v1/owners/{ownerId}/restaurants/{slotId}/profile` | 同步已登记餐厅的头像和评价 |

### 读取榜单

`sort` 可取 `overall`、`service`、`food`、`dailyProfit` 或 `totalProfit`，均从高到低。无数据的店铺仍会显示，`rank` 为 0。并列店铺用同一名次。

`filter` 可取 `all`、`first`（1–3 天）、`week`（3–7 天）或 `month`（7–30 天）。区间包括起止日。名次按当前筛选结果计算。日均净利润为 `totalProfit / profitDays`，金额字段以百分之一金币为单位。

响应包含 `stores`、`total`、`page`、`pages`。每条餐厅记录的字段见下文，另外包含 `rank` 和 `avatar`，公开的 `id` 格式为 `ownerId:存档ID`。

### 同步存档

Unity 会自动调用这一接口。请求使用 `Content-Type: application/json`，并带上 `Authorization: Bearer <64 位小写十六进制随机值>`。`ownerId` 是 32 位小写十六进制。首次同步时，服务端登记该电脑的凭据，之后只接受相同凭据更新这些餐厅。此凭据由游戏自动创建和保存在测试玩家电脑上。

请求体示例

```json
{
  "stores": [
    {
      "id": "11111111111111111111111111111111",
      "restaurantName": "山灯餐厅",
      "reviews": 3,
      "daysOpen": 4,
      "profitDays": 3,
      "totalProfit": 12050,
      "overall": 4.5,
      "service": 5,
      "food": 4
    }
  ],
  "deleted": []
}
```

存档 `id` 可为 32 位小写十六进制或旧档使用的 `legacy`。所有评分取 0–5，`profitDays` 为已统计的结算天数。删除时把存档 ID 放进 `deleted` 数组，可以与其他餐厅更新一起提交。成功响应为 `{"ok":true}`，重复同步和重复删除可以安全重试。没有出现在本次请求中的餐厅仍会保留，直到游戏同步对应的删除记录。

### 餐厅主页和评价

主页的读取接口返回 `store`、`reviews`、`participants`、`total`、`page`、`pages`。评价按发表时间从新到旧，已撤榜餐厅返回 404。

头像与评价的同步接口使用同一份 `Authorization`。需要先同步该餐厅的存档统计。请求体为 `{"avatar":"", "reviews":[]}`，每次最多提交 20 条评价。评价由游戏生成稳定 ID，重复提交不会新增副本。删档会撤下餐厅并移除头像和评价。

`avatar` 为空字符串时用默认图标。自选头像为固定的 80×80 RGB24 像素数据，经 Base64 编码后提交。游戏自动完成从 JPG 或 PNG 的转换。

每条评价包含 `id`、`guestId`、`guest`、`date`、`evaluation`、`overall`、`service`、`food`、`offline`。评价的分数字段按半星计数，整数 0–10 对应 0–5 星。`id` 为评价内容的 SHA-256 小写十六进制摘要，后接冒号和同内容评价的从零起算编号。
