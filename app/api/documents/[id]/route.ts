import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const { data: doc } = await supabase
        .from("documents")
        .select("storage_path")
        .eq("id", id)
        .single();

    if (!doc) return NextResponse.json({ error: "Document not found" }, { status: 404 });

    // Row delete -> chunks vanish automatically via ON DELETE CASCADE
    const { error: delErr } = await supabase.from("documents").delete().eq("id", id);
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

    // Clean the binary too (best effort)
    await supabase.storage.from("pdf-documents").remove([doc.storage_path]);

    return NextResponse.json({ success: true });
}