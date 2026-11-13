import { useEffect, useState } from "react";
import {
  ArrowRight,
  BookOpenCheck,
  GraduationCap,
  LogOut,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { Link, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { AuthProvider, useAuth } from "@/auth/AuthContext";
import { AuthLoading, AuthPage } from "@/auth/AuthPage";
import { apiRequest } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  CreateQuizPage,
  EditQuizPage,
  PreviewQuizPage,
  TeacherDashboardPage,
  TeacherMonitorPage,
  TeacherResultsPage,
} from "@/teacher/TeacherPages";
import {
  AvailableExamsPage,
  ExamAttemptPage,
  QuizDetailsPage,
  ResultDetailPage,
  ResultsPage,
  StudentDashboardPage,
} from "@/student/StudentPages";

function RoleRoute({ role, children }) {
  const { user, status } = useAuth();

  if (status === "loading") return <AuthLoading />;
  if (status === "error") return <ServiceUnavailable />;
  if (!user) {
    return <Navigate to={role === "STUDENT" ? "/student/login" : "/teacher/login"} replace />;
  }
  if (user.role !== role) {
    return <Navigate to={user.role === "STUDENT" ? "/student/dashboard" : "/teacher/dashboard"} replace />;
  }
  return children;
}

function DashboardPage({ role }) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [dashboard, setDashboard] = useState(null);
  const [error, setError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const isStudent = role === "STUDENT";
  const loginPath = isStudent ? "/student/login" : "/teacher/login";
  const title = isStudent ? "Your learning, in flow." : "Your classroom, in flow.";
  const WelcomeIcon = isStudent ? GraduationCap : UsersRound;

  useEffect(() => {
    let active = true;
    apiRequest(`/api/${role.toLowerCase()}/dashboard`, { cache: "no-store" })
      .then((data) => {
        if (active) setDashboard(data);
      })
      .catch((requestError) => {
        if (active) {
          setError(
            requestError.status === 401
              ? "Your session has expired. Sign in again to continue."
              : requestError.message,
          );
        }
      });
    return () => {
      active = false;
    };
  }, [role]);

  async function handleSignOut() {
    setSigningOut(true);
    setError("");
    try {
      await signOut();
      navigate(loginPath, { replace: true });
    } catch (requestError) {
      setError(requestError.message ?? "Could not sign out. Please try again.");
      setSigningOut(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex min-h-16 max-w-7xl items-center justify-between px-5 sm:px-8">
          <Link
            to={isStudent ? "/student/dashboard" : "/teacher/dashboard"}
            className="inline-flex items-center gap-2.5"
          >
            <span className="flex size-9 items-center justify-center rounded-xl bg-indigo-600 text-white">
              <BookOpenCheck aria-hidden="true" className="size-4.5" />
            </span>
            <span className="font-semibold tracking-tight">ExamFlow</span>
            <span className="hidden rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700 sm:inline-flex">
              {isStudent ? "Student" : "Teacher"}
            </span>
          </Link>
          <Button
            type="button"
            variant="ghost"
            disabled={signingOut}
            onClick={handleSignOut}
            className="text-slate-600 hover:text-slate-950"
          >
            <LogOut aria-hidden="true" className="mr-2 size-4" />
            {signingOut ? "Signing out…" : "Sign out"}
          </Button>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-5 py-10 sm:px-8 sm:py-14">
        <section className="relative overflow-hidden rounded-3xl bg-[radial-gradient(ellipse_at_75%_0%,#4f46e5_0%,#26235f_39%,#111827_100%)] px-6 py-10 text-white shadow-xl shadow-indigo-950/10 sm:px-10 sm:py-12">
          <div
            aria-hidden="true"
            className="absolute -right-20 -top-32 size-80 rounded-full border border-white/10"
          />
          <div className="relative max-w-2xl">
            <div className="mb-7 flex size-12 items-center justify-center rounded-2xl border border-white/15 bg-white/10">
              <WelcomeIcon aria-hidden="true" className="size-6" />
            </div>
            <p className="text-sm font-medium text-indigo-200">
              {isStudent ? "STUDENT WORKSPACE" : "TEACHER WORKSPACE"}
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
            <p className="mt-3 max-w-xl text-sm leading-6 text-slate-300 sm:text-base">
              {user.name ? `Welcome, ${user.name}. ` : "Welcome. "}
              {isStudent
                ? "Your account is ready. Available assessments and results will appear here."
                : "Your teacher account is ready. Your quizzes and class activity will appear here."}
            </p>
          </div>
        </section>

        {error && (
          <div
            role="alert"
            className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
          >
            <span>{error}</span>
            {error.includes("expired") && (
              <Link to={loginPath} className="font-semibold underline underline-offset-4">
                Sign in again
              </Link>
            )}
          </div>
        )}

        <section className="mt-8 grid gap-5 md:grid-cols-2">
          <article className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex size-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-700">
              <WelcomeIcon aria-hidden="true" className="size-5" />
            </div>
            <h2 className="mt-5 text-lg font-semibold">
              {isStudent ? "Ready when you are" : "Your teaching hub"}
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              {isStudent
                ? dashboard?.availableQuizzes?.length
                  ? "Your available assessments are ready to explore."
                  : "There are no active assessments just yet. Check back soon."
                : dashboard?.quizzes?.length
                  ? "Your quizzes are ready to manage."
                  : "Your quizzes will appear here when you create them."}
            </p>
            <div className="mt-5 inline-flex items-center gap-2 text-sm font-medium text-indigo-700">
              {isStudent ? "Student dashboard" : "Teacher dashboard"}
              <ArrowRight aria-hidden="true" className="size-4" />
            </div>
          </article>
          <article className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex size-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700">
              <ShieldCheck aria-hidden="true" className="size-5" />
            </div>
            <h2 className="mt-5 text-lg font-semibold">Your account is secure</h2>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              Signed in as <span className="font-medium text-slate-700">{user.email}</span>. Your
              session is protected and can be ended at any time.
            </p>
            <Button
              type="button"
              variant="outline"
              disabled={signingOut}
              onClick={handleSignOut}
              className="mt-5"
            >
              Sign out securely
            </Button>
          </article>
        </section>
      </div>
    </main>
  );
}

function ServiceUnavailable() {
  const { retrySession } = useAuth();

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-6">
      <section className="max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center">
        <h1 className="text-xl font-semibold">ExamFlow is unavailable</h1>
        <p className="mt-2 text-sm text-slate-600">
          We could not restore your session. Check the API and local MongoDB, then reload.
        </p>
        <Button
          type="button"
          onClick={retrySession}
          className="mt-6 bg-indigo-600 text-white hover:bg-indigo-700"
        >
          Retry
        </Button>
      </section>
    </main>
  );
}

function HomeRedirect() {
  const { user, status } = useAuth();
  if (status === "loading") return <AuthLoading />;
  if (status === "error") return <ServiceUnavailable />;
  return <Navigate to={user ? (user.role === "STUDENT" ? "/student/dashboard" : "/teacher/dashboard") : "/student/login"} replace />;
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/" element={<HomeRedirect />} />
        <Route path="/student/login" element={<AuthPage role="STUDENT" />} />
        <Route path="/student/register" element={<AuthPage role="STUDENT" mode="register" />} />
        <Route
          path="/student/dashboard"
          element={
            <RoleRoute role="STUDENT">
              <StudentDashboardPage />
            </RoleRoute>
          }
        />
        <Route path="/student/exams" element={<RoleRoute role="STUDENT"><AvailableExamsPage /></RoleRoute>} />
        <Route path="/student/exams/:quizId" element={<RoleRoute role="STUDENT"><QuizDetailsPage /></RoleRoute>} />
        <Route path="/student/quizzes/:quizId" element={<RoleRoute role="STUDENT"><QuizDetailsPage /></RoleRoute>} />
        <Route path="/student/attempts/:attemptId" element={<RoleRoute role="STUDENT"><ExamAttemptPage /></RoleRoute>} />
        <Route path="/student/results" element={<RoleRoute role="STUDENT"><ResultsPage /></RoleRoute>} />
        <Route path="/student/results/:attemptId" element={<RoleRoute role="STUDENT"><ResultDetailPage /></RoleRoute>} />
        <Route path="/teacher/login" element={<AuthPage role="TEACHER" />} />
        <Route
          path="/teacher/dashboard"
          element={
            <RoleRoute role="TEACHER">
              <TeacherDashboardPage />
            </RoleRoute>
          }
        />
        <Route
          path="/teacher/quizzes/new"
          element={
            <RoleRoute role="TEACHER">
              <CreateQuizPage />
            </RoleRoute>
          }
        />
        <Route
          path="/teacher/quizzes/:quizId/edit"
          element={
            <RoleRoute role="TEACHER">
              <EditQuizPage />
            </RoleRoute>
          }
        />
        <Route
          path="/teacher/quizzes/:quizId/preview"
          element={
            <RoleRoute role="TEACHER">
              <PreviewQuizPage />
            </RoleRoute>
          }
        />
        <Route path="/teacher/quizzes/:quizId/monitor" element={<RoleRoute role="TEACHER"><TeacherMonitorPage /></RoleRoute>} />
        <Route path="/teacher/quizzes/:quizId/results" element={<RoleRoute role="TEACHER"><TeacherResultsPage /></RoleRoute>} />
        <Route path="*" element={<HomeRedirect />} />
      </Routes>
    </AuthProvider>
  );
}
