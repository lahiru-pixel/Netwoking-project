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

final class RoomBroker implements AutoCloseable {
    private static final int MAX_LINE_LENGTH = 65_536;
    private static final int MAX_DEDUPLICATION_ENTRIES = 2_000;
    private static final ObjectMapper JSON =
            new ObjectMapper().enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS);

    private final byte[] sharedSecret;
    private final Object stateLock = new Object();
    private final Map<String, ClientConnection> sessions = new ConcurrentHashMap<>();
    private final Map<String, Set<String>> rooms = new ConcurrentHashMap<>();
    private final Set<ClientConnection> connections = ConcurrentHashMap.newKeySet();
    private final LinkedHashMap<String, String> responses = new LinkedHashMap<>();
    private volatile boolean closed;

    RoomBroker(String sharedSecret) {
        this.sharedSecret = sharedSecret.getBytes(StandardCharsets.UTF_8);
    }

    void handle(Socket socket) {
        ClientConnection client = new ClientConnection(socket);
        connections.add(client);
        System.out.printf("TCP client connected: %s%n", socket.getRemoteSocketAddress());
        try (socket;
             BufferedReader reader = new BufferedReader(
                     new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
             BufferedWriter writer = new BufferedWriter(
                     new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8))) {
            client.writer = writer;
            while (!closed) {
                String line;
                try {
                    line = readBoundedLine(reader);
                } catch (MessageTooLargeException exception) {
                    sendError(client, null, "MESSAGE_TOO_LARGE", "Message exceeds the maximum size.");
                    break;
                }
                if (line == null) break;
                processLine(client, line);
            }
        } catch (IOException exception) {
            if (!closed) {
                System.err.printf("TCP client error (%s): %s%n",
                        socket.getRemoteSocketAddress(), exception.getMessage());
            }
        } finally {
            disconnect(client);
            connections.remove(client);
            System.out.printf("TCP client disconnected: %s%n", socket.getRemoteSocketAddress());
        }
    }

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
        return line.isEmpty() ? null : line.toString();
    }

    private void processLine(ClientConnection client, String line) {
        JsonNode parsed;
        try {
            parsed = JSON.readTree(line);
        } catch (IOException exception) {
            sendError(client, null, "MALFORMED_JSON", "Message must be a valid JSON object.");
            return;
        }
        if (parsed == null || !parsed.isObject()) {
            sendError(client, null, "INVALID_ENVELOPE", "Message must be a JSON object.");
            return;
        }
        String messageId = text(parsed, "messageId");
        String type = text(parsed, "type");
        JsonNode payload = parsed.get("payload");
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
            if (replayable) authorizeBroadcast(client, type, (ObjectNode) payload);
            synchronized (responses) {
                String previousResponse = replayable ? cachedResponse(messageId) : null;
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
            String response = errorEnvelope(messageId, exception.code, exception.getMessage());
            System.err.printf("TCP protocol error: %s%n", exception.code);
            client.send(response);
        } catch (RuntimeException exception) {
            System.err.printf("Failed to process TCP message %s (%s): %s%n",
                    messageId, type, exception.getMessage());
            String response = errorEnvelope(messageId, "INTERNAL_ERROR", "Message could not be processed.");
            client.send(response);
        }
    }

    private void authorizeBroadcast(ClientConnection client, String type, ObjectNode payload)
            throws ProtocolException {
        if (!client.authenticated) throw new ProtocolException("AUTH_REQUIRED", "Authenticate the gateway first.");
        requireSession(client);
        boolean lifecycle = "START_QUIZ".equals(type) || "END_QUIZ".equals(type);
        if (!"GATEWAY".equals(client.role) && !(lifecycle && "TEACHER".equals(client.role))) {
            throw new ProtocolException("FORBIDDEN", "This session cannot publish server events.");
        }
        if (!"GATEWAY".equals(client.role)) requireRoomMembership(client, requiredText(payload, "quizId"));
    }

    private String processMessage(ClientConnection client, String messageId, String type, ObjectNode payload)
            throws ProtocolException {
        if (!client.authenticated) {
            if (!"AUTH".equals(type)) {
                throw new ProtocolException("AUTH_REQUIRED", "Authenticate the gateway before sending commands.");
            }
            JsonNode supplied = payload.get("sharedSecret");
            if (supplied == null || !supplied.isTextual()
                    || !MessageDigest.isEqual(sharedSecret, supplied.asText().getBytes(StandardCharsets.UTF_8))) {
                throw new ProtocolException("AUTH_FAILED", "Gateway authentication failed.");
            }
            client.authenticated = true;
            return ack(messageId, "AUTHENTICATED");
        }

        return switch (type) {
            case "AUTH" -> throw new ProtocolException("ALREADY_AUTHENTICATED", "Gateway is already authenticated.");
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

    private String registerSession(ClientConnection client, String messageId, ObjectNode payload)
            throws ProtocolException {
        String sessionId = requiredText(payload, "sessionId");
        String role = requiredText(payload, "role");
        if (!validIdentifier(sessionId) || !Set.of("STUDENT", "TEACHER", "GATEWAY").contains(role)) {
            throw new ProtocolException("INVALID_SESSION", "Session ID or role is invalid.");
        }
        synchronized (stateLock) {
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
            client.sessionId = sessionId;
            client.role = role;
            sessions.put(sessionId, client);
        }
        System.out.printf("TCP session registered: %s role=%s active=%d%n", sessionId, role, sessions.size());
        return ack(messageId, "SESSION_REGISTERED");
    }

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
            joined = rooms.computeIfAbsent(quizId, ignored -> ConcurrentHashMap.newKeySet())
                    .add(client.sessionId);
        }
        System.out.printf("TCP room join: session=%s room=%s%n", client.sessionId, quizId);
        return ack(messageId, joined ? "ROOM_JOINED" : "ALREADY_IN_ROOM");
    }

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

    private String broadcastLifecycle(ClientConnection client, String messageId, ObjectNode payload,
                                      String eventType) throws ProtocolException {
        requireSession(client);
        if (!Set.of("TEACHER", "GATEWAY").contains(client.role)) {
            throw new ProtocolException("FORBIDDEN", "Only a teacher session may start or end a quiz.");
        }
        String quizId = requiredText(payload, "quizId");
        if (!validIdentifier(quizId)) {
            throw new ProtocolException("INVALID_QUIZ_ID", "Quiz ID is invalid.");
        }
        if (!"GATEWAY".equals(client.role)) requireRoomMembership(client, quizId);
        ObjectNode eventPayload = JSON.createObjectNode();
        eventPayload.put("quizId", quizId);
        eventPayload.put("sessionId", client.sessionId);
        broadcast(Set.of(LOBBY_ROOM, quizId), eventType, eventPayload, client.sessionId);
        return ack(messageId, eventType);
    }

    private String broadcastGatewayEvent(ClientConnection client, String messageId, String eventType,
                                         ObjectNode payload) throws ProtocolException {
        requireSession(client);
        if (!"GATEWAY".equals(client.role)) {
            throw new ProtocolException("FORBIDDEN", "Only the trusted gateway may publish server events.");
        }
        String quizId = requiredText(payload, "quizId");
        if (!validIdentifier(quizId)) {
            throw new ProtocolException("INVALID_QUIZ_ID", "Quiz ID is invalid.");
        }
        ObjectNode eventPayload = payload.deepCopy();
        eventPayload.put("quizId", quizId);
        eventPayload.put("sessionId", client.sessionId);
        broadcast(Set.of(LOBBY_ROOM, quizId), eventType, eventPayload, client.sessionId);
        return ack(messageId, eventType);
    }

    private static final String LOBBY_ROOM = "__examflow_lobby__";

    private void broadcast(String quizId, String eventType, ObjectNode payload, String excludedSessionId) {
        broadcast(Set.of(quizId), eventType, payload, excludedSessionId);
    }

    private void broadcast(Set<String> roomIds, String eventType, ObjectNode payload, String excludedSessionId) {
        ArrayList<ClientConnection> recipients = new ArrayList<>();
        synchronized (stateLock) {
            Set<ClientConnection> uniqueRecipients = ConcurrentHashMap.newKeySet();
            for (String roomId : roomIds) {
                Set<String> members = rooms.get(roomId);
                if (members == null) continue;
                for (String sessionId : members) {
                    if (sessionId.equals(excludedSessionId)) continue;
                    ClientConnection recipient = sessions.get(sessionId);
                    if (recipient != null) uniqueRecipients.add(recipient);
                }
            }
            recipients.addAll(uniqueRecipients);
        }
        String event = envelope(UUID.randomUUID().toString(), eventType, payload);
        System.out.printf("Broadcasting Java TCP event %s to %d session(s).%n", eventType, recipients.size());
        for (ClientConnection recipient : recipients) recipient.send(event);
    }

    private void requireSession(ClientConnection client) throws ProtocolException {
        if (client.sessionId == null) {
            throw new ProtocolException("SESSION_REQUIRED", "Register a session before using quiz rooms.");
        }
    }

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

    private void disconnect(ClientConnection client) {
        synchronized (stateLock) {
            if (client.sessionId == null) return;
            sessions.remove(client.sessionId, client);
            for (Set<String> members : rooms.values()) members.remove(client.sessionId);
            rooms.entrySet().removeIf(entry -> entry.getValue().isEmpty());
            client.sessionId = null;
        }
    }

    private static String text(JsonNode node, String field) {
        JsonNode value = node.get(field);
        return value != null && value.isTextual() ? value.asText() : null;
    }

    private synchronized String cachedResponse(String messageId) {
        return responses.get(messageId);
    }

    private synchronized void cacheResponse(String messageId, String response) {
        responses.put(messageId, response);
        if (responses.size() > MAX_DEDUPLICATION_ENTRIES) {
            responses.remove(responses.keySet().iterator().next());
        }
    }

    private static String requiredText(ObjectNode payload, String field) throws ProtocolException {
        String value = text(payload, field);
        if (value == null || value.isBlank()) {
            throw new ProtocolException("INVALID_PAYLOAD", field + " is required.");
        }
        return value;
    }

    private static boolean validIdentifier(String value) {
        return value != null && value.matches("[A-Za-z0-9._:-]{1,128}");
    }

    private static boolean validTimestamp(JsonNode timestamp) {
        if (timestamp == null || !timestamp.isTextual()) return false;
        try {
            Instant.parse(timestamp.asText());
            return true;
        } catch (DateTimeParseException exception) {
            return false;
        }
    }

    private static String ack(String messageId, String status) {
        ObjectNode payload = JSON.createObjectNode();
        payload.put("ackMessageId", messageId);
        payload.put("status", status);
        return envelope(UUID.randomUUID().toString(), "ACK", payload);
    }

    private static String pong(String messageId) {
        ObjectNode payload = JSON.createObjectNode();
        payload.put("ackMessageId", messageId);
        return envelope(UUID.randomUUID().toString(), "PONG", payload);
    }

    private static String errorEnvelope(String messageId, String code, String message) {
        ObjectNode payload = JSON.createObjectNode();
        if (messageId != null) payload.put("ackMessageId", messageId);
        payload.put("code", code);
        payload.put("message", message);
        return envelope(UUID.randomUUID().toString(), "ERROR", payload);
    }

    private static void sendError(ClientConnection client, String messageId, String code, String message) {
        client.send(errorEnvelope(messageId, code, message));
    }

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

    @Override
    public void close() {
        closed = true;
        for (ClientConnection client : connections) client.close();
        connections.clear();
        sessions.clear();
        rooms.clear();
    }

    private static final class ClientConnection {
        private final Socket socket;
        private volatile BufferedWriter writer;
        private volatile boolean authenticated;
        private volatile String sessionId;
        private volatile String role;

        private ClientConnection(Socket socket) {
            this.socket = socket;
        }

        private synchronized void send(String message) {
            if (writer == null || socket.isClosed()) return;
            try {
                writer.write(message);
                writer.newLine();
                writer.flush();
            } catch (IOException exception) {
                close();
            }
        }

        private void close() {
            try {
                socket.close();
            } catch (IOException ignored) {
                // Closing a disconnected client is best-effort cleanup.
            }
        }
    }

    private static final class ProtocolException extends Exception {
        private final String code;

        private ProtocolException(String code, String message) {
            super(message);
            this.code = code;
        }
    }

    private static final class MessageTooLargeException extends Exception {
    }
}
