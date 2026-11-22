package lk.examflow.socket;

import java.io.IOException;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

// Accept TCP connections from the Node.js gateway and let RoomBroker handle messages.
public final class TcpServer implements AutoCloseable {
    // A ServerSocket listens for connections; each client uses its own Socket.
    private final ServerSocket listener;
    // Virtual threads are lightweight, so many connections can wait for data at once.
    private final ExecutorService clients = Executors.newVirtualThreadPerTaskExecutor();
    private final AtomicBoolean started = new AtomicBoolean();
    private final RoomBroker broker;

    // Check the settings and open the listening socket.
    public TcpServer(InetAddress bindAddress, int port, String sharedSecret) throws IOException {
        // Only allow connections through this computer's loopback address.
        if (!bindAddress.isLoopbackAddress()) {
            throw new IllegalArgumentException("Java TCP server must bind to a loopback address.");
        }
        // Require a secret that the broker can use to check the gateway.
        if (sharedSecret == null || sharedSecret.length() < 32) {
            throw new IllegalArgumentException("The gateway shared secret must be at least 32 characters.");
        }
        // Listen on this address and port. The backlog of 50 requests a queue for
        // pending connections; it is not the maximum number of connected students.
        listener = new ServerSocket(port, 50, bindAddress);
        // All connections share this broker's session and room records.
        broker = new RoomBroker(sharedSecret);
    }

    // Start the connection loop once, even if different threads call this method.
    public void start() {
        if (!started.compareAndSet(false, true)) {
            throw new IllegalStateException("TCP server has already been started.");
        }
        clients.submit(this::acceptClients);
    }

    // Return the actual listening port, including a port chosen when zero was passed.
    public int port() {
        return listener.getLocalPort();
    }

    // Keep accepting new connections until the listener is closed.
    private void acceptClients() {
        while (!listener.isClosed()) {
            try {
                // Wait for a connection and get a Socket for talking to that client.
                Socket socket = listener.accept();
                // Ask the operating system to check whether an idle connection is alive.
                socket.setKeepAlive(true);
                // A read that waits 90 seconds for data fails and triggers broker cleanup.
                socket.setSoTimeout(90_000);
                // Handle this socket in its own virtual thread so other clients can run too.
                clients.submit(() -> broker.handle(socket));
            } catch (IOException exception) {
                // Report connection errors, but not the expected error during shutdown.
                if (!listener.isClosed()) {
                    System.err.println("TCP accept failed: " + exception.getMessage());
                }
            }
        }
    }

    // Stop accepting connections, close client sockets, and stop the worker tasks.
    @Override
    public void close() {
        try {
            // Closing the listener also wakes a thread waiting in accept().
            listener.close();
        } catch (IOException exception) {
            System.err.println("Error closing Java TCP listener: " + exception.getMessage());
        }
        broker.close();
        clients.shutdownNow();
    }
}
