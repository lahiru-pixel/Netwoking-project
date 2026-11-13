import { Router } from "express";
import bcrypt from "bcryptjs";
import { rateLimit } from "express-rate-limit";
import { User } from "../models/User.js";
import { newCsrfToken, requireAuth, requireCsrf, requireRole } from "./middleware.js";
import { credentialsSchema, studentRegistrationSchema } from "./validation.js";

const router = Router();
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: { code: "LOGIN_RATE_LIMITED", message: "Too many sign-in attempts. Try again later." },
  },
});
const registrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: {
    error: { code: "REGISTRATION_RATE_LIMITED", message: "Too many registrations. Try again later." },
  },
});

function publicUser(user) {
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: user.role,
  };
}

function saveSession(session) {
  return new Promise((resolve, reject) => {
    session.save((error) => (error ? reject(error) : resolve()));
  });
}

function regenerateSession(request) {
  return new Promise((resolve, reject) => {
    request.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
}

router.get("/csrf", (request, response) => {
  request.session.csrfToken ??= newCsrfToken();
  response.set("Cache-Control", "no-store");
  response.json({ csrfToken: request.session.csrfToken });
});

router.post("/student/register", registrationLimiter, requireCsrf, async (request, response, next) => {
  const parsed = studentRegistrationSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(422).json({
      error: {
        code: "VALIDATION_FAILED",
        message: "Check the highlighted fields and try again.",
        fields: parsed.error.flatten().fieldErrors,
      },
    });
  }

  try {
    const { name, email, password } = parsed.data;
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({ name, email, passwordHash, role: "STUDENT" });
    response.status(201).json({ user: publicUser(user) });
  } catch (error) {
    if (error?.code === 11000) {
      return response.status(409).json({
        error: { code: "EMAIL_IN_USE", message: "An account with that email already exists." },
      });
    }
    next(error);
  }
});

async function loginForRole(expectedRole, request, response, next) {
  const parsed = credentialsSchema.safeParse(request.body);
  if (!parsed.success) {
    return response.status(422).json({
      error: {
        code: "VALIDATION_FAILED",
        message: "Enter a valid email and password.",
        fields: parsed.error.flatten().fieldErrors,
      },
    });
  }

  try {
    const { email, password } = parsed.data;
    const user = await User.findOne({ email }).select("+passwordHash");
    const passwordMatches = user
      ? await bcrypt.compare(password, user.passwordHash)
      : await bcrypt.compare(
          password,
          "$2b$12$lTr3APEcfmaa3F/.BAdFT.XIgMiYhO54A46PT9JFwHnTkS7Hyn96C",
        );

    if (!user || user.role !== expectedRole || !passwordMatches) {
      return response.status(401).json({
        error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password." },
      });
    }

    await regenerateSession(request);
    request.session.userId = user._id.toString();
    request.session.role = user.role;
    request.session.csrfToken = newCsrfToken();
    await saveSession(request.session);

    response.set("Cache-Control", "no-store");
    response.json({ user: publicUser(user), csrfToken: request.session.csrfToken });
  } catch (error) {
    next(error);
  }
}

router.post("/student/login", loginLimiter, requireCsrf, (request, response, next) =>
  loginForRole("STUDENT", request, response, next),
);
router.post("/teacher/login", loginLimiter, requireCsrf, (request, response, next) =>
  loginForRole("TEACHER", request, response, next),
);

router.get("/me", requireAuth, (request, response) => {
  response.set("Cache-Control", "no-store");
  response.json({ user: request.user });
});

router.post("/logout", requireAuth, requireCsrf, (request, response, next) => {
  request.session.destroy((error) => {
    if (error) return next(error);
    response.clearCookie("examflow.sid", { path: "/" });
    response.status(204).end();
  });
});

export default router;
