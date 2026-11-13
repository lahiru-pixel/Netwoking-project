import { z } from "zod";

export const credentialsSchema = z.object({
  email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
  password: z
    .string()
    .min(8)
    .max(128)
    .refine((password) => Buffer.byteLength(password, "utf8") <= 72, {
      message: "Password must be 72 bytes or fewer.",
    }),
});

export const studentRegistrationSchema = credentialsSchema.extend({
  name: z.string().trim().min(2).max(80),
});
