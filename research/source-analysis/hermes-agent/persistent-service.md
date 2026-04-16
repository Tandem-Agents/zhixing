# Hermes Agent — 常驻服务 / 消息网关架构分析

> **分析状态**: ✅ 完整分析（2026-04-16）
> **核心问题**: Hermes 如何实现 7×24 常驻运行、17 平台消息网关、定时调度？
> **源码路径**: `E:\Dev\longxia\_refs\hermes-agent-main\gateway\`

## 一、核心结论

Hermes 拥有三个参考项目中**平台覆盖最广**的消息网关——17 个平台适配器，远超 OpenClaw（~16 个，但以插件形式分散在 extensions/）。但其架构选择了与 OpenClaw 完全不同的路线：**纯 asyncio 单进程 + 同步 Agent 线程池**，没有 WebSocket RPC 协议，没有独立的 Command Queue，也没有 Lane 隔离。

```
┌─────────────────────────────────────────────────────────────────────┐
│                   GatewayRunner（asyncio 单进程）                     │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  17 个平台适配器（BasePlatformAdapter 子类）                    │  │
│  │  ┌──────┬──────┬──────┬──────┬──────┬──────┬──────┬─────┐    │  │
│  │  │Tele- │Disc- │Slack │Whats-│Signal│Matrix│Ding- │ ... │    │  │
│  │  │gram  │ord   │      │App   │      │      │Talk  │     │    │  │
│  │  └──┬───┴──┬───┴──┬───┴──┬───┴──┬───┴──┬───┴──┬───┴─────┘    │  │
│  │     │      │      │      │      │      │      │               │  │
│  │     └──────┴──────┴──────┴──────┴──────┴──────┘               │  │
│  └────────────────────────────┬───────────────────────────────────┘  │
│                               │ handle_message()                     │
│                               ▼                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  GatewayRunner._handle_message()                               │  │
│  │  会话解析 → Agent 缓存 → asyncio.to_thread(run_conversation)  │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐   │
│  │ Cron Ticker   │  │ Session      │  │ 后台 Watcher             │   │
│  │ (daemon 线程) │  │ Expiry       │  │ (重连/缓存清理)          │   │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘   │
│                                                                      │
└────────────────────────────┬─────────────────────────────────────────┘
                             │ OS 级保活
                    ┌────────▼────────┐
                    │ systemd / launchd │
                    │ + Docker 容器     │
                    └─────────────────┘
```

## 二、Gateway 入口与启动流程

### 2.1 入口文件

**文件**: `gateway/run.py`（7905 行——整个网关的核心逻辑集中在**单文件**中）

三种启动方式：
- 直接运行：`python -m gateway.run` → `main()` → `asyncio.run(start_gateway())`
- CLI 子命令：`hermes gateway run`（通过 `hermes_cli/gateway.py` 调度）
- OS 服务：`hermes gateway install` 安装为 systemd/launchd 服务

### 2.2 框架选择

**不使用 Web 框架。** Gateway 核心是一个纯 asyncio 事件循环。只有个别适配器内部启动了局部 HTTP 服务器（用于接收 webhook）：

| 服务 | 端口 | 用途 |
|------|------|------|
| API Server | 8642 | OpenAI 兼容 API |
| Webhook 接收 | 8644 | 通用 webhook |
| SMS (Twilio) | 8080 | SMS webhook |
| BlueBubbles | 8645 | iMessage webhook |

### 2.3 启动序列

```python
# gateway/run.py start_gateway() 第 7696 行
async def start_gateway():
    # 1. 单实例保护 — PID 文件
    existing_pid = get_running_pid()
    
    # 2. 创建 GatewayRunner
    runner = GatewayRunner(config)
    
    # 3. 注册信号处理 (SIGINT/SIGTERM)
    loop.add_signal_handler(sig, signal_handler)
    
    # 4. 启动所有适配器（每个平台的 connect()）
    success = await runner.start()
    
    # 5. 写 PID 文件
    write_pid_file()
    
    # 6. 启动 cron ticker（daemon 线程）
    cron_thread = threading.Thread(target=_start_cron_ticker, daemon=True)
    
    # 7. 阻塞等待关闭信号
    await runner.wait_for_shutdown()
```

### 2.4 设计评价

| 维度 | 评价 |
|------|------|
| **简洁性** | ✅ 优秀。纯 asyncio，无框架依赖 |
| **可维护性** | ❌ 差。7905 行**单文件**，所有逻辑挤在一起 |
| **与 OpenClaw 对比** | OpenClaw 拆分为 gateway/, infra/, daemon/, cron/ 多个目录 |

## 三、平台适配器（17 个）

### 3.1 完整列表

所有适配器位于 `gateway/platforms/` 目录。枚举定义在 `gateway/config.py:48-67`。

| # | 平台 | 文件 | 入站协议 | 出站协议 | 特殊能力 |
|---|------|------|---------|---------|---------|
| 1 | **Telegram** | `telegram.py` | Long Polling（python-telegram-bot） | Bot API `send_message` | MarkdownV2 格式、inline keyboard |
| 2 | **Discord** | `discord.py` | WebSocket（discord.py Bot） | REST `channel.send()` | Emoji reaction、guild 隔离 |
| 3 | **Slack** | `slack.py` | Socket Mode（slack-bolt） | REST `chat.postMessage` | Block Kit、Thread 支持 |
| 4 | **WhatsApp** | `whatsapp.py` | HTTP Bridge（Node.js 子进程 whatsapp-web.js） | Bridge HTTP API | 多媒体消息 |
| 5 | **Signal** | `signal.py` | SSE + JSON-RPC 2.0（signal-cli daemon） | HTTP JSON-RPC | 端到端加密 |
| 6 | **Matrix** | `matrix.py` | Long Polling（matrix-nio `/sync`） | REST `room_send()` | 联邦协议 |
| 7 | **Mattermost** | `mattermost.py` | WebSocket（aiohttp） | REST API v4 | 自托管 |
| 8 | **Email** | `email.py` | IMAP Polling（15s 间隔） | SMTP | 附件处理 |
| 9 | **SMS** | `sms.py` | Webhook（Twilio POST） | Twilio REST API | — |
| 10 | **DingTalk (钉钉)** | `dingtalk.py` | Stream Mode（dingtalk-stream SDK） | Session webhook POST (markdown) | 中国市场 |
| 11 | **Feishu (飞书)** | `feishu.py` | WebSocket（lark-oapi WSClient）或 Webhook | lark-oapi `CreateMessageRequest` | 中国市场 |
| 12 | **WeCom (企业微信)** | `wecom.py` | WebSocket（aibot_subscribe） | `aibot_send_msg` WS 消息 | 中国市场 |
| 13 | **Weixin (个人微信)** | `weixin.py` | Long Polling（iLink Bot `getupdates` API） | REST API + context_token | 中国市场、第三方桥 |
| 14 | **Home Assistant** | `homeassistant.py` | WebSocket（HA WS API `state_changed`） | Persistent notifications | IoT 场景 |
| 15 | **API Server** | `api_server.py` | HTTP `POST /v1/chat/completions` | HTTP response / SSE stream | OpenAI 兼容 |
| 16 | **Webhook** | `webhook.py` | HTTP POST + HMAC 验签 | 跨平台投递或 GitHub comment | 通用集成 |
| 17 | **BlueBubbles (iMessage)** | `bluebubbles.py` | REST + 本地 Webhook（httpx/aiohttp） | REST API 发送 | macOS 限定 |

### 3.2 协议分布分析

```
WebSocket 长连接:  Discord, Mattermost, WeCom, Feishu, Home Assistant  (5)
Socket Mode/Stream: Slack, DingTalk                                     (2)
Long Polling:       Telegram, Matrix, Weixin                            (3)
SSE:                Signal                                              (1)
Webhook/HTTP:       SMS, BlueBubbles, Webhook, API Server               (4)
桥接子进程:          WhatsApp (Node.js subprocess)                       (1)
传统轮询:            Email (IMAP Polling)                                (1)
```

### 3.3 中国市场覆盖

Hermes 是三个参考项目中**唯一**提供中国社交平台原生适配的。对知行（个人助手定位）极具参考价值：
- 钉钉（DingTalk）— Stream Mode SDK
- 飞书（Feishu/Lark）— WebSocket + Webhook 双模
- 企业微信（WeCom）— WebSocket
- 个人微信（Weixin）— 第三方桥接（iLink Bot），非官方 API

## 四、通道抽象层

### 4.1 基类

**文件**: `gateway/platforms/base.py`，`BasePlatformAdapter` 类（第 660 行）

```python
class BasePlatformAdapter(ABC):
    # === 4 个必须实现的抽象方法 ===
    @abstractmethod
    async def connect(self) -> bool: ...         # 建立平台连接
    @abstractmethod
    async def disconnect(self) -> None: ...      # 断开连接
    @abstractmethod
    async def send(self, chat_id, content, reply_to=None, metadata=None) -> SendResult: ...
    @abstractmethod
    async def get_chat_info(self, chat_id) -> Dict[str, Any]: ...

    # === 丰富的可选覆写方法（渐进增强） ===
    async def edit_message(...)    → SendResult   # 编辑已发消息
    async def send_typing(...)                     # 打字指示器
    async def send_image(...)                      # 原生图片
    async def send_animation(...)                  # GIF 动图
    async def send_voice(...)                      # 语音消息
    async def send_video(...)                      # 视频
    async def send_document(...)                   # 文件
    async def send_image_file(...)                 # 本地图片文件
    async def play_tts(...)                        # TTS 播放

    # === 内建的消息处理管线 ===
    async def handle_message(event)                # 调度+中断+后台任务
    async def _process_message_background(...)     # 完整发送管线
    async def _send_with_retry(...)                # 自动重试+plain-text 降级
    async def _keep_typing(...)                    # 持续打字指示器
```

### 4.2 与 OpenClaw 通道抽象的对比

| 维度 | Hermes `BasePlatformAdapter` | OpenClaw `ChannelPlugin` |
|------|------------------------------|--------------------------|
| **形态** | Python ABC 类继承 | TypeScript 结构化对象（~35 个可选 adapter slot） |
| **必须实现** | 4 个方法 | 仅 `config` adapter 必须 |
| **粒度** | 粗粒度：一个类包含所有能力 | 细粒度：每种能力一个独立 adapter |
| **可选能力** | 通过覆写基类方法 | 通过提供/不提供对应 adapter slot |
| **消息处理管线** | 内建在基类中 | 外部：Gateway Server + Inbound Debounce + Dispatch |
| **文件量** | 每平台 1 个 .py（含在 gateway/platforms/） | 每平台 1 个 extension 包（独立 package.json） |
| **复杂度** | 低（继承即可） | 高（需要理解 ~35 种 adapter 的契约） |
| **可扩展性** | 一般（修改基类影响所有平台） | 优秀（每个 adapter slot 独立演进） |

### 4.3 设计评价

| 维度 | 评价 |
|------|------|
| **上手成本** | ✅ 优秀。实现 4 个方法就能接入新平台 |
| **渐进增强** | ✅ 优秀。可选覆写丰富，不强制 |
| **内聚性** | ⚠️ 一般。基类太大，混合了连接管理、消息处理、重试逻辑 |
| **可测试性** | ⚠️ 一般。基类有大量内部状态，难以单元测试 |

## 五、Gateway ↔ Agent 集成

### 5.1 核心模式：每消息一次独立 Agent 调用

Gateway **不维护共享的 agent 循环**。每条入站消息触发一次独立的 agent 调用。

### 5.2 完整消息处理流程

```
平台消息到达
    │
    ▼
BasePlatformAdapter.handle_message(event)                [base.py:1329]
    │ 调用 asyncio.create_task(self._process_message_background(...))
    │
    ▼
_process_message_background()
    │ 检查: 是否有活跃 agent 在此 session？
    │ ├── 有 → 触发中断 _active_sessions[key].set()
    │ └── 无 → 继续
    │
    ▼
GatewayRunner._handle_message()                          [run.py:1826]
    │
    ▼
SessionStore.get_or_create_session(source)               [run.py:2384]
    │ session key = (platform, chat_id, user_id, thread_id)
    │
    ▼
Agent 缓存检查
    │ _agent_cache: Dict[str, (AIAgent, config_signature)]  [run.py:510]
    │ ├── 命中 + config 未变 → 复用（保留 prompt cache）
    │ └── 未命中 / config 变更 → 创建新 AIAgent
    │
    ▼
asyncio.to_thread(run_conversation, ...)                 
    │ 关键: Agent 是同步阻塞的，通过线程池桥接到 async 世界
    │
    ▼
GatewayStreamConsumer 桥接同步回调 → 异步平台 message edit
    │
    ▼
_send_with_retry() → 发送回复到平台
```

### 5.3 并发控制

```python
# 追踪活跃 agent [run.py:505]
self._running_agents: Dict[str, Any] = {}

# 新消息到达已有活跃 session 时的处理 [run.py:1347-1398]
if session_key in self._running_agents:
    self._active_sessions[session_key].set()  # 触发 asyncio.Event 中断
    self._pending_messages[session_key].append(event)  # 排队等待

# 命令绕过守卫 [run.py:1359]
# /approve, /deny, /stop, /new 等命令绕过 active-session 守卫直接执行
```

### 5.4 设计评价

| 维度 | 评价 |
|------|------|
| **简洁性** | ✅ 优秀。没有 Command Queue / Lane 的概念，asyncio.create_task 即并发 |
| **隔离性** | ✅ 良好。线程池隔离同步 agent，不阻塞 event loop |
| **缓存效率** | ✅ 良好。Agent 缓存保留 prompt cache，减少 LLM 冷启动 |
| **背压控制** | ❌ 弱。无 maxConcurrent 限制，无优先级队列 |
| **与 OpenClaw 对比** | OpenClaw 的 Command Queue + Lane 隔离更成熟，但复杂度也更高 |

## 六、调度系统（Cron）

### 6.1 架构

**文件**: `cron/scheduler.py`、`cron/jobs.py`

- Gateway 内嵌 cron ticker，运行在独立 **daemon 线程**中
- 每 **60 秒**检查一次（`_start_cron_ticker`，run.py:7642）
- 文件锁（`~/.hermes/cron/.tick.lock`）防止多进程并发执行

### 6.2 与 OpenClaw Cron 的对比

| 维度 | Hermes | OpenClaw |
|------|--------|----------|
| **文件量** | 数个文件 | ~130 个 .ts 文件 |
| **调度机制** | threading + sleep 循环 | setTimeout 递归 + clamp |
| **执行模式** | 直接执行 agent turn | main session / isolated / current / session:xxx |
| **投递** | DeliveryRouter → 任意平台 | announce / webhook |
| **退避** | 有（简单指数退避） | 有（5 级退避表 + 连续失败通知） |
| **missed job 追赶** | 无明确记载 | 有（重启后补执行，最多 5 个） |
| **成熟度** | ⚠️ 基础 | ✅ 完善但过度复杂 |

### 6.3 Gateway 内的其他后台任务

除了 cron ticker，Gateway 还运行：
- **Session expiry watcher**（每 300 秒）：自动检测过期会话 → 执行 memory flush
- **Channel directory refresh**（每 5 分钟）：更新平台频道目录缓存
- **媒体缓存清理**（每小时）：清理 24 小时前的图片/音频/文档缓存

## 七、守护进程 / 进程管理

### 7.1 OS 级服务集成

通过 `hermes_cli/gateway.py` 提供：

| 平台 | 方式 | 命令 | 特性 |
|------|------|------|------|
| **Linux** | systemd | `hermes gateway install` | 用户级/系统级、`Restart=on-failure`、多 profile 支持 |
| **macOS** | launchd | `hermes gateway install` | `RunAtLoad=true`、`KeepAlive.SuccessfulExit=false` |
| **Docker** | 容器 | Dockerfile + entrypoint.sh | debian:13.4 基础镜像、/opt/data volume 持久化 |

### 7.2 健康检查与自恢复

- **PID 文件保护**：`gateway.pid` 防止重复实例（run.py:7710）
- **`--replace` 参数**：强制接管现有实例（SIGTERM → 10s 等待 → SIGKILL）
- **运行时状态文件**：`gateway_state.json` 记录 gateway_state / platform_state / error_code
- **后台重连**：失败平台进入 `_failed_platforms` 队列，30 秒起步指数退避重试
- **Fatal error 区分**：`_set_fatal_error(code, message, retryable=True/False)` — retryable 触发重连，non-retryable 放弃
- **launchd plist 自修复**：`refresh_launchd_plist_if_needed()` 检测并更新过期配置

### 7.3 与 OpenClaw Daemon 的对比

| 维度 | Hermes | OpenClaw |
|------|--------|----------|
| **实现量** | CLI 代码 + plist/unit 模板 | ~60 个 .ts 文件（daemon/） |
| **Windows** | 不支持 | 支持（schtasks） |
| **Docker** | ✅ 有 Dockerfile | 无官方 Docker 支持 |
| **多 profile** | ✅ 服务名带 profile 后缀 | 无 |
| **优雅重启** | SIGTERM → wait_for_shutdown | SIGUSR1 → drain → fork/in-process restart |

## 八、内部消息格式

### 8.1 入站：MessageEvent

```python
@dataclass
class MessageEvent:                    # gateway/platforms/base.py:565-624
    text: str
    message_type: MessageType          # TEXT/PHOTO/VIDEO/AUDIO/VOICE/DOCUMENT/STICKER/COMMAND
    source: SessionSource              # platform / chat_id / user_id / thread_id / chat_type
    raw_message: Any                   # 原始平台消息对象（留给适配器特化处理）
    message_id: Optional[str]
    media_urls: List[str]              # 本地缓存的文件路径（非原始 URL）
    media_types: List[str]
    reply_to_message_id: Optional[str]
    reply_to_text: Optional[str]
    auto_skill: Optional[str | list[str]]  # 自动触发的 skill 名称
    internal: bool = False             # 系统内部事件跳过鉴权
```

### 8.2 出站：SendResult

```python
@dataclass
class SendResult:                      # gateway/platforms/base.py:626-634
    success: bool
    message_id: Optional[str]
    error: Optional[str]
    raw_response: Any
    retryable: bool = False
```

### 8.3 平台特有功能处理

| 功能 | 处理方式 |
|------|---------|
| **富媒体** | `extract_images()` 从 markdown `![](url)` 和 `<img>` 标签提取，发为原生附件 |
| **MEDIA: 标签** | `extract_media()` 解析 `MEDIA:/path/to/file`，按类型路由到 `send_voice/video/document` |
| **本地文件** | `extract_local_files()` 自动检测响应中的本地文件路径 |
| **长消息分块** | `truncate_message()` 智能分割，保持代码块完整性 |
| **格式转换** | 每个适配器覆写 `format_message()`（如 Telegram 转 MarkdownV2） |
| **打字/reaction** | Discord 覆写 `on_processing_start/complete` 添加 emoji reaction |

## 九、并发会话管理

### 9.1 会话隔离

- **Session key**：`(platform, chat_id, user_id, thread_id)` 组合 → 独立 session
- **SessionStore**：SQLite + legacy JSONL 双写（run.py:488）

### 9.2 并发策略

```
消息 A 到达 session X（无活跃 agent）
    → 创建 agent task，记录到 _running_agents[X]

消息 B 到达 session X（agent A 活跃中）
    → _active_sessions[X].set()            # 中断信号
    → _pending_messages[X].append(B)       # 排队

Agent A 完成
    → 检查 _pending_messages[X]
    → 有 → 立即处理排队消息
    → 无 → 完成

特殊: 照片连拍（Telegram/Discord）
    → 自动合并为单个 MessageEvent，不触发中断
```

### 9.3 Agent 缓存

```python
# run.py:510-516
self._agent_cache: Dict[str, tuple] = {}
# key = session_key
# value = (AIAgent 实例, config_signature)
# 目的: 保留 LLM prompt cache，减少冷启动
```

## 十、错误处理 / 弹性

### 10.1 连接层

- **自动重连**：失败平台加入 `_failed_platforms`，后台 watcher 指数退避重试（30s 起步）
- **Fatal error 区分**：retryable 错误触发重连，non-retryable 直接放弃
- **Stale session 驱逐**：基于 idle 时间和 wall-clock 超时自动清理 hung agent（run.py:1921-1964）

### 10.2 发送层

- **`_send_with_retry()`**：网络错误自动重试（指数退避，最多 2 次）
- **Plain-text 降级**：格式化失败后自动回退到纯文本
- **投递失败通知**：所有重试失败后发送 "delivery failed" 通知

### 10.3 平台层

- **代理支持**：`resolve_proxy_url()` 支持 SOCKS/HTTP 代理，自动检测 macOS 系统代理 — **对 GFW 场景至关重要**
- **SSRF 防护**：`_ssrf_redirect_guard()` 拦截重定向到内网的请求
- **Rate limiting**：每个平台独立去重缓存（如 Slack 的 `_seen_messages` TTL 5min）
- **Timeout 感知**：区分 connect timeout（安全重试）和 read/write timeout（不重试）

## 十一、配置管理

### 11.1 三层级联

```
环境变量（最高）→ ~/.hermes/config.yaml → ~/.hermes/gateway.json（legacy）→ 内建默认值
```

### 11.2 每平台配置

```python
@dataclass
class PlatformConfig:
    enabled: bool
    token: Optional[str]
    api_key: Optional[str]
    home_channel: Optional[HomeChannel]  # cron 输出默认目标
    reply_to_mode: str                   # "off" / "first" / "all"
    extra: Dict[str, Any]                # 平台特有设置
```

### 11.3 会话重置策略

`SessionResetPolicy` 支持 `daily` / `idle` / `both` / `none` 四种模式：
- `idle_minutes`: 空闲超时（默认 1440 = 24h）
- `at_hour`: 每日重置时间（默认 4:00）
- 每平台、每类型（dm/group/thread）可独立覆写

## 十二、与知行的对比思考

### 12.1 Hermes 做对了的

1. **中国平台覆盖**：钉钉/飞书/企业微信/个人微信四大平台——知行作为中文个人助手必须参考
2. **极简通道抽象**：实现 4 个方法就能接入新平台——降低了集成门槛
3. **Agent 缓存**：复用 AIAgent 实例保留 prompt cache——减少 LLM 冷启动成本
4. **代理支持**：原生 SOCKS/HTTP 代理——对中国网络环境至关重要
5. **OpenAI 兼容 API Server**：`/v1/chat/completions` 端点让 Hermes 可以被其他工具调用
6. **Docker 支持**：官方 Dockerfile + volume 持久化——降低部署门槛

### 12.2 Hermes 做得不够好的

1. **单文件巨石**：`run.py` 7905 行，可维护性极差。OpenClaw 将 gateway 拆分为数十个文件
2. **无 WebSocket RPC 协议**：没有标准化的客户端通信协议，CLI 与 Gateway 通过文件/subprocess 间接交互
3. **无 Lane 隔离**：所有消息通过 asyncio.create_task 并发，无优先级、无背压控制
4. **无优雅重启**：收到 SIGTERM 直接 shutdown，不像 OpenClaw 的 drain → wait → abort 渐进策略
5. **同步 Agent + 线程池桥接**：Agent 是同步阻塞的 `run_conversation()`，必须通过 `asyncio.to_thread` 桥接，增加了复杂度
6. **Session 存储简陋**：SQLite + JSONL 双写，无压缩、无流式恢复
7. **Cron 基础**：没有 OpenClaw 级别的 missed job 追赶、多执行模式、退避表

### 12.3 对知行的启示

| 启示 | 来源 | 行动 |
|------|------|------|
| 通道抽象应**极简** | Hermes 4 方法 vs OpenClaw 35 slot | 知行可取中间路线：核心抽象 4-6 方法 + 可选 capability trait |
| 中国平台是**刚需** | Hermes 是唯一覆盖的 | 知行作为中文助手，钉钉/飞书/企微至少覆盖一个 |
| **代理/GFW** 必须考虑 | Hermes 原生支持 | 知行的 Provider + Channel 层都需要 proxy 配置 |
| 避免**单文件巨石** | Hermes 7905 行反面教材 | 知行已有良好的模块拆分传统，继续保持 |
| **Agent 缓存**值得借鉴 | Hermes prompt cache 复用 | 知行的 Server 模式需要 session → agent 实例缓存 |
| **OpenAI 兼容 API** 有价值 | Hermes API Server | 知行的 Server 模式可暴露兼容 API，让其他工具调用 |
