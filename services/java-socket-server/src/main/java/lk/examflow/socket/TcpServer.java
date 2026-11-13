package lk.examflow.socket;

import java.io.IOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

public final class TcpServer implements AutoCloseable {
    private final ServerSocket listener;
    private final ExecutorService clients = Executors.newVirtualThreadPerTaskExecutor();
    private final AtomicBoolean started = new AtomicBoolean();
    private final RoomBroker broker;

    public TcpServer(InetAddress bindAddress, int port, String sharedSecret) throws IOException {
        if (!bindAddress.isLoopbackAddress()) {
            throw new IllegalArgumentException("Java TCP server must bind to a loopback address.");
        }
        if (sharedSecret == null || sharedSecret.length() < 32) {
            throw new IllegalArgumentException("The gateway shared secret must be at least 32 characters.");
        }
        listener = new ServerSocket(port, 50, bindAddress);
        broker = new RoomBroker(sharedSecret);
    }

    public void start() {
        if (!started.compareAndSet(false, true)) {
            throw new IllegalStateException("TCP server has already been started.");
        }
        clients.submit(this::acceptClients);
    }

    public int port() {
        return listener.getLocalPort();
    }

    private void acceptClients() {
        while (!listener.isClosed()) {
            try {
                Socket socket = listener.accept();
                socket.setKeepAlive(true);
                socket.setSoTimeout(90_000);
                clients.submit(() -> broker.handle(socket));
            } catch (IOException exception) {
                if (!listener.isClosed()) {
                    System.err.println("TCP accept failed: " + exception.getMessage());
                }
            }
        }
    }

    @Override
    public void close() {
        try {
            listener.close();
        } catch (IOException exception) {
            System.err.println("Error closing Java TCP listener: " + exception.getMessage());
        }
        broker.close();
        clients.shutdownNow();
    }
}
