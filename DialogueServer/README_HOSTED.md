# 《AI餐厅》共享对白服务部署

测试员拿到配置好的 Windows 游戏包后，解压并打开 `AI Canteen.exe` 即可新建餐厅存档。共享对白通过 HTTPS 调用，DeepSeek 密钥由服务器上的内部对白进程持有。

## 从 GitHub 部署或升级

1. 使用 Node.js 24。在服务器克隆本仓库，已有仓库执行 `git pull`。将工作目录设为仓库根目录，`DialogueServer/` 与 `Assets/` 的相对位置需要一致。
2. 在密钥管理或服务进程环境中，为内部对白进程设置 `DEEPSEEK_API_KEY`，再启动该进程。默认端口为本机的 18765。

   ```sh
   CANTEEN_DIALOGUE_MAX_ACTIVE=8 node DialogueServer/dialogue.mjs
   ```

3. 启动或重启对白网关，默认端口为本机的 18767。通过 `CANTEEN_DIALOGUE_USAGE_DB` 指定可写的持久化用量数据库路径。更新时沿用同一个文件，同一部署的所有对白请求都应经过同一个额度数据库。

   ```sh
   CANTEEN_DIALOGUE_USAGE_DB=/var/lib/ai-canteen/dialogue-usage.sqlite \
   CANTEEN_DIALOGUE_TRUST_PROXY=1 node DialogueServer/gateway.mjs
   ```

4. 将 `/api/v1/dialogue` 和 `/api/v1/dialogue/health` 通过 HTTPS 反向代理转到 18767。仅在与网关同机的反向代理会覆盖 `X-Real-IP` 时，启用上面的 `CANTEEN_DIALOGUE_TRUST_PROXY=1`。例如以下 Nginx 设置适用于直接接收玩家连接的服务器。已有其他代理时，由部署方按实际网络配置可信的客户端地址。

   ```nginx
   location /api/v1/dialogue {
       proxy_pass http://127.0.0.1:18767;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_read_timeout 40s;
   }
   ```

5. 打开公开地址的 `/api/v1/dialogue/health`，确认 `status` 为 `ok`、`quota` 为 `per-ip-and-global`，且 `limits` 对应 20、500 和 4000 次。再从服务器本机访问 `http://127.0.0.1:18765/health`，确认内部对白进程返回模式、协议号及 `cooking: ingredient-timeline`。新出品规则需要同一版本的 `dialogue.mjs`、`kitchen.mjs` 和 `cooking.mjs`。
6. 游戏端在 `Assets/Resources/DialogueConfig.json` 中将 `url` 填为该公开 HTTPS 根地址，再重新打包。美众点评的地址单独填在 `Assets/Resources/LeaderboardConfig.json`。用新包新建存档，开张后确认客人开场及主动发送的对白都有回复。

本次新增食材需要同时更新 `Assets/Resources/CanteenDemo.json` 和 `DialogueServer/`。更新仓库后重启内部对白进程，新食材才能用于上菜后的对白和评价。旧版游戏对白仍按原协议访问。

## 对白接口

| 请求 | 用途 |
| --- | --- |
| `GET /api/v1/dialogue/health` | 检查网关版本及可用性 |
| `POST /api/v1/dialogue` | 直接请求顾客对白、做菜结果或评价 |

每个 IP 每分钟 20 次、每天 500 次。全服每天合计 4000 次。日额度按 UTC 午夜重置，对应北京时间每天早上 8 点。开场、聊天、料理生成、上菜反馈和评价在请求通过网关基础检查并被放行时各计一次。健康检查免费。

额度随代码版本生效。健康接口的 `limits` 显示 `perIpPerMinute`、`perIpPerDay` 和 `globalPerDay`。网关默认同时处理 8 个请求，每个 IP 同时处理 2 个。达到并发上限时返回 `busy`。可用 `CANTEEN_DIALOGUE_MAX_ACTIVE` 调整网关的全服并发数。

网关根据来源 IP 计数。同机反向代理覆盖 `X-Real-IP` 后才可启用 `CANTEEN_DIALOGUE_TRUST_PROXY=1`。若按 TCP 连接地址计数，经同一代理的玩家会共用该地址的额度。新版客户端会把每分钟、单 IP 每天和全服每天三类限额分别显示。

本机开发时，`DialogueConfig.json` 的 `url` 留空可使用本机对白服务或离线演示。开发或验收时可用环境变量 `CANTEEN_DIALOGUE_URL` 覆盖配置。
