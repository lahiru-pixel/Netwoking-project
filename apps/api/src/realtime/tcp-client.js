import { EventEmitter } from "node:events";
import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";

const MAX_LINE_LENGTH = 65_536;

export class JavaTcpClient extends EventEmitter {
  constructor({ host, port, sharedSecret, sessionId, role, rooms = [], reconnectMinMs = 250, reconnectMaxMs = 10_000 }) {
    super();
    this.host = host;
    this.port = port;
    this.sharedSecret = sharedSecret;
    this.sessionId = sessionId;
    this.role = role;
    this.rooms = new Set(rooms);
    this.reconnectMinMs = reconnectMinMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.socket = null;
    this.connected = false;
    this.everConnected = false;
    this.closing = false;
    this.reconnectDelay = reconnectMinMs;
    this.pending = new Map();
    this.readyWaiters = new Set();
    this.connecting = null;
    this.heartbeat = null;
    this.reconnectTimer = null;
  }

  start() {
    if (!this.connecting && !this.connected && !this.closing) {
      this.connecting = this.connectSocket().finally(() => {
        this.connecting = null;
      });
      this.connecting.catch(() => {});
    }
    return this.waitUntilReady();
  }

  async request(type, payload = {}, { timeoutMs = 5_000, messageId } = {}) {
    await this.waitUntilReady();
    return this.sendRequest(type, payload, timeoutMs, this.socket, messageId);
  }

  async joinRoom(quizId) {
    if (this.rooms.has(quizId)) return;
    await this.request("JOIN_ROOM", { quizId });
    this.rooms.add(quizId);
  }

  async leaveRoom(quizId) {
    if (!this.rooms.has(quizId)) return;
    await this.request("LEAVE_ROOM", { quizId });
    this.rooms.delete(quizId);
  }

  async close() {
    this.closing = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeat);
    for (const [messageId, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(new Error("Java TCP connection was closed."));
      this.pending.delete(messageId);
    }
    this.socket?.destroy();
    this.connected = false;
    this.rejectReadyWaiters(new Error("Java TCP client is closed."));
    if (this.connecting) await this.connecting.catch(() => {});
  }

  async waitUntilReady(timeoutMs = 5_000) {
    if (this.connected) return;
    if (this.closing) throw new Error("Java TCP client is closed.");
    if (!this.connecting) this.start().catch(() => {});
    await new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          this.readyWaiters.delete(waiter);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          this.readyWaiters.delete(waiter);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        this.readyWaiters.delete(waiter);
        reject(new Error("Timed out waiting for the Java TCP connection."));
      }, timeoutMs);
      timer.unref();
      this.readyWaiters.add(waiter);
    });
  }

  async connectSocket() {
    if (this.closing) return;
    const socket = net.createConnection({ host: this.host, port: this.port });
    socket.setNoDelay(true);
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    this.socket = socket;

    socket.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      if (buffer.length > MAX_LINE_LENGTH && !buffer.includes("\n")) {
        socket.destroy(new Error("Java TCP response exceeds the maximum message size."));
        return;
      }
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.length > MAX_LINE_LENGTH) {
          socket.destroy(new Error("Java TCP response exceeds the maximum message size."));
          return;
        }
        this.handleLine(line);
      }
    });

    socket.on("error", (error) => {
      if (!this.closing) console.error(`Java TCP socket error (${this.sessionId}):`, error.message);
    });
    socket.on("close", () => this.handleDisconnect(socket));

    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          socket.off("connect", onConnect);
          reject(error);
        };
        const onConnect = () => {
          socket.off("error", onError);
          resolve();
        };
        socket.once("error", onError);
        socket.once("connect", onConnect);
      });

      await this.sendRequest("AUTH", { sharedSecret: this.sharedSecret }, 5_000, socket);
      await this.sendRequest("REGISTER_SESSION", { sessionId: this.sessionId, role: this.role }, 5_000, socket);
      for (const quizId of this.rooms) {
        await this.sendRequest("JOIN_ROOM", { quizId }, 5_000, socket);
      }
      this.connected = true;
      this.reconnectDelay = this.reconnectMinMs;
      this.resolveReadyWaiters();
      this.heartbeat = setInterval(() => {
        this.request("PING", {}, { timeoutMs: 5_000 }).catch((error) => {
          if (!this.closing) console.error(`Java TCP heartbeat failed (${this.sessionId}):`, error.message);
          this.socket?.destroy();
        });
      }, 30_000);
      this.heartbeat.unref();
      this.emit("ready");
      if (this.everConnected) this.emit("reconnected");
      this.everConnected = true;
    } catch (error) {
      socket.destroy();
      this.rejectReadyWaiters(error);
      if (!this.closing) this.scheduleReconnect();
      throw error;
    }
  }

  sendRequest(type, payload, timeoutMs, socket = this.socket, requestMessageId = randomUUID()) {
    if (!socket || socket.destroyed) return Promise.reject(new Error("Java TCP connection is unavailable."));
    const messageId = requestMessageId;
    const envelope = {
      version: 1,
      messageId,
      type,
      timestamp: new Date().toISOString(),
      payload,
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(messageId);
        reject(new Error(`Java TCP ${type} request timed out.`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(messageId, { resolve, reject, timer, socket });
      socket.write(`${JSON.stringify(envelope)}\n`, "utf8", (error) => {
        if (!error) return;
        const pending = this.pending.get(messageId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(messageId);
        reject(error);
      });
    });
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      console.error("Ignoring malformed JSON received from Java TCP server:", error.message);
      return;
    }
    if (
      !message ||
      typeof message !== "object" ||
      message.version !== 1 ||
      typeof message.type !== "string" ||
      typeof message.messageId !== "string" ||
      typeof message.timestamp !== "string" ||
      !message.payload ||
      typeof message.payload !== "object" ||
      Array.isArray(message.payload)
    ) {
      console.error("Ignoring invalid protocol envelope or unsupported version received from Java TCP server.");
      return;
    }
    const ackMessageId = message.payload.ackMessageId;
    const pending = typeof ackMessageId === "string" ? this.pending.get(ackMessageId) : null;
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(ackMessageId);
      if (message.type === "ERROR") {
        pending.reject(new Error(`Java TCP ${message.payload.code ?? "ERROR"}: ${message.payload.message ?? "Request failed."}`));
      } else {
        pending.resolve(message);
      }
      return;
    }
    this.emit("event", message);
  }

  handleDisconnect(socket) {
    if (this.socket !== socket) return;
    clearInterval(this.heartbeat);
    this.heartbeat = null;
    const wasConnected = this.connected;
    this.connected = false;
    this.socket = null;
    for (const [messageId, pending] of this.pending) {
      if (pending.socket !== socket) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error("Java TCP connection was lost."));
      this.pending.delete(messageId);
    }
    if (wasConnected) this.emit("disconnect");
    if (!this.closing) this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.closing) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.reconnectMaxMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start().catch((error) => {
        if (!this.closing) console.error(`Java TCP reconnect failed (${this.sessionId}):`, error.message);
      });
    }, delay);
    this.reconnectTimer.unref();
  }

  resolveReadyWaiters() {
    for (const waiter of this.readyWaiters) waiter.resolve();
    this.readyWaiters.clear();
  }

  rejectReadyWaiters(error) {
    for (const waiter of this.readyWaiters) waiter.reject(error);
    this.readyWaiters.clear();
  }
}
