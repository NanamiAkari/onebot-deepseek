# OneBot v11 反向WS服务（OpenAI/Responses + Agent Loop）

## 用途
- 接收 Napcat 的消息事件（反向 WebSocket）
- 支持群聊与私聊消息回复
- 使用 OpenAI 兼容上游生成回复，支持 `responses` / `chat.completions`
- 内部已升级为多轮 `agent loop + tool registry + tool executor` 架构
- 通过 OneBot v11 动作帧把回复发回 QQ

## 准备
- 安装 Node.js 18+
- 如果部署在 Linux 服务器，建议在服务器本机执行 `npm install`
- 不要把 Windows 上的 `node_modules` 直接复制到 Linux；`sharp` 这类原生模块需要按目标平台重新安装
- 在此目录执行:
  - `npm install`
  - 复制 `.env.example` 为 `.env`
  - 填写上游配置：
    - `OPENAI_API_KEY=sk-...`
    - `OPENAI_BASE_URL=http://127.0.0.1:30080`
    - `LLM_PROVIDER=openai`
    - `OPENAI_MODEL=gpt-5.4`
    - `OPENAI_WIRE_API=responses`
  - 如果需要外置提示词文件：
    - `PROMPT_FILE=prompt.txt`

## 启动
- `npm start`
- 服务默认监听 `ws://<服务器IP>:5000/onebot/v11/ws`
- 端口与路径可在 `.env` 配置：
  - `PORT=5000`
  - `ONEBOT_PATH=/onebot/v11/ws`

## Napcat 配置示例
- 在 `onebot11_XXXX.json` 的 `network.websocketClients` 中新增:
```json
{
  "name": "websocket-client-deepseek",
  "enable": true,
  "url": "ws://<服务器IP>:5000/onebot/v11/ws",
  "messagePostFormat": "array",
  "reportSelfMessage": false,
  "reconnectInterval": 5000,
  "token": "",
  "debug": false,
  "heartInterval": 30000
}
```

## 工作方式
- 入口层仍使用 OneBot v11 反向 WebSocket，不改变 Napcat 接法
- 私聊默认可直接回复；群聊可按 `@机器人` / 前缀规则触发
- 消息进入 `message-handler -> agent runner -> provider -> tool executor` 主链路
- 当前已支持多轮 agent loop、工具注册表、dispatch map、统一 tool result 格式
- 若上游或工具链失败，服务会返回失败提示而不是自动回退到其他模型
- 使用 `send_group_msg` 或 `send_private_msg` 动作帧回复

## 上游协议
- 支持两类 OpenAI 兼容协议：
  - `OPENAI_WIRE_API=responses`：调用 `POST <OPENAI_BASE_URL>/responses`
  - 留空：调用 `POST <OPENAI_BASE_URL>/chat/completions`
- 当前实现会根据 `OPENAI_WIRE_API` 和网关地址自动选择协议。

## Agent Loop
- 当前服务已升级为有限步数的多轮 agent loop
- 默认最大步数为 `5`
- 每轮流程：
  - 调用模型
  - 若模型返回工具调用，则执行首个工具
  - 将工具结果写回历史
  - 继续下一轮，直到得到最终文本或达到步数上限
- 当前已接入的工具包括：
  - `get_msg`
  - `get_image`
  - `send_group_msg`
  - `send_private_msg`
  - `history`
  - `read_file`
  - `write_file`
  - `edit_file`
  - `list_dir`
- 文件类工具带工作区路径沙箱，不能逃逸项目目录

## 服务器部署（systemd）
- 推荐将项目放到 `/opt/onebot-deepseek`，并确保 `.env` 已配置好。
- 首次部署或更新依赖时，请在服务器项目目录重新安装依赖：
```
cd /opt/onebot-deepseek
npm install
```
- 如果 Linux 上 `sharp` 加载失败，可尝试：
```
npm install --include=optional sharp
# 或
npm install --os=linux --cpu=x64 sharp
```
- 创建服务：
```
sudo tee /etc/systemd/system/onebot-deepseek.service >/dev/null <<'EOF'
[Unit]
Description=OneBot v11 OpenAI WS Service
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/onebot-deepseek
EnvironmentFile=/opt/onebot-deepseek/.env
# 如需代理，请取消注释并设置为你的代理：
# Environment=HTTP_PROXY=http://127.0.0.1:7890
# Environment=HTTPS_PROXY=http://127.0.0.1:7890
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
User=www-data
Group=www-data

[Install]
WantedBy=multi-user.target
EOF

sudo chown -R www-data:www-data /opt/onebot-deepseek
sudo systemctl daemon-reload
sudo systemctl enable --now onebot-deepseek
sudo systemctl status onebot-deepseek
sudo systemctl start onebot-deepseek
sudo systemctl stop onebot-deepseek
sudo systemctl restart onebot-deepseek
```
- 查看日志：
```
sudo journalctl -u onebot-deepseek -f
```

## 代理（可选，Mihomo/Clash）
- 使用现有的 Clash 配置（例：`1769326224567.yml`）在服务器运行 Mihomo：
```
/opt/mihomo/mihomo -d /opt/mihomo -f /opt/mihomo/config.yaml
```
- 典型端口：
  - HTTP 代理：`127.0.0.1:7890`
  - SOCKS5 代理：`127.0.0.1:7891`
- 为服务注入代理（不改代码）：
```
sudo systemctl edit onebot-deepseek
# 添加：
[Service]
Environment=HTTP_PROXY=http://127.0.0.1:7890
Environment=HTTPS_PROXY=http://127.0.0.1:7890
Environment=NO_PROXY=127.0.0.1,localhost
sudo systemctl daemon-reload
sudo systemctl restart onebot-deepseek
```

## 日志说明
- 启动成功时：
  - `服务已启动`
- OpenAI 调用：
  - `调用OpenAI`
  - `OpenAI媒体数量: 1`
  - `OpenAI成功`
  - `OpenAI失败 media=1 timeout=...`
- Agent loop：
  - `Agent step 1/5: 调用模型`
  - `Agent step 1/5: 调用工具 get_msg args=...`
  - `Agent step 1/5: 工具 get_msg 成功`
- 媒体链路：
  - `媒体下载失败`
- 图片超时：
  - `图片分析超时，请稍后重试或发送更小的图片`

## 验证
- Napcat url（同机）：`ws://127.0.0.1:5000/onebot/v11/ws`
- 推荐先做一轮最小冒烟测试：
  - 私聊发送普通文本，确认能回复
  - 群聊按前缀或 @ 规则触发一次，确认能回复
  - 回复一条旧消息再提问，确认引用消息场景正常
  - 发送一张简单图片并提问，确认图片链路正常
  - 对同一张图片重复提问一次，确认缓存与稳定性

## 常见问题
- 端口被占用（EADDRINUSE）：
  - 确保只保留一个实例运行；或修改 `.env` 的 `PORT` 并同步 Napcat url。
- DNS 53 端口占用（Mihomo）：
  - 将 Clash 配置中的 `dns.listen` 改为 `127.0.0.1:1053` 或关闭 `dns.enable`。
- 权限问题（CHDIR）：
  - `WorkingDirectory` 指向不可访问路径会失败；推荐 `/opt/onebot-deepseek` 并赋权给运行用户。
- `sharp` 无法加载：
  - 不要复用其他平台的 `node_modules`
  - 在目标 Linux 机器上重新执行 `npm install`
  - 如仍失败，执行 `npm install --include=optional sharp`
- 图片一直超时：
  - 先提高 `OPENAI_TIMEOUT_MS`
  - 确认图片预处理已开启
  - 优先测试简单图片，再测信息密集型截图

## 触发控制
- 默认群聊按前缀触发；私聊默认可直接回复。
- 配置项：
  - `AI_REQUIRE_PREFIX=true|false`：是否必须前缀
  - `AI_GROUP_REQUIRE_MENTION=true|false`：群聊是否必须 `@机器人`
  - `AI_PREFIXES=阿卡林`：多个前缀用逗号分隔，如 `阿卡林,ai`
  - `AI_ADMIN_USER_IDS=123456,234567`：额外管理员 QQ 号白名单，多个用英文逗号分隔
  - `AI_IGNORE_REGEX=`：忽略其他 WS 服务命令的正则；群聊和私聊都会生效
- 示例：群聊不要求 `@`，只要以前缀 `阿卡林` 开头就触发：
```
AI_REQUIRE_PREFIX=true
AI_GROUP_REQUIRE_MENTION=false
AI_PREFIXES=阿卡林
AI_IGNORE_REGEX=^(pjsk|b30)\b
```
- 默认已内置一组较保守的 Sakura bot 常见命令前缀屏蔽，例如：
  - `pjsk`
  - `b30`
  - `msa`
  - `msp`
  - `mysekai`
  - `tsearch`
  - `song`
  - `taikoupdate`
  - `taikorec`
  - `taikob`
  - `taikotrend`
  - `wlsk`
  - `sekai`
  - `qooapp`
  - `cnmusicupdate`
  - `cnmusicdiffupdate`
  - `sk预测`
  - `查房`
  - `分数线`
  - `段位进度`
  - `live订阅`
- 如果你还有其他同机 WS 服务命令，可以继续追加到 `AI_IGNORE_REGEX`

## 多媒体与图片缓存
- 支持图片输入；会在调用上游前把图片下载并转为 base64 / `image_url`
- 引用消息取图：
  - 若引用段包含有效 message_id，会通过 OneBot `get_msg` 拉回原消息中的图片
- 会话级图片缓存：
  - 收到“仅图片消息”时只缓存，不调用上游
  - 在 `AI_IMAGE_CONTEXT_TTL` 时间窗内，后续提问可自动带上上一张图片
  - `AI_IMAGE_CONTEXT_MAX` 控制最多关联的图片数量
- 关键配置：
  - `AI_MAX_MEDIA_BYTES`
  - `AI_MEDIA_REFERER`
  - `AI_IMAGE_CONTEXT_TTL`
  - `AI_IMAGE_CONTEXT_REQUIRE_HINTS`
  - `AI_IMAGE_HINT_REGEX`
  - `AI_IMAGE_CONTEXT_REQUIRE_SAME_USER`
  - `AI_IMAGE_CONTEXT_MODE=ai`
  - `AI_IMAGE_CONTEXT_MAX`
  - `AI_IMAGE_ONLY_NO_CALL=true`
- 图片预处理：
  - 默认启用 `sharp` 预处理
  - 会在发送给上游前按图片类型缩放 / 压缩
  - 普通图片、截图、长图采用不同策略
  - 预处理结果会按图片内容 hash 做进程内缓存
- 关键配置：
  - `AI_IMAGE_PREPROCESS_ENABLE=true`
  - `AI_IMAGE_CACHE_ENABLE=true`
  - `AI_IMAGE_CACHE_TTL=1800`
  - `AI_IMAGE_PREPROCESS_MAX_EDGE=1568`
  - `AI_IMAGE_PREPROCESS_SCREEN_MAX_EDGE=1400`
  - `AI_IMAGE_PREPROCESS_LONG_MAX_EDGE=1080`
  - `AI_IMAGE_PREPROCESS_JPEG_QUALITY=82`
  - `AI_IMAGE_PREPROCESS_WEBP_QUALITY=86`

## 拍一拍与戳一戳
- 监听 OneBot `notice.notify.poke`
- 仅当拍一拍目标是机器人自身时才响应（`AI_POKE_ONLY_SELF=true`）
- 平台支持时尝试 `send_group_poke` 反拍；不支持则发送文本回复
- 支持配置独立文案文件，按行维护多条备选文案并随机回复其中一条
- 默认优先读取 `AI_POKE_REPLY_FILE` 指向的文本文件；如果文件不存在或为空，再回退到 `AI_POKE_REPLY_TEXTS` / `AI_POKE_REPLY_TEXT`
- 支持通过管理员命令动态查看和新增文案，写回文件后立即生效
- 配置项：
  - `AI_POKE_ENABLE`
  - `AI_POKE_COOLDOWN`
  - `AI_POKE_REPLY_FILE`
  - `AI_POKE_REPLY_TEXT`
  - `AI_POKE_REPLY_TEXTS`
  - `AI_POKE_ONLY_SELF`
- 管理命令：
  - `阿卡林 拍一拍 文案列表`
  - `阿卡林 拍一拍 文案添加 你好呀`
  - `阿卡林 拍一拍 开启`
  - `阿卡林 拍一拍 关闭`
- 权限规则：
  - `文案列表` 任何人可查看
  - `文案添加`、开关管理仅群主、群管理员或 `AI_ADMIN_USER_IDS` 中配置的账号可执行

## 管理员权限
- 除了 QQ 群内原生 `owner` / `admin`，还支持通过 `.env` 配置额外管理员账号：
```env
AI_ADMIN_USER_IDS=123456789,987654321
```
- 配置后的账号在私聊和群聊里都可使用管理命令
- 当前已接入的管理员能力：
  - 拍一拍文案新增
  - 拍一拍开关管理
  - 上下文配置修改
  - 违禁词治理管理

## 违禁词治理
- 违禁词按群持久化保存在 `banned.json`
- 列表命令任何人可查看；添加/删除/清空/治理开关/禁言时长仅群主、群管理员或 `AI_ADMIN_USER_IDS` 中配置的账号可执行
- 命中违禁词时，若机器人在群内有管理员权限，将执行禁言
- 常用命令：
  - `阿卡林 违禁词列表`
  - `阿卡林 违禁词添加 词语`
  - `阿卡林 违禁词删除 词语`
  - `阿卡林 违禁词清空`
  - `阿卡林 违禁词治理开启`
  - `阿卡林 违禁词治理关闭`
  - `阿卡林 禁言时长 10分钟`

## 提示词文件
- 默认优先读取 `PROMPT_FILE` 指向的纯文本文件
- 若读取失败，则回退到 `.env` 中的 `SYSTEM_PROMPT`
- 示例：
  - `PROMPT_FILE=prompt.txt`
  - 可使用项目中的 `prompt.py` 生成 `prompt.txt`

## 推荐测试 Checklist
- 部署前
  - 确认已同步 `server.js`、`src/`、`package.json`、`.env`
  - 在目标服务器执行 `npm install`
  - 确认 `node_modules/sharp` 能在目标平台加载
- 启动后
  - `sudo systemctl status onebot-deepseek`
  - `sudo journalctl -u onebot-deepseek -f`
  - 确认 Napcat 已连接到 `ws://127.0.0.1:5000/onebot/v11/ws`
- 功能测试
  - 私聊普通文本回复
  - 群聊触发回复
  - 引用消息回复
  - 简单图片回复
  - 信息密集型截图回复
  - 同图重复提问，观察是否更快
  - 连续追问上下文相关问题
- 日志核对
  - 是否出现 `Agent step`
  - 是否出现 `OpenAI成功`
  - 图片失败时是否出现 `OpenAI失败` 或 `媒体下载失败`
