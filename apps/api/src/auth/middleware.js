import { randomBytes, timingSafeEqual } from "node:crypto";
import { User } from "../models/User.js";

export function newCsrfToken() {
  return randomBytes(32).toString("hex");
}

export function requireCsrf(request, response, next) {
  const expected = request.session?.csrfToken;
  const received = request.get("x-csrf-token");

  if (
    typeof expected !== "string" ||
    typeof received !== "string" ||
    expected.length !== received.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(received))
  ) {
    return response.status(403).json({
      error: { code: "CSRF_INVALID", message: "Refresh the page and try again." },
    });
  }

  next();
}

export async function requireAuth(request, response, next) {
  if (!request.session?.userId || !request.session?.role) {
    return response.status(401).json({
      error: { code: "AUTH_REQUIRED", message: "Please sign in to continue." },
    });
  }

  try {
    const user = await User.findById(request.session.userId)
      .select("name email role")
      .lean();

    if (!user || user.role !== request.session.role) {
      return request.session.destroy((error) => {
        if (error) return next(error);
        response.clearCookie("examflow.sid", { path: "/" });
        response.status(401).json({
          error: { code: "AUTH_REQUIRED", message: "Please sign in to continue." },
        });
      });
    }

    request.user = {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      role: user.role,
    };
    next();
  } catch (error) {
    next(error);
  }
}

export function requireRole(role) {
  return (request, response, next) => {
    if (request.user?.role !== role) {
      return response.status(403).json({
        error: { code: "FORBIDDEN", message: "You do not have access to this resource." },
      });
    }

    next();
  };
}
