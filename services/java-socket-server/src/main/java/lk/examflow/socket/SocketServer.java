package lk.examflow.socket;

import java.io.IOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.util.concurrent.CountDownLatch;


public final class SocketServer {
    private SocketServer() {
    }


    public static void main(String[] args) throws Exception {
        
        String host = System.getenv().getOrDefault("JAVA_TCP_HOST", "127.0.0.1");
        int port = Integer.parseInt(System.getenv().getOrDefault("JAVA_TCP_PORT", "9090"));
        // The gateway must send this same secret to prove it is trusted.
        String sharedSecret = System.getenv("JAVA_TCP_SHARED_SECRET");
        // Stop startup if the secret is missing, too short, or a placeholder.
        if (sharedSecret == null || sharedSecret.length() < 32
                || sharedSecret.toLowerCase().contains("replace-this")) {
            throw new IllegalStateException(
                    "JAVA_TCP_SHARED_SECRET must be a unique value of at least 32 characters.");
        }

        // Convert the host to an IP address and create the TCP listener.
        TcpServer server = new TcpServer(InetAddress.getByName(host), port, sharedSecret);
        // Close sockets and worker threads when the JVM shuts down normally.
        Runtime.getRuntime().addShutdownHook(new Thread(server::close));
        // Start accepting connections in the background.
        server.start();
        System.out.printf("ExamFlow Java TCP server listening on %s:%d%n", host, server.port());
        // Wait here so the main thread stays alive while virtual threads do the work.
        new CountDownLatch(1).await();
    }
}
