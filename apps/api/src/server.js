import mongoose from "mongoose";
import "./config.js";

const mongoUri = process.env.MONGODB_URI;
const port = Number.parseInt(process.env.API_PORT ?? "4000", 10);
const host = process.env.API_HOST ?? "127.0.0.1";

if (!mongoUri) {
  throw new Error("MONGODB_URI must be set; refusing to start without MongoDB.");
}
if (!["127.0.0.1", "localhost", "::1"].includes(new URL(mongoUri).hostname)) {
  throw new Error("MONGODB_URI must point to local MongoDB (127.0.0.1).");
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("API_PORT must be a valid TCP port.");
}
if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
  throw new Error("API_HOST must be a loopback address; mobile clients connect through Vite.");
}

try {
  await mongoose.connect(mongoUri);
  console.info("Connected to local MongoDB.");
} catch (error) {
  console.error("Could not connect to MongoDB; API startup aborted.", error);
  process.exitCode = 1;
  throw error;
}
if (mongoose.connection.host !== "127.0.0.1" && mongoose.connection.host !== "localhost") {
  throw new Error("Connected MongoDB host is not local; API startup aborted.");
}

const { createApp } = await import("./app.js");
const { startAttemptExpiryWorker } = await import("./attempts/expiry-worker.js");
const { createJavaTcpBridge } = await import("./realtime/java-bridge.js");
const javaBridge = createJavaTcpBridge();
await javaBridge.start();
const app = createApp({ eventPublisher: javaBridge, realtimeBridge: javaBridge });
const expiryWorker = startAttemptExpiryWorker({ eventPublisher: javaBridge });

const server = app.listen(port, host, () => {
  console.info(`ExamFlow API listening on http://${host}:${port}`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`Received ${signal}; shutting down ExamFlow API.`);
  await expiryWorker.stop();
  await javaBridge.close();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await app.locals.sessionStore.close();
  await mongoose.disconnect();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    shutdown(signal).catch((error) => {
      console.error("API shutdown failed:", error);
      process.exitCode = 1;
    });
  });
}
