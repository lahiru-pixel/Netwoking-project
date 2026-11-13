package lk.examflow.socket;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class TcpServerIntegrationTest {
    private static final String SECRET = "integration-test-gateway-secret-32-bytes";
    private static final ObjectMapper JSON = new ObjectMapper();
    private TcpServer server;

    @AfterEach
    void stopServer() {
        if (server != null) server.close();
    }

    @Test
    void authenticatesThreeConcurrentClientsAndBroadcastsQuizEvents() throws Exception {
        server = new TcpServer(InetAddress.getByName("127.0.0.1"), 0, SECRET);
        server.start();
        try (TcpClient teacher = connect("teacher-session", "TEACHER");
             TcpClient studentOne = connect("student-one", "STUDENT");
             TcpClient studentTwo = connect("student-two", "STUDENT");
             TcpClient gateway = connectGateway("node-control")) {
            teacher.send("JOIN_ROOM", payload("quizId", "quiz-123"));
            assertAck(teacher.read(), "ROOM_JOINED");

            studentOne.send("JOIN_ROOM", payload("quizId", "quiz-123"));
            assertAck(studentOne.read(), "ROOM_JOINED");

            studentTwo.send("JOIN_ROOM", payload("quizId", "quiz-123"));
            assertAck(studentTwo.read(), "ROOM_JOINED");

            teacher.send("START_QUIZ", payload("quizId", "quiz-123"));
            assertAck(teacher.read(), "QUIZ_STARTED");
            assertEvent(studentOne.read(), "QUIZ_STARTED", "quiz-123");
            assertEvent(studentTwo.read(), "QUIZ_STARTED", "quiz-123");

            teacher.send("END_QUIZ", payload("quizId", "quiz-123"));
            assertAck(teacher.read(), "QUIZ_ENDED");
            assertEvent(studentOne.read(), "QUIZ_ENDED", "quiz-123");
            assertEvent(studentTwo.read(), "QUIZ_ENDED", "quiz-123");

            gateway.send("STUDENT_JOINED", payload("quizId", "quiz-123", "studentId", "student-two"));
            assertAck(gateway.read(), "STUDENT_JOINED");
            assertEquals("STUDENT_JOINED", studentOne.read().path("type").asText());
            assertEquals("STUDENT_JOINED", studentTwo.read().path("type").asText());
            assertEquals("STUDENT_JOINED", teacher.read().path("type").asText());

            gateway.send("PARTICIPATION_UPDATED", payload("quizId", "quiz-123", "count", 2));
            assertAck(gateway.read(), "PARTICIPATION_UPDATED");
            assertEquals("PARTICIPATION_UPDATED", studentOne.read().path("type").asText());
            assertEquals("PARTICIPATION_UPDATED", teacher.read().path("type").asText());
            assertEquals("PARTICIPATION_UPDATED", studentTwo.read().path("type").asText());

            gateway.send("ATTEMPT_SUBMITTED", payload("quizId", "quiz-123", "attemptId", "attempt-9"));
            assertAck(gateway.read(), "ATTEMPT_SUBMITTED");
            assertEquals("ATTEMPT_SUBMITTED", studentTwo.read().path("type").asText());
            assertEquals("ATTEMPT_SUBMITTED", teacher.read().path("type").asText());
            assertEquals("ATTEMPT_SUBMITTED", studentOne.read().path("type").asText());
        }
    }

    @Test
    void rejectsBadSecretAndMalformedMessagesAndRespondsToHeartbeat() throws Exception {
        server = new TcpServer(InetAddress.getByName("127.0.0.1"), 0, SECRET);
        server.start();
        try (TcpClient invalid = new TcpClient(server.port())) {
            invalid.send("AUTH", payload("sharedSecret", "incorrect-shared-secret-value-32"));
            JsonNode error = invalid.read();
            assertEquals("ERROR", error.path("type").asText());
            assertEquals("AUTH_FAILED", error.path("payload").path("code").asText());
        }

        try (TcpClient client = new TcpClient(server.port())) {
            client.send("AUTH", payload("sharedSecret", SECRET));
            assertAck(client.read(), "AUTHENTICATED");

            client.writeRaw("{bad json}");
            JsonNode malformed = client.read();
            assertEquals("ERROR", malformed.path("type").asText());
            assertEquals("MALFORMED_JSON", malformed.path("payload").path("code").asText());

            ObjectNode unsupported = JSON.createObjectNode();
            unsupported.put("version", 2);
            unsupported.put("messageId", UUID.randomUUID().toString());
            unsupported.put("type", "PING");
            unsupported.put("timestamp", Instant.now().toString());
            unsupported.set("payload", JSON.createObjectNode());
            client.writeRaw(JSON.writeValueAsString(unsupported));
            JsonNode unsupportedVersion = client.read();
            assertEquals("ERROR", unsupportedVersion.path("type").asText());
            assertEquals("INVALID_ENVELOPE", unsupportedVersion.path("payload").path("code").asText());

            client.send("PING", JSON.createObjectNode());
            JsonNode pong = client.read();
            assertEquals("PONG", pong.path("type").asText());
            assertEquals(1, pong.path("version").asInt());
        }
    }

    @Test
    void enforcesSessionRolesAndDeduplicatesCommands() throws Exception {
        server = new TcpServer(InetAddress.getByName("127.0.0.1"), 0, SECRET);
        server.start();
        try (TcpClient student = connect("student-role", "STUDENT");
             TcpClient observer = connect("teacher-observer", "TEACHER")) {
            student.send("JOIN_ROOM", payload("quizId", "quiz-role"));
            assertAck(student.read(), "ROOM_JOINED");

            student.send("START_QUIZ", payload("quizId", "quiz-role"));
            assertEquals("FORBIDDEN", student.read().path("payload").path("code").asText());

            observer.send("JOIN_ROOM", payload("quizId", "quiz-role"));
            assertAck(observer.read(), "ROOM_JOINED");
            String messageId = UUID.randomUUID().toString();
            observer.send("START_QUIZ", payload("quizId", "quiz-role"), messageId);
            assertAck(observer.read(), "QUIZ_STARTED");
            assertEquals("QUIZ_STARTED", student.read().path("type").asText());
            observer.send("START_QUIZ", payload("quizId", "quiz-role"), messageId);
            assertAck(observer.read(), "QUIZ_STARTED");
            student.setReadTimeout(250);
            assertTrue(student.hasNoMessage());

            observer.close();
            try (TcpClient reconnectedGateway = new TcpClient(server.port())) {
                reconnectedGateway.send("AUTH", payload("sharedSecret", SECRET));
                assertAck(reconnectedGateway.read(), "AUTHENTICATED");
                reconnectedGateway.send("REGISTER_SESSION", payload("sessionId", "retry-gateway", "role", "GATEWAY"));
                assertAck(reconnectedGateway.read(), "SESSION_REGISTERED");
                reconnectedGateway.send("START_QUIZ", payload("quizId", "quiz-role"), messageId);
                assertAck(reconnectedGateway.read(), "QUIZ_STARTED");
            }
            assertTrue(student.hasNoMessage());
        }
    }

    @Test
    void leavesRoomsAndReclaimsSessionIdsAfterDisconnect() throws Exception {
        server = new TcpServer(InetAddress.getByName("127.0.0.1"), 0, SECRET);
        server.start();
        try (TcpClient teacher = connect("cleanup-teacher", "TEACHER")) {
            teacher.send("JOIN_ROOM", payload("quizId", "quiz-cleanup"));
            assertAck(teacher.read(), "ROOM_JOINED");

            TcpClient student = connect("cleanup-student", "STUDENT");
            student.send("JOIN_ROOM", payload("quizId", "quiz-cleanup"));
            assertAck(student.read(), "ROOM_JOINED");
            student.send("LEAVE_ROOM", payload("quizId", "quiz-cleanup"));
            assertAck(student.read(), "ROOM_LEFT");
            teacher.send("START_QUIZ", payload("quizId", "quiz-cleanup"));
            assertAck(teacher.read(), "QUIZ_STARTED");
            student.setReadTimeout(250);
            assertTrue(student.hasNoMessage(), "Leaving a room must stop its events");
            student.close();

            try (TcpClient reconnected = new TcpClient(server.port())) {
                reconnected.send("AUTH", payload("sharedSecret", SECRET));
                assertAck(reconnected.read(), "AUTHENTICATED");
                long deadline = System.nanoTime() + 3_000_000_000L;
                JsonNode registration;
                do {
                    reconnected.send("REGISTER_SESSION",
                            payload("sessionId", "cleanup-student", "role", "STUDENT"));
                    registration = reconnected.read();
                    if ("ERROR".equals(registration.path("type").asText())
                            && "SESSION_IN_USE".equals(registration.path("payload").path("code").asText())) {
                        Thread.sleep(10);
                    } else {
                        break;
                    }
                } while (System.nanoTime() < deadline);
                assertEquals("ACK", registration.path("type").asText());
                reconnected.send("JOIN_ROOM", payload("quizId", "quiz-cleanup"));
                assertAck(reconnected.read(), "ROOM_JOINED");
                teacher.send("START_QUIZ", payload("quizId", "quiz-cleanup"));
                assertAck(teacher.read(), "QUIZ_STARTED");
                assertEvent(reconnected.read(), "QUIZ_STARTED", "quiz-cleanup");
            }
        }
    }

    private TcpClient connect(String sessionId, String role) throws Exception {
        return connectRegistered(sessionId, role);
    }

    @Test
    void cachedCommandsCannotBypassAuthenticationOrRolesAndOversizeIsRejected() throws Exception {
        server = new TcpServer(InetAddress.getByName("127.0.0.1"), 0, SECRET);
        server.start();
        String id = UUID.randomUUID().toString();
        try (TcpClient gateway = connectGateway("cache-gateway");
             TcpClient student = connect("cache-student", "STUDENT");
             TcpClient stranger = new TcpClient(server.port())) {
            gateway.send("START_QUIZ", payload("quizId", "cache-quiz"), id);
            assertAck(gateway.read(), "QUIZ_STARTED");
            stranger.send("START_QUIZ", payload("quizId", "cache-quiz"), id);
            assertEquals("AUTH_REQUIRED", stranger.read().path("payload").path("code").asText());
            student.send("START_QUIZ", payload("quizId", "cache-quiz"), id);
            assertEquals("FORBIDDEN", student.read().path("payload").path("code").asText());
            gateway.send("UNKNOWN", JSON.createObjectNode());
            assertEquals("UNKNOWN_MESSAGE_TYPE", gateway.read().path("payload").path("code").asText());
            stranger.writeRaw("x".repeat(65_537));
            assertEquals("MESSAGE_TOO_LARGE", stranger.read().path("payload").path("code").asText());
            gateway.send("PING", JSON.createObjectNode());
            assertEquals("PONG", gateway.read().path("type").asText());
        }
    }

    private TcpClient connectGateway(String sessionId) throws Exception {
        return connectRegistered(sessionId, "GATEWAY");
    }

    private TcpClient connectRegistered(String sessionId, String role) throws Exception {
        TcpClient client = new TcpClient(server.port());
        client.send("AUTH", payload("sharedSecret", SECRET));
        assertAck(client.read(), "AUTHENTICATED");
        client.send("REGISTER_SESSION", payload("sessionId", sessionId, "role", role));
        assertAck(client.read(), "SESSION_REGISTERED");
        return client;
    }

    private static ObjectNode payload(Object... fields) {
        ObjectNode payload = JSON.createObjectNode();
        for (int i = 0; i < fields.length; i += 2) {
            Object value = fields[i + 1];
            if (value instanceof Integer number) payload.put((String) fields[i], number);
            else payload.put((String) fields[i], String.valueOf(value));
        }
        return payload;
    }

    private static void assertAck(JsonNode response, String status) {
        assertEquals("ACK", response.path("type").asText());
        assertEquals(status, response.path("payload").path("status").asText());
        assertNotNull(response.path("payload").path("ackMessageId").asText(null));
        assertNotNull(response.path("timestamp").asText(null));
    }

    private static void assertEvent(JsonNode response, String type, String quizId) {
        assertEquals(type, response.path("type").asText());
        assertEquals(quizId, response.path("payload").path("quizId").asText());
    }

    private static final class TcpClient implements AutoCloseable {
        private final Socket socket;
        private final BufferedReader reader;
        private final BufferedWriter writer;

        private TcpClient(int port) throws IOException {
            socket = new Socket(InetAddress.getByName("127.0.0.1"), port);
            socket.setSoTimeout(3_000);
            reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
            writer = new BufferedWriter(new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8));
        }

        private void send(String type, ObjectNode payload) throws IOException {
            send(type, payload, UUID.randomUUID().toString());
        }

        private void send(String type, ObjectNode payload, String messageId) throws IOException {
            ObjectNode message = JSON.createObjectNode();
            message.put("version", 1);
            message.put("messageId", messageId);
            message.put("type", type);
            message.put("timestamp", Instant.now().toString());
            message.set("payload", payload);
            writeRaw(JSON.writeValueAsString(message));
        }

        private void writeRaw(String line) throws IOException {
            writer.write(line);
            writer.newLine();
            writer.flush();
        }

        private JsonNode read() throws IOException {
            String line = reader.readLine();
            assertNotNull(line, "Server closed the connection before replying.");
            return JSON.readTree(line);
        }

        private void setReadTimeout(int timeout) throws IOException {
            socket.setSoTimeout(timeout);
        }

        private boolean hasNoMessage() throws IOException {
            try {
                reader.readLine();
                return false;
            } catch (java.net.SocketTimeoutException expected) {
                return true;
            }
        }

        @Override
        public void close() throws IOException {
            socket.close();
        }
    }
}
