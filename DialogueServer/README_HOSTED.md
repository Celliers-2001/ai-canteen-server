# 《AI餐厅》共享对白服务部署

玩家的游戏通过 HTTPS 调用这个服务，由服务器上的 DeepSeek 密钥统一付费。游戏包只存服务器网址。每位测试玩家收到独立的 `CanteenInvite.txt`，游戏启动时自动读取。

## 服务端部署

1. 在服务器上安装 Node.js 24。克隆本仓库，保留 `DialogueServer/` 与 `Assets/` 的相对位置。
2. 在服务器的密钥管理或服务进程环境中设置 `DEEPSEEK_API_KEY`。该变量只给下一步的内部对白进程。部署时使用新建的 DeepSeek 密钥。
3. 从仓库根目录启动内部对白进程。默认监听本机端口 `18765`。这个端口只供同台服务器上的网关访问。

   ```sh
   CANTEEN_DIALOGUE_MAX_ACTIVE=8 node DialogueServer/dialogue.mjs
   ```

4. 用另一个受服务管理器管理的进程启动网关，默认监听本机端口 `18767`。邀请数据库放到持久目录，网关、生成邀请和撤销邀请三者使用同一路径。

   ```sh
   CANTEEN_INVITE_DB=/var/lib/ai-canteen/dialogue-invites.sqlite node DialogueServer/gateway.mjs
   ```

5. 通过服务器现有的 HTTPS 网关转发下面两个路径，保留 `Authorization` 头。只对公开玩家域名开放 HTTPS。可以和榜单使用同一域名，按路径分别将对白转到 18767、榜单转到 18766。反向代理的读取超时设为至少 40 秒。
6. 检查公开网址的 `GET /api/v1/dialogue/health`。回复应为 `{"status":"ok"}`。另从服务器本机检查 `http://127.0.0.1:18765/health` 能返回模式和协议号。

| 请求 | 用途 |
| --- | --- |
| `GET /api/v1/dialogue/health` | 检查公开网关是否在线 |
| `POST /api/v1/dialogue` | 游戏请求顾客对白、做菜结果或评价，使用个人邀请授权 |

网关无需提供 DeepSeek 密钥。邀请数据库只保存邀请的哈希。游戏端读取每位玩家的邀请文件，并通过 HTTPS 请求头提交。原始邀请文件可以被复制，因此按人独立发放。泄漏时可单独撤销，其他玩家不受影响。

## 为玩家打包

1. 在 Unity 项目的 `Assets/Resources/DialogueConfig.json` 中把 `url` 填为公开 HTTPS 根址。比如 `{"url":"https://play.example.com"}`。游戏会自动拼接接口路径。再打包一次游戏，供所有测试员共用。
2. 在服务器上为每位测试玩家分别生成邀请。输出目录先建好。命令会生成单独的文件和一个用于管理的邀请编号。

   ```sh
   export CANTEEN_INVITE_DB=/var/lib/ai-canteen/dialogue-invites.sqlite
   mkdir -p invitations/alice
   node DialogueServer/invites.mjs create "测试员甲" invitations/alice/CanteenInvite.txt
   ```

3. 把该玩家的 `CanteenInvite.txt` 私下发给该玩家，放到 `AI Canteen.exe` 同级。自己在 Unity 编辑器验收时，把自己的测试邀请放到 Unity 项目根目录，再退出 Play 并重新进入。邀请文件随游戏启动自动读取。
4. 删除公开下载包里的邀请文件。共用同一个游戏安装包，每位玩家分别拿自己的邀请。

管理命令

```sh
node DialogueServer/invites.mjs list
node DialogueServer/invites.mjs revoke <邀请编号>
```

默认网关限制单份邀请每分钟 16 次、每天 180 次，全服每天 800 次，按 UTC 日期重置。用 `CANTEEN_DIALOGUE_PER_MINUTE`、`CANTEEN_DIALOGUE_PER_DAY` 和 `CANTEEN_DIALOGUE_GLOBAL_PER_DAY` 调整。以上是请求次数限制。两项服务的并发上限可设为相同的 `CANTEEN_DIALOGUE_MAX_ACTIVE`，从 8 开始即可。

`DialogueConfig.json` 的 `url` 留空时，仍可用本机对白或离线演示。部署中可临时用环境变量 `CANTEEN_DIALOGUE_URL` 覆盖客户端网址。排行榜网址仍单独放在 `LeaderboardConfig.json`。
