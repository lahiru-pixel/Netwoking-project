export function createUnconfiguredEventPublisher() {
  return {
    async publishLifecycleEvent(event) {
      console.info(
        `Quiz event ${event.type} for ${event.quizId} was not delivered: TCP event integration is not configured.`,
      );
      return { status: "not_configured" };
    },
  };
}
