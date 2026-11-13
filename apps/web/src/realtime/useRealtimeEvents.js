import { useEffect, useState } from "react";

const eventTypes = [
  "QUIZ_STARTED",
  "QUIZ_ENDED",
  "STUDENT_JOINED",
  "ATTEMPT_SUBMITTED",
  "PARTICIPATION_UPDATED",
];

export function useRealtimeEvents() {
  const [connectionState, setConnectionState] = useState("connecting");

  useEffect(() => {
    let stream;
    let retryTimer;
    let stopped = false;
    let retries = 0;
    const handleOpen = () => setConnectionState("connected");
    const handleError = () => {
      stream?.close();
      clearTimeout(retryTimer);
      if (!navigator.onLine || retries >= 8) {
        setConnectionState("disconnected");
        return;
      }
      setConnectionState("reconnecting");
      retryTimer = setTimeout(connect, Math.min(1000 * (2 ** retries++), 30000));
    };
    const refresh = (event) => {
      let detail = {};
      try {
        detail = JSON.parse(event.data);
      } catch {
        detail = {};
      }
      setConnectionState("connected");
      retries = 0;
      window.dispatchEvent(new CustomEvent("examflow:refresh", { detail }));
    };

    function connect() {
      if (stopped) return;
      stream?.close();
      stream = new EventSource("/api/realtime/events");
      stream.addEventListener("open", handleOpen);
      stream.addEventListener("error", handleError);
      stream.addEventListener("sync", refresh);
      for (const type of eventTypes) stream.addEventListener(type, refresh);
    }
    const online = () => { retries = 0; clearTimeout(retryTimer); connect(); };
    const offline = () => { clearTimeout(retryTimer); stream?.close(); setConnectionState("disconnected"); };
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    connect();
    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      stream?.close();
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
    };
  }, []);

  return connectionState;
}
