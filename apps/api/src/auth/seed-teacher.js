import bcrypt from "bcryptjs";
import { User } from "../models/User.js";
import { studentRegistrationSchema } from "./validation.js";

export async function createTeacherUser(input) {
  const parsed = studentRegistrationSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("Teacher name, email, or password does not meet the requirements.");
  }

  const { name, email, password } = parsed.data;
  const existingUser = await User.findOne({ email }).select("_id role");
  if (existingUser) {
    throw new Error("An account with that email already exists; no account was changed.");
  }

  const passwordHash = await bcrypt.hash(password, 12);
  return User.create({ name, email, passwordHash, role: "TEACHER" });
}
