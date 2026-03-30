import { NextRequest, NextResponse } from "next/server";
import { clearTranscriptCache } from "@/lib/gemini";

const adminSecret = process.env.JWT_SECRET;

export async function POST(request: NextRequest) {
  try {
    // Simple admin authentication using a header
    const adminToken = request.headers.get("x-admin-token");

    if (!adminToken || adminToken !== adminSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Clear the transcript cache
    await clearTranscriptCache();

    return NextResponse.json({
      success: true,
      message: "Transcript cache cleared",
    });
  } catch (error) {
    console.error("Refresh content error:", error);
    return NextResponse.json(
      { error: "Failed to refresh content" },
      { status: 500 }
    );
  }
}
