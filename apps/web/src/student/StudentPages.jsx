import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpenCheck,
  CheckCircle2,
  Clock3,
  FileQuestion,
  GraduationCap,
  LoaderCircle,
  LogOut,
  Award,
  House,
  ShieldCheck,
} from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "@/auth/AuthContext";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/api";
import { useRealtimeEvents } from "@/realtime/useRealtimeEvents";

function StudentLayout({ children }) {
  useRealtimeEvents();
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState("");

  async function handleSignOut() {
    try {
      await signOut();
      navigate("/student/login", { replace: true });
    } catch (requestError) {
      setError(requestError.message ?? "Could not sign out. Please try again.");
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex min-h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-8">
          <div className="flex items-center gap-5">
            <Link to="/student/dashboard" className="inline-flex items-center gap-2.5">
              <span className="flex size-9 items-center justify-center rounded-xl bg-indigo-600 text-white">
                <BookOpenCheck aria-hidden="true" className="size-4.5" />
              </span>
              <span className="font-semibold tracking-tight">ExamFlow</span>
            </Link>
            <nav className="hidden items-center gap-1 sm:flex" aria-label="Student navigation">
              <Link className="rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-100" to="/student/exams">Exams</Link>
              <Link className="rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-100" to="/student/results">Results</Link>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-slate-500 sm:inline">{user?.name}</span>
            <Button type="button" variant="ghost" onClick={handleSignOut} aria-label="Sign out">
              <LogOut aria-hidden="true" className="mr-2 size-4" />
              <span className="hidden sm:inline">Sign out</span>
            </Button>
          </div>
        </div>
        <nav className="grid grid-cols-3 gap-1 border-t border-slate-100 px-3 py-2 sm:hidden" aria-label="Student navigation">
          <Link className="flex min-h-10 items-center justify-center gap-2 rounded-lg text-xs font-medium text-slate-600 transition hover:bg-indigo-50 hover:text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500" to="/student/dashboard">
            <House aria-hidden="true" className="size-4" /> Home
          </Link>
          <Link className="flex min-h-10 items-center justify-center gap-2 rounded-lg text-xs font-medium text-slate-600 transition hover:bg-indigo-50 hover:text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500" to="/student/exams">
            <FileQuestion aria-hidden="true" className="size-4" /> Exams
          </Link>
          <Link className="flex min-h-10 items-center justify-center gap-2 rounded-lg text-xs font-medium text-slate-600 transition hover:bg-indigo-50 hover:text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500" to="/student/results">
            <Award aria-hidden="true" className="size-4" /> Results
          </Link>
        </nav>
      </header>
      {error && <p role="alert" className="mx-auto mt-4 max-w-7xl px-4 text-sm text-rose-700">{error}</p>}
      {children}
    </div>
  );
}

function PageTitle({ eyebrow, title, description, actions }) {
  return (
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-indigo-600">{eyebrow}</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

function Loading({ label = "Loading..." }) {
  return <div role="status" className="flex min-h-56 items-center justify-center gap-3 text-sm text-slate-500">
    <LoaderCircle aria-hidden="true" className="size-5 animate-spin text-indigo-600" />{label}
  </div>;
}

function ErrorNotice({ children }) {
  return children ? <div role="alert" className="mt-6 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{children}</div> : null;
}

function QuizCard({ quiz, action }) {
  return (
    <article className="flex flex-col justify-between gap-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:flex-row sm:items-center sm:p-6">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-xs font-medium text-emerald-700">
          <span className="size-2 rounded-full bg-emerald-500" /> Available now
        </div>
        <h2 className="mt-2 text-lg font-semibold">{quiz.title}</h2>
        {quiz.description && <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500">{quiz.description}</p>}
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-slate-500">
          {quiz.questionCount !== undefined && <span>{quiz.questionCount} questions</span>}
          <span>{quiz.durationMinutes} minutes</span>
        </div>
      </div>
      {action}
    </article>
  );
}

export function StudentDashboardPage() {
  const { user } = useAuth();
  const [dashboard, setDashboard] = useState(null);
  const [results, setResults] = useState([]);
  const [error, setError] = useState("");

  const loadDashboard = useCallback(async () => {
    try {
      const [data, resultData] = await Promise.all([
      apiRequest("/api/student/dashboard", { cache: "no-store" }),
      apiRequest("/api/results/my", { cache: "no-store" }),
      ]);
      setDashboard(data);
      setResults(resultData.results);
      setError("");
    } catch (requestError) {
      setError(requestError.message ?? "Could not load your workspace.");
    }
  }, []);
  useEffect(() => {
    loadDashboard();
    window.addEventListener("examflow:refresh", loadDashboard);
    return () => window.removeEventListener("examflow:refresh", loadDashboard);
  }, [loadDashboard]);

  return (
    <StudentLayout>
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-8 sm:py-12">
        <section className="relative overflow-hidden rounded-3xl bg-[radial-gradient(ellipse_at_75%_0%,#4f46e5_0%,#26235f_39%,#111827_100%)] px-6 py-9 text-white shadow-xl sm:px-10 sm:py-11">
          <div className="relative max-w-2xl">
            <div className="mb-6 flex size-12 items-center justify-center rounded-2xl border border-white/15 bg-white/10"><GraduationCap aria-hidden="true" className="size-6" /></div>
            <p className="text-sm font-medium text-indigo-200">STUDENT WORKSPACE</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">Your learning, in flow.</h1>
            <p className="mt-3 text-sm leading-6 text-slate-300 sm:text-base">Welcome{user?.name ? `, ${user.name}` : ""}. Explore available exams and review your released results.</p>
          </div>
        </section>
        <ErrorNotice>{error}</ErrorNotice>
        <section className="mt-8 grid gap-4 sm:grid-cols-2">
          <article className="rounded-2xl border border-slate-200 bg-white p-6">
            <FileQuestion aria-hidden="true" className="size-5 text-indigo-600" />
            <p className="mt-4 text-sm text-slate-500">Active exams</p>
            <p className="mt-1 text-3xl font-semibold">{dashboard?.availableQuizzes?.length ?? "—"}</p>
            <Link className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-indigo-700" to="/student/exams">Explore exams <ArrowRight className="size-4" /></Link>
          </article>
          <article className="rounded-2xl border border-slate-200 bg-white p-6">
            <ShieldCheck aria-hidden="true" className="size-5 text-emerald-600" />
            <p className="mt-4 text-sm text-slate-500">Released results</p>
            <p className="mt-1 text-3xl font-semibold">{results.length}</p>
            <Link className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-indigo-700" to="/student/results">View results <ArrowRight className="size-4" /></Link>
          </article>
        </section>
        <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div><h2 className="font-semibold">Available exams</h2><p className="mt-1 text-sm text-slate-500">Join an active assessment to begin.</p></div>
            <Link to="/student/exams" className="text-sm font-medium text-indigo-700">See all</Link>
          </div>
          {dashboard ? (
            <div className="mt-5 grid gap-3">
              {dashboard.availableQuizzes.slice(0, 3).map((quiz) => <QuizCard key={quiz.id} quiz={quiz} action={<Link to={`/student/exams/${quiz.id}`} className="inline-flex h-10 items-center justify-center rounded-xl bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700">View exam</Link>} />)}
              {dashboard.availableQuizzes.length === 0 && <p className="rounded-xl bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">There are no active exams right now. Check back soon.</p>}
            </div>
          ) : !error ? <Loading /> : null}
        </section>
      </main>
    </StudentLayout>
  );
}

export function AvailableExamsPage() {
  const [quizzes, setQuizzes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const data = await apiRequest("/api/quizzes", { cache: "no-store" });
      setQuizzes(data.quizzes);
    } catch (requestError) {
      setError(requestError.message ?? "Could not load available exams.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
    window.addEventListener("examflow:refresh", load);
    return () => window.removeEventListener("examflow:refresh", load);
  }, [load]);

  return (
    <StudentLayout>
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-8 sm:py-12">
        <PageTitle eyebrow="ASSESSMENTS" title="Available exams" description="Review the details before joining. You can join each exam only once." />
        <ErrorNotice>{error}</ErrorNotice>
        {loading ? <Loading label="Loading available exams..." /> : (
          <div className="mt-8 grid gap-4">
            {quizzes.map((quiz) => <QuizCard key={quiz.id} quiz={quiz} action={<Link to={`/student/exams/${quiz.id}`} className="inline-flex h-10 shrink-0 items-center justify-center rounded-xl bg-indigo-600 px-4 text-sm font-medium text-white hover:bg-indigo-700">View details <ArrowRight className="ml-2 size-4" /></Link>} />)}
            {quizzes.length === 0 && <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center text-sm text-slate-500">No active exams are available at the moment.</div>}
          </div>
        )}
      </main>
    </StudentLayout>
  );
}

export function QuizDetailsPage() {
  const { quizId } = useParams();
  const navigate = useNavigate();
  const { csrfToken } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    let active = true;
    apiRequest(`/api/quizzes/${quizId}`, { cache: "no-store" })
      .then((response) => { if (active) setData(response); })
      .catch((requestError) => { if (active) setError(requestError.message ?? "Could not load exam details."); });
    return () => { active = false; };
  }, [quizId]);

  async function joinQuiz() {
    setJoining(true);
    setError("");
    try {
      const token = csrfToken ?? (await apiRequest("/api/auth/csrf", { cache: "no-store" })).csrfToken;
      const response = await apiRequest(`/api/quizzes/${quizId}/join`, {
        method: "POST",
        csrfToken: token,
        body: JSON.stringify({}),
      });
      navigate(`/student/attempts/${response.attempt.id}`);
    } catch (requestError) {
      setError(requestError.message ?? "Could not join this exam.");
      setJoining(false);
    }
  }

  const existingAttempt = data?.attempt;
  const canResume = existingAttempt?.status === "IN_PROGRESS";

  return (
    <StudentLayout>
      <main className="mx-auto max-w-4xl px-4 py-8 sm:px-8 sm:py-12">
        <Link to="/student/exams" className="inline-flex items-center gap-2 text-sm font-medium text-slate-500 hover:text-slate-900"><ArrowLeft className="size-4" /> All exams</Link>
        {error && <ErrorNotice>{error}</ErrorNotice>}
        {!data ? (!error && <Loading label="Loading exam details..." />) : (
          <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-9">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.15em] text-emerald-700"><span className="size-2 rounded-full bg-emerald-500" /> Active exam</div>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">{data.quiz.title}</h1>
            {data.quiz.description && <p className="mt-3 text-slate-600">{data.quiz.description}</p>}
            <div className="mt-7 grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl bg-slate-50 p-4"><p className="text-xs text-slate-500">Questions</p><p className="mt-1 font-semibold">{data.questions.length}</p></div>
              <div className="rounded-xl bg-slate-50 p-4"><p className="text-xs text-slate-500">Time limit</p><p className="mt-1 font-semibold">{data.quiz.durationMinutes} minutes</p></div>
            </div>
            {data.quiz.instructions && <div className="mt-7"><h2 className="font-semibold">Instructions</h2><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-600">{data.quiz.instructions}</p></div>}
            <div className="mt-7 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">Your timer starts when you begin. Answers are saved as you select them, and the server submits your attempt when time expires.</div>
            <Button className="mt-7 h-11 rounded-xl bg-indigo-600 px-5 text-white hover:bg-indigo-700" disabled={joining || (existingAttempt && !canResume)} onClick={canResume ? () => navigate(`/student/attempts/${existingAttempt.id}`) : joinQuiz}>
              {joining ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : null}
              {joining ? "Joining..." : canResume ? "Resume exam" : existingAttempt ? "Attempt submitted" : "Join exam"}
            </Button>
          </section>
        )}
      </main>
    </StudentLayout>
  );
}

function formatTime(seconds) {
  const safe = Math.max(0, seconds);
  return `${Math.floor(safe / 60).toString().padStart(2, "0")}:${(safe % 60).toString().padStart(2, "0")}`;
}

export function ExamAttemptPage() {
  const { attemptId } = useParams();
  const navigate = useNavigate();
  const { csrfToken } = useAuth();
  const [data, setData] = useState(null);
  const [index, setIndex] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const requestQueue = useRef(Promise.resolve());
  const submittedRef = useRef(false);
  const clockOffset = useRef(0);

  const load = useCallback(async () => {
    const response = await apiRequest(`/api/attempts/${attemptId}`, { cache: "no-store" });
    setError("");
    setData(response);
    clockOffset.current = Date.parse(response.serverTime) - Date.now();
    const remaining = Math.ceil((Date.parse(response.attempt.expiresAt) - (Date.now() + clockOffset.current)) / 1000);
    setSecondsLeft(Math.max(0, remaining));
    if (response.attempt.status !== "IN_PROGRESS") submittedRef.current = true;
    return response;
  }, [attemptId]);

  useEffect(() => {
    let active = true;
    const refresh = () => load().catch((requestError) => { if (active) setError(requestError.message ?? "Could not load this attempt."); });
    refresh();
    window.addEventListener("examflow:refresh", refresh);
    return () => { active = false; window.removeEventListener("examflow:refresh", refresh); };
  }, [load]);

  useEffect(() => {
    if (!data || data.attempt.status !== "IN_PROGRESS") return undefined;
    const timer = window.setInterval(() => {
      const remaining = Math.ceil((Date.parse(data.attempt.expiresAt) - (Date.now() + clockOffset.current)) / 1000);
      setSecondsLeft(Math.max(0, remaining));
    }, 500);
    return () => window.clearInterval(timer);
  }, [data]);

  const currentQuestion = data?.questions[index];

  const submit = useCallback(async (automatic = false) => {
    if (!data || data.attempt.status !== "IN_PROGRESS" || submittedRef.current || submitting) return;
    submittedRef.current = true;
    setSubmitting(true);
    setSubmitError("");
    try {
      await requestQueue.current;
      const token = csrfToken ?? (await apiRequest("/api/auth/csrf", { cache: "no-store" })).csrfToken;
      await apiRequest(`/api/attempts/${attemptId}/submit`, {
        method: "POST",
        csrfToken: token,
        body: JSON.stringify({}),
      });
      const refreshed = await load();
      if (refreshed.attempt.status === "IN_PROGRESS") {
        submittedRef.current = false;
        if (secondsLeft !== 0) setSubmitError("Submission is still being finalized. Try again in a moment.");
      }
    } catch (requestError) {
      submittedRef.current = false;
      setSubmitError(requestError.message ?? (automatic ? "Automatic submission could not be confirmed. Retrying..." : "Could not submit your exam."));
    } finally {
      setSubmitting(false);
    }
  }, [attemptId, csrfToken, data, load, submitting]);

  useEffect(() => {
    if (secondsLeft === 0 && data?.attempt.status === "IN_PROGRESS") void submit(true);
  }, [secondsLeft, data, submit]);

  async function saveAnswer(optionId) {
    if (!currentQuestion || data.attempt.status !== "IN_PROGRESS" || saving) return;
    setError("");
    setData((current) => ({
      ...current,
      questions: current.questions.map((question) =>
        question.id === currentQuestion.id ? { ...question, selectedOptionId: optionId } : question,
      ),
    }));
    setSaving(true);
    const queue = requestQueue.current.then(async () => {
      const token = csrfToken ?? (await apiRequest("/api/auth/csrf", { cache: "no-store" })).csrfToken;
      await apiRequest(`/api/attempts/${attemptId}/answers/${currentQuestion.id}`, {
        method: "PUT",
        csrfToken: token,
        body: JSON.stringify({ optionId }),
      });
    });
    requestQueue.current = queue.catch(() => {});
    try {
      await queue;
    } catch (requestError) {
      setData((current) => ({
        ...current,
        questions: current.questions.map((question) => question.id === currentQuestion.id
          ? { ...question, selectedOptionId: currentQuestion.selectedOptionId } : question),
      }));
      setError(requestError.message ?? "Your answer could not be saved.");
      if (requestError.code === "ATTEMPT_EXPIRED" || requestError.code === "ATTEMPT_COMPLETED" || requestError.code === "QUIZ_ENDED") {
        try { await load(); } catch { /* The original save error is shown. */ }
      }
    } finally {
      setSaving(false);
    }
  }

  const finished = data && data.attempt.status !== "IN_PROGRESS";

  return (
    <StudentLayout>
      <main className="mx-auto max-w-4xl px-4 py-6 sm:px-8 sm:py-10">
        {error && <ErrorNotice>{error}</ErrorNotice>}
        {!data ? (!error && <Loading label="Loading your exam..." />) : finished ? (
          <section className="mt-8 rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm sm:p-12">
            <CheckCircle2 aria-hidden="true" className="mx-auto size-12 text-emerald-600" />
            <h1 className="mt-5 text-2xl font-semibold">Exam submitted</h1>
            <p className="mt-2 text-sm leading-6 text-slate-500">Your answers have been saved and scored securely. Results appear after they are released.</p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <Button variant="outline" onClick={() => navigate("/student/exams")}>Browse exams</Button>
              <Button className="bg-indigo-600 text-white hover:bg-indigo-700" onClick={() => navigate("/student/results")}>View results</Button>
            </div>
          </section>
        ) : (
          <>
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
              <div><p className="text-xs font-semibold uppercase tracking-[0.15em] text-indigo-600">EXAM IN PROGRESS</p><h1 className="mt-2 text-2xl font-semibold sm:text-3xl">{data.quiz.title}</h1></div>
              <div role="timer" aria-live="off" className={`flex items-center gap-2 self-start rounded-xl border px-4 py-3 font-mono text-lg font-semibold ${secondsLeft < 60 ? "border-rose-200 bg-rose-50 text-rose-700" : "border-slate-200 bg-white text-slate-800"}`}>
                <Clock3 aria-hidden="true" className="size-5" />{formatTime(secondsLeft ?? 0)}
              </div>
            </div>
            {submitError && <ErrorNotice>{submitError}</ErrorNotice>}
            <section className="mt-6 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-8">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-slate-500">Question {index + 1} of {data.questions.length}</p>
                <p className="text-xs text-slate-500">{saving ? "Saving answer..." : currentQuestion.selectedOptionId ? "Answer saved" : "Not answered"}</p>
              </div>
              <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-indigo-600 transition-all" style={{ width: `${((index + 1) / data.questions.length) * 100}%` }} /></div>
              <h2 className="mt-7 text-xl font-semibold leading-8">{currentQuestion.text}</h2>
              <div className="mt-6 grid gap-3">
                {currentQuestion.options.map((option, optionIndex) => {
                  const selected = currentQuestion.selectedOptionId === option.id;
                  return (
                    <button key={option.id} type="button" disabled={saving} onClick={() => saveAnswer(option.id)} aria-pressed={selected} className={`flex min-h-14 items-center gap-4 rounded-xl border p-4 text-left transition ${selected ? "border-indigo-500 bg-indigo-50 ring-2 ring-indigo-100" : "border-slate-200 hover:border-indigo-300 hover:bg-slate-50"} disabled:cursor-wait`}>
                      <span className={`flex size-8 shrink-0 items-center justify-center rounded-lg text-sm font-semibold ${selected ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600"}`}>{String.fromCharCode(65 + optionIndex)}</span>
                      <span className="min-w-0 break-words text-sm leading-6">{option.text}</span>
                    </button>
                  );
                })}
              </div>
              <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-5">
                <Button variant="outline" disabled={index === 0 || saving} onClick={() => setIndex((value) => value - 1)}><ArrowLeft className="mr-2 size-4" />Previous</Button>
                {index < data.questions.length - 1 ? (
                  <Button className="bg-indigo-600 text-white hover:bg-indigo-700" disabled={saving} onClick={() => setIndex((value) => value + 1)}>Next question<ArrowRight className="ml-2 size-4" /></Button>
                ) : (
                  <Button className="bg-emerald-600 text-white hover:bg-emerald-700" disabled={saving || submitting} onClick={() => void submit(false)}>{submitting ? "Submitting..." : "Submit exam"}</Button>
                )}
              </div>
            </section>
            <p className="mt-4 text-center text-xs text-slate-500">Your selected answers are autosaved. The official score is calculated by ExamFlow.</p>
          </>
        )}
      </main>
    </StudentLayout>
  );
}

export function ResultsPage() {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    const refresh = () => apiRequest("/api/results/my", { cache: "no-store" }).then((data) => {
      if (active) setResults(data.results);
    }).catch((requestError) => {
      if (active) setError(requestError.message ?? "Could not load your results.");
    }).finally(() => { if (active) setLoading(false); });
    refresh();
    window.addEventListener("examflow:refresh", refresh);
    return () => { active = false; window.removeEventListener("examflow:refresh", refresh); };
  }, []);

  return (
    <StudentLayout>
      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-8 sm:py-12">
        <PageTitle eyebrow="YOUR PROGRESS" title="Released results" description="Scores and answer reviews are available here once released by your teacher." />
        <ErrorNotice>{error}</ErrorNotice>
        {loading ? <Loading label="Loading released results..." /> : (
          <div className="mt-8 grid gap-4">
            {results.map((result) => <article key={result.attemptId} className="flex flex-col justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-5 sm:flex-row sm:items-center sm:p-6">
              <div><h2 className="font-semibold">{result.quizTitle}</h2><p className="mt-1 text-sm text-slate-500">Submitted {new Date(result.submittedAt).toLocaleString()}</p></div>
              <div className="flex items-center justify-between gap-5 sm:justify-end"><p className="font-semibold text-indigo-700">{result.score} / {result.totalMarks}</p><Link to={`/student/results/${result.attemptId}`} className="inline-flex h-10 items-center justify-center rounded-xl border border-slate-200 px-4 text-sm font-medium hover:bg-slate-50">Review</Link></div>
            </article>)}
            {results.length === 0 && <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-16 text-center text-sm text-slate-500">No results have been released for your account yet.</div>}
          </div>
        )}
      </main>
    </StudentLayout>
  );
}

export function ResultDetailPage() {
  const { attemptId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    apiRequest(`/api/results/my/${attemptId}`, { cache: "no-store" })
      .then((response) => { if (active) setData(response); })
      .catch((requestError) => { if (active) setError(requestError.message ?? "Could not load this result."); });
    return () => { active = false; };
  }, [attemptId]);

  return (
    <StudentLayout>
      <main className="mx-auto max-w-4xl px-4 py-8 sm:px-8 sm:py-12">
        <Link to="/student/results" className="inline-flex items-center gap-2 text-sm font-medium text-slate-500 hover:text-slate-900"><ArrowLeft className="size-4" /> All results</Link>
        <ErrorNotice>{error}</ErrorNotice>
        {!data ? (!error && <Loading label="Loading result review..." />) : (
          <>
            <section className="mt-5 rounded-3xl bg-slate-950 p-6 text-white sm:p-8">
              <p className="text-xs font-semibold uppercase tracking-[0.15em] text-indigo-300">RESULT RELEASED</p>
              <h1 className="mt-3 text-2xl font-semibold sm:text-3xl">{data.result.quizTitle}</h1>
              <p className="mt-3 text-slate-300">Your score</p>
              <p className="mt-1 text-4xl font-semibold">{data.result.score} <span className="text-xl text-slate-400">/ {data.result.totalMarks}</span></p>
            </section>
            <div className="mt-6 grid gap-4">
              {data.questions.map((question, questionIndex) => <article key={question.id} className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6">
                <p className="text-xs font-medium text-slate-500">Question {questionIndex + 1} · {question.marks} {question.marks === 1 ? "mark" : "marks"}</p>
                <h2 className="mt-2 font-semibold leading-6">{question.text}</h2>
                <div className="mt-4 grid gap-2">
                  {question.options.map((option) => {
                    const correct = option.id === question.correctOptionId;
                    const selected = option.id === question.selectedOptionId;
                    return <div key={option.id} className={`rounded-lg border px-4 py-3 text-sm ${correct ? "border-emerald-300 bg-emerald-50 text-emerald-900" : selected ? "border-rose-200 bg-rose-50 text-rose-800" : "border-slate-100 text-slate-600"}`}>
                      <span>{option.text}</span>
                      {correct && <span className="ml-2 font-semibold">Correct answer</span>}
                      {selected && !correct && <span className="ml-2 font-semibold">Your answer</span>}
                    </div>;
                  })}
                  {!question.selectedOptionId && <p className="text-xs text-slate-500">No answer selected.</p>}
                </div>
              </article>)}
            </div>
          </>
        )}
      </main>
    </StudentLayout>
  );
}
