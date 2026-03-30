import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

function getSecretKey(): Uint8Array {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters");
  }
  return new TextEncoder().encode(jwtSecret);
}

export interface SessionPayload {
  email: string;
  iat: number;
  exp: number;
}

export async function createSession(email: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = 7 * 24 * 60 * 60; // 7 days

  const token = await new SignJWT({ email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + expiresIn)
    .sign(getSecretKey());

  return token;
}

export async function verifySession(token: string): Promise<SessionPayload | null> {
  try {
    const verified = await jwtVerify(token, getSecretKey());
    return verified.payload as unknown as SessionPayload;
  } catch (error) {
    return null;
  }
}

export async function setSessionCookie(token: string) {
  const cookieStore = await cookies();
  const expiresIn = 7 * 24 * 60 * 60 * 1000; // 7 days in ms

  cookieStore.set("session", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: expiresIn / 1000,
    path: "/",
  });
}

export async function getSessionFromCookies(): Promise<SessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get("session")?.value;

  if (!token) {
    return null;
  }

  return verifySession(token);
}

export async function clearSessionCookie() {
  const cookieStore = await cookies();
  cookieStore.delete("session");
}
