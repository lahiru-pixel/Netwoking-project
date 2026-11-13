import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { z } from "zod";
import {
  ArrowLeft,
  ArrowRight,
  BookOpenCheck,
  Check,
  GraduationCap,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
  UsersRound,
} from "lucide-react";
import { useAuth } from "@/auth/AuthContext";
import { ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const roleDetails = {
  STUDENT: {
    label: "Student",
    eyebrow: "YOUR LEARNING, IN FLOW",
    headline: "A clearer way to show what you know.",
    description:
      "Your assessments, thoughtfully organized. Sign in to pick up right where your learning takes you.",
    icon: GraduationCap,
    feature: "A focused space for every assessment",
    oppositeLabel: "Teacher portal",
    oppositePath: "/teacher/login",
    dashboard: "/student/dashboard",
  },
  TEACHER: {
    label: "Teacher",
    eyebrow: "TEACHING, IN FLOW",
    headline: "More time for the work that matters.",
    description:
      "Bring your assessments and class progress together in one calm, considered workspace.",
    icon: UsersRound,
    feature: "One clear view of your classroom",
    oppositeLabel: "Student portal",
    oppositePath: "/student/login",
    dashboard: "/teacher/dashboard",
  },
};

const loginSchema = z.object({
  email: z.string().trim().email("Enter a valid email address.").max(254),
  password: z.string().min(8, "Password must be at least 8 characters.").max(128),
});

const registrationSchema = loginSchema.extend({
  name: z.string().trim().min(2, "Enter your full name.").max(80),
});

function Field({ id, label, error, ...inputProps }) {
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      <Input
        id={id}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        {...inputProps}
      />
      {error && (
        <p id={`${id}-error`} role="alert" className="text-sm text-rose-600">
          {error.message}
        </p>
      )}
    </div>
  );
}

function AuthBackdrop({ role, details }) {
  const Icon = details.icon;

  return (
    <aside
      className={`relative hidden min-h-screen overflow-hidden px-10 py-10 text-white lg:flex lg:flex-col lg:justify-between xl:px-16 ${
        role === "STUDENT"
          ? "bg-[radial-gradient(ellipse_at_15%_0%,#3730a3_0%,#171c43_42%,#0b1120_100%)]"
          : "bg-[radial-gradient(ellipse_at_15%_0%,#4338a8_0%,#201b49_42%,#0b1120_100%)]"
      }`}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-36 top-24 size-[28rem] rounded-full border border-white/10"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-20 top-40 size-[21rem] rounded-full border border-white/[0.07]"
      />
      <div className="absolute bottom-28 right-28 size-48 rounded-full bg-indigo-400/10 blur-3xl" />

      <Link to={details.dashboard} className="relative inline-flex w-fit items-center gap-3">
        <span className="flex size-11 items-center justify-center rounded-xl border border-white/15 bg-white/10 shadow-lg shadow-black/10">
          <BookOpenCheck aria-hidden="true" className="size-5" />
        </span>
        <span className="text-xl font-semibold tracking-tight">ExamFlow</span>
      </Link>

      <div className="relative max-w-xl pb-8">
        <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.07] px-3.5 py-2 text-xs font-medium tracking-wide text-indigo-100">
          <Sparkles aria-hidden="true" className="size-3.5 text-indigo-300" />
          {details.eyebrow}
        </div>
        <h1 className="max-w-lg text-5xl font-semibold leading-[1.12] tracking-[-0.04em] xl:text-6xl">
          {details.headline}
        </h1>
        <p className="mt-6 max-w-md text-base leading-7 text-slate-300">
          {details.description}
        </p>

        <div className="mt-12 flex max-w-md items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.06] p-4 backdrop-blur-sm">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-indigo-400/15 text-indigo-200">
            <Icon aria-hidden="true" className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-white">{details.feature}</p>
            <p className="mt-1 text-xs text-slate-400">Simple. Secure. Ready when you are.</p>
          </div>
          <Check aria-hidden="true" className="size-4 shrink-0 text-emerald-300" />
        </div>
      </div>

      <div className="relative flex items-center justify-between text-xs text-slate-400">
        <span>© {new Date().getFullYear()} ExamFlow</span>
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck aria-hidden="true" className="size-3.5" />
          Private by design
        </span>
      </div>
    </aside>
  );
}

export function AuthPage({ role, mode = "login" }) {
  const details = roleDetails[role];
  const isRegister = mode === "register";
  const { user, status, signIn, registerStudent } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [serverError, setServerError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const form = useForm({
    resolver: zodResolver(isRegister ? registrationSchema : loginSchema),
    mode: "onBlur",
    defaultValues: { name: "", email: "", password: "" },
  });

  if (status === "loading") {
    return <AuthLoading />;
  }
  if (status === "error") {
    return <AuthUnavailable />;
  }
  if (user) {
    return <Navigate to={roleDetails[user.role].dashboard} replace />;
  }

  async function onSubmit(values) {
    setServerError("");
    setSubmitting(true);
    try {
      if (isRegister) {
        await registerStudent(values);
        navigate("/student/login", {
          replace: true,
          state: { notice: "Your student account is ready. Sign in to continue." },
        });
      } else {
        const signedInUser = await signIn(role, values);
        navigate(roleDetails[signedInUser.role].dashboard, { replace: true });
      }
    } catch (error) {
      if (error instanceof ApiError && error.fields) {
        for (const [field, messages] of Object.entries(error.fields)) {
          if (messages?.[0]) {
            form.setError(field, { type: "server", message: messages[0] });
          }
        }
      }
      setServerError(error.message ?? "Unable to continue. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const heading = isRegister ? "Create your account" : `Welcome back`;

  return (
    <main className="grid min-h-screen bg-white lg:grid-cols-[minmax(0,1.04fr)_minmax(32rem,0.96fr)]">
      <AuthBackdrop role={role} details={details} />

      <section className="flex min-h-screen flex-col px-5 py-6 sm:px-10 lg:px-12 xl:px-20">
        <header className="flex items-center justify-between lg:hidden">
          <Link to={roleDetails[role].dashboard} className="inline-flex items-center gap-2.5">
            <span className="flex size-10 items-center justify-center rounded-xl bg-indigo-600 text-white">
              <BookOpenCheck aria-hidden="true" className="size-5" />
            </span>
            <span className="text-lg font-semibold tracking-tight text-slate-900">ExamFlow</span>
          </Link>
          <Link
            to={details.oppositePath}
            className="text-sm font-medium text-slate-600 hover:text-indigo-700"
          >
            {details.oppositeLabel}
          </Link>
        </header>
        <div className="hidden items-center justify-end lg:flex">
          <Link
            to={details.oppositePath}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm font-medium text-slate-600 transition hover:text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
          >
            {details.oppositeLabel}
            <ArrowRight aria-hidden="true" className="size-4" />
          </Link>
        </div>

        <div className="mx-auto flex w-full max-w-[26rem] flex-1 flex-col justify-center py-10 lg:py-16">
          <div className="mb-8 lg:hidden">
            <p className="text-xs font-semibold tracking-[0.16em] text-indigo-600">
              {details.eyebrow}
            </p>
          </div>
          <div className="mb-8">
            <p className="mb-3 hidden text-sm font-medium text-indigo-600 lg:block">
              {details.label} portal
            </p>
            <h2 className="text-3xl font-semibold tracking-[-0.035em] text-slate-950">
              {heading}
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              {isRegister
                ? "Join ExamFlow with your student account."
                : `Sign in to your ${details.label.toLowerCase()} workspace.`}
            </p>
          </div>

          <form className="space-y-5" onSubmit={form.handleSubmit(onSubmit)} noValidate>
            {!isRegister && location.state?.notice && (
              <div
                role="status"
                className="rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-3 text-sm text-emerald-800"
              >
                {location.state.notice}
              </div>
            )}
            {isRegister && (
              <Field
                id="name"
                label="Full name"
                type="text"
                autoComplete="name"
                placeholder="Your full name"
                error={form.formState.errors.name}
                {...form.register("name")}
              />
            )}
            <Field
              id="email"
              label="Email address"
              type="email"
              autoComplete="email"
              placeholder="you@university.edu"
              error={form.formState.errors.email}
              {...form.register("email")}
            />
            <Field
              id="password"
              label="Password"
              type="password"
              autoComplete={isRegister ? "new-password" : "current-password"}
              placeholder={isRegister ? "At least 8 characters" : "Enter your password"}
              error={form.formState.errors.password}
              {...form.register("password")}
            />

            {serverError && (
              <div
                role="alert"
                aria-live="polite"
                className="rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm text-rose-700"
              >
                {serverError}
              </div>
            )}

            <Button
              type="submit"
              disabled={submitting}
              className="h-12 w-full rounded-lg bg-indigo-600 text-[0.94rem] font-semibold shadow-sm shadow-indigo-200 hover:bg-indigo-700"
            >
              {submitting ? "Please wait…" : isRegister ? "Create student account" : "Sign in"}
              {!submitting && <ArrowRight aria-hidden="true" className="ml-2 size-4" />}
            </Button>
          </form>

          <div className="mt-7 border-t border-slate-100 pt-6 text-center text-sm text-slate-500">
            {isRegister ? (
              <>
                Already have an account?{" "}
                <Link to="/student/login" className="font-semibold text-indigo-700 hover:text-indigo-800">
                  Sign in
                </Link>
              </>
            ) : role === "STUDENT" ? (
              <>
                New to ExamFlow?{" "}
                <Link to="/student/register" className="font-semibold text-indigo-700 hover:text-indigo-800">
                  Create a student account
                </Link>
              </>
            ) : (
              <span className="inline-flex items-center gap-2 text-slate-500">
                <LockKeyhole aria-hidden="true" className="size-4" />
                Teacher accounts are provisioned by your administrator.
              </span>
            )}
          </div>
          <Link
            to={details.oppositePath}
            className="mt-6 inline-flex min-h-11 items-center justify-center gap-2 rounded-lg text-sm font-medium text-slate-600 transition hover:text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 lg:hidden"
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            Switch to {details.oppositeLabel}
          </Link>
        </div>

        <footer className="flex items-center justify-center gap-2 pb-2 text-xs text-slate-400">
          <ShieldCheck aria-hidden="true" className="size-3.5" />
          Your account is protected with secure sign-in
        </footer>
      </section>
    </main>
  );
}

export function AuthLoading() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-6">
      <div className="flex items-center gap-3 text-sm font-medium text-slate-600" role="status">
        <span className="size-5 animate-spin rounded-full border-2 border-indigo-600 border-r-transparent" />
        Restoring your secure session…
      </div>
    </main>
  );
}

function AuthUnavailable() {
  const { retrySession } = useAuth();

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-6">
      <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <h1 className="text-xl font-semibold text-slate-900">Sign-in is unavailable</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          ExamFlow could not reach the API. Check that the backend and local MongoDB are running.
        </p>
        <Button
          type="button"
          onClick={retrySession}
          className="mt-6 bg-indigo-600 text-white hover:bg-indigo-700"
        >
          Try again
        </Button>
      </div>
    </main>
  );
}
