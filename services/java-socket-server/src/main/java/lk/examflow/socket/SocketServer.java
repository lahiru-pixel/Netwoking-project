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
        String sharedSecret = System.getenv("JAVA_TCP_SHARED_SECRET");
        if (sharedSecret == null || sharedSecret.length() < 32
                || sharedSecret.toLowerCase().contains("replace-this")) {
            throw new IllegalStateException(
                    "JAVA_TCP_SHARED_SECRET must be a unique value of at least 32 characters.");
        }

        TcpServer server = new TcpServer(InetAddress.getByName(host), port, sharedSecret);
        Runtime.getRuntime().addShutdownHook(new Thread(server::close));
        server.start();
        System.out.printf("ExamFlow Java TCP server listening on %s:%d%n", host, server.port());
        new CountDownLatch(1).await();
    }
}
