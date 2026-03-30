import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

const protectedPaths = ["/chat"];

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // Check if the path is protected
  const isProtectedPath = protectedPaths.some((path) =>
    pathname.startsWith(path)
  );

  if (!isProtectedPath) {
    return NextResponse.next();
  }

  // Get the session token from cookies
  const token = request.cookies.get("session")?.value;

  if (!token) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    console.error("JWT_SECRET is not set");
    return NextResponse.redirect(new URL("/login", request.url));
  }

  try {
    const secretKey = new TextEncoder().encode(jwtSecret);
    await jwtVerify(token, secretKey);
    return NextResponse.next();
  } catch (error) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
}

export const config = {
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|public).*)",
  ],
};
