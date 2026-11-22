package lk.examflow.socket;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

// Handle messages from the Node.js TCP gateway and manage sessions and quiz rooms.
// Website login happens elsewhere; this class checks the gateway's shared secret.
final class RoomBroker implements AutoCloseable {
    // Limit incoming line length and the number of saved replies.
    private static final int MAX_LINE_LENGTH = 65_536;
    private static final int MAX_DEDUPLICATION_ENTRIES = 2_000;
    // Read and write JSON, rejecting extra JSON values after the first one.
    private static final ObjectMapper JSON =
            new ObjectMapper().enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);

    private final byte[] sharedSecret;
    // Keep related session and room changes together when several threads are working.
    private final Object stateLock = new Object();
    // Find a connection by session ID, and store each room's member session IDs.
    private final Map<String, ClientConnection> sessions = new ConcurrentHashMap<>();
    private final Map<String, Set<String>> rooms = new ConcurrentHashMap<>();
    // Track every open connection, including those not yet registered as sessions.
    private final Set<ClientConnection> connections = ConcurrentHashMap.newKeySet();
    // Save recent command replies so a retry need not broadcast the event again.
    private final LinkedHashMap<String, String> responses = new LinkedHashMap<>();
    private volatile boolean closed;

    // Store the expected secret as UTF-8 bytes for comparison during authentication.
    RoomBroker(String sharedSecret) {
        this.sharedSecret = sharedSecret.getBytes(StandardCharsets.UTF_8);
    }

    // Read messages from one TCP connection until it closes or an I/O error occurs.
    void handle(Socket socket) {
        ClientConnection client = new ClientConnection(socket);
        connections.add(client);
        System.out.printf("TCP client connected: %s%n", socket.getRemoteSocketAddress());
        // The input stream receives bytes; the output stream sends bytes.
        // UTF-8 converts between bytes and text, and buffers group small reads and writes.
        // This try block automatically closes the socket and streams when it ends.
        try (socket;
             BufferedReader reader = new BufferedReader(
                     new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
             BufferedWriter writer = new BufferedWriter(
                     new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8))) {
            client.writer = writer;
            while (!closed) {
                String line;
                try {
                    // TCP is a byte stream, so a newline marks the end of each JSON message.
                    line = readBoundedLine(reader);
                } catch (MessageTooLargeException exception) {
                    // Send an error and stop reading this connection if the line is too long.
                    sendError(client, null, "MESSAGE_TOO_LARGE", "Message exceeds the maximum size.");
                    break;
                }
                // A null line means the peer has closed its sending side with no data left.
                if (line == null) break;
                processLine(client, line);
            }
        } catch (IOException exception) {
            // Read timeouts and broken connections end this handler.
            if (!closed) {
                System.err.printf("TCP client error (%s): %s%n",
                        socket.getRemoteSocketAddress(), exception.getMessage());
            }
        } finally {
            // Remove session and room records even when reading or processing fails.
            disconnect(client);
            connections.remove(client);
            System.out.printf("TCP client disconnected: %s%n", socket.getRemoteSocketAddress());
        }
    }

    // Read one line with a character limit, accepting both LF and CRLF line endings.
    private static String readBoundedLine(BufferedReader reader) throws IOException, MessageTooLargeException {
        StringBuilder line = new StringBuilder();
        int next;
        while ((next = reader.read()) != -1) {
            if (next == '\n') {
                if (!line.isEmpty() && line.charAt(line.length() - 1) == '\r') {
                    line.setLength(line.length() - 1);
                }
                return line.toString();
            }
            if (line.length() >= MAX_LINE_LENGTH) throw new MessageTooLargeException();
            line.append((char) next);
        }
        // If the stream ends, return any final text even without a newline.
        return line.isEmpty() ? null : line.toString();
    }

    // Parse one JSON message, check its fields, and send a reply to the same connection.
    private void processLine(ClientConnection client, String line) {
        JsonNode parsed;
        try {
            parsed = JSON.readTree(line);
        } catch (IOException exception) {
            sendError(client, null, "MALFORMED_JSON", "Message must be a valid JSON object.");
            return;
        }
        // Reject empty input, lists, and other values that are not JSON objects.
        if (parsed == null || !parsed.isObject()) {
            sendError(client, null, "INVALID_ENVELOPE", "Message must be a JSON object.");
            return;
        }
        String messageId = text(parsed, "messageId");
        String type = text(parsed, "type");
        JsonNode payload = parsed.get("payload");
        // Require protocol version 1, valid IDs, a timestamp, and an object payload.
        if (!parsed.path("version").isIntegralNumber() || parsed.path("version").asInt() != 1
                || !validIdentifier(messageId) || !validIdentifier(type)
                || !validTimestamp(parsed.get("timestamp")) || payload == null || !payload.isObject()) {
            sendError(client, validIdentifier(messageId) ? messageId : null,
                    "INVALID_ENVELOPE", "Required fields are version 1, messageId, type, timestamp and object payload.");
            return;
        }

        try {
            // Only notification commands are replayable across sockets. Authentication,
            // registration and room membership are connection-local state transitions.
            boolean replayable = Set.of("START_QUIZ", "END_QUIZ", "STUDENT_JOINED",
                    "ATTEMPT_SUBMITTED", "PARTICIPATION_UPDATED").contains(type);
            // Check permission before using a saved reply, so retries cannot skip security.
            if (replayable) authorizeBroadcast(client, type, (ObjectNode) payload);
            // Check and save replies under one lock so simultaneous retries run only once.
            synchronized (responses) {
                String previousResponse = replayable ? cachedResponse(messageId) : null;
                // A remembered message ID gets its old reply without sending another event.
                if (previousResponse != null) {
                    client.send(previousResponse);
                    return;
                }
                String response = processMessage(client, messageId, type, (ObjectNode) payload);
                if (response != null) {
                    if (replayable) cacheResponse(messageId, response);
                    client.send(response);
                }
            }
        } catch (ProtocolException exception) {
            // Tell the sender which protocol rule or permission check failed.
            String response = errorEnvelope(messageId, exception.code, exception.getMessage());
            System.err.printf("TCP protocol error: %s%n", exception.code);
            client.send(response);
        } catch (RuntimeException exception) {
            // Log unexpected failures and send a general error to the sender.
            System.err.printf("Failed to process TCP message %s (%s): %s%n",
                    messageId, type, exception.getMessage());
            String response = errorEnvelope(messageId, "INTERNAL_ERROR", "Message could not be processed.");
            client.send(response);
        }
    }

    // Only authenticated, registered sessions with an allowed role may publish events.
    private void authorizeBroadcast(ClientConnection client, String type, ObjectNode payload)
            throws ProtocolException {
        if (!client.authenticated) throw new ProtocolException("AUTH_REQUIRED", "Authenticate the gateway first.");
        requireSession(client);
        // A gateway may publish all supported events; a teacher may start or end a joined quiz.
        boolean lifecycle = "START_QUIZ".equals(type) || "END_QUIZ".equals(type);
        if (!"GATEWAY".equals(client.role) && !(lifecycle && "TEACHER".equals(client.role))) {
            throw new ProtocolException("FORBIDDEN", "This session cannot publish server events.");
        }
        if (!"GATEWAY".equals(client.role)) requireRoomMembership(client, requiredText(payload, "quizId"));
    }

    // Authenticate the connection first, then choose the action for the message type.
    private String processMessage(ClientConnection client, String messageId, String type, ObjectNode payload)
            throws ProtocolException {
        // This checks the trusted TCP gateway, not a student's website login.
        if (!client.authenticated) {
            if (!"AUTH".equals(type)) {
                throw new ProtocolException("AUTH_REQUIRED", "Authenticate the gateway before sending commands.");
            }
            // Require the shared secret and compare its bytes using a timing-safe helper.
            JsonNode supplied = payload.get("sharedSecret");
            if (supplied == null || !supplied.isTextual()
                    || !MessageDigest.isEqual(sharedSecret, supplied.asText().getBytes(StandardCharsets.UTF_8))) {
                throw new ProtocolException("AUTH_FAILED", "Gateway authentication failed.");
            }
            client.authenticated = true;
            return ack(messageId, "AUTHENTICATED");
        }

        // Route supported commands to their handlers; unknown types become ERROR replies.
        return switch (type) {
            case "AUTH" -> throw new ProtocolException("ALREADY_AUTHENTICATED", "Gateway is already authenticated.");
            // PING/PONG lets the authenticated gateway check that the server responds.
            case "PING" -> pong(messageId);
            case "REGISTER_SESSION" -> registerSession(client, messageId, payload);
            case "JOIN_ROOM" -> joinRoom(client, messageId, payload);
            case "LEAVE_ROOM" -> leaveRoom(client, messageId, payload);
            case "START_QUIZ" -> broadcastLifecycle(client, messageId, payload, "QUIZ_STARTED");
            case "END_QUIZ" -> broadcastLifecycle(client, messageId, payload, "QUIZ_ENDED");
            case "STUDENT_JOINED", "PARTICIPATION_UPDATED", "ATTEMPT_SUBMITTED" ->
                    broadcastGatewayEvent(client, messageId, type, payload);
            default -> throw new ProtocolException("UNKNOWN_MESSAGE_TYPE", "Unsupported message type.");
        };
    }

    // Attach a session ID and role supplied by the trusted gateway to this TCP connection.
    private String registerSession(ClientConnection client, String messageId, ObjectNode payload)
            throws ProtocolException {
        String sessionId = requiredText(payload, "sessionId");
        String role = requiredText(payload, "role");
        if (!validIdentifier(sessionId) || !Set.of("STUDENT", "TEACHER", "GATEWAY").contains(role)) {
            throw new ProtocolException("INVALID_SESSION", "Session ID or role is invalid.");
        }
        synchronized (stateLock) {
            // Reject IDs used by another connection and changes to this session's ID or role.
            ClientConnection existing = sessions.get(sessionId);
            if (existing != null && existing != client) {
                throw new ProtocolException("SESSION_IN_USE", "Session ID is already connected.");
            }
            if (client.sessionId != null && !client.sessionId.equals(sessionId)) {
                throw new ProtocolException("SESSION_ALREADY_REGISTERED", "Connection already has a registered session.");
            }
            if (client.sessionId != null && !role.equals(client.role)) {
                throw new ProtocolException("SESSION_ROLE_IMMUTABLE", "A registered session role cannot be changed.");
            }
            // Save the ID and role so room operations can find and check this connection.
            client.sessionId = sessionId;
            client.role = role;
            sessions.put(sessionId, client);
        }
        System.out.printf("TCP session registered: %s role=%s active=%d%n", sessionId, role, sessions.size());
        return ack(messageId, "SESSION_REGISTERED");
    }

    // Add a registered session to a quiz room, creating the room when needed.
    private String joinRoom(ClientConnection client, String messageId, ObjectNode payload)
            throws ProtocolException {
        String quizId = requiredText(payload, "quizId");
        if (!validIdentifier(quizId)) {
            throw new ProtocolException("INVALID_QUIZ_ID", "Quiz ID is invalid.");
        }
        requireSession(client);
        boolean joined;
        synchronized (stateLock) {
            if (sessions.get(client.sessionId) != client) {
                throw new ProtocolException("SESSION_REQUIRED", "Register a session before using quiz rooms.");
            }
            // A set keeps each session ID only once, even if it joins the same room again.
            joined = rooms.computeIfAbsent(quizId, ignored -> ConcurrentHashMap.newKeySet())
                    .add(client.sessionId);
        }
        System.out.printf("TCP room join: session=%s room=%s%n", client.sessionId, quizId);
        return ack(messageId, joined ? "ROOM_JOINED" : "ALREADY_IN_ROOM");
    }

    // Remove the session from this room and delete the room if no members remain.
    private String leaveRoom(ClientConnection client, String messageId, ObjectNode payload)
            throws ProtocolException {
        String quizId = requiredText(payload, "quizId");
        requireSession(client);
        if (!validIdentifier(quizId)) {
            throw new ProtocolException("INVALID_QUIZ_ID", "Quiz ID is invalid.");
        }
        synchronized (stateLock) {
            Set<String> members = rooms.get(quizId);
            if (members != null) {
                members.remove(client.sessionId);
                if (members.isEmpty()) rooms.remove(quizId);
            }
        }
        return ack(messageId, "ROOM_LEFT");
    }

    // Turn START_QUIZ or END_QUIZ into a QUIZ_STARTED or QUIZ_ENDED notification.
    // This sends an event; it does not update the quiz database here.
    private String broadcastLifecycle(ClientConnection client, String messageId, ObjectNode payload,
                                      String eventType) throws ProtocolException {
        requireSession(client);
        // Allow teacher and gateway roles; students cannot start or end quizzes here.
        if (!Set.of("TEACHER", "GATEWAY").contains(client.role)) {
            throw new ProtocolException("FORBIDDEN", "Only a teacher session may start or end a quiz.");
        }
        String quizId = requiredText(payload, "quizId");
        if (!validIdentifier(quizId)) {
            throw new ProtocolException("INVALID_QUIZ_ID", "Quiz ID is invalid.");
        }
        if (!"GATEWAY".equals(client.role)) requireRoomMembership(client, quizId);
        // Build the event with the quiz ID and the sender's registered session ID.
        ObjectNode eventPayload = JSON.createObjectNode();
        eventPayload.put("quizId", quizId);
        eventPayload.put("sessionId", client.sessionId);
        // Notify both the quiz room and the lobby, excluding the sender.
        broadcast(Set.of(LOBBY_ROOM, quizId), eventType, eventPayload, client.sessionId);
        return ack(messageId, eventType);
    }

    // Forward participation and submission events published by a registered gateway.
    private String broadcastGatewayEvent(ClientConnection client, String messageId, String eventType,
                                         ObjectNode payload) throws ProtocolException {
        requireSession(client);
        // These event types require the gateway role, even on an authenticated connection.
        if (!"GATEWAY".equals(client.role)) {
            throw new ProtocolException("FORBIDDEN", "Only the trusted gateway may publish server events.");
        }
        String quizId = requiredText(payload, "quizId");
        if (!validIdentifier(quizId)) {
            throw new ProtocolException("INVALID_QUIZ_ID", "Quiz ID is invalid.");
        }
        // Keep the event details and set the sender ID from the registered connection.
        ObjectNode eventPayload = payload.deepCopy();
        eventPayload.put("quizId", quizId);
        eventPayload.put("sessionId", client.sessionId);
        broadcast(Set.of(LOBBY_ROOM, quizId), eventType, eventPayload, client.sessionId);
        return ack(messageId, eventType);
    }

    // The lobby is a named room joined and left like a quiz room; joining is not automatic.
    // Its members receive events from the quiz and gateway broadcast methods above.
    private static final String LOBBY_ROOM = "__examflow_lobby__";

    // Use the same broadcast logic when only one room is requested.
    private void broadcast(String quizId, String eventType, ObjectNode payload, String excludedSessionId) {
        broadcast(Set.of(quizId), eventType, payload, excludedSessionId);
    }

    // Find connected members of the selected rooms and send each one the event.
    private void broadcast(Set<String> roomIds, String eventType, ObjectNode payload, String excludedSessionId) {
        ArrayList<ClientConnection> recipients = new ArrayList<>();
        synchronized (stateLock) {
            // A member in both the lobby and quiz room must receive the event only once.
            Set<ClientConnection> uniqueRecipients = ConcurrentHashMap.newKeySet();
            for (String roomId : roomIds) {
                Set<String> members = rooms.get(roomId);
                if (members == null) continue;
                for (String sessionId : members) {
                    // Skip the sender, then look up the member's current TCP connection.
                    if (sessionId.equals(excludedSessionId)) continue;
                    ClientConnection recipient = sessions.get(sessionId);
                    if (recipient != null) uniqueRecipients.add(recipient);
                }
            }
            recipients.addAll(uniqueRecipients);
        }
        // Build one JSON event with a new ID and send it after releasing the room lock.
        String event = envelope(UUID.randomUUID().toString(), eventType, payload);
        System.out.printf("Broadcasting Java TCP event %s to %d session(s).%n", eventType, recipients.size());
        for (ClientConnection recipient : recipients) recipient.send(event);
    }

    // Authentication alone is not enough for rooms; a session must also be registered.
    private void requireSession(ClientConnection client) throws ProtocolException {
        if (client.sessionId == null) {
            throw new ProtocolException("SESSION_REQUIRED", "Register a session before using quiz rooms.");
        }
    }

    // Check that this connection still owns a session that belongs to the quiz room.
    private void requireRoomMembership(ClientConnection client, String quizId) throws ProtocolException {
        synchronized (stateLock) {
            Set<String> members = rooms.get(quizId);
            if (members == null || !members.contains(client.sessionId)
                    || sessions.get(client.sessionId) != client) {
                throw new ProtocolException("ROOM_MEMBERSHIP_REQUIRED",
                        "Register and join the quiz room before publishing this message.");
            }
        }
    }

    // Remove the disconnected session from all rooms and discard empty rooms.
    private void disconnect(ClientConnection client) {
        synchronized (stateLock) {
            if (client.sessionId == null) return;
            sessions.remove(client.sessionId, client);
            for (Set<String> members : rooms.values()) members.remove(client.sessionId);
            rooms.entrySet().removeIf(entry -> entry.getValue().isEmpty());
            client.sessionId = null;
        }
    }

    // Read a text field without converting numbers or other JSON values into text.
    private static String text(JsonNode node, String field) {
        JsonNode value = node.get(field);
        return value != null && value.isTextual() ? value.asText() : null;
    }

    // Look up a reply for a recently processed notification command.
    private synchronized String cachedResponse(String messageId) {
        return responses.get(messageId);
    }

    // Keep at most 2,000 replies, removing the oldest when full.
    // Duplicate protection lasts only while the reply is remembered in this server process.
    private synchronized void cacheResponse(String messageId, String response) {
        responses.put(messageId, response);
        if (responses.size() > MAX_DEDUPLICATION_ENTRIES) {
            responses.remove(responses.keySet().iterator().next());
        }
    }

    // Reject missing, non-text, or blank values for required payload fields.
    private static String requiredText(ObjectNode payload, String field) throws ProtocolException {
        String value = text(payload, field);
        if (value == null || value.isBlank()) {
            throw new ProtocolException("INVALID_PAYLOAD", field + " is required.");
        }
        return value;
    }

    // Accept short IDs containing only letters, digits, dots, underscores, colons, or hyphens.
    private static boolean validIdentifier(String value) {
        return value != null && value.matches("[A-Za-z0-9._:-]{1,128}");
    }

    // Check that the timestamp is text that Java can read as an Instant.
    private static boolean validTimestamp(JsonNode timestamp) {
        if (timestamp == null || !timestamp.isTextual()) return false;
        try {
            Instant.parse(timestamp.asText());
            return true;
        } catch (DateTimeParseException exception) {
            return false;
        }
    }

    // ACK confirms a command was handled and identifies the original message.
    private static String ack(String messageId, String status) {
        ObjectNode payload = JSON.createObjectNode();
        payload.put("ackMessageId", messageId);
        payload.put("status", status);
        return envelope(UUID.randomUUID().toString(), "ACK", payload);
    }

    // Reply to PING with PONG and the original message ID.
    private static String pong(String messageId) {
        ObjectNode payload = JSON.createObjectNode();
        payload.put("ackMessageId", messageId);
        return envelope(UUID.randomUUID().toString(), "PONG", payload);
    }

    // Build an ERROR reply with a reason and the original message ID when known.
    private static String errorEnvelope(String messageId, String code, String message) {
        ObjectNode payload = JSON.createObjectNode();
        if (messageId != null) payload.put("ackMessageId", messageId);
        payload.put("code", code);
        payload.put("message", message);
        return envelope(UUID.randomUUID().toString(), "ERROR", payload);
    }

    // Send the error back through the same TCP connection.
    private static void sendError(ClientConnection client, String messageId, String code, String message) {
        client.send(errorEnvelope(messageId, code, message));
    }

    // Wrap a payload in the common message fields and convert it to JSON text.
    private static String envelope(String messageId, String type, ObjectNode payload) {
        ObjectNode response = JSON.createObjectNode();
        response.put("version", 1);
        response.put("messageId", messageId);
        response.put("type", type);
        response.put("timestamp", Instant.now().toString());
        response.set("payload", payload);
        try {
            return JSON.writeValueAsString(response);
        } catch (IOException exception) {
            throw new IllegalStateException("Could not encode protocol response.", exception);
        }
    }

    // Close all tracked sockets and clear the session and room records on shutdown.
    @Override
    public void close() {
        closed = true;
        for (ClientConnection client : connections) client.close();
        connections.clear();
        sessions.clear();
        rooms.clear();
    }

    // Hold one TCP socket, its outgoing writer, and its authentication and session details.
    private static final class ClientConnection {
        private final Socket socket;
        private volatile BufferedWriter writer;
        private volatile boolean authenticated;
        private volatile String sessionId;
        private volatile String role;

        private ClientConnection(Socket socket) {
            this.socket = socket;
        }

        // Lock each send so replies and events cannot mix their text on the same socket.
        private synchronized void send(String message) {
            if (writer == null || socket.isClosed()) return;
            try {
                // Write one JSON message, add its newline, and flush buffered text to TCP.
                writer.write(message);
                writer.newLine();
                writer.flush();
            } catch (IOException exception) {
                // Close a failed connection; its reading handler will clean up the session.
                close();
            }
        }

        // Closing the socket also stops pending reads in the connection's handler.
        private void close() {
            try {
                socket.close();
            } catch (IOException ignored) {
                // Closing a disconnected client is best-effort cleanup.
            }
        }
    }

    // Carry a protocol error code and message back to the reply handler.
    private static final class ProtocolException extends Exception {
        private final String code;

        private ProtocolException(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    // Signal that an incoming line exceeded the allowed character count.
    private static final class MessageTooLargeException extends Exception {
    }
}
