/**
 * dsh-resume-on-restart ws 状态推送（0.11.0）：零依赖的最小 RFC6455 WebSocket 服务端
 * （node:http + node:crypto，不新增任何 npm 依赖）。
 *
 * 背景：web 顶栏开关（lib/client.js 的 ResumeToggle）此前每 15 秒轮询
 * GET /api/dsh-resume-on-restart/state 来同步 restoreCandidates/excluded。
 * 0.11.0 起改为 websocket 快照广播（用户规则：能不用轮询接口就不用轮询；ws 连接
 * 失败必须无限重试、绝不回退轮询；「重启 dsh」功能的轮询豁免区不涉及本文件）。
 *
 * 本文件只做三件事：
 *
 * 1. 最小 RFC6455 协议（握手 + 帧编解码）：
 *    - Sec-WebSocket-Accept = base64(sha1(Sec-WebSocket-Key + 固定 GUID))；
 *    - 服务端只发文本帧且不加掩码；收帧支持客户端掩码去除、ping/pong/close、
 *      最简分片（客户端数据一概不消费，只为正确吃掉字节流并回出控制帧）；
 *    - 单帧与累积接收缓冲上限 1MiB，超出按 1009 关闭，防异常客户端撑内存。
 *
 * 2. 安全：进程（插件实例）启动时生成随机 token；升级握手校验 query 里的 token
 *    （sha256 摘要后 timingSafeEqual，避免时序/长度泄漏），再回调 index.js 注入的
 *    信任围栏（与 HTTP 路由同口径的 ws 拓扑适配版），任一不过直接 destroy，
 *    不给任何回包。连接数有上限（MAX_CLIENTS）兜底。
 *
 * 3. 生命周期与广播：
 *    - bind 0.0.0.0 + port 0（随机端口）：可达性与宿主 webServer 一致
 *      （用户可能从局域网 IP 打开 GUI）；server.unref() 与每条连接 socket.unref()
 *      都不改变进程退出行为；
 *    - listen 失败只 console.warn 降级（info() 从此返回 null，index.js 的 /ws-info
 *      相应返回 503，客户端保持无限重试，开关退化为其挂载时的一次性查询），
 *      绝不抛出、绝不阻断插件加载；
 *    - close() 由 index.js 的 ctx.effect dispose 调用：关全部连接 + 关服务端；
 *    - 连接建立后立即推一帧全量快照 { type:'state', restoreCandidates, excluded }
 *      （与 GET /state 同口径；重连成功后的状态重建就靠它）；此后 excluded 变化
 *      （POST /state 成功）或候选集变化（recordActivity 触发点）都经 broadcast()
 *      广播同一快照结构——首发立即（开关点击零感知延迟），广播节流窗口内的
 *      高频活动事件（agent/assistant-stream 等）合并为一帧尾随广播（默认 300ms），
 *      快照内容没变（如同 id 活动只挪动 recentSessions 顺序）直接跳过不重发。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';

/** RFC6455 握手计算 Sec-WebSocket-Accept 用的固定 GUID。 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** 单帧与累积接收缓冲的字节上限：超出按 1009 关闭。 */
const MAX_FRAME_BYTES = 1024 * 1024;
/** 服务端心跳 ping 间隔（ms）：连续一个周期无任何字节的连接视为半开，强制回收。 */
const HEARTBEAT_MS = 30000;
/** 广播合并节流窗口（ms）：首发立即，窗口内的高频触发合并为一帧尾随广播。 */
const DEFAULT_THROTTLE_MS = 300;
/** 同时连接数上限：token 泄漏或异常客户端时的兜底保护（每个 GUI 标签页一条）。 */
const MAX_CLIENTS = 64;

// RFC6455 opcode
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const EMPTY_PAYLOAD = Buffer.alloc(0);

/** token 比较（timing-safe）：先归一到定长 sha256 摘要再比较。 */
function tokenMatches(expected, provided) {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const left = createHash('sha256').update(expected).digest();
  const right = createHash('sha256').update(provided).digest();
  return timingSafeEqual(left, right);
}

/** 服务端出站帧（FIN=1、无掩码）：文本/控制帧统一在此编码。 */
function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | opcode;
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** close 帧体：2 字节状态码（本服务端不发 close reason，省字节）。 */
function closeBody(code) {
  const body = Buffer.allocUnsafe(2);
  body.writeUInt16BE(code, 0);
  return body;
}

/**
 * 从缓冲头部解析一帧（RFC6455：客户端帧必须带掩码）。
 * 返回 `{ frame }` / `{ error }`（协议错误，调用方按 1002/1009 关闭）/
 * `null`（字节不够，等下一块 data 再试）。
 */
function readFrame(buffer) {
  if (buffer.length < 2) return null;
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const extended = buffer.readBigUInt64BE(2);
    if (extended > BigInt(MAX_FRAME_BYTES)) return { error: 'frame-too-large' };
    length = Number(extended);
    offset = 10;
  }
  if (length > MAX_FRAME_BYTES) return { error: 'frame-too-large' };
  if (!masked) return { error: 'unmasked-client-frame' };
  const maskKey = buffer.subarray(offset, offset + 4);
  offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i += 1) payload[i] = buffer[offset + i] ^ maskKey[i & 3];
  return { frame: { fin, opcode, payload, consumed: offset + length } };
}

/**
 * 创建 ws 状态推送服务。
 * @param {object} options
 * @param {() => {restoreCandidates: object, excluded: object}} options.snapshot
 *   全量快照提供方（index.js 闭包：候选 = recentSessions 实时视图、排除 = 全集），
 *   每次广播/每条新连接时调用，保证快照永远是当前值。
 * @param {(req: import('node:http').IncomingMessage) => boolean} [options.verifyUpgrade]
 *   信任围栏（index.js 注入，token 校验不在这里）：返回非 true = 不信任，直接 destroy。
 * @param {number} [options.throttleMs] 广播合并节流窗口（ms），默认 300。
 */
export function createWsStatePush({ snapshot, verifyUpgrade, throttleMs = DEFAULT_THROTTLE_MS }) {
  // 进程（插件实例）生命周期内唯一的接入令牌：只经受围栏的 GET /ws-info 下发
  const token = randomBytes(24).toString('base64url');

  /** 已完成握手的客户端集合。 */
  const clients = new Set();
  let httpServer = null;
  let port = 0;
  let degraded = false; // listen 失败后置位：info() 恒 null，广播空转，只 warn 不抛
  let closed = false; // dispose 后置位：不再重启（本服务的生命周期跟着 ctx.effect 走）
  let throttleTimer = null;
  let throttlePending = false;
  let heartbeatTimer = null;
  let lastSentJson = null;

  /**
   * 启动监听（幂等；close 后不可重启）。bind 0.0.0.0 + 随机端口，
   * listen 失败只降级（degraded），绝不抛出。
   */
  function start() {
    if (closed || degraded || httpServer !== null) return;
    const server = createHttpServer();
    server.on('request', (_req, res) => {
      // 本端口只服务 ws 升级；普通 HTTP 请求统一 426，不暴露任何插件路由
      res.writeHead(426, { connection: 'close', 'content-type': 'text/plain; charset=utf-8' });
      res.end('websocket endpoint: upgrade required\n');
    });
    server.on('upgrade', handleUpgrade);
    server.on('clientError', (_err, socket) => socket.destroy());
    server.on('error', (err) => {
      // 监听失败（权限/地址族等）只降级：开关退化为本组件挂载时的一次性查询，
      // 客户端 /ws-info 无限重试（不回退轮询），服务恢复后自动接上
      degraded = true;
      httpServer = null;
      console.warn('[resume-on-restart] ws: listen failed, state push disabled:', err);
    });
    server.listen(0, '0.0.0.0', () => {
      const address = server.address();
      port = address !== null && typeof address === 'object' ? address.port : 0;
      server.unref(); // 不改变进程退出行为（连接 socket 同样 unref，见 handleUpgrade）
      heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
      heartbeatTimer.unref?.();
      console.log(`[resume-on-restart] ws: state push listening on 0.0.0.0:${port}`);
    });
    httpServer = server;
  }

  /** 升级握手：token + 信任围栏 + 协议头三道校验，任一不过直接断开。 */
  function handleUpgrade(req, socket, head) {
    try {
      socket.on('error', () => socket.destroy());
      const url = new URL(req.url ?? '/', 'http://dsh.local');
      // 1) 随机 token（query）：不对不给任何回包，直接 destroy
      if (!tokenMatches(token, url.searchParams.get('token'))) {
        socket.destroy();
        return;
      }
      // 2) 信任围栏（index.js 注入：宿主 connection 认证 + ws 拓扑适配版信任判断）
      if (typeof verifyUpgrade === 'function' && verifyUpgrade(req) !== true) {
        socket.destroy();
        return;
      }
      // 3) 协议头：Upgrade: websocket、Sec-WebSocket-Version: 13、16 字节随机 key
      const key = req.headers['sec-websocket-key'];
      const upgradeHeader = req.headers.upgrade;
      const keyOk = typeof key === 'string' && Buffer.from(key, 'base64').length === 16;
      if (typeof upgradeHeader !== 'string' || upgradeHeader.toLowerCase() !== 'websocket'
        || req.headers['sec-websocket-version'] !== '13' || !keyOk) {
        socket.write('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      if (clients.size >= MAX_CLIENTS) {
        console.warn('[resume-on-restart] ws: client limit reached, rejecting upgrade');
        socket.write('HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      // RFC6455 握手回包：Accept = base64(sha1(key + GUID))
      const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n'
        + 'upgrade: websocket\r\n'
        + 'connection: upgrade\r\n'
        + `sec-websocket-accept: ${accept}\r\n\r\n`,
      );
      socket.setNoDelay(true);
      socket.unref?.(); // 连接同样不阻止进程退出
      const client = { socket, buffer: Buffer.alloc(0), fragOpcode: null, alive: true, closed: false };
      clients.add(client);
      socket.on('data', (chunk) => feedClient(client, chunk));
      socket.on('close', () => {
        clients.delete(client);
      });
      if (head !== undefined && head.length > 0) feedClient(client, head);
      // 连接建立后立即推一帧全量快照（客户端重连成功后的状态重建就靠它）
      sendSnapshotTo(client);
    } catch (err) {
      console.warn('[resume-on-restart] ws: upgrade failed:', err);
      socket.destroy();
    }
  }

  /** 把到达的字节流切成帧逐个处理；协议错误/超大帧按对应状态码关闭。 */
  function feedClient(client, chunk) {
    client.buffer = client.buffer.length === 0 ? chunk : Buffer.concat([client.buffer, chunk]);
    while (!client.closed) {
      const parsed = readFrame(client.buffer);
      if (parsed === null) break; // 半帧：等下一块 data
      if (parsed.error) {
        closeClient(client, parsed.error === 'frame-too-large' ? 1009 : 1002, parsed.error);
        return;
      }
      client.buffer = client.buffer.subarray(parsed.frame.consumed);
      client.alive = true; // 任何到达的字节都证明对端存活（不止 pong）
      if (!handleFrame(client, parsed.frame)) return;
    }
  }

  /** 处理一帧；返回 false 表示连接已终止，外层停止解析。 */
  function handleFrame(client, { fin, opcode, payload }) {
    switch (opcode) {
      case OP_CLOSE: {
        // 规范回礼：回一帧 close（回显状态码）再断开
        closeClient(client, payload.length >= 2 ? payload.readUInt16BE(0) : 1000, 'client close');
        return false;
      }
      case OP_PING:
        sendFrame(client, OP_PONG, payload.subarray(0, 125)); // 控制帧载荷上限 125
        return true;
      case OP_PONG:
        return true; // 存活性已在 feedClient 统一置位
      case OP_TEXT:
      case OP_BINARY:
        // 本服务不消费客户端数据；分片按最简处理：只为正确吃掉字节流
        if (client.fragOpcode !== null) return protocolError(client);
        if (!fin) client.fragOpcode = opcode;
        return true;
      case OP_CONT:
        if (client.fragOpcode === null) return protocolError(client); // 没有开始的续帧
        if (fin) client.fragOpcode = null;
        return true;
      default:
        return protocolError(client); // 保留 opcode（0x3-0x7 / 0xb-0xf）= 协议错误
    }
  }

  /** 协议错误：按 1002 关闭。 */
  function protocolError(client) {
    closeClient(client, 1002, 'protocol error');
    return false;
  }

  /** 优雅关闭：回一帧 close（服务端帧不加掩码），短暂等待后强制回收。 */
  function closeClient(client, code, why = '') {
    if (client.closed) return;
    if (why) console.log(`[resume-on-restart] ws: closing client (${code} ${why})`);
    // 先发 close 帧再标记 closed（sendFrame 会拒绝已关闭的客户端）；
    // 对端已发 close 时这就是规范要求的回礼
    try {
      client.socket.write(encodeFrame(OP_CLOSE, closeBody(code)));
    } catch (err) {
      console.warn('[resume-on-restart] ws: close frame write failed:', (err && err.message) || err);
    }
    client.closed = true;
    const { socket } = client;
    const reap = setTimeout(() => socket.destroy(), 1000);
    reap.unref?.();
  }

  /** 发送一帧；同步失败记日志并销毁连接（异步失败由 socket error 事件兜底）。 */
  function sendFrame(client, opcode, payload) {
    if (client.closed || client.socket.destroyed) return false;
    try {
      client.socket.write(encodeFrame(opcode, payload));
      return true;
    } catch (err) {
      console.warn('[resume-on-restart] ws: write failed:', (err && err.message) || err);
      client.socket.destroy();
      return false;
    }
  }

  /** 构造当前快照文本（JSON 失败只 warn，返回 null = 本轮不推）。 */
  function currentSnapshotText() {
    try {
      return JSON.stringify({ type: 'state', ...snapshot() });
    } catch (err) {
      console.warn('[resume-on-restart] ws: snapshot build failed:', err);
      return null;
    }
  }

  function sendSnapshotTo(client) {
    const text = currentSnapshotText();
    if (text !== null) sendFrame(client, OP_TEXT, Buffer.from(text, 'utf8'));
  }

  function sendSnapshotToAll() {
    const text = currentSnapshotText();
    // 内容没变（如同 id 活动只挪动 recentSessions 顺序，id 集合没变）直接跳过不重发
    if (text === null || text === lastSentJson) return;
    lastSentJson = text;
    const frame = encodeFrame(OP_TEXT, Buffer.from(text, 'utf8'));
    for (const client of clients) {
      if (client.closed || client.socket.destroyed) continue;
      try {
        client.socket.write(frame);
      } catch (err) {
        console.warn('[resume-on-restart] ws: broadcast write failed:', (err && err.message) || err);
        client.socket.destroy();
      }
    }
  }

  /**
   * 广播一帧全量快照（排除集合变化 / 候选集变化都调它）：
   * 首发立即（开关点击零感知延迟），节流窗口内的高频活动事件合并为一帧尾随广播。
   */
  function broadcast() {
    if (closed || degraded || httpServer === null || port === 0) return;
    if (clients.size === 0) return;
    if (throttleTimer !== null) {
      throttlePending = true;
      return;
    }
    sendSnapshotToAll();
    throttleTimer = setTimeout(() => {
      throttleTimer = null;
      if (!throttlePending) return;
      throttlePending = false;
      sendSnapshotToAll();
    }, throttleMs);
    throttleTimer.unref?.();
  }

  /** 心跳：连续一个周期没有任何字节的连接视为半开（休眠/断网的标签页），强制回收。 */
  function heartbeat() {
    for (const client of clients) {
      if (client.closed) continue;
      if (!client.alive) {
        console.log('[resume-on-restart] ws: heartbeat timeout, dropping client');
        clients.delete(client);
        client.socket.destroy();
        continue;
      }
      client.alive = false;
      sendFrame(client, OP_PING, EMPTY_PAYLOAD);
    }
  }

  /** /ws-info 的接入信息；未启动 / 已降级 / 已关闭返回 null（调用方回 503）。 */
  function info() {
    return !closed && !degraded && httpServer !== null && port > 0 ? { port, token } : null;
  }

  /** 释放全部资源（index.js 的 ctx.effect dispose 调用）。 */
  function close() {
    if (closed) return;
    closed = true;
    if (throttleTimer !== null) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    for (const client of clients) {
      // 先标记：close() 之后不再接受新帧；close 帧是尽力而为（写完立即 destroy）
      const wasOpen = !client.closed;
      client.closed = true;
      if (wasOpen) {
        try {
          client.socket.write(encodeFrame(OP_CLOSE, closeBody(1001))); // going away
        } catch (err) {
          console.warn('[resume-on-restart] ws: close frame write failed:', (err && err.message) || err);
        }
      }
      client.socket.destroy();
    }
    clients.clear();
    const server = httpServer;
    httpServer = null;
    port = 0;
    if (server !== null) {
      // listen 尚未完成时 close() 会同步抛 ERR_SERVER_NOT_RUNNING，只记日志：
      // dispose 阶段的回收失败不影响进程退出（server 已 unref）
      try {
        if (server.listening) server.close(() => {});
      } catch (err) {
        console.warn('[resume-on-restart] ws: server close failed:', err);
      }
    }
  }

  return { token, start, info, broadcast, close };
}
