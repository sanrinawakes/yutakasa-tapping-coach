import { NextRequest, NextResponse } from "next/server";
import { getAdminAuthError } from "@/lib/admin-auth";
import { clearTranscriptCache } from "@/lib/gemini";

export async function POST(request: NextRequest) {
  try {
    const authError = getAdminAuthError(request);
    if (authError) return authError;

    // Rebuild the in-process search index from the bundled course snapshot.
    await clearTranscriptCache();

    return NextResponse.json({
      success: true,
      message: "Course search cache cleared",
    });
  } catch (error) {
    console.error("Refresh content error:", error);
    return NextResponse.json(
      { error: "Failed to refresh content" },
      { status: 500 }
    );
  }
}
