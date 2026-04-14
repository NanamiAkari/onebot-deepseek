# OneBot v11 反向WS服务（OpenAI/Responses）

## 用途
- 接收 Napcat 的消息事件（反向 WebSocket）
- 当群内 @机器人 时调用单一 OpenAI 兼容上游生成回复
- 通过 OneBot v11 动作帧把回复发回 QQ

## 准备
- 安装 Node.js 18+
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
- 群消息事件到达后检测是否包含 @机器人
- 提取文本与媒体，按配置调用单一 OpenAI 兼容上游
- 不再自动回退到 Gemini/DeepSeek；若上游失败，直接回复失败提示
- 使用 `send_group_msg` 或 `send_private_msg` 动作帧回复

## 上游协议
- 支持两类 OpenAI 兼容协议：
  - `OPENAI_WIRE_API=responses`：调用 `POST <OPENAI_BASE_URL>/responses`
  - 留空：调用 `POST <OPENAI_BASE_URL>/chat/completions`
- 当前实现会根据 `OPENAI_WIRE_API` 和网关地址自动选择协议。

## 服务器部署（systemd）
- 推荐将项目放到 `/opt/onebot-deepseek`，并确保 `.env` 已配置好。
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
sudo systemctl start onebot-deepseeks
sudo systemctl stop onebot-deepseeks
sudo systemctl restart onebot-deepseeks
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

## 验证
- Napcat url（同机）：`ws://127.0.0.1:5000/onebot/v11/ws`
- 群内 @机器人，观察日志：
  - `调用OpenAI`
  - `OpenAI媒体数量: 1`
  - `OpenAI成功` 或 `OpenAI失败`

## 常见问题
- 端口被占用（EADDRINUSE）：
  - 确保只保留一个实例运行；或修改 `.env` 的 `PORT` 并同步 Napcat url。
- DNS 53 端口占用（Mihomo）：
  - 将 Clash 配置中的 `dns.listen` 改为 `127.0.0.1:1053` 或关闭 `dns.enable`。
- 权限问题（CHDIR）：
  - `WorkingDirectory` 指向不可访问路径会失败；推荐 `/opt/onebot-deepseek` 并赋权给运行用户。

## 触发控制
- 默认仅在群内 **@机器人** 且消息以 `/ai` 前缀时触发（可在 `.env` 配置）。
- 配置项：
  - `AI_REQUIRE_PREFIX=true|false`：是否必须前缀
  - `AI_PREFIXES=ai`：多个前缀用逗号分隔，如 `ai,chat`
  - `AI_IGNORE_REGEX=`：忽略的命令正则，如 `^(pjsk|b30)\\b`
- 示例：仅对 `ai` 生效，并忽略 `pjsk b30`：
```
AI_REQUIRE_PREFIX=true
AI_PREFIXES=ai
AI_IGNORE_REGEX=^(pjsk|b30)\b
```

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

## 拍一拍与戳一戳
- 监听 OneBot `notice.notify.poke`
- 仅当拍一拍目标是机器人自身时才响应（`AI_POKE_ONLY_SELF=true`）
- 平台支持时尝试 `send_group_poke` 反拍；不支持则发送文本回复
- 配置项：
  - `AI_POKE_ENABLE`
  - `AI_POKE_COOLDOWN`
  - `AI_POKE_REPLY_TEXT`
  - `AI_POKE_ONLY_SELF`

## 违禁词治理
- 违禁词按群持久化保存在 `banned.json`
- 列表命令任何人可查看；添加/删除/清空/治理开关/禁言时长仅群主或管理员可执行
- 命中违禁词时，若机器人在群内有管理员权限，将执行禁言
- 常用命令：
  - `@机器人 ai 违禁词列表`
  - `@机器人 ai 违禁词添加 词语`
  - `@机器人 ai 违禁词删除 词语`
  - `@机器人 ai 违禁词清空`
  - `@机器人 ai 违禁词治理开启`
  - `@机器人 ai 违禁词治理关闭`
  - `@机器人 ai 禁言时长 10分钟`

## 提示词文件
- 默认优先读取 `PROMPT_FILE` 指向的纯文本文件
- 若读取失败，则回退到 `.env` 中的 `SYSTEM_PROMPT`
- 示例：
  - `PROMPT_FILE=prompt.txt`
  - 可使用项目中的 `prompt.py` 生成 `prompt.txt`
