import "../src/config.js";
import mongoose from "mongoose";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createTeacherUser } from "../src/auth/seed-teacher.js";

async function seedTeacher() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri || !["127.0.0.1", "localhost", "::1"].includes(new URL(mongoUri).hostname)) {
    throw new Error("MONGODB_URI must point to local MongoDB (127.0.0.1).");
  }
  if (!process.env.TEACHER_NAME || !process.env.TEACHER_EMAIL || !process.env.TEACHER_PASSWORD) {
    throw new Error("Set TEACHER_NAME, TEACHER_EMAIL, and TEACHER_PASSWORD before seeding.");
  }

  await mongoose.connect(mongoUri);
  const user = await createTeacherUser({
    name: process.env.TEACHER_NAME,
    email: process.env.TEACHER_EMAIL,
    password: process.env.TEACHER_PASSWORD,
  });
  console.info(`Teacher account created: ${user.email}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await seedTeacher();
  } catch (error) {
    console.error(`Teacher seed failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}
