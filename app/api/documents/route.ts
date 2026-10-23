import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Service window: server-side only, service role bypasses RLS
const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET() {
    const { data, error } = await supabase
        .from("documents")
        .select("id, filename, status, total_chunks, error_message, created_at")
        .order("created_at", { ascending: false });

    if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ documents: data ?? [] });
}