import { finalizeDueAttempts } from "./finalize.js";

export function startAttemptExpiryWorker({
  intervalMs = 5_000,
  logger = console,
  eventPublisher,
} = {}) {
  let running = false;
  let stopped = false;
  let currentRun = Promise.resolve();

  async function tick() {
    if (stopped) return;
    if (running) return currentRun;
    running = true;
    currentRun = (async () => {
      try {
        const finalized = await finalizeDueAttempts();
        for (const attempt of finalized) {
          if (!eventPublisher?.publishStudentEvent) continue;
          try {
            await eventPublisher.publishStudentEvent({
              type: "ATTEMPT_SUBMITTED",
              quizId: attempt.quizId.toString(),
              studentId: attempt.studentId.toString(),
              attemptId: attempt._id.toString(),
              occurredAt: attempt.submittedAt?.toISOString() ?? new Date().toISOString(),
            });
          } catch (error) {
            logger.error(`Automatic submission event for ${attempt._id} was not delivered:`, error);
          }
        }
      } catch (error) {
        logger.error("Attempt expiry worker failed:", error);
      } finally {
        running = false;
      }
    })();
    return currentRun;
  }

  const timer = setInterval(tick, intervalMs);
  timer.unref();
  void tick();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      while (running) await new Promise((resolve) => setTimeout(resolve, 10));
    },
    tick,
  };
}
