# ExamFlow

ExamFlow implements the [SRS v1.0](docs/ExamFlow_SRS_v1.0.md): separate Student
and Teacher portals, MCQ exams, server deadlines/scoring, local MongoDB, and
real Java TCP notifications delivered to browsers through authenticated SSE.

See the [acceptance report](docs/acceptance-report.md), [architecture](docs/architecture.md),
[protocol](docs/socket-protocol.md), and [final demonstration](docs/final-demonstration.md).

## Prerequisites

- Node.js LTS (audit: 24.14.1), npm.
- Local MongoDB Community Server (audit installation: 8.3).
- JDK 21 and Maven 3.9+ on PATH (audit: Temurin 21.0.13, Maven 3.9.9).
- Installed Chrome for browser tests; installed Edge is also supported.

On this audit machine Java and Maven are installed outside the default PATH:

```powershell
$env:JAVA_HOME = 'D:/tools/jdk-21'
$env:Path = "$env:JAVA_HOME/bin;D:/tools/maven/bin;" + $env:Path
```

Use your actual installation paths elsewhere. Check `java -version` and
`mvn -version`. Run commands from the repository root.

## Configure once

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm ci
```

Configure the ignored `.env` file:

```dotenv
MONGODB_URI=mongodb://127.0.0.1:27017/examflow
API_HOST=127.0.0.1
API_PORT=4000
CLIENT_ORIGIN=http://localhost:5173
JAVA_TCP_HOST=127.0.0.1
JAVA_TCP_PORT=9090
SESSION_SECRET=<unique-random-value-at-least-32-characters>
JAVA_TCP_SHARED_SECRET=<different-random-value-at-least-32-characters>
```

Generate two separate secrets with
`node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"`.
Do not commit or publish `.env`. Node and Java must share the TCP secret.
The API refuses nonlocal MongoDB and invalid configuration; no memory fallback exists.

## Start all four services

Check MongoDB first. Do not restart an already running service:

```powershell
Get-Service MongoDB
# If stopped, from an elevated terminal:
Start-Service MongoDB
```

Build the application and Java (including JUnit tests):

```powershell
npm run build
npm run build:java
```

Use three separate terminals:

```powershell
npm run start:java
```

```powershell
npm run start:api
```

```powershell
npm run start:web
```

Open <http://localhost:5173>. The final demo uses the **built preview**, which
does not inject Vite's development client. The preview proxies `/api` to
Express. <http://localhost:4000/api/health> must return HTTP 200 with
`{"status":"ok","database":"connected"}`. Java must log its loopback listener
and an authenticated Node control session.

For editing, `npm run dev` starts React development and the API; Java/MongoDB
remain separate. Do not run preview and development on the same port.
`npm run start:all` starts three development processes, **not MongoDB**.

On Windows, use `npm run start:local` to start all three development processes
with Java and Maven configured automatically. It uses `JAVA_HOME`/PATH when
available, or this machine's installed JetBrains Java runtime and local Maven
under `.tools`. Keep the terminal open; Ctrl+C stops the three processes.
Use this instead of starting another API or web process on the same ports.
If the API is already running and only Java is missing, run
`npm run start:local -- -Service java` in a separate terminal.

## Accounts and exams

- Student registration/login: `/student/register`, `/student/login`.
- Teacher login: `/teacher/login`; no public teacher signup.
- Dashboards: `/student/dashboard`, `/teacher/dashboard`.
- Teacher creates a draft, adds four-option MCQs, previews and starts it.
- Students join once, save/replace answers and submit. Express finalizes expired
  attempts every five seconds even when the browser is closed.
- Teacher end finalizes remaining attempts and releases results. Student
  dashboards and result endpoints withhold scores until release.
- Results/attempts are owner-scoped; teacher monitor/results require quiz ownership.

Provision a teacher through the controlled seed command:

```powershell
$env:TEACHER_NAME = Read-Host 'Teacher name'
$env:TEACHER_EMAIL = Read-Host 'Teacher email'
$teacherPassword = Read-Host 'Teacher password' -AsSecureString
$env:TEACHER_PASSWORD = [System.Net.NetworkCredential]::new('', $teacherPassword).Password
npm run seed:teacher --workspace apps/api
Remove-Item Env:TEACHER_NAME, Env:TEACHER_EMAIL, Env:TEACHER_PASSWORD
```

Existing emails are rejected; seeding never changes an existing account's role
or password. Sessions use bcrypt, MongoDB, eight-hour expiry, HttpOnly/SameSite
cookies and CSRF tokens. Secure cookies are enabled in production. Local
acceptance uses HTTP; production TLS hosting has not been exercised.

## Repeat the audit

```powershell
npm test
npm run test:java
npm run test:realtime
npm run test:outage
npm run test:browser
```

- API tests use/drop dedicated `examflow_auth_test`, `examflow_quiz_test`,
  and `examflow_attempts_test` databases.
- Realtime tests require running Java with the matching `.env` secret. They use
  `examflow_java_sse_test` and actual one-Teacher/two-Student TCP/SSE sessions.
- Outage tests use `examflow_outage_test` and start/stop their own Java process
  on a temporary port. They require built classes and Maven-cached Jackson
  2.18.2 jars. Set `JAVA_TEST_CLASSPATH` for a custom Maven repository.
- Browser tests require all services and the built preview. They operate three
  isolated Chrome contexts, exercise touch, offline/online recovery, and a real
  one-minute deadline. External browser requests are blocked.
- Set `$env:AUDIT_BROWSER='msedge'` for installed Edge.
- Browser tests retain unique demo accounts/quizzes in `examflow`. Credentials
  are local-only in `.audit/demo-accounts.json`; shareable evidence is under
  [docs/evidence](docs/evidence/). Never share `.audit/`.

Registration allows five requests/hour/IP; login allows ten/15 minutes/IP.
Repeated full browser runs can hit these controls. Wait for the window or
restart your local audit API between reruns; do not weaken the limits.

## Phone access and troubleshooting

On the same Wi-Fi, open `http://<computer-Wi-Fi-IP>:5173`. Only port 5173
should be reachable from the LAN. Express, Java and MongoDB stay on loopback.
A firewall exception may be required, limited to TCP 5173, LocalSubnet and the
Wi-Fi interface. Physical Android/iOS and LAN firewall traversal are unverified.

| Symptom | Action |
|---|---|
| Java/Maven not recognized | Set JDK 21 JAVA_HOME and Maven bin on PATH |
| `ECONNREFUSED 127.0.0.1:9090` | The Java TCP service is not listening. On Windows, run `npm run start:local -- -Service java` in a separate terminal and keep it open (elsewhere, use `npm run start:java` with Java/Maven on PATH). Wait for its listening message; the API reconnects automatically. `npm run start:api` starts only the API. |
| API exits | Check local MongoDB, URI and separate valid secrets |
| Java AUTH_FAILED | Ensure both services loaded the same TCP secret |
| Notifications pending | Check Java logs and outboxEvents; REST remains authoritative |
| UI stale after editing | Rebuild when using preview |
| Registration/login throttled | Respect the rate-limit window |
| Phone cannot connect | Check Wi-Fi IP, same LAN and narrow firewall rule |

Stop terminal processes with Ctrl+C; leave MongoDB in its normal operator-managed
state. No optional product features were added during the audit.
