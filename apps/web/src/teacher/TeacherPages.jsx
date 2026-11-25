import { useCallback, useEffect, useMemo, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import {
  ArrowLeft,
  ArrowRight,
  Activity,
  Award,
  BookOpenCheck,
  Check,
  CheckCircle2,
  CircleHelp,
  Clock3,
  Eye,
  FileQuestion,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Monitor,
  Pencil,
  Plus,
  Rocket,
  ShieldCheck,
  Trash2,
  UsersRound,
  X,
  Wifi,
  WifiOff,
} from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { z } from "zod";
import { useAuth } from "@/auth/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiRequest } from "@/lib/api";
import { useRealtimeEvents } from "@/realtime/useRealtimeEvents";

const quizFormSchema = z.object({
  title: z.string().trim().min(3, "Use at least 3 characters.").max(120),
  description: z.string().max(1000).default(""),
  instructions: z.string().max(2000).default(""),
  durationMinutes: z.coerce.number().int().min(1, "Duration must be at least one minute.").max(1440),
});

const questionFormSchema = z
  .object({
    text: z.string().trim().min(3, "Enter a question.").max(2000),
    options: z.array(
      z.object({
        id: z.string().min(1),
        text: z.string().trim().min(1, "Enter all four answer options.").max(500),
      }),
    ).length(4),
    correctOptionId: z.string().min(1, "Choose the correct answer."),
    marks: z.coerce.number().positive("Marks must be greater than zero.").max(10000),
    order: z.coerce.number().int().min(1, "Order must be at least one.").max(10000),
  })
  .refine((value) => value.options.some((option) => option.id === value.correctOptionId), {
    path: ["correctOptionId"],
    message: "Choose one of the four answer options.",
  });

const inputClass =
  "h-11 rounded-xl border-slate-200 bg-white focus-visible:border-indigo-400 focus-visible:ring-indigo-100";

function classNames(...parts) {
  return parts.filter(Boolean).join(" ");
}

function StatusBadge({ status }) {
  const styles = {
    DRAFT: "border-amber-200 bg-amber-50 text-amber-800",
    ACTIVE: "border-emerald-200 bg-emerald-50 text-emerald-800",
    COMPLETED: "border-slate-200 bg-slate-100 text-slate-600",
  };
  return (
    <span className={classNames("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold", styles[status])}>
      <span className={classNames("size-1.5 rounded-full", status === "ACTIVE" ? "bg-emerald-500" : status === "DRAFT" ? "bg-amber-500" : "bg-slate-400")} />
      {status === "COMPLETED" ? "Completed" : status === "ACTIVE" ? "Active" : "Draft"}
    </span>
  );
}

function TeacherLayout({ children }) {
  const realtimeState = useRealtimeEvents();
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState("");

  async function handleSignOut() {
    setSigningOut(true);
    setError("");
    try {
      await signOut();
      navigate("/teacher/login", { replace: true });
    } catch (requestError) {
      setError(requestError.message ?? "Could not sign out. Please try again.");
      setSigningOut(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#f7f8fc] text-slate-950">
      <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/95 backdrop-blur">
        <div className="mx-auto flex min-h-[4.25rem] max-w-7xl items-center justify-between gap-4 px-4 sm:px-7">
          <div className="flex items-center gap-2 sm:gap-7">
            <Link to="/teacher/dashboard" className="inline-flex items-center gap-2.5">
              <span className="flex size-9 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-sm shadow-indigo-300">
                <BookOpenCheck aria-hidden="true" className="size-[18px]" />
              </span>
              <span className="font-semibold tracking-tight">ExamFlow</span>
            </Link>
            <nav className="hidden items-center gap-1 sm:flex" aria-label="Teacher navigation">
              <Link
                to="/teacher/dashboard"
                className="inline-flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium text-slate-700 transition hover:bg-slate-100"
              >
                <LayoutDashboard aria-hidden="true" className="size-4" />
                Quizzes
              </Link>
            </nav>
          </div>
          <div className="flex items-center gap-2 sm:gap-4">
            <span
              role="status"
              aria-live="polite"
              title={
                realtimeState === "connected"
                  ? "Live updates connected"
                  : realtimeState === "reconnecting"
                    ? "Reconnecting to live updates"
                    : realtimeState === "disconnected"
                      ? "Live updates unavailable"
                      : "Connecting to live updates"
              }
              className={`hidden items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-xs font-medium md:inline-flex ${
                realtimeState === "connected"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                  : realtimeState === "disconnected"
                    ? "border-rose-200 bg-rose-50 text-rose-700"
                    : "border-amber-200 bg-amber-50 text-amber-800"
              }`}
            >
              {realtimeState === "connected" ? (
                <Wifi aria-hidden="true" className="size-3.5" />
              ) : realtimeState === "disconnected" ? (
                <WifiOff aria-hidden="true" className="size-3.5" />
              ) : (
                <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
              )}
              {realtimeState === "connected"
                ? "Live updates"
                : realtimeState === "reconnecting"
                  ? "Reconnecting"
                  : realtimeState === "disconnected"
                    ? "Offline"
                    : "Connecting"}
            </span>
            <div className="hidden text-right sm:block">
              <p className="text-sm font-medium text-slate-800">{user?.name}</p>
              <p className="text-xs text-slate-500">Teacher workspace</p>
            </div>
            <div className="flex size-9 items-center justify-center rounded-full bg-indigo-50 text-sm font-semibold text-indigo-700">
              {user?.name?.slice(0, 1).toUpperCase() ?? "T"}
            </div>
            <Button
              type="button"
              variant="ghost"
              disabled={signingOut}
              onClick={handleSignOut}
              aria-label="Sign out"
              className="size-10 rounded-lg px-0 text-slate-600 hover:bg-slate-100"
            >
              {signingOut ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : <LogOut aria-hidden="true" className="size-4" />}
            </Button>
          </div>
        </div>
        <nav className="grid grid-cols-3 gap-1 border-t border-slate-100 px-2 py-2 sm:hidden" aria-label="Teacher navigation">
          <Link
            to="/teacher/dashboard"
            className="flex min-h-10 items-center justify-center gap-1.5 rounded-lg text-xs font-medium text-slate-600 transition hover:bg-indigo-50 hover:text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            <LayoutDashboard aria-hidden="true" className="size-4" />
            Quizzes
          </Link>
          <Link
            to="/teacher/quizzes/new"
            className="flex min-h-10 items-center justify-center gap-1.5 rounded-lg text-xs font-medium text-slate-600 transition hover:bg-indigo-50 hover:text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            <Plus aria-hidden="true" className="size-4" />
            Create quiz
          </Link>
          <span
            role="status"
            aria-live="polite"
            className={`flex min-h-10 items-center justify-center gap-1.5 rounded-lg text-[0.7rem] font-medium ${
              realtimeState === "connected"
                ? "text-emerald-700"
                : realtimeState === "disconnected"
                  ? "text-rose-700"
                  : "text-amber-700"
            }`}
          >
            {realtimeState === "connected" ? (
              <Wifi aria-hidden="true" className="size-3.5" />
            ) : realtimeState === "disconnected" ? (
              <WifiOff aria-hidden="true" className="size-3.5" />
            ) : (
              <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
            )}
            {realtimeState === "connected"
              ? "Live"
              : realtimeState === "reconnecting"
                ? "Reconnecting"
                : realtimeState === "disconnected"
                  ? "Offline"
                  : "Connecting"}
          </span>
        </nav>
      </header>
      {error && (
        <div role="alert" className="mx-auto mt-4 max-w-7xl px-4 text-sm text-rose-700 sm:px-7">
          {error}
        </div>
      )}
      {children}
    </div>
  );
}

function PageHeading({ eyebrow, title, description, actions }) {
  return (
    <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
      <div>
        {eyebrow && <p className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-indigo-600">{eyebrow}</p>}
        <h1 className="text-3xl font-semibold tracking-[-0.035em] text-slate-950 sm:text-[2.1rem]">{title}</h1>
        {description && <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500 sm:text-[0.94rem]">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

function Notice({ tone = "info", children }) {
  const colors = {
    info: "border-indigo-100 bg-indigo-50 text-indigo-900",
    warning: "border-amber-200 bg-amber-50 text-amber-900",
    error: "border-rose-200 bg-rose-50 text-rose-800",
    success: "border-emerald-200 bg-emerald-50 text-emerald-900",
  };
  return <div role={tone === "error" ? "alert" : "status"} className={classNames("rounded-xl border px-4 py-3 text-sm leading-6", colors[tone])}>{children}</div>;
}

function ErrorMessage({ children }) {
  return children ? <p role="alert" className="mt-1.5 text-xs font-medium text-rose-600">{children}</p> : null;
}

function SummaryCard({ icon: Icon, label, value, detail, color }) {
  return (
    <article className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-slate-500">{label}</p>
          <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">{value}</p>
          <p className="mt-1 text-xs text-slate-500">{detail}</p>
        </div>
        <span className={classNames("flex size-10 items-center justify-center rounded-xl", color)}>
          <Icon aria-hidden="true" className="size-5" />
        </span>
      </div>
    </article>
  );
}

const activityLabels = {
  QUIZ_STARTED: "Quiz started",
  QUIZ_ENDED: "Quiz ended",
  STUDENT_JOINED: "A student joined",
  PARTICIPATION_UPDATED: "Student activity updated",
  ATTEMPT_SUBMITTED: "An attempt was submitted",
};

export function TeacherDashboardPage() {
  const [quizzes, setQuizzes] = useState([]);
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [deletingId, setDeletingId] = useState(null);
  const [notice, setNotice] = useState("");
  const navigate = useNavigate();

  const loadQuizzes = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const data = await apiRequest("/api/quizzes", { cache: "no-store" });
      setQuizzes(data.quizzes);
    } catch (requestError) {
      setError(requestError.message ?? "Could not load your quizzes.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadQuizzes();
    const handleRefresh = (event) => {
      loadQuizzes();
      const message = event.detail;
      const label = activityLabels[message?.type];
      const quizId = message?.payload?.quizId;
      if (message?.source !== "java_tcp" || !label || typeof quizId !== "string") return;

      setActivity((current) => [
        {
          id: message.messageId ?? `${message.type}-${quizId}-${message.timestamp}`,
          label,
          quizId,
          occurredAt: message.timestamp ?? message.payload.occurredAt,
        },
        ...current,
      ].slice(0, 5));
    };
    window.addEventListener("examflow:refresh", handleRefresh);
    return () => window.removeEventListener("examflow:refresh", handleRefresh);
  }, [loadQuizzes]);

  const counts = useMemo(
    () => ({
      total: quizzes.length,
      active: quizzes.filter((quiz) => quiz.status === "ACTIVE").length,
      drafts: quizzes.filter((quiz) => quiz.status === "DRAFT").length,
    }),
    [quizzes],
  );

  async function deleteQuiz(quiz) {
    if (!window.confirm(`Delete the draft "${quiz.title}" and all its questions?`)) return;
    setDeletingId(quiz.id);
    setError("");
    try {
      const csrf = await apiRequest("/api/auth/csrf", { cache: "no-store" });
      await apiRequest(`/api/quizzes/${quiz.id}`, {
        method: "DELETE",
        csrfToken: csrf.csrfToken,
      });
      setNotice(`"${quiz.title}" was deleted.`);
      await loadQuizzes();
    } catch (requestError) {
      setError(requestError.message ?? "Could not delete the draft quiz.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <TeacherLayout>
      <main className="mx-auto max-w-7xl px-4 pb-12 pt-8 sm:px-7 sm:pt-10">
        <PageHeading
          eyebrow="TEACHER WORKSPACE"
          title="Your quizzes, in flow."
          description="Create an assessment, shape its questions, then preview and launch when you’re ready."
          actions={
            <Button
              type="button"
              onClick={() => navigate("/teacher/quizzes/new")}
              className="h-11 rounded-xl bg-indigo-600 px-4 text-white shadow-sm shadow-indigo-200 hover:bg-indigo-700"
            >
              <Plus aria-hidden="true" className="mr-2 size-4" />
              Create quiz
            </Button>
          }
        />

        {error && <Notice tone="error"><span>{error}</span></Notice>}
        {notice && <div className="mt-5"><Notice tone="success">{notice}</Notice></div>}

        <section className="mt-8 grid gap-4 sm:grid-cols-3" aria-label="Quiz summary">
          <SummaryCard icon={FileQuestion} label="Total quizzes" value={counts.total} detail="Across your workspace" color="bg-indigo-50 text-indigo-700" />
          <SummaryCard icon={Rocket} label="Active now" value={counts.active} detail="Currently open" color="bg-emerald-50 text-emerald-700" />
          <SummaryCard icon={Pencil} label="Drafts" value={counts.drafts} detail="Ready for your next edit" color="bg-amber-50 text-amber-700" />
        </section>

        <section className="mt-6 rounded-2xl border border-slate-200/80 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.03)] sm:p-6" aria-labelledby="live-activity-title">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-700">
                <Activity aria-hidden="true" className="size-5" />
              </span>
              <div>
                <h2 id="live-activity-title" className="font-semibold text-slate-900">Live activity</h2>
                <p className="mt-1 text-sm leading-5 text-slate-500">Java TCP events from your classroom, delivered through the authenticated browser stream.</p>
              </div>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-600">
              <Clock3 aria-hidden="true" className="size-3.5" />
              Recent events
            </span>
          </div>
          {activity.length === 0 ? (
            <p className="mt-5 rounded-xl border border-dashed border-slate-200 bg-slate-50/70 px-4 py-5 text-sm text-slate-500" role="status">
              Activity from your quizzes will appear here as students join and submit.
            </p>
          ) : (
            <ul className="mt-5 divide-y divide-slate-100" aria-live="polite" aria-relevant="additions">
              {activity.map((item) => (
                <li key={item.id} className="flex min-w-0 items-start gap-3 py-3 first:pt-0 last:pb-0">
                  <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
                    <Activity aria-hidden="true" className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm font-medium text-slate-800">
                      {item.label}
                      <span className="font-normal text-slate-500">
                        {" "}· {quizzes.find((quiz) => quiz.id === item.quizId)?.title ?? "Quiz"}
                      </span>
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {item.occurredAt ? new Date(item.occurredAt).toLocaleString() : "Just now"}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-8 overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
          <div className="flex flex-col gap-3 border-b border-slate-100 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div>
              <h2 className="font-semibold text-slate-900">Quiz management</h2>
              <p className="mt-1 text-sm text-slate-500">Only you can manage quizzes you created.</p>
            </div>
            <Button type="button" variant="outline" onClick={loadQuizzes} disabled={loading} className="h-10 rounded-xl">
              {loading ? <LoaderCircle aria-hidden="true" className="mr-2 size-4 animate-spin" /> : null}
              Refresh list
            </Button>
          </div>
          {loading ? (
            <div className="flex min-h-52 items-center justify-center gap-3 text-sm text-slate-500" role="status">
              <LoaderCircle aria-hidden="true" className="size-5 animate-spin text-indigo-600" />
              Loading your quizzes…
            </div>
          ) : quizzes.length === 0 ? (
            <div className="flex min-h-72 flex-col items-center justify-center px-6 py-10 text-center">
              <span className="flex size-14 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-700">
                <BookOpenCheck aria-hidden="true" className="size-6" />
              </span>
              <h3 className="mt-5 text-lg font-semibold">Your first quiz starts here</h3>
              <p className="mt-2 max-w-sm text-sm leading-6 text-slate-500">
                Create a draft, add questions with four answer choices, and preview it before you start.
              </p>
              <Button
                type="button"
                onClick={() => navigate("/teacher/quizzes/new")}
                className="mt-5 h-11 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700"
              >
                <Plus aria-hidden="true" className="mr-2 size-4" />
                Create your first quiz
              </Button>
            </div>
          ) : (
            <>
              <div className="hidden grid-cols-[minmax(15rem,1fr)_8rem_8rem_9rem_9rem] items-center gap-4 bg-slate-50/80 px-6 py-3 text-[0.7rem] font-semibold uppercase tracking-[0.12em] text-slate-500 lg:grid">
                <span>Quiz</span><span>Status</span><span>Questions</span><span>Last updated</span><span className="text-right">Actions</span>
              </div>
              <ul className="divide-y divide-slate-100">
                {quizzes.map((quiz) => (
                  <li key={quiz.id} className="grid gap-4 px-5 py-5 transition hover:bg-slate-50/60 sm:px-6 lg:grid-cols-[minmax(15rem,1fr)_8rem_8rem_9rem_9rem] lg:items-center">
                    <div className="min-w-0">
                      <Link
                        to={quiz.status === "DRAFT" ? `/teacher/quizzes/${quiz.id}/edit` : `/teacher/quizzes/${quiz.id}/preview`}
                        className="truncate font-semibold text-slate-900 decoration-indigo-400 underline-offset-4 hover:text-indigo-700 hover:underline"
                      >
                        {quiz.title}
                      </Link>
                      <p className="mt-1 truncate text-sm text-slate-500">{quiz.description || "No description yet"}</p>
                      <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500 lg:hidden">
                        <Clock3 aria-hidden="true" className="size-3.5" /> {quiz.durationMinutes} min
                        <span className="mx-1">·</span>{quiz.questionCount} questions
                      </p>
                    </div>
                    <div><StatusBadge status={quiz.status} /></div>
                    <div className="hidden text-sm text-slate-600 lg:block">{quiz.questionCount}</div>
                    <div className="hidden text-xs text-slate-500 lg:block">{new Date(quiz.updatedAt).toLocaleDateString()}</div>
                    <div className="flex flex-wrap items-center gap-2 md:justify-end">
                      {quiz.status === "DRAFT" ? (
                        <>
                          <Button type="button" variant="outline" onClick={() => navigate(`/teacher/quizzes/${quiz.id}/edit`)} className="h-9 rounded-lg px-3">
                            <Pencil aria-hidden="true" className="mr-1.5 size-3.5" /> Edit
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            disabled={deletingId === quiz.id}
                            aria-label={`Delete ${quiz.title}`}
                            onClick={() => deleteQuiz(quiz)}
                            className="size-9 rounded-lg px-0 text-slate-500 hover:bg-rose-50 hover:text-rose-700"
                          >
                            {deletingId === quiz.id ? <LoaderCircle aria-hidden="true" className="size-4 animate-spin" /> : <Trash2 aria-hidden="true" className="size-4" />}
                          </Button>
                        </>
                      ) : (
                        <>
                          {quiz.status === "ACTIVE" ? (
                            <Button type="button" variant="outline" onClick={() => navigate(`/teacher/quizzes/${quiz.id}/monitor`)} className="h-9 rounded-lg px-3">
                              <Monitor aria-hidden="true" className="mr-1.5 size-3.5" /> Monitor
                            </Button>
                          ) : (
                            <Button type="button" variant="outline" onClick={() => navigate(`/teacher/quizzes/${quiz.id}/results`)} className="h-9 rounded-lg px-3">
                              <Award aria-hidden="true" className="mr-1.5 size-3.5" /> Results
                            </Button>
                          )}
                          <Button type="button" variant="ghost" onClick={() => navigate(`/teacher/quizzes/${quiz.id}/preview`)} className="h-9 rounded-lg px-3">
                            <Eye aria-hidden="true" className="mr-1.5 size-3.5" /> Preview
                          </Button>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
        <p className="mt-5 flex items-center gap-2 text-xs text-slate-400">
          <ShieldCheck aria-hidden="true" className="size-3.5" />
          Quiz changes are saved to your local ExamFlow database.
        </p>
      </main>
    </TeacherLayout>
  );
}

function QuizMetadataForm({ initialValues, submitLabel, onSubmit, disabled = false }) {
  const form = useForm({
    resolver: zodResolver(quizFormSchema),
    defaultValues: initialValues ?? {
      title: "",
      description: "",
      instructions: "",
      durationMinutes: 30,
    },
  });

  useEffect(() => {
    if (initialValues) form.reset(initialValues);
  }, [initialValues, form]);

  return (
    <form className="space-y-5" onSubmit={form.handleSubmit(onSubmit)} noValidate>
      <div>
        <label htmlFor="quiz-title" className="mb-2 block text-sm font-medium text-slate-800">Quiz title</label>
        <Input id="quiz-title" placeholder="e.g. Introduction to Operating Systems" disabled={disabled} className={inputClass} {...form.register("title")} />
        <ErrorMessage>{form.formState.errors.title?.message}</ErrorMessage>
      </div>
      <div>
        <label htmlFor="quiz-description" className="mb-2 block text-sm font-medium text-slate-800">Description <span className="font-normal text-slate-400">(optional)</span></label>
        <textarea id="quiz-description" rows={3} maxLength={1000} disabled={disabled} placeholder="What will students be assessed on?" className="w-full resize-y rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-sm leading-6 text-slate-900 outline-none placeholder:text-slate-400 focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100 disabled:bg-slate-50" {...form.register("description")} />
        <ErrorMessage>{form.formState.errors.description?.message}</ErrorMessage>
      </div>
      <div>
        <label htmlFor="quiz-instructions" className="mb-2 block text-sm font-medium text-slate-800">Student instructions <span className="font-normal text-slate-400">(optional)</span></label>
        <textarea id="quiz-instructions" rows={3} maxLength={2000} disabled={disabled} placeholder="Add any guidance students should read before starting." className="w-full resize-y rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-sm leading-6 text-slate-900 outline-none placeholder:text-slate-400 focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100 disabled:bg-slate-50" {...form.register("instructions")} />
        <ErrorMessage>{form.formState.errors.instructions?.message}</ErrorMessage>
      </div>
      <div className="max-w-xs">
        <label htmlFor="quiz-duration" className="mb-2 block text-sm font-medium text-slate-800">Duration <span className="font-normal text-slate-400">(minutes)</span></label>
        <Input id="quiz-duration" type="number" min="1" max="1440" step="1" disabled={disabled} className={inputClass} {...form.register("durationMinutes")} />
        <ErrorMessage>{form.formState.errors.durationMinutes?.message}</ErrorMessage>
      </div>
      {!disabled && (
        <Button type="submit" disabled={form.formState.isSubmitting} className="h-11 rounded-xl bg-indigo-600 px-4 text-white hover:bg-indigo-700">
          {form.formState.isSubmitting ? <LoaderCircle aria-hidden="true" className="mr-2 size-4 animate-spin" /> : null}
          {submitLabel}
          <ArrowRight aria-hidden="true" className="ml-2 size-4" />
        </Button>
      )}
    </form>
  );
}

export function CreateQuizPage() {
  const navigate = useNavigate();
  const [error, setError] = useState("");

  async function createQuiz(values) {
    setError("");
    try {
      const csrf = await apiRequest("/api/auth/csrf", { cache: "no-store" });
      const result = await apiRequest("/api/quizzes", {
        method: "POST",
        csrfToken: csrf.csrfToken,
        body: JSON.stringify(values),
      });
      navigate(`/teacher/quizzes/${result.quiz.id}/edit`, {
        replace: true,
        state: { notice: "Draft created. Add your questions below." },
      });
    } catch (requestError) {
      setError(requestError.message ?? "Could not create the quiz.");
    }
  }

  return (
    <TeacherLayout>
      <main className="mx-auto max-w-7xl px-4 pb-12 pt-8 sm:px-7 sm:pt-10">
        <Link to="/teacher/dashboard" className="inline-flex min-h-10 items-center gap-2 text-sm font-medium text-slate-500 hover:text-indigo-700">
          <ArrowLeft aria-hidden="true" className="size-4" /> All quizzes
        </Link>
        <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(17rem,0.7fr)]">
          <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-8">
            <PageHeading eyebrow="NEW ASSESSMENT" title="Create a quiz" description="Start with the essentials. You can add questions and preview the draft next." />
            {error && <div className="mt-6"><Notice tone="error">{error}</Notice></div>}
            <div className="mt-8">
              <QuizMetadataForm submitLabel="Create draft" onSubmit={createQuiz} />
            </div>
          </section>
          <aside className="h-fit rounded-2xl border border-indigo-100 bg-indigo-50/70 p-6">
            <span className="flex size-10 items-center justify-center rounded-xl bg-white text-indigo-700 shadow-sm">
              <CircleHelp aria-hidden="true" className="size-5" />
            </span>
            <h2 className="mt-5 font-semibold text-slate-900">A good place to begin</h2>
            <ul className="mt-4 space-y-3 text-sm leading-6 text-slate-600">
              <li className="flex gap-2"><Check aria-hidden="true" className="mt-1 size-4 shrink-0 text-indigo-600" />Choose a clear, recognizable title.</li>
              <li className="flex gap-2"><Check aria-hidden="true" className="mt-1 size-4 shrink-0 text-indigo-600" />Set the time students will have.</li>
              <li className="flex gap-2"><Check aria-hidden="true" className="mt-1 size-4 shrink-0 text-indigo-600" />Add at least one four-option question before starting.</li>
            </ul>
            <p className="mt-5 border-t border-indigo-100 pt-4 text-xs leading-5 text-slate-500">
              Your quiz is saved as a draft. It will not become active until you start it.
            </p>
          </aside>
        </div>
      </main>
    </TeacherLayout>
  );
}

function createEmptyQuestion(order = 1) {
  return {
    text: "",
    options: Array.from({ length: 4 }, (_, index) => ({
      // IDs only need to be unique within this question; work on LAN HTTP too.
      id: `option-${index + 1}`,
      text: "",
      label: String.fromCharCode(65 + index),
    })),
    correctOptionId: "",
    marks: 1,
    order,
  };
}

function QuestionForm({ initialQuestion, nextOrder, onSave, onCancel, disabled }) {
  const form = useForm({
    resolver: zodResolver(questionFormSchema),
    defaultValues: initialQuestion ?? createEmptyQuestion(nextOrder),
  });
  const errors = form.formState.errors;

  useEffect(() => {
    form.reset(initialQuestion ?? createEmptyQuestion(nextOrder));
  }, [initialQuestion, nextOrder, form]);

  async function submit(values) {
    const saved = await onSave({
      ...values,
      marks: Number(values.marks),
      order: Number(values.order),
    });
    if (saved && !initialQuestion) form.reset(createEmptyQuestion(nextOrder + 1));
  }

  return (
    <form onSubmit={form.handleSubmit(submit)} className="space-y-5" noValidate>
      <div>
        <label htmlFor="question-text" className="mb-2 block text-sm font-medium text-slate-800">Question</label>
        <textarea id="question-text" rows={3} disabled={disabled} placeholder="Write the question prompt…" className="w-full resize-y rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-sm leading-6 text-slate-900 outline-none placeholder:text-slate-400 focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100 disabled:bg-slate-50" {...form.register("text")} />
        <ErrorMessage>{errors.text?.message}</ErrorMessage>
      </div>
      <fieldset disabled={disabled}>
        <legend className="text-sm font-medium text-slate-800">Answer options</legend>
        <p className="mb-3 mt-1 text-xs text-slate-500">Enter exactly four options and mark the correct answer.</p>
        <div className="space-y-2.5">
          {[0, 1, 2, 3].map((index) => {
            const option = form.watch(`options.${index}`);
            return (
              <div key={option?.id ?? index} className={classNames("flex items-center gap-3 rounded-xl border p-2.5 transition", form.watch("correctOptionId") === option?.id ? "border-indigo-200 bg-indigo-50/50" : "border-slate-200 bg-white")}>
                <input
                  type="radio"
                  aria-label={`Mark option ${String.fromCharCode(65 + index)} correct`}
                  value={option?.id}
                  checked={form.watch("correctOptionId") === option?.id}
                  onChange={() => form.setValue("correctOptionId", option?.id, { shouldValidate: true })}
                  className="size-4 accent-indigo-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-600"
                />
                <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-xs font-semibold text-slate-600">{String.fromCharCode(65 + index)}</span>
                <Input
                  aria-label={`Option ${String.fromCharCode(65 + index)}`}
                  placeholder={`Answer option ${String.fromCharCode(65 + index)}`}
                  className={classNames("h-10 min-w-0 flex-1 border-transparent bg-transparent shadow-none focus-visible:border-indigo-300 focus-visible:ring-2", form.watch("correctOptionId") === option?.id && "font-medium")}
                  {...form.register(`options.${index}.text`)}
                />
                {form.watch("correctOptionId") === option?.id && <CheckCircle2 aria-label="Correct option" className="size-4 shrink-0 text-indigo-600" />}
              </div>
            );
          })}
        </div>
        <ErrorMessage>{errors.options?.message ?? errors.options?.root?.message ?? errors.options?.[0]?.text?.message ?? errors.options?.[1]?.text?.message ?? errors.options?.[2]?.text?.message ?? errors.options?.[3]?.text?.message}</ErrorMessage>
      </fieldset>
      <ErrorMessage>{errors.correctOptionId?.message}</ErrorMessage>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="question-marks" className="mb-2 block text-sm font-medium text-slate-800">Marks</label>
          <Input id="question-marks" type="number" min="0.01" step="0.01" disabled={disabled} className={inputClass} {...form.register("marks")} />
          <ErrorMessage>{errors.marks?.message}</ErrorMessage>
        </div>
        <div>
          <label htmlFor="question-order" className="mb-2 block text-sm font-medium text-slate-800">Display order</label>
          <Input id="question-order" type="number" min="1" step="1" disabled={disabled} className={inputClass} {...form.register("order")} />
          <ErrorMessage>{errors.order?.message}</ErrorMessage>
        </div>
      </div>
      {!disabled && (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
          <Button type="submit" disabled={form.formState.isSubmitting} className="h-10 rounded-xl bg-indigo-600 text-white hover:bg-indigo-700">
            {form.formState.isSubmitting ? <LoaderCircle aria-hidden="true" className="mr-2 size-4 animate-spin" /> : <Check aria-hidden="true" className="mr-2 size-4" />}
            {initialQuestion ? "Save changes" : "Add question"}
          </Button>
          {initialQuestion && <Button type="button" variant="outline" onClick={onCancel} className="h-10 rounded-xl">Cancel</Button>}
        </div>
      )}
    </form>
  );
}

function EventReadinessNotice({ eventDelivery }) {
  if (!eventDelivery) return null;
  const isDelivered = eventDelivery.status === "accepted_by_java";
  const isConfigured = eventDelivery.status !== "not_configured";
  return (
    <Notice tone={isDelivered ? "success" : isConfigured ? "error" : "warning"}>
      {isDelivered
        ? "Quiz state was saved and the live notification was accepted by the Java TCP server."
        : isConfigured
          ? "Quiz state was saved, but the live notification could not be delivered. Refresh to sync the latest state."
          : "Quiz state was saved. Live notifications are not configured; refresh to sync the latest state."}
    </Notice>
  );
}

function QuizLifecycleActions({ quiz, questionCount, onLifecycle, busy }) {
  if (quiz.status === "DRAFT") {
    return (
      <Button
        type="button"
        disabled={busy || questionCount < 1}
        onClick={() => onLifecycle("start")}
        title={questionCount < 1 ? "Add at least one question before starting" : undefined}
        className="h-10 rounded-xl bg-indigo-600 px-4 text-white hover:bg-indigo-700"
      >
        {busy ? <LoaderCircle aria-hidden="true" className="mr-2 size-4 animate-spin" /> : <Rocket aria-hidden="true" className="mr-2 size-4" />}
        Start quiz
      </Button>
    );
  }
  if (quiz.status === "ACTIVE") {
    return (
      <Button
        type="button"
        disabled={busy}
        onClick={() => onLifecycle("end")}
        className="h-10 rounded-xl bg-rose-600 px-4 text-white hover:bg-rose-700"
      >
        {busy ? <LoaderCircle aria-hidden="true" className="mr-2 size-4 animate-spin" /> : <X aria-hidden="true" className="mr-2 size-4" />}
        End quiz
      </Button>
    );
  }
  return null;
}

export function EditQuizPage() {
  const { quizId } = useParams();
  const navigate = useNavigate();
  const [quiz, setQuiz] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editingQuestion, setEditingQuestion] = useState(null);
  const [questionFormOpen, setQuestionFormOpen] = useState(false);
  const [savingQuestion, setSavingQuestion] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [eventDelivery, setEventDelivery] = useState(null);

  const loadQuiz = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const data = await apiRequest(`/api/quizzes/${quizId}`, { cache: "no-store" });
      setQuiz(data.quiz);
      setQuestions(data.questions);
    } catch (requestError) {
      setError(requestError.message ?? "Could not load this quiz.");
    } finally {
      setLoading(false);
    }
  }, [quizId]);

  useEffect(() => {
    loadQuiz();
  }, [loadQuiz]);

  async function saveMetadata(values) {
    setError("");
    try {
      const csrf = await apiRequest("/api/auth/csrf", { cache: "no-store" });
      const data = await apiRequest(`/api/quizzes/${quizId}`, {
        method: "PATCH",
        csrfToken: csrf.csrfToken,
        body: JSON.stringify(values),
      });
      setQuiz(data.quiz);
      setNotice("Quiz details saved.");
    } catch (requestError) {
      setError(requestError.message ?? "Could not save quiz details.");
    }
  }

  async function saveQuestion(values) {
    setSavingQuestion(true);
    setError("");
    try {
      const csrf = await apiRequest("/api/auth/csrf", { cache: "no-store" });
      const isEditing = Boolean(editingQuestion);
      const endpoint = isEditing
        ? `/api/quizzes/${quizId}/questions/${editingQuestion.id}`
        : `/api/quizzes/${quizId}/questions`;
      const data = await apiRequest(endpoint, {
        method: isEditing ? "PUT" : "POST",
        csrfToken: csrf.csrfToken,
        body: JSON.stringify(values),
      });
      setQuestions((current) =>
        isEditing
          ? current.map((question) => question.id === data.question.id ? data.question : question).sort((a, b) => a.order - b.order)
          : [...current, data.question].sort((a, b) => a.order - b.order),
      );
      setEditingQuestion(null);
      setQuestionFormOpen(false);
      setNotice(isEditing ? "Question updated." : "Question added.");
      return true;
    } catch (requestError) {
      setError(requestError.message ?? "Could not save this question.");
      return false;
    } finally {
      setSavingQuestion(false);
    }
  }

  async function deleteQuestion(question) {
    if (!window.confirm("Remove this question from the draft?")) return;
    setError("");
    try {
      const csrf = await apiRequest("/api/auth/csrf", { cache: "no-store" });
      await apiRequest(`/api/quizzes/${quizId}/questions/${question.id}`, {
        method: "DELETE",
        csrfToken: csrf.csrfToken,
      });
      setQuestions((current) => current.filter((entry) => entry.id !== question.id));
      setNotice("Question removed.");
    } catch (requestError) {
      setError(requestError.message ?? "Could not remove the question.");
    }
  }

  async function changeLifecycle(action) {
    const verb = action === "start" ? "start" : "end";
    if (!window.confirm(`${action === "start" ? "Start" : "End"} "${quiz.title}"?`)) return;
    setLifecycleBusy(true);
    setError("");
    setNotice("");
    try {
      const csrf = await apiRequest("/api/auth/csrf", { cache: "no-store" });
      const data = await apiRequest(`/api/quizzes/${quizId}/${verb}`, {
        method: "POST",
        csrfToken: csrf.csrfToken,
      });
      setQuiz(data.quiz);
      setEventDelivery(data.eventDelivery);
      setNotice(action === "start" ? "Quiz is now active." : "Quiz is now completed.");
      setEditingQuestion(null);
      setQuestionFormOpen(false);
    } catch (requestError) {
      setError(requestError.message ?? `Could not ${verb} this quiz.`);
    } finally {
      setLifecycleBusy(false);
    }
  }

  if (loading) {
    return <TeacherLayout><main className="mx-auto flex min-h-[60vh] max-w-7xl items-center justify-center gap-3 px-4 text-sm text-slate-500"><LoaderCircle aria-hidden="true" className="size-5 animate-spin text-indigo-600" />Loading quiz…</main></TeacherLayout>;
  }
  if (!quiz) {
    return <TeacherLayout><main className="mx-auto max-w-3xl px-4 py-16"><Notice tone="error">{error || "Quiz not found."}</Notice><Link to="/teacher/dashboard" className="mt-5 inline-flex items-center gap-2 text-sm font-medium text-indigo-700"><ArrowLeft aria-hidden="true" className="size-4" />Back to quizzes</Link></main></TeacherLayout>;
  }

  const editable = quiz.status === "DRAFT";

  return (
    <TeacherLayout>
      <main className="mx-auto max-w-7xl px-4 pb-14 pt-7 sm:px-7 sm:pt-9">
        <Link to="/teacher/dashboard" className="inline-flex min-h-9 items-center gap-2 text-sm font-medium text-slate-500 hover:text-indigo-700">
          <ArrowLeft aria-hidden="true" className="size-4" /> All quizzes
        </Link>
        <div className="mt-4 flex flex-col justify-between gap-5 sm:flex-row sm:items-start">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="max-w-3xl break-words text-3xl font-semibold tracking-[-0.035em] text-slate-950">{quiz.title}</h1>
              <StatusBadge status={quiz.status} />
            </div>
            <p className="mt-2 text-sm text-slate-500">{quiz.description || "No description yet"} <span className="mx-1.5">·</span> {quiz.durationMinutes} minutes <span className="mx-1.5">·</span> {questions.length} questions</p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => navigate(`/teacher/quizzes/${quizId}/preview`)} className="h-10 rounded-xl">
              <Eye aria-hidden="true" className="mr-2 size-4" /> Preview
            </Button>
            <QuizLifecycleActions quiz={quiz} questionCount={questions.length} onLifecycle={changeLifecycle} busy={lifecycleBusy} />
          </div>
        </div>

        {error && <div className="mt-5"><Notice tone="error">{error}</Notice></div>}
        {notice && <div className="mt-5"><Notice tone="success">{notice}</Notice></div>}
        <div className="mt-5">
          <EventReadinessNotice eventDelivery={eventDelivery} />
        </div>

        <div className="mt-7 grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(19rem,0.72fr)]">
          <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-7">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Questions</h2>
                <p className="mt-1 text-sm text-slate-500">Four options per question; choose one correct answer.</p>
              </div>
              {editable && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={questionFormOpen || Boolean(editingQuestion)}
                  onClick={() => setQuestionFormOpen(true)}
                  className="h-10 rounded-xl"
                >
                  <Plus aria-hidden="true" className="mr-2 size-4" /> Add question
                </Button>
              )}
            </div>
            {!editable && (
              <div className="mt-5"><Notice tone="info">Questions are locked because this quiz has started. They cannot be added, changed, or removed.</Notice></div>
            )}
            {questionFormOpen && editable && (
              <div className="mt-6 rounded-2xl border border-indigo-100 bg-indigo-50/30 p-4 sm:p-5">
                <h3 className="mb-5 font-semibold">{editingQuestion ? "Edit question" : "Add a question"}</h3>
                <QuestionForm
                  key={editingQuestion?.id ?? `new-${questions.length}`}
                  initialQuestion={editingQuestion}
                  nextOrder={questions.reduce((max, question) => Math.max(max, question.order), 0) + 1}
                  disabled={savingQuestion}
                  onSave={saveQuestion}
                  onCancel={() => { setEditingQuestion(null); setQuestionFormOpen(false); }}
                />
              </div>
            )}
            <div className="mt-5 space-y-3">
              {questions.length === 0 && !questionFormOpen ? (
                <div className="rounded-2xl border border-dashed border-slate-300 px-5 py-10 text-center">
                  <FileQuestion aria-hidden="true" className="mx-auto size-7 text-slate-400" />
                  <p className="mt-3 text-sm font-medium text-slate-700">No questions yet</p>
                  <p className="mt-1 text-xs text-slate-500">Add at least one question before starting your quiz.</p>
                </div>
              ) : questions.map((question) => (
                <article key={question.id} className="rounded-2xl border border-slate-200 p-4 sm:p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 gap-3">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-xs font-semibold text-indigo-700">{question.order}</span>
                      <div className="min-w-0">
                        <p className="whitespace-pre-wrap text-sm font-medium leading-6 text-slate-900">{question.text}</p>
                        <div className="mt-3 grid gap-2 sm:grid-cols-2">
                          {question.options.map((option, index) => (
                            <div key={option.id} className={classNames("flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2 text-xs", option.id === question.correctOptionId ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-slate-100 bg-slate-50 text-slate-600")}>
                              {option.id === question.correctOptionId ? <CheckCircle2 aria-hidden="true" className="size-3.5 shrink-0" /> : <span className="w-3.5 shrink-0 text-center">{String.fromCharCode(65 + index)}</span>}
                              <span className="break-words">{option.text}</span>
                              {option.id === question.correctOptionId && <span className="ml-auto shrink-0 font-medium">Correct</span>}
                            </div>
                          ))}
                        </div>
                        <p className="mt-3 text-xs text-slate-500">{question.marks} {question.marks === 1 ? "mark" : "marks"}</p>
                      </div>
                    </div>
                    {editable && !questionFormOpen && (
                      <div className="flex shrink-0 items-center gap-1">
                        <Button type="button" variant="ghost" aria-label={`Edit question ${question.order}`} onClick={() => { setEditingQuestion(question); setQuestionFormOpen(true); }} className="size-9 rounded-lg px-0 text-slate-500 hover:text-indigo-700">
                          <Pencil aria-hidden="true" className="size-4" />
                        </Button>
                        <Button type="button" variant="ghost" aria-label={`Delete question ${question.order}`} onClick={() => deleteQuestion(question)} className="size-9 rounded-lg px-0 text-slate-500 hover:bg-rose-50 hover:text-rose-700">
                          <Trash2 aria-hidden="true" className="size-4" />
                        </Button>
                      </div>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>

          <aside className="space-y-5">
            <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm sm:p-6">
              <div className="flex items-start gap-3">
                <span className="flex size-9 items-center justify-center rounded-xl bg-indigo-50 text-indigo-700"><Pencil aria-hidden="true" className="size-4" /></span>
                <div><h2 className="font-semibold">Quiz details</h2><p className="mt-1 text-xs text-slate-500">Title, overview and time limit</p></div>
              </div>
              <div className="mt-5">
                {editable ? (
                  <QuizMetadataForm
                    key={quiz.updatedAt}
                    initialValues={{
                      title: quiz.title,
                      description: quiz.description,
                      instructions: quiz.instructions,
                      durationMinutes: quiz.durationMinutes,
                    }}
                    submitLabel="Save details"
                    onSubmit={saveMetadata}
                  />
                ) : (
                  <dl className="space-y-4 text-sm">
                    <div><dt className="text-xs text-slate-500">Title</dt><dd className="mt-1 font-medium">{quiz.title}</dd></div>
                    <div><dt className="text-xs text-slate-500">Instructions</dt><dd className="mt-1 whitespace-pre-wrap leading-6 text-slate-700">{quiz.instructions || "No instructions provided."}</dd></div>
                    <div><dt className="text-xs text-slate-500">Duration</dt><dd className="mt-1 font-medium">{quiz.durationMinutes} minutes</dd></div>
                  </dl>
                )}
              </div>
            </section>
            <section className="rounded-2xl border border-amber-200/70 bg-amber-50/60 p-5">
              <h2 className="font-semibold text-slate-900">Before you start</h2>
              <ul className="mt-3 space-y-2.5 text-sm leading-5 text-slate-600">
                <li className="flex gap-2"><Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-emerald-600" /> Review every question in preview.</li>
                <li className="flex gap-2"><Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-emerald-600" /> Each question has four options and one correct answer.</li>
                <li className="flex gap-2"><Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-emerald-600" /> Starting locks the question set and activates the quiz.</li>
              </ul>
              <p className="mt-4 border-t border-amber-200/70 pt-3 text-xs leading-5 text-slate-500">
                TCP event publishing is an integration point only; event delivery is not enabled yet.
              </p>
            </section>
          </aside>
        </div>
      </main>
    </TeacherLayout>
  );
}

export function PreviewQuizPage() {
  const { quizId } = useParams();
  const [quiz, setQuiz] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [eventDelivery, setEventDelivery] = useState(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await apiRequest(`/api/quizzes/${quizId}`, { cache: "no-store" });
      setQuiz(data.quiz);
      setQuestions(data.questions);
    } catch (requestError) {
      setError(requestError.message ?? "Could not load quiz preview.");
    } finally {
      setLoading(false);
    }
  }, [quizId]);

  useEffect(() => { load(); }, [load]);

  async function changeLifecycle(action) {
    if (!window.confirm(`${action === "start" ? "Start" : "End"} "${quiz.title}"?`)) return;
    setBusy(true);
    setError("");
    try {
      const csrf = await apiRequest("/api/auth/csrf", { cache: "no-store" });
      const data = await apiRequest(`/api/quizzes/${quizId}/${action}`, {
        method: "POST",
        csrfToken: csrf.csrfToken,
      });
      setQuiz(data.quiz);
      setEventDelivery(data.eventDelivery);
    } catch (requestError) {
      setError(requestError.message ?? `Could not ${action} this quiz.`);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <TeacherLayout><main className="mx-auto flex min-h-[60vh] max-w-7xl items-center justify-center gap-3 px-4 text-sm text-slate-500"><LoaderCircle aria-hidden="true" className="size-5 animate-spin text-indigo-600" />Loading preview…</main></TeacherLayout>;
  }
  if (!quiz) {
    return <TeacherLayout><main className="mx-auto max-w-3xl px-4 py-16"><Notice tone="error">{error || "Quiz not found."}</Notice></main></TeacherLayout>;
  }

  return (
    <TeacherLayout>
      <main className="mx-auto max-w-5xl px-4 pb-14 pt-7 sm:px-7 sm:pt-9">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link to={quiz.status === "DRAFT" ? `/teacher/quizzes/${quizId}/edit` : "/teacher/dashboard"} className="inline-flex min-h-10 items-center gap-2 text-sm font-medium text-slate-500 hover:text-indigo-700">
            <ArrowLeft aria-hidden="true" className="size-4" /> {quiz.status === "DRAFT" ? "Back to editing" : "All quizzes"}
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            {quiz.status === "DRAFT" && <Button type="button" variant="outline" onClick={() => navigate(`/teacher/quizzes/${quizId}/edit`)} className="h-10 rounded-xl"><Pencil aria-hidden="true" className="mr-2 size-4" /> Edit draft</Button>}
            <QuizLifecycleActions quiz={quiz} questionCount={questions.length} onLifecycle={changeLifecycle} busy={busy} />
          </div>
        </div>
        {error && <div className="mt-5"><Notice tone="error">{error}</Notice></div>}
        {eventDelivery && <div className="mt-5"><EventReadinessNotice eventDelivery={eventDelivery} /></div>}
        <section className="mt-6 overflow-hidden rounded-3xl border border-slate-200/80 bg-white shadow-sm">
          <div className="bg-[radial-gradient(ellipse_at_85%_0%,#4f46e5_0%,#29245f_43%,#111827_100%)] px-6 py-8 text-white sm:px-9 sm:py-10">
            <div className="flex flex-wrap items-center gap-3"><StatusBadge status={quiz.status} /><span className="text-sm text-indigo-100">{quiz.durationMinutes} minutes</span><span className="text-sm text-indigo-100">·</span><span className="text-sm text-indigo-100">{questions.length} questions</span></div>
            <h1 className="mt-5 text-3xl font-semibold tracking-tight sm:text-4xl">{quiz.title}</h1>
            {quiz.description && <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">{quiz.description}</p>}
            {quiz.instructions && <div className="mt-6 max-w-2xl rounded-xl border border-white/10 bg-white/[0.07] p-4"><p className="text-xs font-semibold uppercase tracking-wide text-indigo-200">Instructions</p><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-200">{quiz.instructions}</p></div>}
          </div>
          <div className="space-y-5 p-5 sm:p-8">
            {questions.map((question, index) => (
              <article key={question.id} className="rounded-2xl border border-slate-200 p-4 sm:p-6">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex gap-3"><span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-xs font-semibold text-indigo-700">{index + 1}</span><h2 className="pt-1 text-sm font-semibold leading-6 text-slate-900 sm:text-base">{question.text}</h2></div>
                  <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">{question.marks} {question.marks === 1 ? "mark" : "marks"}</span>
                </div>
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  {question.options.map((option, optionIndex) => (
                    <div key={option.id} className={classNames("flex items-center gap-3 rounded-xl border px-3.5 py-3 text-sm", option.id === question.correctOptionId ? "border-emerald-200 bg-emerald-50/60 text-emerald-900" : "border-slate-200 bg-white text-slate-700")}>
                      <span className={classNames("flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold", option.id === question.correctOptionId ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-600")}>{String.fromCharCode(65 + optionIndex)}</span>
                      <span>{option.text}</span>
                      {option.id === question.correctOptionId && <CheckCircle2 aria-label="Correct answer" className="ml-auto size-4 shrink-0 text-emerald-600" />}
                    </div>
                  ))}
                </div>
              </article>
            ))}
            {questions.length === 0 && <div className="rounded-2xl border border-dashed border-slate-300 px-5 py-10 text-center text-sm text-slate-500">This draft has no questions yet. Add questions before starting.</div>}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-100 bg-slate-50/70 px-5 py-5 sm:px-8">
            <p className="text-xs leading-5 text-slate-500">Preview for teacher review. The highlighted answer is not shown to students.</p>
            <QuizLifecycleActions quiz={quiz} questionCount={questions.length} onLifecycle={changeLifecycle} busy={busy} />
          </div>
        </section>
        <div className="mt-5 flex items-start gap-2 text-xs leading-5 text-slate-500"><ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />Only you can view this preview. MongoDB remains authoritative; live updates are relayed through Java TCP and the authenticated browser event stream.</div>
      </main>
    </TeacherLayout>
  );
}

function TeacherQuizReportPage({ mode }) {
  const { quizId } = useParams();
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const isMonitor = mode === "monitor";

  const loadReport = useCallback(async () => {
    setError("");
    try {
      const data = await apiRequest(`/api/quizzes/${quizId}/${mode}`, { cache: "no-store" });
      setReport(data);
    } catch (requestError) {
      setError(requestError.message ?? `Could not load quiz ${mode}.`);
    } finally {
      setLoading(false);
    }
  }, [mode, quizId]);

  useEffect(() => {
    loadReport();
    const handleRefresh = (event) => {
      if (event.detail?.source === "rest" || event.detail?.payload?.quizId === quizId) loadReport();
    };
    window.addEventListener("examflow:refresh", handleRefresh);
    return () => window.removeEventListener("examflow:refresh", handleRefresh);
  }, [loadReport, quizId]);

  return (
    <TeacherLayout>
      <main className="mx-auto max-w-7xl px-4 pb-12 pt-8 sm:px-7 sm:pt-10">
        <PageHeading
          eyebrow={isMonitor ? "LIVE CLASSROOM" : "ASSESSMENT RESULTS"}
          title={report?.quiz?.title ?? (isMonitor ? "Live monitoring" : "Quiz results")}
          description={isMonitor
            ? "Participation and submission status from the server, refreshed as Java TCP events arrive."
            : "Official marks calculated by the server for students who completed this quiz."}
          actions={
            <>
              <Button type="button" variant="outline" onClick={loadReport} disabled={loading} className="h-10 rounded-xl">
                {loading ? <LoaderCircle aria-hidden="true" className="mr-2 size-4 animate-spin" /> : null}
                Refresh
              </Button>
              <Button asChild variant="outline" className="h-10 rounded-xl">
                <Link to="/teacher/dashboard"><ArrowLeft aria-hidden="true" className="mr-2 size-4" />Quizzes</Link>
              </Button>
            </>
          }
        />
        {error && <div className="mt-6"><Notice tone="error">{error}</Notice></div>}
        {loading && !report ? (
          <div className="mt-8 flex min-h-48 items-center justify-center gap-3 text-sm text-slate-500" role="status">
            <LoaderCircle aria-hidden="true" className="size-5 animate-spin text-indigo-600" />
            Loading {isMonitor ? "live participation" : "released results"}…
          </div>
        ) : report ? (
          <>
            <section className="mt-8 grid gap-4 sm:grid-cols-3" aria-label={isMonitor ? "Participation counts" : "Result summary"}>
              {isMonitor ? (
                <>
                  <SummaryCard icon={UsersRound} label="Joined" value={report.counts.joined} detail="Unique quiz attempts" color="bg-indigo-50 text-indigo-700" />
                  <SummaryCard icon={Activity} label="In progress" value={report.counts.inProgress} detail="Not yet submitted" color="bg-amber-50 text-amber-700" />
                  <SummaryCard icon={CheckCircle2} label="Submitted" value={report.counts.submitted} detail="Submitted or auto-submitted" color="bg-emerald-50 text-emerald-700" />
                </>
              ) : (
                <>
                  <SummaryCard icon={UsersRound} label="Submissions" value={report.results.length} detail="Completed attempts" color="bg-indigo-50 text-indigo-700" />
                  <SummaryCard icon={Award} label="Average score" value={report.results.length
                    ? `${(report.results.reduce((total, result) => total + result.score, 0) / report.results.length).toFixed(1)}`
                    : "—"} detail="Marks across submitted attempts" color="bg-emerald-50 text-emerald-700" />
                  <SummaryCard icon={CheckCircle2} label="Results released" value={report.quiz.resultsReleased ? "Yes" : "No"} detail="Student result visibility" color="bg-slate-100 text-slate-700" />
                </>
              )}
            </section>
            <section className="mt-6 overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm">
              <div className="border-b border-slate-100 px-5 py-5 sm:px-6">
                <h2 className="font-semibold text-slate-900">{isMonitor ? "Participants" : "Student submissions"}</h2>
                <p className="mt-1 text-sm text-slate-500">{isMonitor ? "Latest server-recorded attempt state." : "Scores are authoritative and read from MongoDB."}</p>
              </div>
              {(() => {
                const rows = isMonitor ? report.participants : report.results;
                return rows.length ? (
                  <ul className="divide-y divide-slate-100">
                    {rows.map((entry) => (
                      <li key={entry.attemptId} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-slate-900">{isMonitor ? entry.name : entry.studentName}</p>
                          <p className="mt-1 truncate text-sm text-slate-500">{isMonitor ? entry.email : entry.studentEmail}</p>
                        </div>
                        <div className="flex flex-wrap items-center gap-3 text-sm">
                          <span className={classNames("rounded-full border px-2.5 py-1 text-xs font-semibold", entry.status === "IN_PROGRESS" ? "border-amber-200 bg-amber-50 text-amber-800" : "border-emerald-200 bg-emerald-50 text-emerald-800")}>
                            {entry.status.replaceAll("_", " ")}
                          </span>
                          {entry.score != null && <span className="font-semibold text-slate-800">{entry.score} / {entry.totalMarks}</span>}
                          <span className="text-xs text-slate-500">
                            {entry.submittedAt ? new Date(entry.submittedAt).toLocaleString()
                              : entry.startedAt ? `Started ${new Date(entry.startedAt).toLocaleString()}`
                                : "Not started"}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="px-5 py-10 text-center text-sm text-slate-500" role="status">
                    {isMonitor ? "No students have joined this quiz yet." : "No released submissions are available yet."}
                  </p>
                );
              })()}
            </section>
          </>
        ) : null}
      </main>
    </TeacherLayout>
  );
}

export function TeacherMonitorPage() {
  return <TeacherQuizReportPage mode="monitor" />;
}

export function TeacherResultsPage() {
  return <TeacherQuizReportPage mode="results" />;
}
