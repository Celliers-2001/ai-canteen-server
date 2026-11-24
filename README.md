# 《AI餐厅》服务端

仓库包含美众点评联机榜单、共享对白网关、DeepSeek 内部对白服务和试玩邀请管理。克隆后可直接部署。后续更新在同一目录执行 `git pull`。

## 部署

使用 Node.js 24，分别运行下表三个进程，工作目录设为仓库根目录。将示例数据库路径换成服务账号可写的持久目录。给内部对白进程单独设置 `DEEPSEEK_API_KEY`，由服务器的密钥管理保存。

| 服务 | 本机端口 | 从仓库根目录启动 | 公开 HTTPS 路径 |
| --- | --- | --- | --- |
| 美众点评 | 18766 | `CANTEEN_RANKINGS_DB=/var/lib/ai-canteen/leaderboard.sqlite node LeaderboardServer/server.mjs` | `/health`、`/api/v1/rankings`、`/api/v1/restaurants/`、`/api/v1/owners/` |
| 共享对白网关 | 18767 | `CANTEEN_INVITE_DB=/var/lib/ai-canteen/dialogue-invites.sqlite node DialogueServer/gateway.mjs` | `/api/v1/dialogue`、`/api/v1/dialogue/health` |
| DeepSeek 内部对白 | 18765 | `CANTEEN_DIALOGUE_MAX_ACTIVE=8 node DialogueServer/dialogue.mjs` | 仅供本机网关调用 |

三个进程默认监听 `127.0.0.1`。对外通过同一个 HTTPS 域名按表分流，保留路径、查询参数和 `Authorization` 请求头。对白代理的读取超时至少设为 40 秒。

## 验收和后续配置

- 从公网访问 `GET /health` 和 `GET /api/v1/rankings`，确认榜单可读。新装服务会返回空榜单。
- 访问 `GET /api/v1/dialogue/health` 检查网关。用一份真实试玩邀请启动游戏并与客人对话，确认服务器能调用 DeepSeek。
- 把对外 HTTPS 根地址交给游戏负责人。Unity 里的 `Assets/Resources/LeaderboardConfig.json` 与 `Assets/Resources/DialogueConfig.json` 各有一个 `url`，填好后重新构建玩家版。
- 玩家将自己的 `CanteenInvite.txt` 放在游戏可执行文件同级。密钥、邀请和数据库留在运行环境内。`Assets/Resources/CanteenDemo.json` 是内部对白服务需要读取的默认游戏设定。

## 详细说明

- [共享对白部署、配额与邀请管理](DialogueServer/README_HOSTED.md)
- [美众点评部署与接口](LeaderboardServer/README.md)
